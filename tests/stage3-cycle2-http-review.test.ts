import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/api/http";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";

describe("stage 3 cycle 2: client address normalization", () => {
  it.each([
    [{}, "local"],
    [{ "x-real-ip": "  ", "x-forwarded-for": " , , " }, "local"],
    [{ "x-real-ip": " 198.51.100.1 ", "x-forwarded-for": "203.0.113.2" }, "198.51.100.1"],
    [{ "x-real-ip": "", "x-forwarded-for": "203.0.113.2, 198.51.100.1" }, "198.51.100.1"],
    [{ "x-real-ip": " \t ", "x-forwarded-for": " ,203.0.113.2, ,198.51.100.1, " }, "198.51.100.1"],
    [{ "x-real-ip": "2001:db8::1" }, "2001:db8::1"],
  ])("normalizes %j", (headers, expected) => {
    expect(clientIp(new Request("http://localhost", { headers: headers as HeadersInit }))).toBe(expected);
  });
});

describe("stage 3 cycle 2: global write budget", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/cases/repository");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("permits 120 writes, rejects rotating addresses, and recovers after 60 seconds", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const database = createDb(":memory:");
    try {
      await migrate(database);
      vi.doMock("@/lib/cases/repository", async (original) => ({
        ...(await original<typeof import("@/lib/cases/repository")>()),
        db: async () => database,
      }));
      const { POST } = await import("@/app/api/cases/route");
      const send = (ip: string) => POST(new Request("http://localhost/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({
          amount: 450000, newRecipient: true,
          messageText: "Служба безопасности банка. Переведите деньги на безопасный счёт.",
          outcome: "cancelled_by_client",
        }),
      }));
      for (let i = 0; i < 120; i++) {
        expect((await send(`198.51.100.${Math.floor(i / 20) + 1}`)).status).toBe(201);
      }
      const blocked = await send("203.0.113.99");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("60");
      expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(120);
      clock.mockReturnValue(1_060_000);
      expect((await send("198.51.100.1")).status).toBe(201);
      expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(121);
    } finally {
      database.close();
    }
  });
});
