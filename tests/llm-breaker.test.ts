import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { parse: sdk.parse }; },
}));

import { analyzeMessage } from "@/lib/detector";
import { FAILURE_LIMIT, llmBreaker } from "@/lib/detector/llm-gate";

// Текст в серой зоне — без шлюза LLM вызывалась бы всегда
const GRAY = "Мама, я разбил телефон, пишу с номера друга. Скинь, пожалуйста, 40 тысяч ему на карту.";

describe("автоотключение настоящего вызова LLM (SDK подменён, без сети)", () => {
  beforeEach(() => {
    sdk.parse.mockReset();
    llmBreaker.success();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in tests")));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("после сбоев подряд перестаёт ждать недоступный API, ответ — локальный", async () => {
    sdk.parse.mockRejectedValue(new Error("synthetic timeout"));
    for (let i = 0; i < FAILURE_LIMIT; i++) expect((await analyzeMessage(GRAY)).mode).toBe("rules");
    expect(sdk.parse).toHaveBeenCalledTimes(FAILURE_LIMIT);
    expect(llmBreaker.open()).toBe(true);
    const r = await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(FAILURE_LIMIT);
    expect(r.mode).toBe("rules");
  });

  it("отказ модели (refusal) — не сбой API: счётчик не растёт", async () => {
    sdk.parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    for (let i = 0; i < FAILURE_LIMIT + 1; i++) await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(FAILURE_LIMIT + 1);
    expect(llmBreaker.open()).toBe(false);
  });
});
