import { createClient } from "@libsql/client";
import { expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";

// Inject an in-memory database into the real entry point; SQL and dataset stay real.
vi.mock("../src/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/db/client")>()),
  createDb: vi.fn(),
}));

it("review: actual seed entry point is deterministic, idempotent and preserves non-synthetic rows", async () => {
  const db = createClient({ url: ":memory:" });
  const originalArgv = process.argv;
  vi.mocked(createDb).mockReturnValue(db);
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("DATABASE_AUTH_TOKEN", "");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    await migrate(db);
    await db.execute(`INSERT INTO cases
      (id, created_at, client_alias, channel, language, text_excerpt, risk_score, analysis_mode, outcome)
      VALUES ('preserved-fixture', '2026-11-12T00:00:00Z', 'Synthetic test fixture', 'sms', 'ru', 'Masked', 0, 'rules', 'no_transfer')`);

    async function runSeed() {
      vi.resetModules();
      process.argv = [originalArgv[0], "db-seed.ts"];
      let complete!: () => void;
      let fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      const close = vi.spyOn(db, "close").mockImplementation(() => complete());
      const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
        fail(new Error(`seed exited with ${code}`));
        return undefined as never;
      });
      try {
        await import("../scripts/db-seed");
        await finished;
      } finally {
        close.mockRestore();
        exit.mockRestore();
        process.argv = originalArgv;
      }
      return (await db.execute("SELECT * FROM cases ORDER BY id")).rows;
    }

    const first = await runSeed();
    expect(first).toHaveLength(121);
    expect(first.filter((row) => row.synthetic === 1)).toHaveLength(120);
    expect(first.some((row) => row.id === "preserved-fixture" && row.synthetic === 0)).toBe(true);
    expect(await runSeed()).toEqual(first);
    expect(vi.mocked(createDb)).toHaveBeenCalledWith(":memory:", undefined);
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    log.mockRestore();
    db.close();
  }
});
