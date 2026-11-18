import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { parse: sdk.parse }; },
}));

import { analyzeMessage } from "@/lib/detector";
import { DEFAULT_LLM_MAX_PER_MIN, LlmBudget, llmBreaker, parseLlmMaxPerMin } from "@/lib/detector/llm-gate";

// Текст в серой зоне: LLM для него вызывается, если бюджет есть
const GRAY = "Мама, я разбил телефон, пишу с номера друга. Скинь, пожалуйста, 40 тысяч ему на карту.";
const VERDICT = { stop_reason: "end_turn", parsed_output: { riskScore: 80, scamType: "relative_in_trouble", reasons: ["синтетика"] } };

describe("QALQAN_LLM_MAX_PER_MIN", () => {
  it.each([
    [undefined, DEFAULT_LLM_MAX_PER_MIN],
    ["", DEFAULT_LLM_MAX_PER_MIN],
    ["  ", DEFAULT_LLM_MAX_PER_MIN],
    ["10", 10],
    [" 5 ", 5],
    ["0", 0],
    ["-1", DEFAULT_LLM_MAX_PER_MIN],
    ["2.5", DEFAULT_LLM_MAX_PER_MIN],
    ["abc", DEFAULT_LLM_MAX_PER_MIN],
  ])("%j → %d", (value, expected) => {
    expect(parseLlmMaxPerMin(value)).toBe(expected);
  });
});

describe("LlmBudget", () => {
  it("пропускает не больше лимита за минуту и освобождает место через минуту", () => {
    let now = 1_000_000;
    const budget = new LlmBudget(() => 2, () => now);

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.exhausted()).toBe(true);
    expect(budget.take()).toBe(false);

    now += 59_999;
    expect(budget.take()).toBe(false);
    now += 1;
    expect(budget.exhausted()).toBe(false);
    expect(budget.take()).toBe(true);
  });

  it("отказ не занимает место: после паузы снова ровно лимит", () => {
    let now = 0;
    const budget = new LlmBudget(() => 1, () => now);
    expect(budget.take()).toBe(true);
    for (let i = 0; i < 5; i++) expect(budget.take()).toBe(false);
    now += 60_000;
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("лимит 0 — LLM не вызывается никогда", () => {
    const budget = new LlmBudget(() => 0, () => 0);
    expect(budget.exhausted()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("exhausted() ничего не занимает", () => {
    const budget = new LlmBudget(() => 1, () => 0);
    for (let i = 0; i < 3; i++) expect(budget.exhausted()).toBe(false);
    expect(budget.take()).toBe(true);
  });
});

describe("бюджет на настоящем вызове LLM (SDK подменён, без сети)", () => {
  let clock = Date.UTC(2026, 10, 18, 12);

  beforeEach(() => {
    // Каждый тест — через час после предыдущего: окно бюджета общего экземпляра пустое
    clock += 3_600_000;
    vi.useFakeTimers({ now: clock, toFake: ["Date"] });
    sdk.parse.mockReset();
    sdk.parse.mockResolvedValue(VERDICT);
    llmBreaker.success();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in tests")));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("сверх бюджета LLM не вызывается, ответ — локальный", async () => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "2");
    const first = await analyzeMessage(GRAY);
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(2);
    expect(first.mode).not.toBe("rules");

    const third = await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(2);
    expect(third.mode).toBe("rules");
  });

  it("через минуту бюджет восстанавливается", async () => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "1");
    await analyzeMessage(GRAY);
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(1);

    vi.setSystemTime(clock + 60_000);
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(2);
  });

  it("вне серой зоны бюджет не тратится", async () => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "1");
    await analyzeMessage("Привет, во сколько завтра встречаемся?");
    expect(sdk.parse).not.toHaveBeenCalled();
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(1);
  });

  it("на паузе после сбоев бюджет не тратится", async () => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "1");
    for (let i = 0; i < 3; i++) llmBreaker.failure();
    expect(llmBreaker.open()).toBe(true);
    await analyzeMessage(GRAY);
    expect(sdk.parse).not.toHaveBeenCalled();

    llmBreaker.success();
    await analyzeMessage(GRAY);
    expect(sdk.parse).toHaveBeenCalledTimes(1);
  });

  it("подменённая LLM (options.llm) бюджет не использует", async () => {
    vi.stubEnv("QALQAN_LLM_MAX_PER_MIN", "0");
    const llm = vi.fn().mockResolvedValue({ riskScore: 80, scamType: "relative_in_trouble", reasons: ["синтетика"] });
    await analyzeMessage(GRAY, { llm });
    expect(llm).toHaveBeenCalledTimes(1);
  });
});
