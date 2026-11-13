import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { parseDataset } from "@/lib/dataset";
import { generateCases } from "../scripts/db-seed";

const dataset = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8")).items;
let db: Client | undefined;

afterEach(() => db?.close());

async function freshDb() {
  db = createDb(":memory:");
  await migrate(db);
  return db;
}

describe("схема и seed", () => {
  it("миграция идемпотентна", async () => {
    const d = await freshDb();
    await migrate(d);
    const { rows } = await d.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(rows.map((r) => r.name)).toContain("cases");
  });

  it("seed детерминирован", () => {
    expect(generateCases(dataset, 20)).toEqual(generateCases(dataset, 20));
  });

  it("все сгенерированные случаи проходят ограничения схемы", async () => {
    const d = await freshDb();
    const cases = generateCases(dataset);
    const cols = Object.keys(cases[0]);
    await d.batch(
      cases.map((c) => ({
        sql: `INSERT INTO cases (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        args: Object.values(c),
      })),
      "write",
    );
    const { rows } = await d.execute("SELECT COUNT(*) AS n, COUNT(DISTINCT scam_type) AS types FROM cases");
    expect(rows[0].n).toBe(cases.length);
    expect(Number(rows[0].types)).toBeGreaterThanOrEqual(6);
  });

  it("в базу не попадают длинные последовательности цифр (карты, ИИН, телефоны)", () => {
    for (const c of generateCases(dataset)) {
      expect(c.text_excerpt).not.toMatch(/\d{6,}/);
    }
  });

  it("миграция v1 → v2 добавляет CHECK на scam_type и сохраняет строки", async () => {
    db = createDb(":memory:");
    // База версии 1: таблица без ограничения на scam_type
    await db.execute(`CREATE TABLE cases (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, client_alias TEXT NOT NULL, channel TEXT NOT NULL,
      language TEXT NOT NULL, text_excerpt TEXT NOT NULL, risk_score INTEGER NOT NULL, scam_type TEXT,
      reasons TEXT NOT NULL DEFAULT '[]', recommendation TEXT NOT NULL DEFAULT '', analysis_mode TEXT NOT NULL,
      transfer_amount INTEGER, new_recipient INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', synthetic INTEGER NOT NULL DEFAULT 0)`);
    await db.execute(`INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt, risk_score, scam_type, analysis_mode, outcome)
      VALUES ('ok', '2026-01-01', 'a', 'sms', 'ru', 't', 80, 'safe_account', 'rules', 'no_transfer'),
             ('bad', '2026-01-01', 'a', 'sms', 'ru', 't', 80, 'unknown', 'rules', 'no_transfer')`);

    await migrate(db);

    const { rows } = await db.execute("SELECT id, scam_type FROM cases ORDER BY id");
    expect(rows.map((r) => [r.id, r.scam_type])).toEqual([
      ["bad", null],
      ["ok", "safe_account"],
    ]);
    await expect(db.execute("UPDATE cases SET scam_type = 'unknown' WHERE id = 'ok'")).rejects.toThrow();
    expect((await db.execute("SELECT value FROM schema_meta WHERE key = 'version'")).rows[0].value).toBe(2);
  });

  it("схема отвергает некорректный риск-скор", async () => {
    const d = await freshDb();
    await expect(
      d.execute(
        `INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
         VALUES ('x', '2026-01-01', 'a', 'sms', 'ru', 't', 150, 'rules', 'no_transfer')`,
      ),
    ).rejects.toThrow();
  });
});
