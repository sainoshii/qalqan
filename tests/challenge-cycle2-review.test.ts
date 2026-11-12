import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { analyzeMessage } from "@/lib/detector";
import { HIGH_RISK, SCAM_TYPES } from "@/lib/domain";

// All 40 texts and labels were written before reading rules.ts or either older dataset.
// Only omitted hardNegative:false metadata after the parser rejected that representation.
const challenge = parseDataset(readFileSync("data/dataset/challenge-2.jsonl", "utf8"));

describe("cycle 2: independent synthetic challenge", () => {
  it("meets all quotas and does not duplicate earlier records", () => {
    expect(challenge.errors).toEqual([]);
    expect(challenge.items).toHaveLength(40);
    const previous = ["messages", "challenge-1"].flatMap((name) =>
      parseDataset(readFileSync(`data/dataset/${name}.jsonl`, "utf8")).items,
    );
    const ids = new Set(previous.map((item) => item.id));
    const texts = new Set(previous.map((item) => item.text));
    for (const [index, item] of challenge.items.entries()) {
      expect(item.id).toBe(`${item.lang}-${item.label}-${201 + index}`);
      expect(item.split).toBe("holdout");
      expect(ids.has(item.id)).toBe(false);
      expect(texts.has(item.text)).toBe(false);
    }
    for (const label of ["scam", "legit"]) {
      const group = challenge.items.filter((item) => item.label === label);
      expect(group).toHaveLength(20);
      expect(group.filter((item) => item.lang === "kk").length).toBeGreaterThanOrEqual(8);
    }
    expect(challenge.items.filter((item) => item.hardNegative).length).toBeGreaterThanOrEqual(8);
    expect(new Set(challenge.items.filter((item) => item.label === "scam").map((item) => item.scamType)))
      .toEqual(new Set(SCAM_TYPES));
  });

  it("reports coverage by scheme without imposing a quality target", async () => {
    const rows = await Promise.all(challenge.items.map(async (item) => {
      const result = await analyzeMessage(item.text, { lang: item.lang, useLlm: false });
      expect(result.mode).toBe("rules");
      expect(Number.isInteger(result.riskScore)).toBe(true);
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(100);
      return { item, result };
    }));
    console.log("CYCLE2_BY_TYPE " + JSON.stringify(SCAM_TYPES.map((type) => {
      const group = rows.filter((row) => row.item.scamType === type);
      const caught = group.filter((row) => row.result.riskScore >= HIGH_RISK);
      return { type, n: group.length, caught: caught.length,
        correctTypeAmongCaught: caught.filter((row) => row.result.scamType === type).length };
    })));
  });
});
