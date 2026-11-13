import type { CaseOutcome, CaseStatus, Channel, Language } from "@/lib/domain";

export const STATUS_LABELS: Record<CaseStatus, string> = {
  new: "Новый",
  reviewing: "На проверке",
  confirmed_fraud: "Мошенничество подтверждено",
  false_positive: "Ложное срабатывание",
};

export const OUTCOME_LABELS: Record<CaseOutcome, string> = {
  cancelled_by_client: "Клиент отменил перевод",
  held_for_trusted_contact: "Ждёт доверенное лицо",
  proceeded: "Клиент всё равно перевёл",
  no_transfer: "Перевода не было",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  sms: "SMS",
  call: "Звонок",
  messenger: "Мессенджер",
  email: "Email",
};

export const LANGUAGE_LABELS: Record<Language, string> = { ru: "Русский", kk: "Казахский" };

export const tenge = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₸`;

/** Дата и время в часовом поясе Алматы (UTC+5). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" });
}
