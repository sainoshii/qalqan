import { CHANNELS, LANGUAGES, SCAM_TYPES, type Channel, type Language, type ScamType } from "./domain";

/** Запись размеченного тестового набора (data/dataset/messages.jsonl). */
export interface DatasetItem {
  id: string;
  lang: Language;
  channel: Channel;
  label: "scam" | "legit";
  scamType: ScamType | null; // обязателен для scam, null для legit
  split: "dev" | "holdout"; // holdout не используется при настройке правил
  hardNegative?: boolean; // legit-сообщение, похожее на мошенническое (ловушка для ложных срабатываний)
  text: string;
}

/** Проверка одной записи; возвращает список ошибок (пустой — запись корректна). */
export function validateItem(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return ["запись не объект"];
  const item = raw as Record<string, unknown>;

  if (typeof item.id !== "string" || !/^(ru|kk)-(scam|legit)-\d{3}$/.test(item.id)) {
    errors.push(`id «${String(item.id)}» не по формату <lang>-<label>-NNN`);
  }
  if (!LANGUAGES.includes(item.lang as Language)) errors.push(`lang: ${String(item.lang)}`);
  if (!CHANNELS.includes(item.channel as Channel)) errors.push(`channel: ${String(item.channel)}`);
  if (item.label !== "scam" && item.label !== "legit") errors.push(`label: ${String(item.label)}`);
  if (item.split !== "dev" && item.split !== "holdout") errors.push(`split: ${String(item.split)}`);
  if (typeof item.text !== "string" || item.text.trim().length < 15) errors.push("text короче 15 символов");

  if (item.label === "scam" && !SCAM_TYPES.includes(item.scamType as ScamType)) {
    errors.push(`scam без корректного scamType: ${String(item.scamType)}`);
  }
  if (item.label === "legit" && item.scamType !== null) errors.push("legit должен иметь scamType: null");
  if (item.hardNegative !== undefined && (item.label !== "legit" || item.hardNegative !== true)) {
    errors.push("hardNegative допустим только как true у legit");
  }
  if (typeof item.id === "string" && typeof item.lang === "string" && !item.id.startsWith(`${item.lang}-`)) {
    errors.push("id не совпадает с lang");
  }
  if (typeof item.id === "string" && typeof item.label === "string" && !item.id.includes(`-${item.label}-`)) {
    errors.push("id не совпадает с label");
  }
  return errors;
}

export function parseDataset(jsonl: string): { items: DatasetItem[]; errors: string[] } {
  const items: DatasetItem[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  jsonl.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`строка ${index + 1}: некорректный JSON`);
      return;
    }
    const itemErrors = validateItem(raw);
    if (itemErrors.length) {
      errors.push(...itemErrors.map((e) => `строка ${index + 1}: ${e}`));
      return;
    }
    const item = raw as DatasetItem;
    if (seen.has(item.id)) errors.push(`строка ${index + 1}: повтор id ${item.id}`);
    seen.add(item.id);
    items.push(item);
  });

  return { items, errors };
}

export function summarize(items: DatasetItem[]) {
  const count = (pred: (i: DatasetItem) => boolean) => items.filter(pred).length;
  return {
    total: items.length,
    scam: count((i) => i.label === "scam"),
    legit: count((i) => i.label === "legit"),
    hardNegative: count((i) => i.hardNegative === true),
    byLang: Object.fromEntries(LANGUAGES.map((l) => [l, count((i) => i.lang === l)])),
    bySplit: { dev: count((i) => i.split === "dev"), holdout: count((i) => i.split === "holdout") },
    byScamType: Object.fromEntries(SCAM_TYPES.map((t) => [t, count((i) => i.scamType === t)])),
  };
}
