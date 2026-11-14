import { afterEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { parse: sdk.parse }; },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("C9 (fixed): invalid messageText produces a Russian validation error", async () => {
  const { POST } = await import("@/app/api/transfer/assess/route");
  const response = await POST(new Request("http://localhost/api/transfer/assess", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: 1, newRecipient: false, messageText: 42 }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "messageText: нужна строка" });
});

it("C10: deployment can configure an LLM timeout longer than six seconds", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-review-key");
  vi.stubEnv("QALQAN_LLM_TIMEOUT_MS", "12000");
  sdk.parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
  const { askLlm } = await import("@/lib/detector/llm");
  await askLlm("Синтетический текст", "ru");
  expect(sdk.parse).toHaveBeenCalledWith(expect.anything(), { timeout: 12000, maxRetries: 0 });
});
