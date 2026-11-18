import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetItem } from "@/lib/dataset";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { parse: sdk.parse }; } }));
const text = "Синтетическое сообщение для проверки выбора LLM.";
const verdict = { riskScore: 0, scamType: null, reasons: [] };

describe("cycle 2: useLlm compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("QALQAN_LLM_ZONE", "all");
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "1");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
    sdk.parse.mockReset().mockResolvedValue({ stop_reason: "end_turn", parsed_output: verdict });
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([undefined, true, false])("useLlm=%s with no key preserves the complete local result and budget", async (useLlm) => {
    const { analyzeMessage } = await import("@/lib/detector");
    const { llmBudget } = await import("@/lib/detector/llm-gate");
    const local = await analyzeMessage(text, { useLlm: false });
    expect(await analyzeMessage(text, { useLlm })).toEqual(local);
    expect(sdk.parse).not.toHaveBeenCalled();
    expect(llmBudget.exhausted()).toBe(false);
  });

  it.each([undefined, true, false])("useLlm=%s with configured SDK respects opt-out", async (useLlm) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
    const { analyzeMessage } = await import("@/lib/detector");
    const result = await analyzeMessage(text, { useLlm });
    expect(sdk.parse).toHaveBeenCalledTimes(useLlm === false ? 0 : 1);
    expect(result.mode).toBe(useLlm === false ? "rules" : "hybrid");
  });

  it.each([undefined, true, false])("useLlm=%s with injected LLM bypasses exhausted budget and open breaker", async (useLlm) => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "0");
    const { analyzeMessage } = await import("@/lib/detector");
    const { llmBreaker } = await import("@/lib/detector/llm-gate");
    for (let i = 0; i < 3; i++) llmBreaker.failure();
    expect(llmBreaker.open()).toBe(true);
    const llm = vi.fn().mockResolvedValue(verdict);
    const result = await analyzeMessage(text, { useLlm, llm });
    expect(llm).toHaveBeenCalledTimes(useLlm === false ? 0 : 1);
    expect(result.mode).toBe(useLlm === false ? "rules" : "hybrid");
    expect(sdk.parse).not.toHaveBeenCalled();
    expect(llmBreaker.open()).toBe(true);
  });

  it("eval scoring with --llm semantics and no key matches local scoring without consuming budget", async () => {
    const { scoreDataset } = await import("../scripts/eval");
    const { llmBudget } = await import("@/lib/detector/llm-gate");
    const items: DatasetItem[] = [{ id: "ru-legit-001", lang: "ru", channel: "sms", label: "legit", scamType: null, split: "dev", text }];
    expect(await scoreDataset(items, true)).toEqual(await scoreDataset(items, false));
    expect(sdk.parse).not.toHaveBeenCalled();
    expect(llmBudget.exhausted()).toBe(false);
  });
});
