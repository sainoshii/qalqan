import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTraining, TRAIN_FILES } from "../scripts/train-model";
import { scoreDataset } from "../scripts/eval";
import { parseDataset, type DatasetItem } from "@/lib/dataset";
import { crossValidate } from "@/lib/detector/train";
import { combineLocal } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";

// Замер на отложенных наборах — только явно (QALQAN_HELD_OUT=1), как в llm-gray-cycle2: обычный check их не мерит.
const HELD_OUT = process.env.QALQAN_HELD_OUT === "1";

describe("train-4 review: aggregate-only audit", () => {
  // Цифры — текущей модели (после train-5, 20 ноября): на challenge-4 ложных предупреждений 25%.
  it.skipIf(!HELD_OUT)("reproduces warning percentages without printing held-out texts", async () => {
    for (const [file, expected] of [["challenge-2", [95, 30]], ["challenge-4", [100, 25]]] as const) {
      const parsed = parseDataset(readFileSync(`data/dataset/${file}.jsonl`, "utf8"));
      expect(parsed.errors.length).toBe(0);
      const rows = await scoreDataset(parsed.items, false);
      for (const lang of ["all", "ru", "kk"]) {
        const group = rows.filter(r => lang === "all" || r.item.lang === lang);
        const rates = ["scam", "legit"].map(label => {
          const selected = group.filter(r => r.item.label === label);
          return Math.round(100 * selected.filter(r => r.riskScore >= 40).length / selected.length);
        });
        console.log(`${file}/${lang}: warning recall/FPR (%)=${rates.join("/")}`);
        if (lang === "all") expect(rates).toEqual(expected);
      }
    }
  });

  it("reports five-fold language and hard-negative metrics before and after train-4", () => {
    // Вклад именно train-4: train-5 (добавлен позже) исключён из обеих выборок
    const withoutLater = TRAIN_FILES.filter(f => !f.endsWith("train-5.jsonl"));
    const old = loadTraining(withoutLater.filter(f => !f.endsWith("train-4.jsonl")));
    const all = loadTraining(withoutLater);
    expect(old.length).toBe(444);
    expect(all.length).toBe(604);
    const oldIds = new Set(old.map(i => i.id));
    // Standard crossValidate reshuffles folds when the dataset grows; these are descriptive,
    // not a paired experiment establishing the cause of any difference.
    for (const [name, items] of [["before", old], ["after", all]] as const) {
      const preds = crossValidate(items, 5);
      const groups: Array<[string, (i: DatasetItem) => boolean]> = [
        ["all", () => true], ["ru", i => i.lang === "ru"], ["kk", i => i.lang === "kk"],
        ["hardNegative", i => !!i.hardNegative],
        ["old-only", i => oldIds.has(i.id)], ["new-only", i => !oldIds.has(i.id)],
      ];
      for (const [layer, threshold] of [["model", 0.6], ["combined", 0.7]] as const) {
        const rows = preds.map(p => ({ item: p.item, score: layer === "model" ? p.probability :
          combineLocal(evaluateRules(p.item.text), p, p.item.text).score / 100 }));
        for (const [group, select] of groups) {
          const selected = rows.filter(r => select(r.item));
          if (!selected.length) continue;
          const rates = ["scam", "legit"].map(label => {
            const subset = selected.filter(r => r.item.label === label);
            const caught = subset.filter(r => r.score >= threshold).length;
            return subset.length ? `${caught}/${subset.length} (${Math.round(100 * caught / subset.length)}%)` : "n/a";
          });
          console.log(`${name}/${layer}/${group}: recall/FPR=${rates.join("; ")}`);
        }
      }
    }
  }, 120_000);
});
