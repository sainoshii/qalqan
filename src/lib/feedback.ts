import type { Client } from "@libsql/client";
import { CHANNELS, LANGUAGES, SCAM_TYPES, type Channel, type Language, type ScamType } from "./domain";
import { parseDataset, validateItem, type DatasetItem } from "./dataset";
import { excerpt, maskSensitive } from "./privacy";

/**
 * Обратная связь аналитиков → обучающие данные модели.
 *
 * Аналитик в панели отмечает случай как «подтверждённое мошенничество» или «ложное
 * срабатывание». Эти решения выгружаются в `data/dataset/feedback.jsonl` (формат набора,
 * data/README.md) и при следующем `npm run train` попадают в обучение:
 * ложные срабатывания учат модель не пугаться похожих обычных сообщений, подтверждённые
 * случаи — узнавать новые формулировки мошенников.
 *
 * Что НЕ попадает:
 * - синтетические случаи (они сгенерированы из уже размеченного набора);
 * - случаи без решения аналитика (new, reviewing);
 * - подтверждённые без типа схемы (тип нужен для обучения типов);
 * - тексты из отложенных наборов (иначе оценка качества стала бы нечестной);
 * - повторы одного и того же текста.
 * Текст в базе уже замаскирован; маскирование повторяется на всякий случай.
 */

export const FEEDBACK_FILE = "data/dataset/feedback.jsonl"; // одобренные — идут в обучение
export const FEEDBACK_CANDIDATES_FILE = "data/dataset/feedback.candidates.jsonl"; // до просмотра человеком
const MIN_TEXT = 15;
const MAX_ITEMS = 999; // формат id: <lang>-<label>-NNN

export interface FeedbackRow {
  id: string;
  created_at: string;
  channel: string;
  language: string;
  text_excerpt: string;
  scam_type: string | null;
  status: string;
}

export interface FeedbackSkip {
  caseId: string;
  reason: "no_scam_type" | "too_short" | "held_out" | "duplicate" | "invalid" | "limit";
}

export const normFeedbackText = (t: string) => t.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/**
 * Длина общего фрагмента, с которой текст считается цитатой отложенного набора.
 * 50 символов — около 7–9 слов. При 40 совпадала одна шаблонная фраза банковского уведомления
 * («…с нового устройства. если это были не вы…») между обучающим и отложенным наборами; при 50
 * совпадений между ними нет (проверено на всех наборах).
 */
export const HELD_OUT_SHINGLE = 50;

const shingleCache = new WeakMap<ReadonlySet<string>, Set<string>>();

function shinglesOf(heldOut: ReadonlySet<string>): Set<string> {
  let sh = shingleCache.get(heldOut);
  if (!sh) {
    sh = new Set();
    for (const h of heldOut) for (let i = 0; i + HELD_OUT_SHINGLE <= h.length; i++) sh.add(h.slice(i, i + HELD_OUT_SHINGLE));
    shingleCache.set(heldOut, sh);
  }
  return sh;
}

/**
 * Совпадает ли текст с отложенным набором. `heldOut` — нормализованные представления текстов
 * отложенных наборов (полный, замаскированный, фрагмент — см. `heldOutRepresentations`).
 * Отклоняется точное совпадение и любой общий фрагмент от HELD_OUT_SHINGLE символов в любом
 * месте текста: обрезанный «…» фрагмент из базы, частичная цитата, вставка в другой текст.
 * `heldOut` не должен меняться после первого вызова (фрагменты кэшируются).
 */
export function matchesHeldOut(text: string, heldOut: ReadonlySet<string>): boolean {
  const norm = normFeedbackText(text);
  if (heldOut.has(norm)) return true;
  const body = norm.endsWith("…") ? norm.slice(0, -1).trimEnd() : norm;
  if (body.length < HELD_OUT_SHINGLE) return false;
  const sh = shinglesOf(heldOut);
  for (let i = 0; i + HELD_OUT_SHINGLE <= body.length; i++) if (sh.has(body.slice(i, i + HELD_OUT_SHINGLE))) return true;
  return false;
}

/**
 * Проверка файла кандидатов перед одобрением: формат, повторное маскирование (файл мог быть
 * отредактирован вручную), утечка отложенных текстов (по исходному и замаскированному тексту),
 * повторы. Любая проблема — исключение: одобряется либо весь файл, либо ничего.
 */
export function approveCandidates(content: string, heldOut: ReadonlySet<string>): DatasetItem[] {
  const { items, errors } = parseDataset(content);
  if (errors.length) throw new Error(`Файл кандидатов некорректен:\n${errors.join("\n")}`);
  const out: DatasetItem[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const item of items) {
    const text = maskSensitive(item.text).replace(/\s+/g, " ").trim();
    if (matchesHeldOut(item.text, heldOut) || matchesHeldOut(text, heldOut)) {
      problems.push(`${item.id}: текст из отложенных наборов`);
      continue;
    }
    const norm = normFeedbackText(text);
    if (seen.has(norm)) {
      problems.push(`${item.id}: повтор текста`);
      continue;
    }
    const masked: DatasetItem = { ...item, text };
    const invalid = validateItem(masked);
    if (invalid.length) {
      problems.push(`${item.id}: ${invalid.join("; ")}`);
      continue;
    }
    seen.add(norm);
    out.push(masked);
  }
  if (problems.length) throw new Error(`Одобрение отклонено (среди кандидатов есть тексты отложенных наборов или ошибки):\n${problems.join("\n")}`);
  return out;
}

/** Все представления текста, в которых он может оказаться в базе: исходный, замаскированный, фрагмент. */
export function heldOutRepresentations(text: string): string[] {
  const masked = maskSensitive(text);
  return [...new Set([text, masked, excerpt(text)].map(normFeedbackText))];
}

export async function readFeedbackRows(db: Client): Promise<FeedbackRow[]> {
  const rs = await db.execute(
    "SELECT id, created_at, channel, language, text_excerpt, scam_type, status FROM cases " +
      "WHERE synthetic = 0 AND status IN ('confirmed_fraud','false_positive') ORDER BY created_at, id",
  );
  return rs.rows.map((r) => ({
    id: String(r.id),
    created_at: String(r.created_at),
    channel: String(r.channel),
    language: String(r.language),
    text_excerpt: String(r.text_excerpt),
    scam_type: r.scam_type === null ? null : String(r.scam_type),
    status: String(r.status),
  }));
}

/** Строки базы → записи набора. `heldOutTexts` — нормализованные тексты отложенных наборов. */
export function buildFeedbackDataset(
  rows: FeedbackRow[],
  heldOutTexts: ReadonlySet<string> = new Set(),
): { items: DatasetItem[]; skipped: FeedbackSkip[]; sources: string[] } {
  const items: DatasetItem[] = [];
  const sources: string[] = []; // sources[i] — id случая в базе для items[i]
  const skipped: FeedbackSkip[] = [];
  const seen = new Set<string>();
  const counters = new Map<string, number>();

  for (const row of rows) {
    const label = row.status === "confirmed_fraud" ? "scam" : row.status === "false_positive" ? "legit" : null;
    if (!label) continue;
    const text = maskSensitive(row.text_excerpt).replace(/\s+/g, " ").trim();
    const norm = normFeedbackText(text);
    const scamType = label === "scam" ? row.scam_type : null;

    if (label === "scam" && !SCAM_TYPES.includes(scamType as ScamType)) {
      skipped.push({ caseId: row.id, reason: "no_scam_type" });
      continue;
    }
    if (text.length < MIN_TEXT) {
      skipped.push({ caseId: row.id, reason: "too_short" });
      continue;
    }
    if (matchesHeldOut(text, heldOutTexts) || matchesHeldOut(row.text_excerpt, heldOutTexts)) {
      skipped.push({ caseId: row.id, reason: "held_out" });
      continue;
    }
    if (seen.has(norm)) {
      skipped.push({ caseId: row.id, reason: "duplicate" });
      continue;
    }
    const lang = LANGUAGES.includes(row.language as Language) ? (row.language as Language) : null;
    const channel = CHANNELS.includes(row.channel as Channel) ? (row.channel as Channel) : null;
    if (!lang || !channel) {
      skipped.push({ caseId: row.id, reason: "invalid" });
      continue;
    }
    const key = `${lang}-${label}`;
    const n = (counters.get(key) ?? 0) + 1;
    if (n > MAX_ITEMS) {
      skipped.push({ caseId: row.id, reason: "limit" });
      continue;
    }
    const item: DatasetItem = {
      id: `${key}-${String(n).padStart(3, "0")}`,
      lang,
      channel,
      label,
      scamType: scamType as ScamType | null,
      split: "dev",
      text,
    };
    if (validateItem(item).length) {
      skipped.push({ caseId: row.id, reason: "invalid" });
      continue;
    }
    counters.set(key, n);
    seen.add(norm);
    items.push(item);
    sources.push(row.id);
  }
  return { items, skipped, sources };
}

/** JSONL набора; `sources` — id случаев (для файла кандидатов: поле caseId, его игнорирует парсер набора). */
export function toJsonl(items: DatasetItem[], sources?: string[]): string {
  const lines = items.map((i, k) => {
    const { id, lang, channel, label, scamType, split, hardNegative, text } = i;
    const clean = { id, lang, channel, label, scamType, split, ...(hardNegative ? { hardNegative } : {}), text };
    return JSON.stringify(sources ? { ...clean, caseId: sources[k] } : clean);
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}
