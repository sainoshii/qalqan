import { createClient, type Client } from "@libsql/client";

/**
 * Клиент базы данных. Локально — файл SQLite (`file:data/qalqan.db`),
 * в облаке — Turso (libSQL) по `DATABASE_URL` и `DATABASE_AUTH_TOKEN`.
 * Код один и тот же, отличается только адрес.
 */
export const DEFAULT_DATABASE_URL = "file:data/qalqan.db";

let client: Client | undefined;

export function getDb(): Client {
  client ??= createClient({
    url: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });
  return client;
}

/** Для тестов и скриптов: клиент на произвольный адрес (например, `:memory:`). */
export function createDb(url: string, authToken?: string): Client {
  return createClient({ url, authToken });
}
