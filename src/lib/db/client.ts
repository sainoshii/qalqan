import { createClient, type Client } from "@libsql/client";

/**
 * Клиент базы данных. Локально — файл SQLite (`file:data/qalqan.db`),
 * в облаке — Turso (libSQL) по `DATABASE_URL` и `DATABASE_AUTH_TOKEN`.
 * Код один и тот же, отличается только адрес.
 */
export const DEFAULT_DATABASE_URL = "file:data/qalqan.db";

/**
 * На Vercel файловая система проекта только для чтения; без DATABASE_URL база живёт во
 * временной папке экземпляра функции (/tmp). Это режим демо: данные заполняются
 * синтетикой при первом обращении и могут сбрасываться при перезапуске экземпляра.
 * Для постоянного хранения задайте DATABASE_URL (Turso).
 */
export const SERVERLESS_DATABASE_URL = "file:/tmp/qalqan.db";

export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  return env.VERCEL ? SERVERLESS_DATABASE_URL : DEFAULT_DATABASE_URL;
}

let client: Client | undefined;

export function getDb(): Client {
  client ??= createClient({
    url: resolveDatabaseUrl(),
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });
  return client;
}

/** Для тестов и скриптов: клиент на произвольный адрес (например, `:memory:`). */
export function createDb(url: string, authToken?: string): Client {
  return createClient({ url, authToken });
}
