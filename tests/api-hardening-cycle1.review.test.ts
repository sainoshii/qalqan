import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { parse: sdk.parse }; } }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/cases/repository", () => ({ db: async () => ({ execute: async () => ({ rows: [{ n: 0 }] }) }) }));

const verdict = { stop_reason: "end_turn", parsed_output: { riskScore: 0, scamType: null, reasons: [] } };
const text = "Синтетическое сообщение для проверки бюджета.";

describe("api-hardening cycle 1: budget integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "2");
    vi.stubEnv("QALQAN_LLM_ZONE", "all");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
    sdk.parse.mockReset().mockResolvedValue(verdict);
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reserves before awaiting SDK: 50 concurrent calls consume only two slots", async () => {
    const { analyzeMessage } = await import("@/lib/detector");
    let release!: (value: typeof verdict) => void;
    sdk.parse.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = Array.from({ length: 50 }, () => analyzeMessage(text));
    expect(sdk.parse).toHaveBeenCalledTimes(2);
    release(verdict);
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.mode === "hybrid")).toHaveLength(2);
    expect(results.filter((r) => r.mode === "rules")).toHaveLength(48);
  });

  it("explicit useLlm without a key must not consume the real API budget", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { analyzeMessage } = await import("@/lib/detector");
    const { llmBudget } = await import("@/lib/detector/llm-gate");
    await analyzeMessage(text, { useLlm: true });
    await analyzeMessage(text, { useLlm: true });
    expect(sdk.parse).not.toHaveBeenCalled();
    expect(llmBudget.exhausted()).toBe(false);
  });

  it("health observes exhaustion and expiry without consuming slots", async () => {
    const { analyzeMessage } = await import("@/lib/detector");
    const { GET } = await import("@/app/api/health/route");
    for (let i = 0; i < 5; i++) expect((await (await GET()).json()).llm.budgetExhausted).toBe(false);
    await analyzeMessage(text);
    await analyzeMessage(text);
    expect((await (await GET()).json()).llm.budgetExhausted).toBe(true);
    vi.setSystemTime(1_060_000);
    expect((await (await GET()).json()).llm.budgetExhausted).toBe(false);
    await analyzeMessage(text);
    expect(sdk.parse).toHaveBeenCalledTimes(3);
  });

  it("useLlm false and injected LLM leave the real budget untouched", async () => {
    const { analyzeMessage } = await import("@/lib/detector");
    await analyzeMessage(text, { useLlm: false });
    await analyzeMessage(text, { llm: async () => null });
    await analyzeMessage(text);
    await analyzeMessage(text);
    expect(sdk.parse).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["@/app/api/analyze/route", { text }],
    ["@/app/api/transfer/assess/route", { amount: 5000, newRecipient: false, messageText: text }],
  ])("%s: concurrent global limit, IP rejections and minute recovery", async (modulePath, body) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = await import(modulePath);
    const request = (ip: string) => new Request("http://localhost/api/test", {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body),
    });
    for (let i = 0; i < 30; i++) expect((await POST(request("10.0.0.1"))).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await POST(request("10.0.0.1"))).status).toBe(429);
    const responses: Response[] = await Promise.all(Array.from({ length: 580 }, (_, i) =>
      POST(request(`10.1.${Math.floor(i / 250)}.${i % 250}`))));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(570);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    vi.setSystemTime(1_059_999);
    expect((await POST(request("10.9.9.9"))).status).toBe(429);
    vi.setSystemTime(1_060_000);
    expect((await POST(request("10.0.0.1"))).status).toBe(200);
    expect(sdk.parse).not.toHaveBeenCalled();
  });
});
