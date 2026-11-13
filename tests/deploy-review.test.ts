import { readFileSync } from "node:fs";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { parseDataset } from "@/lib/dataset";
import { CASE_COUNT, generateCases, seedSynthetic } from "@/lib/seed/synthetic";

const jsonl = readFileSync("data/dataset/messages.jsonl", "utf8");
const dataset = parseDataset(jsonl).items;
const clients: Client[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  for (const client of clients.splice(0)) client.close();
});

async function repository(autoSeed = "1") {
  const client = createDb(":memory:");
  clients.push(client);
  const readDataset = vi.fn().mockResolvedValue(jsonl);
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("QALQAN_AUTO_SEED", autoSeed);
  vi.doMock("@/lib/db/client", () => ({ getDb: () => client }));
  vi.doMock("node:fs/promises", () => ({ readFile: readDataset }));
  const { db } = await import("@/lib/cases/repository");
  return { client, readDataset, db };
}

describe("deploy review: cold-start initialization", () => {
  it("shares one initialization across 32 simultaneous callers", async () => {
    const { client, readDataset, db } = await repository();
    const results = await Promise.all(Array.from({ length: 32 }, () => db()));
    expect(results.every((result) => result === client)).toBe(true);
    expect(readDataset).toHaveBeenCalledTimes(1);
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
    await client.execute("UPDATE cases SET status = 'reviewing' WHERE id = 'case-0001'");
    await db();
    expect(readDataset).toHaveBeenCalledTimes(1);
    expect((await client.execute("SELECT status FROM cases WHERE id = 'case-0001'")).rows[0].status).toBe("reviewing");
  });

  it("retries after a transient dataset read failure", async () => {
    const { client, readDataset, db } = await repository();
    readDataset.mockRejectedValueOnce(new Error("EIO: synthetic dataset read failure"));
    // Контракт после C1 (цикл 1): сбой автозаполнения не закрывает доступ к базе,
    // заполнение повторяется при следующем обращении.
    await expect(db()).resolves.toBe(client);
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
    await expect(db()).resolves.toBe(client);
    expect(readDataset).toHaveBeenCalledTimes(2);
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
  });

  it("retries after a transient seed write failure", async () => {
    const { client, db } = await repository();
    await migrate(client);
    vi.spyOn(client, "batch").mockRejectedValueOnce(new Error("SQLITE_FULL: simulated seed write failure"));
    await expect(db()).resolves.toBe(client); // см. контракт C1 выше
    await expect(db()).resolves.toBe(client);
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
  });

  it("does not read the dataset when explicitly disabled on Vercel", async () => {
    const { client, readDataset, db } = await repository("0");
    await db();
    expect(readDataset).not.toHaveBeenCalled();
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
  });

  it("does not overwrite existing synthetic rows on initialization", async () => {
    const { client, readDataset, db } = await repository();
    await migrate(client);
    await seedSynthetic(client, jsonl);
    await client.execute("UPDATE cases SET status = 'reviewing' WHERE id = 'case-0001'");
    await db();
    expect(readDataset).not.toHaveBeenCalled();
    expect((await client.execute("SELECT status FROM cases WHERE id = 'case-0001'")).rows[0].status).toBe("reviewing");
  });

  it("C1: keeps a healthy database usable when optional seed data stays unavailable", async () => {
    const { client, readDataset, db } = await repository();
    await migrate(client);
    await client.execute(`INSERT INTO cases
      (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
      VALUES ('review-demo', '2026-11-13T00:00:00Z', 'Демо-клиент', 'sms', 'ru', 'Синтетический текст', 90, 'rules', 'no_transfer')`);
    readDataset.mockRejectedValue(new Error("ENOENT: synthetic dataset missing"));
    const results = await Promise.allSettled([db(), db()]);
    results.push(...await Promise.allSettled([db()]));
    // The underlying database remains readable; optional fixture failure must
    // not prevent displaying existing demo cases on every request.
    expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(1);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  });
});

describe("deploy review: dates", () => {
  it("is deterministic throughout the same UTC day", () => {
    expect(generateCases(dataset, CASE_COUNT, new Date("2026-12-04T00:00:00Z")))
      .toEqual(generateCases(dataset, CASE_COUNT, new Date("2026-12-04T23:59:59Z")));
  });

  it.each(["2026-12-04T00:00:00Z", "2026-12-04T23:59:59Z"])(
    "C2: every case is in the real preceding 30 days at %s",
    (iso) => {
      const now = new Date(iso);
      const outOfWindow = generateCases(dataset, CASE_COUNT, now).filter((item) => {
        const timestamp = Date.parse(item.created_at);
        return timestamp > now.getTime() || timestamp < now.getTime() - 30 * 86_400_000;
      });
      expect(outOfWindow.map(({ id, created_at }) => ({ id, created_at }))).toEqual([]);
    },
  );
});
