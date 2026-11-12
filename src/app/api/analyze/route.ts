import { analyzeMessage } from "@/lib/detector";
import { AnalyzeRequestSchema, MAX_BODY_BYTES, createRateLimiter } from "@/lib/api/analyze-request";

/**
 * POST /api/analyze
 * Вход:  { "text": string (1–5000 символов), "lang"?: "ru" | "kk" }
 * Выход: { riskScore, scamType, reasons[], recommendation, mode }
 *
 * Текст запроса не сохраняется и не логируется.
 */
const allow = createRateLimiter(30, 60_000);

const error = (status: number, message: string, headers?: HeadersInit) =>
  Response.json({ error: message }, { status, headers });

/** Читает тело потоком и прекращает чтение, как только превышен лимит. */
async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allow(ip)) return error(429, "Слишком много запросов. Повторите через минуту.", { "Retry-After": "60" });

  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return error(415, "Ожидается Content-Type: application/json");

  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return error(413, "Запрос слишком большой");
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return error(413, "Запрос слишком большой");

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, "Некорректный JSON");
  }

  const parsed = AnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Некорректный запрос");

  const result = await analyzeMessage(parsed.data.text, { lang: parsed.data.lang });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
