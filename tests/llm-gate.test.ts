import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMessage, evaluateRules } from "@/lib/detector";
import {
  DEFAULT_LLM_ZONE,
  FAILURE_LIMIT,
  LlmBreaker,
  PAUSE_MS,
  inLlmZone,
  parseLlmZone,
} from "@/lib/detector/llm-gate";
import { llmPlan, type Scored } from "../scripts/eval";
import type { DatasetItem } from "@/lib/dataset";

const verdict = { riskScore: 90, scamType: "relative_in_trouble" as const, reasons: ["Синтетическая причина"] };

describe("серая зона LLM", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("разбирает QALQAN_LLM_ZONE, некорректное значение — зона по умолчанию", () => {
    expect(parseLlmZone(undefined)).toEqual(DEFAULT_LLM_ZONE);
    expect(parseLlmZone("all")).toBe("all");
    expect(parseLlmZone(" 20 - 60 ")).toEqual({ min: 20, max: 60 });
    for (const bad of ["60-20", "0-101", "abc", "-5-10", "30"]) expect(parseLlmZone(bad)).toEqual(DEFAULT_LLM_ZONE);
  });

  it("границы зоны включительны", () => {
    expect(inLlmZone(29, DEFAULT_LLM_ZONE)).toBe(false);
    expect(inLlmZone(30, DEFAULT_LLM_ZONE)).toBe(true);
    expect(inLlmZone(69, DEFAULT_LLM_ZONE)).toBe(true);
    expect(inLlmZone(70, DEFAULT_LLM_ZONE)).toBe(false);
    expect(inLlmZone(0, "all")).toBe(true);
  });

  it("однозначное мошенничество (риск правил ≥ 70) не отправляется в LLM", async () => {
    const text = "Срочно продиктуйте код из SMS, иначе карта будет заблокирована.";
    expect(evaluateRules(text).score).toBeGreaterThanOrEqual(70);
    const llm = vi.fn().mockResolvedValue(verdict);
    const r = await analyzeMessage(text, { llm });
    expect(llm).not.toHaveBeenCalled();
    expect(r.mode).toBe("rules");
  });

  it("обычное сообщение (риск < 30) не отправляется в LLM", async () => {
    const llm = vi.fn().mockResolvedValue(verdict);
    const r = await analyzeMessage("Привет, встречаемся в шесть у входа в парк.", { llm });
    expect(llm).not.toHaveBeenCalled();
    expect(r.mode).toBe("rules");
  });

  it("сообщение в серой зоне отправляется в LLM и получает hybrid", async () => {
    const text = "Мама, я разбил телефон, пишу с номера друга. Скинь, пожалуйста, 40 тысяч ему на карту.";
    const local = await analyzeMessage(text, { useLlm: false });
    expect(inLlmZone(local.riskScore, DEFAULT_LLM_ZONE)).toBe(true);
    const llm = vi.fn().mockResolvedValue(verdict);
    const r = await analyzeMessage(text, { llm });
    expect(llm).toHaveBeenCalledOnce();
    expect(r.mode).toBe("hybrid");
    expect(r.riskScore).toBeGreaterThanOrEqual(70);
  });

  it("зона из окружения: all — LLM для каждого сообщения", async () => {
    vi.stubEnv("QALQAN_LLM_ZONE", "all");
    const llm = vi.fn().mockResolvedValue(null);
    await analyzeMessage("Привет, встречаемся в шесть у входа в парк.", { llm });
    expect(llm).toHaveBeenCalledOnce();
  });
});

describe("автоотключение LLM после сбоев", () => {
  it(`после ${FAILURE_LIMIT} сбоев подряд — пауза ${PAUSE_MS / 1000} с, потом снова пробует`, () => {
    let now = 1_000;
    const b = new LlmBreaker(() => now);
    for (let i = 0; i < FAILURE_LIMIT - 1; i++) b.failure();
    expect(b.open()).toBe(false);
    b.failure();
    expect(b.open()).toBe(true);
    now += PAUSE_MS - 1;
    expect(b.open()).toBe(true);
    now += 1;
    expect(b.open()).toBe(false);
  });

  it("успешный ответ сбрасывает счётчик сбоев", () => {
    const b = new LlmBreaker(() => 0);
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    expect(b.open()).toBe(false);
  });
});

describe("план вызовов LLM в eval", () => {
  const item = (id: string, label: "scam" | "legit"): DatasetItem => ({
    id,
    lang: "ru",
    channel: "sms",
    label,
    scamType: label === "scam" ? "code_request" : null,
    split: "holdout",
    text: "Синтетический текст для проверки плана вызовов.",
  });
  const rows: Scored[] = [
    { item: item("a", "scam"), riskScore: 85, scamType: "code_request" },
    { item: item("b", "scam"), riskScore: 50, scamType: null },
    { item: item("c", "scam"), riskScore: 10, scamType: null },
    { item: item("d", "legit"), riskScore: 40, scamType: null },
    { item: item("e", "legit"), riskScore: 75, scamType: "code_request" },
    { item: item("f", "legit"), riskScore: 0, scamType: null },
  ];

  it("считает вызовы и ошибки, которые LLM не увидит", () => {
    expect(llmPlan(rows, DEFAULT_LLM_ZONE)).toEqual({
      n: 6,
      asked: 2,
      askedScam: 1,
      askedLegit: 1,
      missedBelow: 1,
      falseAbove: 1,
    });
    expect(llmPlan(rows, "all")).toMatchObject({ asked: 6, missedBelow: 0, falseAbove: 0 });
  });
});
