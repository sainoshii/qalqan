import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { parseDataset } from "@/lib/dataset";
import { isDashboardAuthorized } from "@/lib/dashboard/auth";
import { PAGE_SIZE, getCase, getStats, listCases, parseFilters, updateStatus } from "@/lib/dashboard/queries";
import { generateCases } from "../scripts/db-seed";

const dataset = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8")).items;
const db = createDb(":memory:");
const cases = generateCases(dataset);

beforeAll(async () => {
  await migrate(db);
  const cols = Object.keys(cases[0]);
  await db.batch(
    cases.map((c) => ({ sql: `INSERT INTO cases (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, args: Object.values(c) })),
    "write",
  );
});
afterAll(() => db.close());

describe("parseFilters", () => {
  it("берёт только допустимые значения", () => {
    expect(parseFilters({ status: "new", type: "safe_account", lang: "kk", risk: "high", page: "3" })).toEqual({
      status: "new",
      scamType: "safe_account",
      language: "kk",
      risk: "high",
      page: 3,
    });
    expect(parseFilters({ status: "x' OR 1=1 --", type: "drop", lang: "en", risk: "low", page: "-5" })).toEqual({
      status: undefined,
      scamType: undefined,
      language: undefined,
      risk: undefined,
      page: 1,
    });
    expect(parseFilters({ type: "none", page: ["2", "9"] })).toMatchObject({ scamType: "none", page: 2 });
  });
});

describe("listCases", () => {
  it("постранично, сначала новые", async () => {
    const { cases: page1, total } = await listCases(db, { page: 1 });
    expect(total).toBe(cases.length);
    expect(page1).toHaveLength(PAGE_SIZE);
    const times = page1.map((c) => c.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const { cases: last } = await listCases(db, { page: Math.ceil(total / PAGE_SIZE) });
    expect(last.length).toBeGreaterThan(0);
  });

  it("фильтры сужают выборку и сходятся с сырыми данными", async () => {
    const expected = cases.filter((c) => c.language === "kk" && c.risk_score >= 70).length;
    const { total, cases: rows } = await listCases(db, { language: "kk", risk: "high" });
    expect(total).toBe(expected);
    expect(rows.every((r) => r.language === "kk" && r.riskScore >= 70)).toBe(true);

    const none = await listCases(db, { scamType: "none" });
    expect(none.total).toBe(cases.filter((c) => c.scam_type === null).length);
  });
});

describe("getStats", () => {
  it("цифры сходятся с данными", async () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const s = await getStats(db, 30, now);
    expect(s.total).toBe(cases.length);
    expect(s.highRisk).toBe(cases.filter((c) => c.risk_score >= 70).length);
    const prevented = cases.filter((c) => c.outcome === "cancelled_by_client" || c.outcome === "held_for_trusted_contact");
    expect(s.preventedCount).toBe(prevented.length);
    expect(s.preventedAmount).toBe(prevented.reduce((sum, c) => sum + (c.transfer_amount ?? 0), 0));
    expect(s.byScamType.reduce((sum, r) => sum + r.count, 0)).toBe(cases.filter((c) => c.scam_type).length);
    expect(s.byOutcome.reduce((sum, r) => sum + r.count, 0)).toBe(cases.length);
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay.at(-1)?.day).toBe("2026-11-12");
    expect(s.byDay.reduce((sum, r) => sum + r.count, 0)).toBeLessThanOrEqual(cases.length);
  });

  it("пустая база — нули, без деления на ноль", async () => {
    const empty = createDb(":memory:");
    await migrate(empty);
    const s = await getStats(empty);
    expect(s).toMatchObject({ total: 0, preventedAmount: 0, stopRate: null, byScamType: [] });
    empty.close();
  });
});

describe("updateStatus", () => {
  it("допустимые переходы проходят, недопустимые — нет", async () => {
    const id = cases.find((c) => c.status === "new")!.id;
    expect(await updateStatus(db, id, "new")).toBe("invalid");
    expect(await updateStatus(db, id, "reviewing")).toBe("ok");
    expect(await updateStatus(db, id, "confirmed_fraud")).toBe("ok");
    expect((await getCase(db, id))?.status).toBe("confirmed_fraud");
    expect(await updateStatus(db, id, "false_positive")).toBe("invalid");
    expect(await updateStatus(db, "нет-такого", "reviewing")).toBe("not_found");
  });
});

describe("пароль на панель", () => {
  const basic = (user: string, pass: string) => `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)))}`;

  it("без пароля в окружении панель открыта", () => {
    expect(isDashboardAuthorized(null, undefined)).toBe(true);
  });

  it("с паролем пускает только с верным паролем", () => {
    expect(isDashboardAuthorized(null, "s3cret")).toBe(false);
    expect(isDashboardAuthorized(basic("analyst", "s3cret"), "s3cret")).toBe(true);
    expect(isDashboardAuthorized(basic("analyst", "s3cre"), "s3cret")).toBe(false);
    expect(isDashboardAuthorized(basic("analyst", "s3cret!"), "s3cret")).toBe(false);
    expect(isDashboardAuthorized("Bearer s3cret", "s3cret")).toBe(false);
    expect(isDashboardAuthorized("Basic !!!не-base64", "s3cret")).toBe(false);
    expect(isDashboardAuthorized(basic("аналитик", "пароль:1"), "пароль:1")).toBe(true);
  });

  it("proxy отвечает 401 с WWW-Authenticate без верного пароля", async () => {
    vi.stubEnv("QALQAN_DASHBOARD_PASSWORD", "s3cret");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const denied = proxy(new NextRequest("http://localhost/dashboard"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toMatch(/^Basic/);
    const ok = proxy(new NextRequest("http://localhost/dashboard", { headers: { authorization: basic("a", "s3cret") } }));
    expect(ok.status).toBe(200);
    vi.unstubAllEnvs();
  });
});
