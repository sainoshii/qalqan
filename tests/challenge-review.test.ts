import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { analyzeMessage } from "@/lib/detector";
import { HIGH_RISK, SCAM_TYPES } from "@/lib/domain";

// Written before reading rules.ts or messages.jsonl. No tuning on this holdout.
const challenge = parseDataset(readFileSync("data/dataset/challenge-1.jsonl", "utf8"));

describe("independent challenge holdout", () => {
  it("has 40 valid, new records and the requested coverage", () => {
    expect(challenge.errors).toEqual([]);
    expect(challenge.items).toHaveLength(40);
    const original = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));
    const originalIds = new Set(original.items.map((item) => item.id));
    const originalTexts = new Set(original.items.map((item) => item.text));
    for (const item of challenge.items) {
      expect(item.split).toBe("holdout");
      expect(Number(item.id.split("-").at(-1))).toBeGreaterThanOrEqual(101);
      expect(originalIds.has(item.id)).toBe(false);
      expect(originalTexts.has(item.text)).toBe(false);
    }
    for (const label of ["scam", "legit"]) {
      const rows = challenge.items.filter((item) => item.label === label);
      expect(rows).toHaveLength(20);
      expect(rows.filter((item) => item.lang === "kk").length).toBeGreaterThanOrEqual(7);
    }
    expect(challenge.items.filter((item) => item.hardNegative).length).toBeGreaterThanOrEqual(8);
    expect(new Set(challenge.items.filter((item) => item.label === "scam").map((item) => item.scamType)))
      .toEqual(new Set(SCAM_TYPES));
  });

  it("reports all errors without imposing an invented quality target", async () => {
    const rows = await Promise.all(challenge.items.map(async (item) => {
      const result = await analyzeMessage(item.text, { lang: item.lang, useLlm: false });
      expect(result.mode).toBe("rules");
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(100);
      return { ...item, score: result.riskScore, predicted: result.scamType };
    }));
    for (const lang of ["all", "ru", "kk"]) {
      const group = rows.filter((row) => lang === "all" || row.lang === lang);
      const scam = group.filter((row) => row.label === "scam");
      const legit = group.filter((row) => row.label === "legit");
      const caught = scam.filter((row) => row.score >= HIGH_RISK);
      const hard = legit.filter((row) => row.hardNegative);
      console.log(JSON.stringify({
        lang, caught: `${caught.length}/${scam.length}`,
        falsePositives: `${legit.filter((row) => row.score >= HIGH_RISK).length}/${legit.length}`,
        hardFalsePositives: `${hard.filter((row) => row.score >= HIGH_RISK).length}/${hard.length}`,
        correctTypeAmongCaught: `${caught.filter((row) => row.predicted === row.scamType).length}/${caught.length}`,
        correctTypeAllScam: `${scam.filter((row) => row.predicted === row.scamType).length}/${scam.length}`,
      }));
    }
    console.log("CHALLENGE_RESULTS " + JSON.stringify(rows.map((row) => ({
      id: row.id, score: row.score, actual: row.predicted, expected: row.scamType,
      error: (row.label === "scam") !== (row.score >= HIGH_RISK)
        || (row.label === "scam" && row.predicted !== row.scamType),
    }))));
  });
});
