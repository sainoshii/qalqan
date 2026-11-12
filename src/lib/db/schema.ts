import type { Client } from "@libsql/client";
import { CASE_OUTCOMES, CASE_STATUSES, CHANNELS, LANGUAGES, SCAM_TYPES } from "../domain";

/**
 * Схема базы. Намеренно нет полей для номеров карт, CVV, кодов и телефонов:
 * хранятся только замаскированный фрагмент текста и результат анализа.
 *
 * Перечисления в CHECK строятся из `src/lib/domain.ts`, чтобы база и типы не расходились.
 * Версия схемы хранится в `PRAGMA user_version`; `migrate` доводит любую базу до текущей.
 */
export const SCHEMA_VERSION = 2;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

const CASES_COLUMNS = `
    id               TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL,                 -- ISO 8601, UTC
    client_alias     TEXT NOT NULL,                 -- псевдоним клиента, не ФИО
    channel          TEXT NOT NULL CHECK (channel IN (${list(CHANNELS)})),
    language         TEXT NOT NULL CHECK (language IN (${list(LANGUAGES)})),
    text_excerpt     TEXT NOT NULL,                 -- замаскированный фрагмент (maskSensitive)
    risk_score       INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    scam_type        TEXT CHECK (scam_type IS NULL OR scam_type IN (${list(SCAM_TYPES)})),
    reasons          TEXT NOT NULL DEFAULT '[]',    -- JSON-массив строк
    recommendation   TEXT NOT NULL DEFAULT '',
    analysis_mode    TEXT NOT NULL CHECK (analysis_mode IN ('rules','hybrid')),
    transfer_amount  INTEGER,                       -- тенге; NULL, если перевода не было
    new_recipient    INTEGER NOT NULL DEFAULT 0 CHECK (new_recipient IN (0,1)),
    outcome          TEXT NOT NULL CHECK (outcome IN (${list(CASE_OUTCOMES)})),
    status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(CASE_STATUSES)})),
    synthetic        INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1))`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_scam_type ON cases (scam_type)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status)`,
];

export const SCHEMA: string[] = [`CREATE TABLE IF NOT EXISTS cases (${CASES_COLUMNS}\n  )`, ...INDEXES];

async function tableExists(db: Client, name: string): Promise<boolean> {
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return rows.length > 0;
}

export async function migrate(db: Client): Promise<void> {
  const { rows } = await db.execute("PRAGMA user_version");
  const version = Number(rows[0]?.user_version ?? 0);
  if (version >= SCHEMA_VERSION && (await tableExists(db, "cases"))) return;

  if (await tableExists(db, "cases")) {
    // v1 → v2: пересоздать таблицу с CHECK на scam_type. Строки с неизвестным типом
    // схемы сохраняются с scam_type = NULL, а не теряются.
    const known = list(SCAM_TYPES);
    await db.batch(
      [
        `CREATE TABLE cases_v2 (${CASES_COLUMNS}\n  )`,
        `INSERT INTO cases_v2 SELECT id, created_at, client_alias, channel, language, text_excerpt, risk_score,
           CASE WHEN scam_type IN (${known}) THEN scam_type ELSE NULL END,
           reasons, recommendation, analysis_mode, transfer_amount, new_recipient, outcome, status, synthetic
         FROM cases`,
        `DROP TABLE cases`,
        `ALTER TABLE cases_v2 RENAME TO cases`,
        ...INDEXES,
        `PRAGMA user_version = ${SCHEMA_VERSION}`,
      ],
      "write",
    );
    return;
  }

  await db.batch([...SCHEMA, `PRAGMA user_version = ${SCHEMA_VERSION}`], "write");
}
