/**
 * Синтетические случаи для панели антифрода. Все данные вымышлены; тексты взяты из
 * data/dataset и проходят через maskSensitive (excerpt).
 */
import type { Client } from "@libsql/client";
import { parseDataset, type DatasetItem } from "../dataset";
import { excerpt } from "../privacy";
import type { CaseOutcome, CaseStatus, ScamType } from "../domain";

export const CASE_COUNT = 120;
/** Окно синтетики: 29 суток до начала текущего дня — всегда внутри «последних 30 дней». */
const DAYS = 29;
/**
 * Опорное время — начало текущих суток по UTC: в течение дня результат детерминирован,
 * все случаи лежат в прошлом (не позже `now`) и в окне «последние 30 дней» панели.
 */
export function seedAnchor(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

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

function buildCase(r: () => number, i: number, scams: DatasetItem[], legits: DatasetItem[], NOW: number) {
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
    // LLM в демо не подключена — синтетика не должна выдавать себя за её результат.
    // r() вызывается, чтобы остальные поля остались прежними (детерминированность seed).
    analysis_mode: (r(), "rules"),
    transfer_amount: transferAmount,
    new_recipient: hasTransfer && r() < 0.85 ? 1 : 0,
    outcome,
    status,
    synthetic: 1,
  };
}

export function generateCases(dataset: DatasetItem[], count = CASE_COUNT, now = new Date()) {
  const anchor = seedAnchor(now);
  const r = rng(20261120);
  const scams = dataset.filter((d) => d.label === "scam");
  const legits = dataset.filter((d) => d.label === "legit" && d.hardNegative);
  return Array.from({ length: count }, (_, i) => buildCase(r, i, scams, legits, anchor));
}


/** Перезаписывает синтетические случаи (несинтетические — из демо — не трогает). */
export async function seedSynthetic(db: Client, datasetJsonl: string, now = new Date()): Promise<number> {
  const { items, errors } = parseDataset(datasetJsonl);
  if (errors.length) throw new Error(`Тестовый набор некорректен:\n${errors.join("\n")}`);
  const cases = generateCases(items, CASE_COUNT, now);
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
  return cases.length;
}
