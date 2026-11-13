import { readFileSync } from "node:fs";
import type { InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { CASE_STATUSES } from "@/lib/domain";
import { parseDataset } from "@/lib/dataset";
import { generateCases } from "../scripts/db-seed";
import { isDashboardAuthorized } from "@/lib/dashboard/auth";
import { getCase, getStats, listCases, parseFilters, STATUS_TRANSITIONS, updateStatus } from "@/lib/dashboard/queries";

// Only tiny, synthetic SQL fixtures in memory; no new dataset or network calls.
let database: ReturnType<typeof createDb>;
const basic = (password: string) => `Basic ${Buffer.from(`analyst:${password}`).toString("base64")}`;

async function insert(id: string, createdAt = "2026-11-12T19:00:00.000Z", status = "new") {
  await database.execute({
    sql: `INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt,
      risk_score, scam_type, analysis_mode, outcome, status)
      VALUES (?, ?, 'Synthetic', 'sms', 'ru', '[КОД]', 70, 'safe_account', 'rules', 'no_transfer', ?)`,
    args: [id, createdAt, status],
  });
}

beforeEach(async () => {
  database = createDb(":memory:");
  await migrate(database);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  database.close();
});

describe("dashboard review: real SQL", () => {
  it("ignores unknown URL filters and treats injected IDs as literal values", async () => {
    await insert("safe");
    const attack = "' OR 1=1; DROP TABLE cases; --";
    expect((await listCases(database, parseFilters({ status: attack, type: attack, lang: attack, risk: attack }))).total).toBe(1);
    expect(await getCase(database, attack)).toBeNull();
    expect(await updateStatus(database, attack, "reviewing")).toBe("not_found");
    expect((await getCase(database, "safe"))?.status).toBe("new");
  });

  it("covers all status, scheme, language and risk filters", async () => {
    const fixtures = generateCases(parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8")).items);
    const cols = Object.keys(fixtures[0]);
    await database.batch(fixtures.map((c) => ({
      sql: `INSERT INTO cases (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      args: Object.values(c),
    })), "write");
    for (const status of CASE_STATUSES) {
      for (const risk of ["high", "medium"] as const) {
        const expected = fixtures.filter((c) => c.status === status && c.language === "ru" && c.scam_type === "safe_account"
          && (risk === "high" ? c.risk_score >= 70 : c.risk_score >= 40 && c.risk_score < 70));
        expect((await listCases(database, { status, risk, language: "ru", scamType: "safe_account" })).total).toBe(expected.length);
      }
    }
    const ids: string[] = [];
    for (let page = 1; page <= Math.ceil(fixtures.length / 25); page++) {
      ids.push(...(await listCases(database, { page })).cases.map((c) => c.id));
    }
    expect(new Set(ids).size).toBe(fixtures.length);
    expect(fixtures.every((c) => c.analysis_mode === "rules")).toBe(true);
  });

  it("groups UTC+5 midnight, includes the whole first day, and fills gaps", async () => {
    for (const [id, date] of [
      ["outside", "2026-11-09T18:59:59.999Z"],
      ["first", "2026-11-09T19:00:00.000Z"],
      ["last-before", "2026-11-11T18:59:59.999Z"],
      ["midnight", "2026-11-11T19:00:00.000Z"],
    ]) await insert(id, date);
    expect((await getStats(database, 4, new Date("2026-11-13T12:00:00.000Z"))).byDay).toEqual([
      { day: "2026-11-10", count: 1 },
      { day: "2026-11-11", count: 1 },
      { day: "2026-11-12", count: 1 },
      { day: "2026-11-13", count: 0 },
    ]);
  });

  it("empty database has consistent zero totals, daily and outcome buckets", async () => {
    const stats = await getStats(database, 2, new Date("2026-11-13T00:00:00Z"));
    expect(stats).toMatchObject({ total: 0, highRisk: 0, newCount: 0, confirmed: 0, falsePositive: 0,
      preventedCount: 0, preventedAmount: 0, stopRate: null, byScamType: [] });
    expect(stats.byOutcome.every((x) => x.count === 0)).toBe(true);
    expect(stats.byDay.every((x) => x.count === 0)).toBe(true);
    expect(await listCases(database, {})).toEqual({ total: 0, cases: [] });
    expect(await getCase(database, "missing")).toBeNull();
  });

  it("checks every allowed and forbidden status transition", async () => {
    for (const from of CASE_STATUSES) {
      for (const to of CASE_STATUSES) {
        const id = `${from}-${to}`;
        await insert(id, undefined, from);
        const allowed = STATUS_TRANSITIONS[from].includes(to);
        expect(await updateStatus(database, id, to)).toBe(allowed ? "ok" : "invalid");
        expect((await getCase(database, id))?.status).toBe(allowed ? to : from);
      }
    }
  });

  it("rejects a stale write after another analyst wins the race", async () => {
    await insert("race");
    const execute = database.execute.bind(database);
    vi.spyOn(database, "execute").mockImplementation(async (statement: InStatement) => {
      if (typeof statement !== "string" && statement.sql.startsWith("UPDATE cases SET status")) {
        await execute("UPDATE cases SET status = 'false_positive' WHERE id = 'race'");
      }
      return execute(statement);
    });
    expect(await updateStatus(database, "race", "confirmed_fraud")).toBe("invalid");
    expect((await getCase(database, "race"))?.status).toBe("false_positive");
  });
});

describe("dashboard review: Basic parsing", () => {
  it.each([null, "", "Basic ", "Basic !!!", "Basic Og==", "Basic bm9jb2xvbg==", basic("wrong"),
    `Basic ${Buffer.from([0x61, 0x3a, 0xff]).toString("base64")}`])("rejects absent/invalid credentials: %s", (header) => {
    expect(isDashboardAuthorized(header, "секрет:1")).toBe(false);
  });
  it("supports UTF-8 passwords, colon in password, and empty username", () => {
    expect(isDashboardAuthorized(basic("секрет:1"), "секрет:1")).toBe(true);
    expect(isDashboardAuthorized(`Basic ${Buffer.from(":секрет:1").toString("base64")}`, "секрет:1")).toBe(true);
  });
  it("C3: accepts the case-insensitive HTTP authentication scheme", () => {
    expect(isDashboardAuthorized(basic("secret").replace("Basic", "basic"), "secret")).toBe(true);
  });
});
