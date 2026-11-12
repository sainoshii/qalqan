import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { CASE_OUTCOMES, CASE_STATUSES, CHANNELS, LANGUAGES, SCAM_TYPES } from "@/lib/domain";

let db: Client | undefined;
afterEach(() => db?.close());

async function fixture() {
  db = createDb(":memory:");
  await migrate(db);
  await db.execute(`INSERT INTO cases
    (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
    VALUES ('review-case', '2026-11-12T00:00:00Z', 'Synthetic', 'sms', 'ru', 'Masked', 50, 'rules', 'no_transfer')`);
  return db;
}

describe("review: schema and domain enums agree", () => {
  it.each([
    ["channel", CHANNELS],
    ["language", LANGUAGES],
    ["outcome", CASE_OUTCOMES],
    ["status", CASE_STATUSES],
    ["scam_type", [...SCAM_TYPES, null]],
    ["analysis_mode", ["rules", "hybrid"]],
  ] as const)("accepts domain values and rejects an unknown %s", async (column, values) => {
    const d = await fixture();
    for (const value of values) {
      await d.execute({ sql: `UPDATE cases SET ${column} = ?`, args: [value] });
      expect((await d.execute(`SELECT ${column} FROM cases`)).rows[0][column]).toBe(value);
    }
    await expect(d.execute({ sql: `UPDATE cases SET ${column} = ?`, args: ["unknown_review_value"] })).rejects.toThrow();
  });
});
