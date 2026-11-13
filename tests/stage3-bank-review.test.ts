import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { MAX_BODY_BYTES } from "@/lib/api/http";

// All data are synthetic. Invoke handlers directly; no HTTP or LLM network calls.
const SCAM = "Служба безопасности банка. Переведите деньги на безопасный счёт.";
const caseBody = {
  amount: 450_000,
  newRecipient: true,
  messageText: SCAM,
  outcome: "cancelled_by_client",
};
const routes = ["analyze", "transfer/assess", "cases"] as const;
type Route = (typeof routes)[number];
type Handler = (request: Request) => Promise<Response>;

function request(route: Route, body: unknown, forwarded?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  return new Request(`http://localhost/api/${route}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

describe("stage 3 review: storage, shared HTTP guards and abuse", () => {
  let database: ReturnType<typeof createDb>;
  let handlers: Record<Route, Handler>;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    database = createDb(":memory:");
    await migrate(database);
    vi.doMock("@/lib/cases/repository", async (original) => ({
      ...(await original<typeof import("@/lib/cases/repository")>()),
      db: async () => database,
    }));
    handlers = {
      analyze: (await import("@/app/api/analyze/route")).POST,
      "transfer/assess": (await import("@/app/api/transfer/assess/route")).POST,
      cases: (await import("@/app/api/cases/route")).POST,
    };
  });

  afterEach(() => {
    database.close();
    vi.doUnmock("@/lib/cases/repository");
    vi.unstubAllEnvs();
  });

  it.each(routes)("%s rejects a misleading JSON media type", async (route) => {
    const req = request(route, { ...caseBody, text: SCAM });
    req.headers.set("content-type", "application/jsonp");
    expect((await handlers[route](req)).status).toBe(415);
  });

  it.each(routes)("%s limits streamed bytes even with a false Content-Length", async (route) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8192).fill(32)); },
      cancel,
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", body, duplex: "half",
      headers: { "content-type": "application/json", "content-length": "1" },
    };
    expect(MAX_BODY_BYTES).toBe(32768);
    expect((await handlers[route](new Request(`http://localhost/api/${route}`, init))).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
  });

  it("assessing a high-risk transfer never writes a case", async () => {
    const response = await handlers["transfer/assess"](request("transfer/assess", caseBody));
    expect(response.status).toBe(200);
    expect((await response.json()).decision).toBe("intervene");
    expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
  });

  it("client-supplied scores cannot turn a benign transfer into a stored case", async () => {
    const response = await handlers.cases(request("cases", {
      ...caseBody, amount: 3000, newRecipient: false, messageText: "Скинь 3 000 за пиццу",
      riskScore: 100, reasons: ["Подставленная причина"],
      analysis: { riskScore: 100, scamType: "safe_account" },
    }));
    expect((await response.json()).stored).toBe(false);
    expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
  });

  it("masks the corrected payment OTP and synthetic financial identifiers in persisted rows", async () => {
    const response = await handlers.cases(request("cases", {
      ...caseBody,
      messageText: `${SCAM} Код подтверждения оплаты заказа: 4821. Карта 4400 4301 2345 6789. Телефон +7 701 555 12 34. ИИН 991231350123.`,
    }));
    expect(response.status).toBe(201);
    const { rows } = await database.execute("SELECT * FROM cases");
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    for (const secret of ["4821", "4400 4301 2345 6789", "+7 701 555 12 34", "991231350123"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const marker of ["[КОД]", "[КАРТА]", "[ТЕЛЕФОН]", "[ИИН]"]) {
      expect(String(rows[0].text_excerpt)).toContain(marker);
    }
  });

  it("blocks the 21st write in the same rate-limit window", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await handlers.cases(request("cases", caseBody, "198.51.100.7"))).status).toBe(201);
    }
    const blocked = await handlers.cases(request("cases", caseBody, "198.51.100.7"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(20);
  });

  it("C1: changing an untrusted X-Forwarded-For prefix must not reset the write budget", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await handlers.cases(request("cases", caseBody, "198.51.100.7"))).status).toBe(201);
    }
    expect((await handlers.cases(request("cases", caseBody, "198.51.100.7"))).status).toBe(429);
    // Same caller/proxy chain; only the client-controlled leftmost value changes.
    const bypass = await handlers.cases(request("cases", caseBody, "203.0.113.99, 198.51.100.7"));
    const count = (await database.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n;
    expect({ status: bypass.status, rows: count }).toEqual({ status: 429, rows: 20 });
  });
});
