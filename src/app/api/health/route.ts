import { connection } from "next/server";
import { db } from "@/lib/cases/repository";
import { describeDbError, storageKind } from "@/lib/db/diagnose";
import { DEFAULT_MODEL, llmConfigured } from "@/lib/detector/llm";
import { describeLlmZone, llmBreaker, llmZoneFromEnv } from "@/lib/detector/llm-gate";

/** Состояние LLM без ключа: подключена ли, модель, «серая зона», пауза после сбоев. */
function llmStatus() {
  const configured = llmConfigured();
  return {
    configured,
    model: configured ? process.env.QALQAN_LLM_MODEL || DEFAULT_MODEL : null,
    zone: describeLlmZone(llmZoneFromEnv()),
    paused: configured && llmBreaker.open(),
  };
}

/**
 * GET /api/health — состояние сервиса и базы для диагностики деплоя.
 * Не раскрывает адрес базы, токены, ключ LLM и текст ошибок: только вид хранилища и код ошибки.
 */
export async function GET() {
  await connection();
  const storage = storageKind();
  try {
    const client = await db();
    const { rows } = await client.execute("SELECT COUNT(*) AS n FROM cases");
    return Response.json(
      { status: "ok", storage, cases: Number(rows[0]?.n ?? 0), llm: llmStatus() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { status: "error", storage, db: describeDbError(err), llm: llmStatus() },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
