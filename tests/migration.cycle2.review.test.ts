import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { SCAM_TYPES } from "@/lib/domain";

let db: Client;
afterEach(() => db?.close());

// Explicit legacy fixture: no scam_type constraint and all original columns.
const legacySchema = `CREATE TABLE cases (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, client_alias TEXT NOT NULL,
  channel TEXT NOT NULL, language TEXT NOT NULL, text_excerpt TEXT NOT NULL,
  risk_score INTEGER NOT NULL, scam_type TEXT, reasons TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT NOT NULL DEFAULT '', analysis_mode TEXT NOT NULL,
  transfer_amount INTEGER, new_recipient INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', synthetic INTEGER NOT NULL DEFAULT 0
)`;

async function assertIndexesAndVersion() {
  expect((await db.execute("PRAGMA user_version")).rows[0].user_version).toBe(2);
  const indexes = (await db.execute("PRAGMA index_list(cases)")).rows.map((row) => row.name);
  expect(indexes).toEqual(expect.arrayContaining([
    "idx_cases_created_at", "idx_cases_scam_type", "idx_cases_status",
  ]));
  expect((await db.execute("SELECT name FROM sqlite_master WHERE name = 'cases_v2'")).rows).toEqual([]);
}

describe("cycle 2: migration lifecycle", () => {
  it("initializes an empty database and supports repeated migration", async () => {
    db = createDb(":memory:");
    await migrate(db);
    await migrate(db);
    await assertIndexesAndVersion();
    expect((await db.execute("SELECT * FROM cases")).rows).toEqual([]);
  });

  it.each([0, 1])("preserves every column when migrating legacy version %i twice", async (version) => {
    db = createDb(":memory:");
    await db.execute(legacySchema);
    await db.execute(`PRAGMA user_version = ${version}`);
    for (const [i, type] of [...SCAM_TYPES, null, "legacy_unknown"].entries()) {
      await db.execute({
        sql: `INSERT INTO cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [`fixture-${i}`, "2026-11-12T12:00:00Z", "Synthetic", "sms", "kk", "[КОД]",
          80, type, '["reason"]', "recommendation", "hybrid", 25000, 1,
          "cancelled_by_client", "reviewing", i % 2],
      });
    }
    const before = (await db.execute("SELECT * FROM cases ORDER BY id")).rows;
    const expected = before.map((row) => ({
      ...row, scam_type: row.scam_type === "legacy_unknown" ? null : row.scam_type,
    }));
    await migrate(db);
    expect((await db.execute("SELECT * FROM cases ORDER BY id")).rows).toEqual(expected);
    await migrate(db);
    expect((await db.execute("SELECT * FROM cases ORDER BY id")).rows).toEqual(expected);
    await assertIndexesAndVersion();
    await expect(db.execute("UPDATE cases SET scam_type = 'unknown'")).rejects.toThrow();
  });

  it("rolls back the entire migration on a rejected legacy row", async () => {
    db = createDb(":memory:");
    await db.execute(legacySchema);
    await db.execute("PRAGMA user_version = 1");
    await db.execute(`INSERT INTO cases
      (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
      VALUES ('fixture', '2026-11-12', 'Synthetic', 'sms', 'ru', '[КОД]', 101, 'rules', 'no_transfer')`);
    await expect(migrate(db)).rejects.toThrow();
    expect((await db.execute("PRAGMA user_version")).rows[0].user_version).toBe(1);
    expect((await db.execute("SELECT risk_score FROM cases")).rows[0].risk_score).toBe(101);
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name = 'cases_v2'")).rows).toEqual([]);
    await db.execute("UPDATE cases SET risk_score = 80");
    await migrate(db);
    await assertIndexesAndVersion();
  });
});
