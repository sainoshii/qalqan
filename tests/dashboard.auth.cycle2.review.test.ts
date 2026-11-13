import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeStatus } from "@/app/dashboard/cases/[id]/actions";
import { isDashboardAuthorized } from "@/lib/dashboard/auth";
import { proxy } from "@/proxy";

const mocks = vi.hoisted(() => ({ headers: vi.fn(), db: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/cases/repository", () => ({ db: mocks.db }));

const token = (credentials: string) => Buffer.from(credentials).toString("base64");
const validToken = token("analyst:review-secret");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("QALQAN_DASHBOARD_PASSWORD", "review-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("C3: Basic parsing keeps password enforcement", () => {
  it.each([
    `basic ${validToken}`,
    `BASIC ${validToken}`,
    `bAsIc   ${validToken}   `,
    `Basic \t${validToken}\t `,
  ])("accepts scheme casing and whitespace around a single token: %s", (authorization) => {
    expect(isDashboardAuthorized(authorization)).toBe(true);
    const response = proxy(new NextRequest("http://localhost/dashboard", {
      headers: { authorization },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    null,
    "",
    "Basic",
    "basic   ",
    "BASIC \t ",
    `basic ${token("analyst:")}`,
    `basic ${token(":")}`,
    `basic ${token("analyst:wrong")}`,
    `basic ${token("review-secret")}`,
    `basic ${validToken.slice(0, 4)} ${validToken.slice(4)}`,
    `basic ${validToken.slice(0, 4)}\t${validToken.slice(4)}`,
    `basic ${validToken} ${validToken}`,
    `basic ${token("analyst::review-secret")}`,
    `basic ${token("analyst:review-secret:")}`,
    `basic ${token("analyst:wrong:review-secret")}`,
  ])("rejects malformed or wrong credentials at all entrypoints: %s", async (authorization) => {
    expect(isDashboardAuthorized(authorization)).toBe(false);
    const headers = new Headers(authorization === null ? {} : { authorization });
    const response = proxy(new NextRequest("http://localhost/dashboard/cases/known", { headers }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
    mocks.headers.mockResolvedValue(headers);
    const form = new FormData();
    form.set("id", "known");
    form.set("status", "reviewing");
    await expect(changeStatus(form)).rejects.toThrow("Нет доступа");
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it("compares the whole password after the first colon", () => {
    const password = "review:secret:tail";
    expect(isDashboardAuthorized(`basic ${token(`analyst:${password}`)}`, password)).toBe(true);
    expect(isDashboardAuthorized(`basic ${token(`:${password}`)}`, password)).toBe(true);
    expect(isDashboardAuthorized(`basic ${token("analyst:review:secret")}`, password)).toBe(false);
    expect(isDashboardAuthorized(`basic ${token("analyst:secret:tail")}`, password)).toBe(false);
  });

  it("an empty configured password retains the documented open demo mode", () => {
    vi.stubEnv("QALQAN_DASHBOARD_PASSWORD", "");
    expect(isDashboardAuthorized(null)).toBe(true);
    expect(proxy(new NextRequest("http://localhost/dashboard")).headers.get("x-middleware-next")).toBe("1");
  });
});
