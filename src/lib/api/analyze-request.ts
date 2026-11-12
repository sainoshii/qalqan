import { z } from "zod";
import { LANGUAGES } from "../domain";

/** Ограничения входа `/api/analyze`. */
export const MAX_TEXT_LENGTH = 5000; // символов; SMS, сообщение или расшифровка звонка
export const MAX_BODY_BYTES = 32 * 1024;

export const AnalyzeRequestSchema = z.object({
  text: z
    .string({ error: "Поле text обязательно и должно быть строкой" })
    .trim()
    .min(1, "Текст пуст")
    .max(MAX_TEXT_LENGTH, `Текст длиннее ${MAX_TEXT_LENGTH} символов`),
  lang: z.enum(LANGUAGES, { error: "lang: допустимы ru или kk" }).optional(),
});

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

/**
 * Ограничение частоты: скользящее окно в памяти процесса.
 * Для демо достаточно; в проде нужен общий счётчик (Redis и т. п.), потому что
 * у serverless-функций память не общая.
 */
export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.delete(key); // переставить ключ в конец — порядок вставки = давность
    hits.set(key, recent);
    if (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
    return true;
  };
}
