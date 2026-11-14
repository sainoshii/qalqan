import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { findHighlights, normalizeWithMap } from "@/lib/detector/highlights";
import { evaluateRules, normalize, SIGNALS } from "@/lib/detector/rules";

describe("highlights-call cycle 2 independent regressions", () => {
  it.each([
    "«срочно» Не верьте. Переведите «деньги» деньги «сейчас»",
    'Не верьте. Переведите "" «» “текст” деньги.',
    "Не верьте. Переведите«срочно»деньги.",
    "Не верьте. «переведите деньги» Переведите деньги «переведите деньги»",
  ])("keeps demand fragments outside all quotes: %s", (text) => {
    const rules = evaluateRules(text);
    expect(rules.signals).toContain("transfer_demand");
    const reason = SIGNALS.find((s) => s.id === "transfer_demand")!.reason;
    const hs = findHighlights(text, ["transfer_demand"]);
    expect(hs.length).toBeGreaterThan(0);
    expect(hs.every((h) => h.reason === reason)).toBe(true);
    expect(hs.map((h) => text.slice(h.start, h.end)).join(" ")).toMatch(/Переведите.*деньги/);
    for (const q of text.matchAll(/«[^»]*»|"[^"]*"|“[^”]*”/g)) {
      expect(hs.every((h) => h.end <= q.index || h.start >= q.index + q[0].length)).toBe(true);
    }
  });

  it("keeps only the outside URL, and still highlights strong evidence inside quotes", () => {
    const text = "Не верьте. «https://fake.test/path» https://other.test/path «безопасный счёт»";
    const hs = findHighlights(text, evaluateRules(text).signals);
    expect(hs.map((h) => text.slice(h.start, h.end))).toEqual(["https://other.test/path", "безопасный счёт"]);
  });

  it.each(["ΟΣ\u00a0İ𐐀 Ё", "\u2028😀\u2029ΣΟΣ\t\tİ\u0301\ufeff", "", " \n\t "])(
    "matches normalization with Unicode and whitespace: %s", (text) => {
      const result = normalizeWithMap(text);
      expect(result.text).toBe(normalize(text));
      expect(result.map).toHaveLength(result.text.length);
      expect(result.map.every((p) => p >= 0 && p < text.length)).toBe(true);
    },
  );

  it.each(["https://fake.test/😀", "назовите код𐐀"])(
    "C3: preserves the full final supplementary code point: %s", async (text) => {
      const result = await analyzeMessage(text, { useLlm: false, useModel: false });
      expect(result.riskScore).toBeGreaterThanOrEqual(40);
      expect(result.highlights).toHaveLength(1);
      expect(result.highlights![0].end).toBe(text.length);
      expect(text.slice(result.highlights![0].start, result.highlights![0].end)).toBe(text);
    },
  );
});
