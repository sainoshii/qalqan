import { analyzeMessage, detectLanguage } from "@/lib/detector";
import { createRateLimiter } from "@/lib/api/analyze-request";
import { clientIp, jsonError, readJson } from "@/lib/api/http";
import { db, insertCase } from "@/lib/cases/repository";
import { assessTransfer, WARN_RISK } from "@/lib/transfer/risk";
import { CaseRequestSchema } from "@/lib/transfer/request";

/**
 * POST /api/cases — зафиксировать исход попытки перевода для панели антифрода.
 * Вход: { amount, newRecipient, messageText?, channel?, outcome }
 *
 * Риск пересчитывается на сервере: клиент не может прислать «нужный» скор.
 * Сохраняются только случаи с подозрением (риск >= 40) и только замаскированный фрагмент.
 */
const allow = createRateLimiter(20, 60_000);

export async function POST(request: Request) {
  if (!allow(clientIp(request))) return jsonError(429, "Слишком много запросов. Повторите через минуту.", { "Retry-After": "60" });

  const body = await readJson(request);
  if ("response" in body) return body.response;

  const parsed = CaseRequestSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Некорректный запрос");

  const { amount, newRecipient, messageText, channel, outcome } = parsed.data;
  if (!messageText) return Response.json({ stored: false, reason: "нет подозрительного сообщения" });

  const analysis = await analyzeMessage(messageText);
  const assessment = assessTransfer({ amount, newRecipient, message: analysis });
  if (assessment.riskScore < WARN_RISK) return Response.json({ stored: false, reason: "риск ниже порога" });

  try {
    const id = await insertCase(await db(), {
      messageText,
      language: detectLanguage(messageText),
      channel: channel ?? "messenger",
      analysis,
      riskScore: assessment.riskScore,
      reasons: assessment.reasons,
      amount,
      newRecipient,
      outcome,
    });
    return Response.json({ stored: true, id }, { status: 201 });
  } catch {
    // База может быть недоступна или только для чтения (демо-деплой) — перевод это не ломает
    return Response.json({ stored: false, reason: "хранилище недоступно" }, { status: 503 });
  }
}
