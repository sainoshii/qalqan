import { analyzeMessage } from "@/lib/detector";
import { createRateLimiter } from "@/lib/api/analyze-request";
import { clientIp, jsonError, readJson } from "@/lib/api/http";
import { assessTransfer } from "@/lib/transfer/risk";
import { AssessRequestSchema } from "@/lib/transfer/request";

/**
 * POST /api/transfer/assess — оценка перевода перед подтверждением.
 * Вход:  { amount, newRecipient, messageText? }
 * Выход: { decision: "allow" | "warn" | "intervene", riskScore, reasons[], message }
 * Ничего не сохраняет. Реквизиты получателя не принимаются.
 */
const allow = createRateLimiter(30, 60_000);

export async function POST(request: Request) {
  if (!allow(clientIp(request))) return jsonError(429, "Слишком много запросов. Повторите через минуту.", { "Retry-After": "60" });

  const body = await readJson(request);
  if ("response" in body) return body.response;

  const parsed = AssessRequestSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Некорректный запрос");

  const { amount, newRecipient, messageText } = parsed.data;
  const message = messageText ? await analyzeMessage(messageText) : null;
  const assessment = assessTransfer({ amount, newRecipient, message });
  return Response.json({ ...assessment, message }, { headers: { "Cache-Control": "no-store" } });
}
