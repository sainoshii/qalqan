import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, LibsqlError, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate, MigrationError, SCHEMA } from "@/lib/db/schema";
import { getStats, listCases } from "@/lib/dashboard/queries";

const clients: Client[] = [];
const directories: string[] = [];
const sqlOf = (stmt: Parameters<Client["batch"]>[0][number]) =>
  typeof stmt === "string" ? stmt : Array.isArray(stmt) ? stmt[0] : stmt.sql;
const legacySchema = `CREATE TABLE cases (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, client_alias TEXT NOT NULL,
  channel TEXT NOT NULL, language TEXT NOT NULL, text_excerpt TEXT NOT NULL,
  risk_score INTEGER NOT NULL, scam_type TEXT, reasons TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT NOT NULL DEFAULT '', analysis_mode TEXT NOT NULL,
  transfer_amount INTEGER, new_recipient INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', synthetic INTEGER NOT NULL DEFAULT 0
)`;
const fixture = `INSERT INTO cases
  (id, created_at, client_alias, channel, language, text_excerpt, risk_score,
   scam_type, analysis_mode, transfer_amount, outcome, status)
  VALUES ('review-fixture', '2026-11-12T20:30:00Z', 'Synthetic', 'sms', 'kk',
    '[КОД]', 90, 'safe_account', 'rules', 25000, 'cancelled_by_client', 'reviewing')`;

function memory() {
  const db = createDb(":memory:");
  clients.push(db);
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("@/lib/cases/repository");
  vi.doUnmock("next/server");
  vi.resetModules();
  for (const db of clients.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("deploy fixes cycle 1: migration invariants", () => {
  it.each([0, 1, 2])("imports PRAGMA version %i and performs no writes on subsequent calls", async (version) => {
    const db = memory();
    await db.batch(version === 2 ? SCHEMA : [legacySchema], "write");
    await db.execute(`PRAGMA user_version = ${version}`);
    await db.execute(fixture);
    const before = (await db.execute("SELECT * FROM cases")).rows;
    await migrate(db);
    expect((await db.execute("SELECT * FROM cases")).rows).toEqual(before);
    expect((await db.execute("SELECT value FROM schema_meta WHERE key = 'version'")).rows[0].value).toBe(2);
    const batch = vi.spyOn(db, "batch");
    const execute = vi.spyOn(db, "execute");
    await migrate(db);
    await migrate(db);
    expect(batch).not.toHaveBeenCalled();
    expect(execute.mock.calls.every(([stmt]) => /^SELECT\b/i.test(sqlOf(stmt)))).toBe(true);
    await expect(db.execute("UPDATE cases SET scam_type = 'unknown'")).rejects.toThrow();
  });

  it.each(["empty", "legacy", "v2"])("rolls back a late failure including schema_meta (%s)", async (kind) => {
    const db = memory();
    if (kind !== "empty") {
      await db.batch(kind === "v2" ? SCHEMA : [legacySchema], "write");
      await db.execute(`PRAGMA user_version = ${kind === "v2" ? 2 : 1}`);
      await db.execute(fixture);
    }
    const before = (await db.execute("SELECT name, sql FROM sqlite_master ORDER BY name")).rows;
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce((statements, mode) =>
      batch([...statements, "INSERT INTO nonexistent_review_table VALUES (1)"], mode));
    await expect(migrate(db)).rejects.toMatchObject({
      name: "MigrationError", step: kind === "legacy" ? "upgrade_v1" : "create",
    });
    expect((await db.execute("SELECT name, sql FROM sqlite_master ORDER BY name")).rows).toEqual(before);
    if (kind !== "empty") expect((await db.execute("SELECT id FROM cases")).rows[0].id).toBe("review-fixture");
    await migrate(db);
    expect((await db.execute("SELECT value FROM schema_meta WHERE key = 'version'")).rows[0].value).toBe(2);
  });

  it("upgrades an existing database when PRAGMA is rejected, without SQL comments in batches", async () => {
    const db = memory();
    await db.execute(legacySchema);
    await db.execute(fixture);
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((stmt) => {
      if (/^PRAGMA/i.test(sqlOf(stmt))) return Promise.reject(new LibsqlError("unsupported", "SQL_PARSE_ERROR"));
      return execute(stmt);
    });
    const batch = vi.spyOn(db, "batch");
    await migrate(db);
    for (const [statements] of batch.mock.calls) {
      for (const stmt of statements) expect(sqlOf(stmt)).not.toMatch(/--|\/\*|\bPRAGMA\b/i);
    }
    expect((await db.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(1);
  });

  it.each(["empty", "legacy"])("preserves rows when two independent clients both decide to migrate (%s)", async (kind) => {
    const dir = mkdtempSync(path.join(tmpdir(), "qalqan-review-"));
    directories.push(dir);
    const dbs = [createDb(`file:${dir}/review.db`), createDb(`file:${dir}/review.db`)];
    clients.push(...dbs);
    if (kind === "legacy") {
      await dbs[0].execute(legacySchema);
      await dbs[0].execute(fixture);
    }
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    for (const db of dbs) {
      const batch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementation(async (statements, mode) => {
        if (++arrivals === 2) release();
        await gate;
        return batch(statements, mode);
      });
    }
    await Promise.all(dbs.map(migrate));
    expect((await dbs[0].execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(kind === "legacy" ? 1 : 0);
    expect((await dbs[0].execute("SELECT * FROM schema_meta")).rows).toHaveLength(1);
    expect((await dbs[0].execute("SELECT name FROM sqlite_master WHERE name = 'cases_v2'")).rows).toEqual([]);
  });

  it("executes dashboard CASE, bound date modifier and filtering on local libSQL", async () => {
    const db = memory();
    await migrate(db);
    await db.execute(fixture);
    const stats = await getStats(db, 2, new Date("2026-11-13T12:00:00Z"));
    expect(stats).toMatchObject({ total: 1, highRisk: 1, preventedAmount: 25000, preventedCount: 1, stopRate: 1 });
    expect(stats.byDay).toContainEqual({ day: "2026-11-13", count: 1 });
    expect((await listCases(db, { status: "reviewing", language: "kk", risk: "high" })).total).toBe(1);
  });
});

async function health() {
  vi.stubEnv("DATABASE_URL", "libsql://synthetic-private-db.invalid");
  vi.stubEnv("QALQAN_AUTO_SEED", "0");
  vi.doMock("next/server", () => ({ connection: async () => {} }));
  return (await import("@/app/api/health/route")).GET();
}

describe("deploy fixes cycle 1: health diagnostic boundary", () => {
  it.each([401, 403, 404])("retains HTTP %i through a real SDK and MigrationError, without exposing the cause", async (status) => {
    // The SDK receives only an injected in-memory response. No network is used.
    const db = createClient({
      url: "https://synthetic-private-db.invalid", authToken: "synthetic-private-token",
      fetch: async () => new Response("synthetic-private-error-body", { status }),
    });
    clients.push(db);
    vi.doMock("@/lib/db/client", async (original) => ({
      ...(await original<typeof import("@/lib/db/client")>()), getDb: () => db,
    }));
    const response = await health();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private|cause|stack/);
    expect(body.db).toMatchObject({ code: "SERVER_ERROR", step: "read_version", httpStatus: status });
  });

  it("never serializes nested cause details for a migration SQL error", async () => {
    vi.doMock("@/lib/cases/repository", () => ({ db: async () => {
      throw new MigrationError("create", "SQL_PARSE_ERROR", {
        cause: Object.assign(new Error("synthetic-private-token"), { step: "synthetic-private-db" }),
      });
    } }));
    const response = await health();
    const body = await response.json();
    expect(body.db).toMatchObject({ code: "SQL_PARSE_ERROR", step: "create" });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private|cause|stack/);
  });

  it("does not echo arbitrary code text received through the real SDK", async () => {
    const db = createClient({
      url: "https://synthetic-private-db.invalid",
      fetch: async () => Response.json({
        baton: null,
        base_url: null,
        results: [
          { type: "error", error: {
            message: "private failure",
            code: "libsql://synthetic-private-db.invalid?authToken=synthetic-private-token",
          } },
          { type: "ok", response: { type: "close" } },
        ],
      }),
    });
    clients.push(db);
    vi.doMock("@/lib/db/client", async (original) => ({
      ...(await original<typeof import("@/lib/db/client")>()), getDb: () => db,
    }));
    const response = await health();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.db.step).toBe("read_version");
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private/);
  });

  it("does not echo arbitrary step text on an unexpected error", async () => {
    vi.doMock("@/lib/cases/repository", () => ({ db: async () => {
      throw Object.assign(new LibsqlError("private failure", "SERVER_ERROR"), {
        step: "libsql://synthetic-private-db.invalid?authToken=synthetic-private-token",
      });
    } }));
    const response = await health();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/synthetic-private/);
  });
});
