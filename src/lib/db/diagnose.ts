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
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STEPS = new Set(["read_version", "create", "upgrade_v1"]);

const pickCode = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && SAFE_CODE.test(c) ? c : undefined;
};

/** Цепочка ошибки: сама ошибка и её причины (cause), не глубже 5 уровней. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) out.push(e);
  return out;
}

/**
 * Безопасное описание ошибки базы: только машинный код (вида SERVER_ERROR), шаг миграции из
 * фиксированного списка и HTTP-статус. Текст ошибки и любые произвольные строки наружу не идут —
 * в них могут быть адрес базы или токен.
 */
export function describeDbError(err: unknown): DbProblem {
  const errors = chain(err);
  // Код и статус берём из самой глубокой причины, где они есть (MigrationError оборачивает ошибку SDK)
  const code = errors.map(pickCode).filter(Boolean).at(-1) ?? "UNKNOWN";
  const messages = errors.map((e) => (e instanceof Error ? e.message : ""));
  // Как и код — статус из самой глубокой причины, где он есть
  const status =
    messages
      .map((m) => Number(m.match(/HTTP status (\d{3})/i)?.[1]) || undefined)
      .filter((v): v is number => v !== undefined)
      .at(-1) ?? undefined;
  const rawStep = (err as { step?: unknown } | null)?.step;
  const step = typeof rawStep === "string" && STEPS.has(rawStep) ? rawStep : undefined;

  let hint = "Проверьте DATABASE_URL и DATABASE_AUTH_TOKEN в настройках Vercel и сделайте Redeploy.";
  if (code === "URL_INVALID" || code === "URL_SCHEME_NOT_SUPPORTED") {
    hint = "DATABASE_URL в неверном формате: нужен адрес вида libsql://<база>.turso.io без кавычек и пробелов.";
  } else if (status === 401 || status === 403) {
    hint = "Turso отклонил токен: создайте новый токен базы (Read & Write), замените DATABASE_AUTH_TOKEN и сделайте Redeploy.";
  } else if (status === 404) {
    hint = "База по этому адресу не найдена: проверьте имя базы в DATABASE_URL.";
  } else if (code === "SQL_PARSE_ERROR") {
    hint = "Сервер базы не принял SQL-запрос: это ошибка в коде миграции, а не в настройках. Сообщите разработчику шаг (step).";
  } else if (code === "SERVER_ERROR" || messages.some((m) => /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(m))) {
    hint = "Нет связи с Turso: проверьте адрес базы (ошибка в имени хоста) и что база существует.";
  }
  return { code, step, httpStatus: status, hint };
}
