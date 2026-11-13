import { readFileSync } from "node:fs";
import type { Client } from "@libsql/client";
import { afterEach, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { CASE_COUNT } from "@/lib/seed/synthetic";

const jsonl = readFileSync("data/dataset/messages.jsonl", "utf8");
const clients: Client[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  for (const client of clients.splice(0)) client.close();
});

async function setup() {
  const client = createDb(":memory:");
  clients.push(client);
  const readDataset = vi.fn().mockResolvedValue(jsonl);
  vi.stubEnv("QALQAN_AUTO_SEED", "1");
  vi.doMock("@/lib/db/client", () => ({ getDb: () => client }));
  vi.doMock("node:fs/promises", () => ({ readFile: readDataset }));
  const { db } = await import("@/lib/cases/repository");
  return { client, readDataset, db };
}

it("propagates a migration failure to all cold callers and retries migration", async () => {
  const { client, readDataset, db } = await setup();
  const failure = new Error("simulated migration write failure");
  const batch = vi.spyOn(client, "batch").mockRejectedValueOnce(failure);
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => db()));
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(failure);
  }
  expect(batch).toHaveBeenCalledTimes(1);
  expect(readDataset).not.toHaveBeenCalled();

  await expect(db()).resolves.toBe(client);
  expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
  expect(batch).toHaveBeenCalledTimes(3); // failed migration, retry, seed
});

it("shares a pending failed seed attempt, then shares one successful retry", async () => {
  const { client, readDataset, db } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let rejectRead!: (reason: Error) => void;
  readDataset.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
    rejectRead = reject;
  }));
  let completed = 0;
  const firstWave = Promise.all(Array.from({ length: 32 }, () => db().then((value) => {
    completed++;
    return value;
  })));
  await vi.waitFor(() => expect(readDataset).toHaveBeenCalledTimes(1));
  expect(completed).toBe(0);
  rejectRead(new Error("private simulated failure detail"));
  expect((await firstWave).every((value) => value === client)).toBe(true);
  expect(readDataset).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private simulated failure detail");
  expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);

  const batch = vi.spyOn(client, "batch");
  const secondWave = await Promise.all(Array.from({ length: 32 }, () => db()));
  expect(secondWave.every((value) => value === client)).toBe(true);
  expect(readDataset).toHaveBeenCalledTimes(2);
  expect(batch).toHaveBeenCalledTimes(1);
  expect((await client.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(CASE_COUNT);
});
