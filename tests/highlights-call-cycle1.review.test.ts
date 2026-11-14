import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { findHighlights, normalizeWithMap } from "@/lib/detector/highlights";
import { evaluateRules, normalize, SIGNALS } from "@/lib/detector/rules";
import { assessTransfer } from "@/lib/transfer/risk";
import type { AnalysisResult } from "@/lib/domain";

describe("highlights-call cycle 1 independent regressions", () => {
  it.each(["ΟΣ", "𐐀", "İ Ё\u00a0СЧЁТ 😀\u2028и\u0301"])("C1: normalization agrees for %s", (text) => {
    expect(normalizeWithMap(text).text).toBe(normalize(text));
  });

  it("C2: retains an outside-quote demand that rules counted", async () => {
    const text = "Не верьте. Переведите «деньги» деньги на безопасный счёт.";
    const rules = evaluateRules(text);
    expect(rules.signals).toContain("transfer_demand");
    const result = await analyzeMessage(text, { useLlm: false, useModel: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(40);
    const reason = SIGNALS.find((s) => s.id === "transfer_demand")!.reason;
    expect(result.highlights?.some((h) => h.reason.includes(reason))).toBe(true);
  });

  it("onCall never lowers risk across scores, evidence and context", () => {
    for (const evidence of ["rules", "llm", "model", "none", undefined] as const) {
      for (let riskScore = 0; riskScore <= 100; riskScore++) {
        const message: AnalysisResult = { riskScore, evidence, reasons: [], recommendation: "", mode: "rules", scamType: null };
        for (const amount of [1000, 500_000, 1_000_000]) {
          for (const newRecipient of [false, true]) {
            const context = { amount, newRecipient, message };
            expect(assessTransfer({ ...context, onCall: true }).riskScore)
              .toBeGreaterThanOrEqual(assessTransfer({ ...context, onCall: false }).riskScore);
          }
        }
      }
    }
  });

  it("preserves UTF-16 offsets after expanding İ and mixed whitespace", () => {
    const text = "İ 😀\u00a0Переведите на безопасный\u2028счёт";
    const spans = findHighlights(text, evaluateRules(text).signals);
    expect(spans.map((h) => text.slice(h.start, h.end))).toContain("безопасный\u2028счёт");
  });

  it("handles adversarial 5000-character inputs within a generous bound", () => {
    for (const text of ["a".repeat(5000), "1".repeat(5000), "срочно ".repeat(715).slice(0, 5000)]) {
      const start = performance.now();
      const spans = findHighlights(text, SIGNALS.map((s) => s.id).concat("suspicious_link"));
      expect(performance.now() - start).toBeLessThan(1000);
      expect(spans.length).toBeLessThanOrEqual(30);
    }
  });
});
