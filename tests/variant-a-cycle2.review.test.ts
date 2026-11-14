import { describe, expect, it } from "vitest";
import { analyzeMessage, evaluateRules } from "@/lib/detector";
import { HIGH_RISK } from "@/lib/domain";

describe("variant A cycle 2: fixes and explicit credential requests", () => {
  it.each(["\n", "\r\n", "\t", "\u00a0", " — ", ": ", ", "])("C1: separator %j preserves a code request", async (separator) => {
    const result = await analyzeMessage(`Назовите${separator}код из SMS`, { useLlm: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  it.each(["Доход не гарантирован", "Доходность не гарантирована", "Доход не\nгарантирован"])("C2: explicit disclaimer: %s", (text) => {
    expect(evaluateRules(text).strong).toBe(false);
  });

  it.each(["Доход гарантирован не только сегодня", "Доходность гарантирована не только на словах"])("C2: trailing negation: %s", (text) => {
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["кодты", "кодын", "пароль", "құпиясөз"])("C3: reverse request for %s", async (credential) => {
    for (const verb of ["назовите", "скажите", "продиктуйте"]) {
      expect((await analyzeMessage(`${credential} ${verb}`, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    }
  });

  it.each(["Назовите құпиясөз", "Скажите құпиясөз"])("C3: forward request: %s", (text) => {
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["Код из SMS отправьте мне", "Код из SMS сообщите мне"])("C4: reverse RU request: %s", async (text) => {
    const result = await analyzeMessage(text, { useLlm: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["Құпиясөзді айтыңыз", "Құпиясөзді жіберіңіз", "Парольді айтыңыз"])("C5: KZ credential request: %s", async (text) => {
    const result = await analyzeMessage(text, { useLlm: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(evaluateRules(text).strong).toBe(true);
  });
});
