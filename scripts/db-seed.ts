/**
 * Наполняет базу синтетическими случаями для панели банка.
 * Детерминирован (фиксированный seed): одинаковые данные при каждом запуске.
 *
 *   npm run db:seed            — пересоздать данные в DATABASE_URL (по умолчанию data/qalqan.db)
 *
 * Все данные вымышлены; тексты взяты из data/dataset и проходят через maskSensitive.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createDb, DEFAULT_DATABASE_URL } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/schema";
import { parseDataset, type DatasetItem } from "../src/lib/dataset";
import { excerpt } from "../src/lib/privacy";
import type { CaseOutcome, CaseStatus, ScamType } from "../src/lib/domain";

const CASE_COUNT = 120;
const DAYS = 30;
const NOW = Date.parse("2026-11-12T12:00:00Z"); // фиксированная дата — детерминированный результат

/** mulberry32 — маленький детерминированный ГПСЧ. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REASONS: Record<ScamType, string[]> = {
  fake_security_service: [
    "Собеседник представляется службой безопасности банка",
    "Создаётся ощущение срочности и угрозы деньгам",
  ],
  safe_account: [
    "Просят перевести деньги на «безопасный» или «резервный» счёт — банки так не делают",
    "Просят скрыть разговор от сотрудников банка и близких",
  ],
  code_request: [
    "Просят сообщить код из SMS, CVV или PIN — их не спрашивает никто, включая банк",
    "Угроза списания денег, если не продиктовать код",
  ],
  phishing_link: [
    "Ссылка ведёт на сайт, не принадлежащий банку",
    "Требование «подтвердить данные» под угрозой блокировки",
  ],
  official_impersonation: [
    "Собеседник представляется полицией / госорганом и требует перевести деньги",
    "Ссылка на «тайну следствия» и угрозы уголовным делом",
  ],
  relative_in_trouble: [
    "Просьба о срочном переводе от «родственника» с нового номера",
    "Просят не звонить и никому не рассказывать",
  ],
  investment: [
    "Обещание гарантированной высокой доходности",
    "Давление: «осталось несколько мест», решение нужно сегодня",
  ],
  prize_or_delivery: [
    "Чтобы получить выигрыш или посылку, требуют оплатить «доставку» или «пошлину»",
    "Ссылка на сторонний сайт и ограничение по времени",
  ],
  marketplace: [
    "«Покупатель» просит ввести данные карты, чтобы получить оплату",
    "Ссылка на поддельную «безопасную сделку»",
  ],
};

const RECOMMENDATION_HIGH =
  "Не переводите деньги и не сообщайте коды. Положите трубку и позвоните в банк по номеру на обороте карты.";
const RECOMMENDATION_MEDIUM = "Проверьте отправителя через официальный канал банка, прежде чем что-либо делать.";

const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];

function weighted<T>(r: () => number, entries: Array<[T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [value, w] of entries) {
    if ((x -= w) < 0) return value;
  }
  return entries[entries.length - 1][0];
}

function buildCase(r: () => number, i: number, scams: DatasetItem[], legits: DatasetItem[]) {
  // ~12% — ложные срабатывания на обычных сообщениях (для честной статистики в панели)
  const falsePositive = r() < 0.12;
  const source = falsePositive ? pick(r, legits) : pick(r, scams);
  const scamType = falsePositive ? null : (source.scamType as ScamType);

  const riskScore = falsePositive ? 40 + Math.floor(r() * 25) : 62 + Math.floor(r() * 38);
  const reasons = scamType
    ? REASONS[scamType]
    : ["Сообщение содержит слова, характерные для мошеннических схем (код, срочно, банк)"];

  const hasTransfer = r() < 0.75;
  const transferAmount = hasTransfer ? Math.round((20_000 + r() * 1_480_000) / 1000) * 1000 : null;

  const outcome: CaseOutcome = !hasTransfer
    ? "no_transfer"
    : weighted<CaseOutcome>(r, [
        ["cancelled_by_client", 55],
        ["held_for_trusted_contact", 25],
        ["proceeded", 20],
      ]);

  const createdAt = new Date(NOW - Math.floor(r() * DAYS * 24 * 60) * 60_000);
  const ageDays = (NOW - createdAt.getTime()) / 86_400_000;
  const status: CaseStatus =
    ageDays < 2
      ? "new"
      : falsePositive
        ? weighted<CaseStatus>(r, [["false_positive", 80], ["reviewing", 20]])
        : weighted<CaseStatus>(r, [["confirmed_fraud", 75], ["reviewing", 25]]);

  return {
    id: `case-${String(i + 1).padStart(4, "0")}`,
    created_at: createdAt.toISOString(),
    client_alias: `Клиент #${1000 + Math.floor(r() * 9000)}`,
    channel: source.channel,
    language: source.lang,
    text_excerpt: excerpt(source.text),
    risk_score: riskScore,
    scam_type: scamType,
    reasons: JSON.stringify(reasons),
    recommendation: riskScore >= 70 ? RECOMMENDATION_HIGH : RECOMMENDATION_MEDIUM,
    analysis_mode: r() < 0.8 ? "hybrid" : "rules",
    transfer_amount: transferAmount,
    new_recipient: hasTransfer && r() < 0.85 ? 1 : 0,
    outcome,
    status,
    synthetic: 1,
  };
}

export function generateCases(dataset: DatasetItem[], count = CASE_COUNT) {
  const r = rng(20261120);
  const scams = dataset.filter((d) => d.label === "scam");
  const legits = dataset.filter((d) => d.label === "legit" && d.hardNegative);
  return Array.from({ length: count }, (_, i) => buildCase(r, i, scams, legits));
}

async function main() {
  const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  if (url.startsWith("file:")) mkdirSync("data", { recursive: true });

  const { items, errors } = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));
  if (errors.length) throw new Error(`Тестовый набор некорректен:\n${errors.join("\n")}`);

  const db = createDb(url, process.env.DATABASE_AUTH_TOKEN || undefined);
  await migrate(db);

  const cases = generateCases(items);
  const columns = Object.keys(cases[0]);
  await db.batch(
    [
      "DELETE FROM cases WHERE synthetic = 1",
      ...cases.map((c) => ({
        sql: `INSERT INTO cases (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        args: Object.values(c),
      })),
    ],
    "write",
  );

  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM cases");
  console.log(`Seed: ${cases.length} синтетических случаев записано, всего в базе: ${rows[0].n} (${url})`);
  db.close();
}

if (process.argv[1]?.endsWith("db-seed.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
