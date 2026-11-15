import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { parse: sdk.parse }; } }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/cases/repository", () => ({
  db: async () => ({ execute: async () => ({ rows: [{ n: 0 }] }) }),
}));

import { analyzeMessage, evaluateRules } from "@/lib/detector";
import { DEFAULT_LLM_ZONE, llmBreaker, parseLlmZone } from "@/lib/detector/llm-gate";
import { GET } from "@/app/api/health/route";

const GRAY = "Мама, я разбил телефон, пишу с номера друга. Скинь, пожалуйста, 40 тысяч ему на карту.";

describe("llm-gray cycle 1: offline review probes", () => {
  beforeEach(() => {
    sdk.parse.mockReset();
    llmBreaker.success();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-review-key");
    vi.stubEnv("QALQAN_LLM_ZONE", "30-69");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    llmBreaker.success();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("parses edge ranges and rejects malformed values", () => {
    expect(parseLlmZone(" ALL ")).toBe("all");
    expect(parseLlmZone("0-0")).toEqual({ min: 0, max: 0 });
    expect(parseLlmZone("100-100")).toEqual({ min: 100, max: 100 });
    for (const value of ["101-101", "100-0", "30.0-69", "30-69x", "Infinity", "0000-69"])
      expect(parseLlmZone(value)).toEqual(DEFAULT_LLM_ZONE);
  });

  it("three parallel exceptions open the shared breaker and block the next request", async () => {
    sdk.parse.mockRejectedValue(new Error("synthetic timeout"));
    await Promise.all([analyzeMessage(GRAY), analyzeMessage(GRAY), analyzeMessage(GRAY)]);
    expect(llmBreaker.open()).toBe(true);
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(3);
    expect((await (await GET()).json()).llm.paused).toBe(true);
  });

  it("refusal breaks the sequence of API exceptions", async () => {
    sdk.parse.mockRejectedValue(new Error("synthetic timeout"));
    await analyzeMessage(GRAY);
    await analyzeMessage(GRAY);
    sdk.parse.mockResolvedValueOnce({ stop_reason: "refusal", parsed_output: null });
    await analyzeMessage(GRAY);
    await analyzeMessage(GRAY);
    await analyzeMessage(GRAY);
    expect(llmBreaker.open()).toBe(false);
  });

  it("injected LLM ignores an open breaker without resetting it", async () => {
    for (let i = 0; i < 3; i++) llmBreaker.failure();
    const llm = vi.fn().mockResolvedValue(null);
    await analyzeMessage(GRAY, { llm });
    expect(llm).toHaveBeenCalledOnce();
    expect(llmBreaker.open()).toBe(true);
    expect(sdk.parse).not.toHaveBeenCalled();
  });

  it("health hides pause when the key is absent", async () => {
    for (let i = 0; i < 3; i++) llmBreaker.failure();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await (await GET()).json()).llm).toMatchObject({ configured: false, model: null, paused: false });
  });

  it("useLlm false overrides both a configured key and an injected function", async () => {
    const llm = vi.fn();
    await analyzeMessage(GRAY, { useLlm: false, llm, llmZone: "all" });
    expect(llm).not.toHaveBeenCalled();
    expect(sdk.parse).not.toHaveBeenCalled();
  });

  it("documents the tradeoff: score 70 does not imply strong evidence", async () => {
    const text = "Полиция: срочно переведите деньги.";
    expect(evaluateRules(text)).toMatchObject({ score: 70, strong: false });
    const llm = vi.fn().mockResolvedValue({ riskScore: 0, scamType: null, reasons: [] });
    expect((await analyzeMessage(text, { useModel: false, llm })).riskScore).toBe(70);
    expect(llm).not.toHaveBeenCalled();
    expect((await analyzeMessage(text, { useModel: false, llm, llmZone: "all" })).riskScore).toBe(21);
  });
});
