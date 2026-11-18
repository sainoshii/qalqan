/**
 * Замер скорости детектора.
 *
 *   npm run bench                                   — детектор в процессе (правила + модель, без LLM)
 *   npm run bench -- --url https://qalqan-one.vercel.app   — плюс сквозная задержка API по сети
 *   npm run bench -- --write                        — записать docs/performance.md
 *
 * Сквозной замер делает последовательные запросы в пределах лимита API (30 в минуту с адреса):
 * это задержка для одного клиента, а не предельная нагрузка. Пропускная способность — по замеру
 * в процессе (один поток); нагрузочный тест развёрнутого сервиса не проводился.
 * Неуспешный сквозной замер (ошибки, 429, ответ не по контракту) завершает скрипт с кодом 1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { analyzeMessage } from "../src/lib/detector";
import { parseDataset } from "../src/lib/dataset";
import { assessTransfer } from "../src/lib/transfer/risk";
import { TRAIN_FILES } from "./train-model";

/** Те же сообщения, на которых обучается модель (отложенные наборы сюда не входят). */
const DATA = TRAIN_FILES;
const HTTP_REQUESTS = 20;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1) ?? NaN };
}

const ms = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

function loadTexts(): string[] {
  const texts: string[] = [];
  for (const f of DATA) {
    try {
      texts.push(...parseDataset(readFileSync(f, "utf8")).items.map((i) => i.text));
    } catch {
      // файла нет — пропускаем
    }
  }
  return texts;
}

async function inProcess(texts: string[]) {
  // Прогрев: JIT и загрузка весов модели
  for (const t of texts.slice(0, 50)) await analyzeMessage(t, { useLlm: false });

  const ROUNDS = 5;
  const samples: number[] = [];
  const t0 = performance.now();
  for (let r = 0; r < ROUNDS; r++) {
    for (const t of texts) {
      const s = performance.now();
      const message = await analyzeMessage(t, { useLlm: false });
      assessTransfer({ amount: 450_000, newRecipient: true, message, onCall: false });
      samples.push(performance.now() - s);
    }
  }
  const total = performance.now() - t0;
  const throughput = (samples.length / total) * 1000;

  const long = "Здравствуйте, служба безопасности банка. Срочно назовите код из SMS. ".repeat(80).slice(0, 5000);
  const longSamples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const s = performance.now();
    const message = await analyzeMessage(long, { useLlm: false });
    assessTransfer({ amount: 450_000, newRecipient: true, message, onCall: false });
    longSamples.push(performance.now() - s);
  }
  return { typical: stats(samples), long: stats(longSamples), throughput, avgChars: Math.round(texts.reduce((a, t) => a + t.length, 0) / texts.length) };
}

/** Ответ соответствует контракту /api/analyze (а не, например, HTML-странице ошибки). */
export function isAnalysis(body: unknown): boolean {
  const b = body as { riskScore?: unknown; reasons?: unknown } | null;
  return typeof b?.riskScore === "number" && Array.isArray(b.reasons);
}

async function overHttp(base: string, texts: string[]) {
  const url = new URL("/api/analyze", base).toString();
  const samples: number[] = [];
  let errors = 0;
  let route = "";
  let mode = "";
  for (let i = 0; i < HTTP_REQUESTS; i++) {
    const s = performance.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: texts[i % texts.length] }),
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await res.json().catch(() => null);
      // x-vercel-id: «<точка входа>::<регион функции>::…» — где реально выполнялся запрос
      const parts = (res.headers.get("x-vercel-id") ?? "").split("::");
      if (parts.length >= 3) route = `точка входа ${parts[0]}, функция ${parts[parts.length - 2]}`;
      if (res.status === 429) {
        // Лимит API исчерпан (например, предыдущим запуском) — дальше мерить бессмысленно
        errors += HTTP_REQUESTS - i;
        break;
      }
      if (!res.ok || !isAnalysis(body)) {
        errors++;
        continue;
      }
      mode = String((body as { mode?: unknown }).mode ?? "");
      samples.push(performance.now() - s);
    } catch {
      errors++;
    }
  }
  return { ...stats(samples), errors, route, mode };
}

async function main() {
  const argv = process.argv.slice(2);
  const urlIndex = argv.indexOf("--url");
  const base = urlIndex >= 0 ? argv[urlIndex + 1] : undefined;
  const texts = loadTexts();
  if (texts.length === 0) throw new Error("Нет текстов для замера (data/dataset/*.jsonl)");

  const cpu = cpus()[0]?.model ?? "неизвестный процессор";
  const local = await inProcess(texts);
  const lines = [
    `Процессор: ${cpu}, Node.js ${process.version}, один поток.`,
    `Сообщений: ${texts.length} × 5 прогонов, средняя длина ${local.avgChars} символов. Каждый замер: правила + модель + оценка перевода, без LLM.`,
    "",
    "| Замер | Среднее | p50 | p95 | p99 | Максимум |",
    "|---|---:|---:|---:|---:|---:|",
    `| Типичное сообщение, мс | ${ms(local.typical.mean)} | ${ms(local.typical.p50)} | ${ms(local.typical.p95)} | ${ms(local.typical.p99)} | ${ms(local.typical.max)} |`,
    `| Текст 5000 символов, мс | ${ms(local.long.mean)} | ${ms(local.long.p50)} | ${ms(local.long.p95)} | ${ms(local.long.p99)} | ${ms(local.long.max)} |`,
    "",
    `Пропускная способность в этом замере: **≈ ${Math.round(local.throughput).toLocaleString("ru-RU")} проверок в секунду в одном потоке**.`,
  ];

  let failed = false;
  if (base) {
    const http = await overHttp(base, texts);
    if (http.n === 0 || http.errors > 0) {
      failed = true;
      console.error(`Сквозной замер неуспешен: успешных ответов ${http.n} из ${HTTP_REQUESTS}, ошибок ${http.errors}. Результат не записывается.`);
    }
    lines.push(
      "",
      `Сквозная задержка API (${new URL(base).host}${http.route ? `; ${http.route}` : ""}${http.mode ? `; режим анализа на сервере: ${http.mode === "hybrid" ? "правила + LLM" : "правила + модель, без LLM"}` : ""}; ${HTTP_REQUESTS} последовательных запросов, включая сеть и TLS):`,
      "",
      "| Среднее | p50 | p95 | Максимум | Ошибок |",
      "|---:|---:|---:|---:|---:|",
      `| ${ms(http.mean)} мс | ${ms(http.p50)} мс | ${ms(http.p95)} мс | ${ms(http.max)} мс | ${http.errors} |`,
    );
  }

  const out = lines.join("\n");
  console.log(out);

  if (failed) process.exit(1);
  if (argv.includes("--write")) {
    writeFileSync(
      "docs/performance.md",
      `# Скорость детектора\n\n${out}\n\n` +
        "- Проверка не обращается к сети и базе: правила и модель работают в памяти процесса, состояния между запросами нет. Поэтому её можно запускать на нескольких экземплярах параллельно; нагрузочный тест развёрнутого сервиса не проводился.\n" +
        "- Сквозной замер — последовательные запросы одного клиента в пределах лимита API (30 в минуту с адреса); это задержка, а не предельная нагрузка. Она включает сеть, TLS, инфраструктуру Vercel и возможный холодный старт; как она делится между ними, не измерялось. Сама проверка — доли миллисекунды, функция выполняется в регионе Vercel по умолчанию (США).\n" +
        "- С LLM задержка определяется ответом LLM (сотни миллисекунд); поэтому она вызывается только для «серой зоны» (локальный риск 30–69, около четверти сообщений на отложенных наборах).\n\n" +
        "Воспроизвести: `npm run bench -- --url https://qalqan-one.vercel.app --write`.\n",
    );
    console.log("\nЗаписано: docs/performance.md");
  }
}

if (process.argv[1]?.endsWith("bench.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
