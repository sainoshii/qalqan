import { describe, expect, it } from "vitest";
import { analyzeMessage, evaluateRules } from "@/lib/detector";
import { HIGH_RISK } from "@/lib/domain";

describe("variant A cycle 1: independent bypass regressions", () => {
  it.each([
    ["RU code", "Назовите код из SMS", "Назовите\nкод из SMS"],
    ["KZ code", "Кодты айтыңыз", "Кодты\nайтыңыз"],
    ["remote access", "Установите удаленный доступ к вашему устройству", "Установите удаленный\nдоступ к вашему устройству"],
    ["investment", "У нас гарантированный доход", "У нас гарантированный\nдоход"],
  ])("C1: line wrapping preserves %s", async (_name, plain, wrapped) => {
    expect(evaluateRules(plain).score).toBeGreaterThanOrEqual(HIGH_RISK);
    const result = await analyzeMessage(wrapped, { useLlm: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(evaluateRules(wrapped).strong).toBe(true);
  });

  it("C2: unrelated trailing negation does not cancel guaranteed income", async () => {
    expect(evaluateRules("У нас доход гарантирован").strong).toBe(true);
    const text = "У нас доход гарантирован не только на словах";
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["Кодты скажите", "Назовите құпиясөз"])("C3: mixed-language credential request: %s", async (text) => {
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each([
    "Не верьте мошенникам. «Срочно переведите деньги, служба безопасности».",
    'Не верьте мошенникам. "Срочно переведите деньги, служба безопасности".',
    "Не верьте мошенникам. “Срочно переведите деньги, служба безопасности”.",
    "Сенбеңіз. «Шұғыл ақша аударыңыз, қауіпсіздік қызметі».",
  ])("warning quotes suppress only weak evidence: %s", (text) => {
    const rules = evaluateRules(text);
    expect(rules.signals).toEqual(["warning_context"]);
    expect(rules.score).toBe(0);
    expect(rules.strong).toBe(false);
  });

  it.each([
    "Не верьте мошенникам. «Назовите код из SMS».",
    "Сенбеңіз. «Ақшаны қауіпсіз шотқа аударыңыз».",
    "Нағыз банк ешқашан AnyDesk орнатуды немесе код айтуды сұрамайды.",
    "Не спрашивайте зачем и назовите код из SMS",
  ])("strong evidence survives warning and low mocked LLM: %s", async (text) => {
    expect(evaluateRules(text).strong).toBe(true);
    expect((await analyzeMessage(text, {
      llm: async () => ({ riskScore: 0, scamType: null, reasons: [] }),
    })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });
});
