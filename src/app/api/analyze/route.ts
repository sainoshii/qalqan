import { analyzeMessage } from "@/lib/detector";
import { AnalyzeRequestSchema, createRateLimiter } from "@/lib/api/analyze-request";
import { clientIp, jsonError, readJson } from "@/lib/api/http";

/**
 * POST /api/analyze
 * Вход:  { "text": string (1–5000 символов), "lang"?: "ru" | "kk" }
 * Выход: { riskScore, scamType, reasons[], recommendation, mode }
 *
 * Текст запроса не сохраняется и не логируется.
 */
const allow = createRateLimiter(30, 60_000);
/** Общий потолок на весь экземпляр: адрес клиента можно сменить, а нагрузку — нет. */
const allowGlobal = createRateLimiter(600, 60_000);

export async function POST(request: Request) {
  if (!allow(clientIp(request)) || !allowGlobal("*")) return jsonError(429, "Слишком много запросов. Повторите через минуту.", { "Retry-After": "60" });

  const body = await readJson(request);
  if ("response" in body) return body.response;

  const parsed = AnalyzeRequestSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Некорректный запрос");

  const result = await analyzeMessage(parsed.data.text, { lang: parsed.data.lang });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
