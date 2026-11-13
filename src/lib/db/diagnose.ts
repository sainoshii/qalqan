import { resolveDatabaseUrl } from "./client";

export type StorageKind = "turso" | "tmp" | "file" | "other";

/** Вид хранилища по адресу — без самого адреса (в нём может быть имя базы). */
export function storageKind(url = resolveDatabaseUrl()): StorageKind {
  if (/^(libsql|https?|wss?):\/\//i.test(url)) return "turso";
  if (url.startsWith("file:/tmp/")) return "tmp";
  if (url.startsWith("file:")) return "file";
  return "other";
}

export interface DbProblem {
  code: string; // код libSQL, например SERVER_ERROR, URL_INVALID
  step?: string; // шаг миграции, на котором произошла ошибка
  httpStatus?: number;
  hint: string;
}

/**
 * Безопасное описание ошибки базы: только машинный код и HTTP-статус.
 * Сообщение ошибки наружу не отдаётся — в нём могут быть адрес или фрагменты запроса.
 */
export function describeDbError(err: unknown): DbProblem {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "UNKNOWN";
  const message = err instanceof Error ? err.message : "";
  const status = Number(message.match(/HTTP status (\d{3})/i)?.[1]) || undefined;

  let hint = "Проверьте DATABASE_URL и DATABASE_AUTH_TOKEN в настройках Vercel и сделайте Redeploy.";
  if (code === "URL_INVALID" || code === "URL_SCHEME_NOT_SUPPORTED") {
    hint = "DATABASE_URL в неверном формате: нужен адрес вида libsql://<база>.turso.io без кавычек и пробелов.";
  } else if (status === 401 || status === 403) {
    hint = "Turso отклонил токен: создайте новый токен базы (Read & Write), замените DATABASE_AUTH_TOKEN и сделайте Redeploy.";
  } else if (status === 404) {
    hint = "База по этому адресу не найдена: проверьте имя базы в DATABASE_URL.";
  } else if (code === "SERVER_ERROR" || /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    hint = "Нет связи с Turso: проверьте адрес базы (ошибка в имени хоста) и что база существует.";
  }
  const step = typeof (err as { step?: unknown })?.step === "string" ? (err as { step: string }).step : undefined;
  if (code === "SQL_PARSE_ERROR") {
    hint = "Сервер базы не принял SQL-запрос: это ошибка в коде миграции, а не в настройках. Сообщите разработчику шаг (step).";
  }
  return { code, step, httpStatus: status, hint };
}
