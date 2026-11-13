import { connection } from "next/server";
import { db } from "@/lib/cases/repository";
import { describeDbError, storageKind } from "@/lib/db/diagnose";

/**
 * GET /api/health — состояние сервиса и базы для диагностики деплоя.
 * Не раскрывает адрес базы, токен и текст ошибок: только вид хранилища и код ошибки.
 */
export async function GET() {
  await connection();
  const storage = storageKind();
  try {
    const client = await db();
    const { rows } = await client.execute("SELECT COUNT(*) AS n FROM cases");
    return Response.json(
      { status: "ok", storage, cases: Number(rows[0]?.n ?? 0) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { status: "error", storage, db: describeDbError(err) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
