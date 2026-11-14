import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { analyzeMessage, evaluateRules } from "@/lib/detector";
import { HIGH_RISK } from "@/lib/domain";

describe("variant A cycle 3: bank messages and bounded-input performance", () => {
  it.each([
    "Код для входа в приложение: 123456. Никому не сообщайте код.",
    "Никому не сообщайте код",
    "Кодты ешкімге айтпаңыз",
  ])("ordinary notification stays below intervention: %s", async (text) => {
    expect(evaluateRules(text).strong).toBe(false);
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeLessThan(HIGH_RISK);
  });

  // Characterization of the deliberate fail-closed policy, NOT desired semantic labels.
  it.each([
    "Скажите, когда придёт код",
    "Код для входа придёт позже, отправьте отзыв о приложении",
    "Код никому не отправьте",
  ])("known limitation: benign co-occurrence still forces intervention: %s", async (text) => {
    expect(evaluateRules(text).strong).toBe(true);
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect((await analyzeMessage(text, {
      llm: async () => ({ riskScore: 0, scamType: null, reasons: [] }),
    })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  it("processes several 5000-character shapes without multi-second stalls", async () => {
    const samples = [
      "а".repeat(5000),
      "код".repeat(1667).slice(0, 5000),
      "код ".repeat(1250),
      "скажите ".repeat(625),
      "а".repeat(4980) + " Назовите код из SMS",
    ].map((text) => text.padEnd(5000).slice(0, 5000));
    for (const [index, text] of samples.entries()) {
      expect(text.length).toBe(5000);
      await analyzeMessage(text, { useLlm: false });
      const started = performance.now();
      for (let i = 0; i < 10; i++) await analyzeMessage(text, { useLlm: false });
      const elapsed = performance.now() - started;
      console.info(`5000 chars, shape ${index}: ${(elapsed / 10).toFixed(2)} ms/call (10 calls)`);
      expect(elapsed).toBeLessThan(2000);
    }
  });
});
