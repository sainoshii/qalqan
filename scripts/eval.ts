/**
 * Оценка детектора на размеченном наборе.
 *
 *   npm run eval                  — только правила (без сети), таблица в консоль
 *   npm run eval -- --llm         — правила + LLM (нужен ANTHROPIC_API_KEY; платные запросы)
 *   npm run eval -- --write       — дополнительно записать docs/metrics.md
 *   npm run eval -- --verbose     — показать ошибки по каждой записи
 *   npm run eval -- --file data/dataset/challenge-1.jsonl — другой набор
 *
 * «Мошенничество» — riskScore >= HIGH_RISK (70). Метрики считаются отдельно для
 * dev (на нём настраивались правила) и holdout (итоговая оценка).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeMessage } from "../src/lib/detector";
import { parseDataset, type DatasetItem } from "../src/lib/dataset";
import { HIGH_RISK } from "../src/lib/domain";

export interface Scored {
  item: DatasetItem;
  riskScore: number;
  scamType: string | null;
}

export interface Metrics {
  n: number;
  scam: number;
  legit: number;
  recall: number | null; // доля пойманных мошеннических
  fpr: number | null; // доля ложных срабатываний на обычных
  hardNegativeFpr: number | null; // то же на «ловушках»
  typeAccuracy: number | null; // верный тип схемы среди пойманных
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function computeMetrics(rows: Scored[]): Metrics {
  const scam = rows.filter((r) => r.item.label === "scam");
  const legit = rows.filter((r) => r.item.label === "legit");
  const hard = legit.filter((r) => r.item.hardNegative);
  const caught = scam.filter((r) => r.riskScore >= HIGH_RISK);
  const flagged = (list: Scored[]) => list.filter((r) => r.riskScore >= HIGH_RISK).length;
  return {
    n: rows.length,
    scam: scam.length,
    legit: legit.length,
    recall: ratio(caught.length, scam.length),
    fpr: ratio(flagged(legit), legit.length),
    hardNegativeFpr: ratio(flagged(hard), hard.length),
    typeAccuracy: ratio(caught.filter((r) => r.scamType === r.item.scamType).length, caught.length),
  };
}

export async function scoreDataset(items: DatasetItem[], useLlm: boolean): Promise<Scored[]> {
  const rows: Scored[] = [];
  for (const item of items) {
    const result = await analyzeMessage(item.text, { useLlm });
    rows.push({ item, riskScore: result.riskScore, scamType: result.scamType });
  }
  return rows;
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

function table(rows: Scored[]): string {
  const groups: Array<[string, (r: Scored) => boolean]> = [
    ["holdout — все", (r) => r.item.split === "holdout"],
    ["holdout — русский", (r) => r.item.split === "holdout" && r.item.lang === "ru"],
    ["holdout — казахский", (r) => r.item.split === "holdout" && r.item.lang === "kk"],
    ["dev — все", (r) => r.item.split === "dev"],
    ["dev — русский", (r) => r.item.split === "dev" && r.item.lang === "ru"],
    ["dev — казахский", (r) => r.item.split === "dev" && r.item.lang === "kk"],
  ];
  const lines = [
    "| Выборка | Сообщений | Поймано мошеннических | Ложные срабатывания | …на «ловушках» | Верный тип схемы |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const [name, pred] of groups) {
    const m = computeMetrics(rows.filter(pred));
    lines.push(
      `| ${name} | ${m.n} | ${pct(m.recall)} | ${pct(m.fpr)} | ${pct(m.hardNegativeFpr)} | ${pct(m.typeAccuracy)} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const useLlm = args.has("--llm");
  const fileIndex = argv.indexOf("--file");
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : "data/dataset/messages.jsonl";
  const { items, errors } = parseDataset(readFileSync(file, "utf8"));
  if (errors.length) throw new Error(`Тестовый набор некорректен:\n${errors.join("\n")}`);

  const rows = await scoreDataset(items, useLlm);
  const mode = useLlm ? "правила + LLM" : "только правила";
  const out = table(rows);
  console.log(`Набор: ${file} (${items.length}). Режим: ${mode}. Порог мошенничества: riskScore >= ${HIGH_RISK}\n`);
  console.log(out);

  if (args.has("--verbose")) {
    console.log("\nОшибки:");
    for (const r of rows) {
      const flagged = r.riskScore >= HIGH_RISK;
      const wrong = (r.item.label === "scam") !== flagged;
      const wrongType = r.item.label === "scam" && flagged && r.scamType !== r.item.scamType;
      if (wrong || wrongType) {
        console.log(
          `  ${r.item.id} [${r.item.split}] score=${r.riskScore} type=${r.scamType} (ожидалось ${r.item.label}/${r.item.scamType})`,
        );
      }
    }
  }

  if (args.has("--write")) {
    mkdirSync("docs", { recursive: true });
    writeFileSync(
      "docs/metrics.md",
      `# Качество детектора\n\nРежим: **${mode}**. Порог мошенничества: \`riskScore >= ${HIGH_RISK}\`. Набор: ${items.length} синтетических сообщений (\`data/dataset/messages.jsonl\`).\n\n${out}\n\n- **holdout** — отложенная часть, на ней правила не настраивались; это итоговая оценка.\n- **«Ловушки»** — настоящие уведомления банка и бытовые сообщения, похожие на мошеннические.\n- Набор небольшой и написан авторами проекта: цифры показывают работоспособность подхода, а не качество на реальном потоке сообщений.\n\nВоспроизвести: \`npm run eval -- --write\`.\n`,
    );
    console.log("\nЗаписано: docs/metrics.md");
  }
}

if (process.argv[1]?.endsWith("eval.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
