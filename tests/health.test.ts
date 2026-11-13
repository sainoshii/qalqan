import { afterEach, describe, expect, it, vi } from "vitest";
import { LibsqlError } from "@libsql/client";
import { describeDbError, storageKind } from "@/lib/db/diagnose";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("storageKind", () => {
  it.each([
    ["libsql://qalqan-x.turso.io", "turso"],
    ["https://qalqan-x.turso.io", "turso"],
    ["file:/tmp/qalqan.db", "tmp"],
    ["file:data/qalqan.db", "file"],
    [":memory:", "other"],
  ])("%s → %s", (url, kind) => expect(storageKind(url)).toBe(kind));
});

describe("describeDbError", () => {
  it("401 от Turso — подсказка про токен, без текста ошибки", () => {
    const p = describeDbError(new LibsqlError("Server returned HTTP status 401 for libsql://secret-db.turso.io", "SERVER_ERROR"));
    expect(p).toMatchObject({ code: "SERVER_ERROR", httpStatus: 401 });
    expect(p.hint).toMatch(/токен/);
    expect(JSON.stringify(p)).not.toContain("secret-db");
  });
  it("неверный адрес", () => {
    expect(describeDbError(new LibsqlError("The URL 'x' is not in a valid format", "URL_INVALID")).hint).toMatch(/формате/);
  });
  it("неизвестная ошибка", () => {
    expect(describeDbError("boom")).toMatchObject({ code: "UNKNOWN" });
  });
});

describe("GET /api/health", () => {
  it("ok с числом случаев", async () => {
    const { createDb } = await import("@/lib/db/client");
    const mem = createDb(":memory:");
    vi.doMock("@/lib/db/client", async (orig) => ({ ...(await orig<typeof import("@/lib/db/client")>()), getDb: () => mem }));
    vi.doMock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", cases: 0 });
  });

  it("503 с кодом, но без адреса и токена", async () => {
    vi.doMock("@/lib/cases/repository", () => ({
      db: async () => {
        throw new LibsqlError("Server returned HTTP status 401 for libsql://secret-db.turso.io?authToken=tok", "SERVER_ERROR");
      },
    }));
    vi.doMock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("SERVER_ERROR");
    expect(text).not.toMatch(/secret-db|tok/);
  });
});

describe("совместимость схемы с Turso", () => {
  it("в SQL миграции нет комментариев и PRAGMA", async () => {
    const { SCHEMA } = await import("@/lib/db/schema");
    for (const sql of SCHEMA) {
      expect(sql).not.toMatch(/--|\/\*|PRAGMA/i);
    }
  });

  it("ошибка миграции видна в диагностике с шагом", async () => {
    const { MigrationError } = await import("@/lib/db/schema");
    const p = describeDbError(new MigrationError("create", "SQL_PARSE_ERROR"));
    expect(p).toMatchObject({ code: "SQL_PARSE_ERROR", step: "create" });
    expect(p.hint).toMatch(/миграции/);
  });
});
