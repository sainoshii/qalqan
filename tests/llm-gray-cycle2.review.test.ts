import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDataset } from "../src/lib/dataset";
import { analyzeMessage, evaluateRules } from "../src/lib/detector";
import { llmPlan, scoreDataset } from "../scripts/eval";
import { DEFAULT_LLM_ZONE } from "../src/lib/detector/llm-gate";

/**
 * Замер на отложенных наборах (challenge-2, challenge-4): закреплённые цифры README.
 * Запускается только явно — `QALQAN_HELD_OUT=1 npx vitest run tests/llm-gray-cycle2.review.test.ts`:
 * обычный `npm run check` не должен измерять детектор на отложенных наборах (и показывать их цифры
 * при каждой правке правил). Цифры обновляются вместе с README в точке финального замера.
 */
const HELD_OUT = process.env.QALQAN_HELD_OUT === "1";

it.skipIf(!HELD_OUT)("review: README holdout counts and strong false positives are reproducible offline", async () => {
  const items = ["challenge-2", "challenge-4"].flatMap((name) =>
    parseDataset(readFileSync(`data/dataset/${name}.jsonl`, "utf8")).items);
  const rows = await scoreDataset(items, false, true);
  // Цифры замера после train-5 (2026-11-20, `npm run eval` по challenge-2 и challenge-4)
  expect(llmPlan(rows, DEFAULT_LLM_ZONE)).toEqual({ n: 80, asked: 20, askedScam: 12, askedLegit: 8, missedBelow: 1, falseAbove: 4 });
  const falsePositives = rows.filter((r) => r.item.label === "legit" && r.riskScore >= 70);
  expect(falsePositives).toHaveLength(4);
  // Все 4 дают правила сами — однозначные признаки, LLM их не снизит (связка с моделью после train-5 ушла).
  const byRules = falsePositives.filter((r) => evaluateRules(r.item.text).score >= 70);
  expect(byRules).toHaveLength(4);
  for (const row of byRules) {
    expect(evaluateRules(row.item.text).strong).toBe(true);
    const result = await analyzeMessage(row.item.text, {
      llmZone: "all", llm: async () => ({ riskScore: 0, scamType: null, reasons: [] }),
    });
    expect(result.riskScore).toBeGreaterThanOrEqual(70);
  }
});
