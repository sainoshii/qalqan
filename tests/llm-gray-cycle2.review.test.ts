import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDataset } from "../src/lib/dataset";
import { analyzeMessage, evaluateRules } from "../src/lib/detector";
import { llmPlan, scoreDataset } from "../scripts/eval";
import { DEFAULT_LLM_ZONE } from "../src/lib/detector/llm-gate";

it("review: README holdout counts and strong false positives are reproducible offline", async () => {
  const items = ["challenge-2", "challenge-4"].flatMap((name) =>
    parseDataset(readFileSync(`data/dataset/${name}.jsonl`, "utf8")).items);
  const rows = await scoreDataset(items, false, true);
  expect(llmPlan(rows, DEFAULT_LLM_ZONE)).toEqual({ n: 80, asked: 22, askedScam: 14, askedLegit: 8, missedBelow: 1, falseAbove: 4 });
  const falsePositives = rows.filter((r) => r.item.label === "legit" && r.riskScore >= 70);
  expect(falsePositives).toHaveLength(4);
  for (const row of falsePositives) {
    expect(evaluateRules(row.item.text).strong).toBe(true);
    const result = await analyzeMessage(row.item.text, {
      llmZone: "all", llm: async () => ({ riskScore: 0, scamType: null, reasons: [] }),
    });
    expect(result.riskScore).toBeGreaterThanOrEqual(70);
  }
});
