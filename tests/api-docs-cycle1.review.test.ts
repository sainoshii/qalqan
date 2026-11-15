import { afterEach, describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => ({ ask: vi.fn(async () => null) }));
vi.mock("@/lib/detector/llm", () => ({
  llmConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  askLlm: llm.ask,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("api-docs cycle 1: integration guarantees", () => {
  it("computes every documentation example without LLM even with a key configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-review-key-not-a-secret");
    const { computeExamples } = await import("@/lib/api/examples");
    const result = await computeExamples();
    expect(llm.ask).not.toHaveBeenCalled();
    expect(result.analyze.mode).toBe("rules");
    expect(result.transfer.message?.mode).toBe("rules");
    expect(JSON.stringify(result)).not.toContain("synthetic-review-key-not-a-secret");
  });

  it("newRecipient true means a NEW recipient and changes the call-only decision", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = await import("@/app/api/transfer/assess/route");
    for (const [newRecipient, decision] of [[true, "warn"], [false, "allow"]] as const) {
      const response = await POST(new Request("http://localhost/api/transfer/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 15000, newRecipient, onCall: true }),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ decision, message: null });
    }
  });

  it("rules mode can mean a configured LLM failed, not that no LLM was attempted", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-review-key-not-a-secret");
    const { analyzeMessage } = await import("@/lib/detector");
    expect((await analyzeMessage("Обычное синтетическое сообщение для проверки.", { llmZone: "all" })).mode).toBe("rules");
    expect(llm.ask).toHaveBeenCalledOnce();
  });
});
