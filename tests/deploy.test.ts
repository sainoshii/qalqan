import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DATABASE_URL, SERVERLESS_DATABASE_URL, createDb, resolveDatabaseUrl } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { CASE_COUNT, generateCases, seedAnchor, seedSynthetic } from "@/lib/seed/synthetic";
import { parseDataset } from "@/lib/dataset";

const jsonl = readFileSync("data/dataset/messages.jsonl", "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveDatabaseUrl", () => {
  it("явный DATABASE_URL важнее всего", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "libsql://x.turso.io", VERCEL: "1" })).toBe("libsql://x.turso.io");
  });
  it("на Vercel без DATABASE_URL — /tmp, локально — data/", () => {
    expect(resolveDatabaseUrl({ VERCEL: "1" })).toBe(SERVERLESS_DATABASE_URL);
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });
});

describe("синтетика", () => {
  it("случаи лежат в окне последних 30 дней от опорного времени", () => {
    const now = new Date("2026-12-04T08:00:00Z");
    const anchor = seedAnchor(now);
    for (const c of generateCases(parseDataset(jsonl).items, CASE_COUNT, now)) {
      const t = Date.parse(c.created_at);
      expect(t).toBeLessThanOrEqual(anchor);
      expect(anchor - t).toBeLessThanOrEqual(30 * 86_400_000);
    }
  });

  it("seedSynthetic не трогает случаи из демо и идемпотентен", async () => {
    const db = createDb(":memory:");
    await migrate(db);
    await db.execute(`INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
      VALUES ('demo', '2026-11-13T00:00:00Z', 'Демо-клиент', 'sms', 'ru', 't', 90, 'rules', 'cancelled_by_client')`);
    await seedSynthetic(db, jsonl);
    await seedSynthetic(db, jsonl);
    const { rows } = await db.execute("SELECT SUM(synthetic = 1) AS s, SUM(synthetic = 0) AS d FROM cases");
    expect(rows[0]).toMatchObject({ s: CASE_COUNT, d: 1 });
    db.close();
  });
});

describe("автозаполнение в repository.db()", () => {
  it("на Vercel пустая база заполняется при первом обращении", async () => {
    const db = createDb(":memory:");
    vi.doMock("@/lib/db/client", async (orig) => ({ ...(await orig<typeof import("@/lib/db/client")>()), getDb: () => db }));
    vi.stubEnv("VERCEL", "1");
    const { db: getPrepared } = await import("@/lib/cases/repository");
    await getPrepared();
    await getPrepared();
    expect((await db.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
    db.close();
  });

  it("локально без флага не заполняется, QALQAN_AUTO_SEED=0 выключает и на Vercel", async () => {
    const { autoSeedEnabled } = await import("@/lib/cases/repository");
    expect(autoSeedEnabled({})).toBe(false);
    expect(autoSeedEnabled({ QALQAN_AUTO_SEED: "1" })).toBe(true);
    expect(autoSeedEnabled({ VERCEL: "1", QALQAN_AUTO_SEED: "0" })).toBe(false);
  });
});
