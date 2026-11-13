import type { Client } from "@libsql/client";
import { CASE_OUTCOMES, CASE_STATUSES, CHANNELS, LANGUAGES, SCAM_TYPES } from "../domain";

/**
 * Схема базы. Намеренно нет полей для номеров карт, CVV, кодов и телефонов:
 * хранятся только замаскированный фрагмент текста и результат анализа.
 *
 * Перечисления в CHECK строятся из `src/lib/domain.ts`, чтобы база и типы не расходились.
 * Версия схемы хранится в служебной таблице `schema_meta` (а не в PRAGMA user_version:
 * Turso не принимает часть PRAGMA). SQL без комментариев — парсер Turso строже SQLite.
 * `migrate` доводит любую базу до текущей версии.
 *
 * Колонки: created_at — ISO 8601 UTC; client_alias — псевдоним, не ФИО; text_excerpt —
 * замаскированный фрагмент (maskSensitive); reasons — JSON-массив строк; transfer_amount —
 * тенге или NULL, если перевода не было.
 */
export const SCHEMA_VERSION = 2;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

const CASES_COLUMNS = [
  "id TEXT PRIMARY KEY",
  "created_at TEXT NOT NULL",
  "client_alias TEXT NOT NULL",
  `channel TEXT NOT NULL CHECK (channel IN (${list(CHANNELS)}))`,
  `language TEXT NOT NULL CHECK (language IN (${list(LANGUAGES)}))`,
  "text_excerpt TEXT NOT NULL",
  "risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100)",
  `scam_type TEXT CHECK (scam_type IS NULL OR scam_type IN (${list(SCAM_TYPES)}))`,
  "reasons TEXT NOT NULL DEFAULT '[]'",
  "recommendation TEXT NOT NULL DEFAULT ''",
  "analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('rules','hybrid'))",
  "transfer_amount INTEGER",
  "new_recipient INTEGER NOT NULL DEFAULT 0 CHECK (new_recipient IN (0,1))",
  `outcome TEXT NOT NULL CHECK (outcome IN (${list(CASE_OUTCOMES)}))`,
  `status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(CASE_STATUSES)}))`,
  "synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1))",
].join(", ");

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_scam_type ON cases (scam_type)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status)`,
];

const META = "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)";
const SET_VERSION = {
  sql: "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
  args: [SCHEMA_VERSION],
};

export const SCHEMA: string[] = [`CREATE TABLE IF NOT EXISTS cases (${CASES_COLUMNS})`, ...INDEXES];

/** Ошибка миграции с названием шага — для диагностики без раскрытия деталей. */
export class MigrationError extends Error {
  constructor(
    readonly step: "read_version" | "create" | "upgrade_v1",
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(`Миграция базы: шаг ${step}, код ${code}`, options);
    this.name = "MigrationError";
  }
}

const codeOf = (err: unknown) =>
  typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "UNKNOWN";

async function step<T>(name: MigrationError["step"], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new MigrationError(name, codeOf(err), { cause: err });
  }
}

async function tableExists(db: Client, name: string): Promise<boolean> {
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return rows.length > 0;
}

/** Версия схемы: schema_meta; для старых локальных баз — PRAGMA user_version; иначе 0/1. */
async function readVersion(db: Client, hasCases: boolean): Promise<number> {
  if (await tableExists(db, "schema_meta")) {
    const { rows } = await db.execute("SELECT value FROM schema_meta WHERE key = 'version'");
    return Number(rows[0]?.value ?? 0);
  }
  if (!hasCases) return 0;
  try {
    const { rows } = await db.execute("PRAGMA user_version");
    return Number(rows[0]?.user_version ?? 1) || 1;
  } catch {
    return 1; // таблица есть, версия неизвестна — считаем v1 и безопасно пересоздаём
  }
}

export async function migrate(db: Client): Promise<void> {
  const hasCases = await step("read_version", () => tableExists(db, "cases"));
  const version = await step("read_version", () => readVersion(db, hasCases));

  if (hasCases && version >= SCHEMA_VERSION) {
    // Старая локальная база с версией в PRAGMA — однократно переносим версию в schema_meta
    if (!(await step("read_version", () => tableExists(db, "schema_meta")))) {
      await step("create", () => db.batch([META, SET_VERSION], "write"));
    }
    return;
  }

  if (hasCases) {
    // v1 → v2: пересоздать таблицу с CHECK на scam_type. Строки с неизвестным типом
    // схемы сохраняются с scam_type = NULL, а не теряются.
    const known = list(SCAM_TYPES);
    await step("upgrade_v1", () =>
      db.batch(
        [
          `CREATE TABLE cases_v2 (${CASES_COLUMNS})`,
          `INSERT INTO cases_v2 SELECT id, created_at, client_alias, channel, language, text_excerpt, risk_score, CASE WHEN scam_type IN (${known}) THEN scam_type ELSE NULL END, reasons, recommendation, analysis_mode, transfer_amount, new_recipient, outcome, status, synthetic FROM cases`,
          "DROP TABLE cases",
          "ALTER TABLE cases_v2 RENAME TO cases",
          ...INDEXES,
          META,
          SET_VERSION,
        ],
        "write",
      ),
    );
    return;
  }

  await step("create", () => db.batch([...SCHEMA, META, SET_VERSION], "write"));
}
