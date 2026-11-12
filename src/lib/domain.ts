/**
 * Доменные типы Qalqan — общие для детектора, API, мока приложения и панели банка.
 */

export const LANGUAGES = ["ru", "kk"] as const;
export type Language = (typeof LANGUAGES)[number];

export const CHANNELS = ["sms", "call", "messenger", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Типы мошеннических схем социальной инженерии. */
export const SCAM_TYPES = [
  "fake_security_service", // «служба безопасности банка»: операция, утечка, нужно спасать деньги
  "safe_account", // перевод на «безопасный / резервный счёт»
  "code_request", // выманивание кода из SMS, CVV, PIN, пароля
  "phishing_link", // ссылка на поддельный сайт / «приложение банка»
  "official_impersonation", // «полиция», «КНБ», «Нацбанк», «АФМ», «суд»
  "relative_in_trouble", // «мама, я попал в беду, срочно скинь деньги»
  "investment", // гарантированный доход, крипта, «брокер»
  "prize_or_delivery", // выигрыш, посылка, «компенсация» за комиссию
  "marketplace", // «покупатель» с поддельной оплатой / ссылкой на доставку
] as const;
export type ScamType = (typeof SCAM_TYPES)[number];

export const SCAM_TYPE_LABELS: Record<ScamType, string> = {
  fake_security_service: "Ложная служба безопасности",
  safe_account: "«Безопасный счёт»",
  code_request: "Выманивание кода / CVV",
  phishing_link: "Фишинговая ссылка",
  official_impersonation: "Лжесотрудник госоргана",
  relative_in_trouble: "«Родственник в беде»",
  investment: "Инвестиционное мошенничество",
  prize_or_delivery: "Выигрыш / доставка",
  marketplace: "Мошенничество на маркетплейсе",
};

/** Результат анализа сообщения — контракт `/api/analyze`. */
export interface AnalysisResult {
  riskScore: number; // 0–100
  scamType: ScamType | null; // null — признаков схемы нет
  reasons: string[]; // понятные клиенту объяснения
  recommendation: string;
  mode: "rules" | "hybrid"; // hybrid — правила + LLM; rules — LLM не использовалась/недоступна
}

export const CASE_STATUSES = ["new", "reviewing", "confirmed_fraud", "false_positive"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Чем закончилась попытка перевода после вмешательства. */
export const CASE_OUTCOMES = [
  "cancelled_by_client", // клиент отменил перевод
  "held_for_trusted_contact", // ждёт подтверждения доверенного лица
  "proceeded", // клиент всё равно перевёл
  "no_transfer", // сообщение проверено, перевода не было
] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

/** Порог высокого риска: с него сообщение считается мошенническим, а перевод — требующим вмешательства. */
export const HIGH_RISK = 70;

export function riskLevel(score: number): "low" | "medium" | "high" {
  if (score >= HIGH_RISK) return "high";
  if (score >= 40) return "medium";
  return "low";
}
