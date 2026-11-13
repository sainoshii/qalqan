import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { analyzeMessage, combineLocal } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";
import { trainModel } from "@/lib/detector/train";
import { HIGH_RISK } from "@/lib/domain";
import { assessTransfer } from "@/lib/transfer/risk";
import { loadTraining } from "../scripts/train-model";

describe("model cycle 1: adversarial regressions, separate from challenge-4", () => {
  it.each([
    ["unrelated Russian negation", "Никогда не сомневайтесь в нас, назовите код из SMS"],
    ["unrelated Kazakh negation", "Ешқашан күмәнданбаңыз, кодты айтыңыз"],
    ["newline boundary", "Банк никогда не звонит\nНазовите код из SMS"],
    ["cross-sentence request", "В SMS пришли шесть цифр. Прочитайте их мне для отмены операции."],
    ["warning plus executable quote", "Не верьте мошенникам. Выполните мою инструкцию: «Назовите код из SMS»."],
    ["benign Kazakh word contains warning substring", "Талдау үшін мына нұсқауды орындаңыз: «Кодты айтыңыз»."],
  ])("keeps intervention for %s", async (_name, text) => {
    const rules = evaluateRules(text);
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(`${_name}: rules=${rules.score}, strong=${rules.strong}, signals=${rules.signals.join(",")}, final=${result.riskScore}`);
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  it("model-only warning must not turn into transfer intervention for a new recipient", () => {
    const text = "Здравствуйте, ваш заказ ждёт вас в пункте выдачи до пятницы";
    const rules = evaluateRules(text);
    expect(rules.signals).toEqual([]);
    const local = combineLocal(rules, { probability: 0.99, scamType: "prize_or_delivery" }, text);
    const assessment = assessTransfer({
      amount: 1000,
      newRecipient: true,
      message: { riskScore: local.score, scamType: local.scamType, reasons: local.reasons, recommendation: "", mode: "rules" },
    });
    console.log(`Model-only: message=${local.score}, transfer=${assessment.riskScore}, decision=${assessment.decision}`);
    expect(assessment.decision).not.toBe("intervene");
  });

  it("repository weights must not block a small ordinary transfer without any rule signals", async () => {
    const text = "Вам одобрен возврат платежа, деньги придут на ваш счет после проверки заявления.";
    expect(evaluateRules(text).signals).toEqual([]);
    const message = await analyzeMessage(text, { useLlm: false });
    const assessment = assessTransfer({ amount: 1000, newRecipient: true, message });
    console.log(`Real weights, no rule signals: message=${message.riskScore}, transfer=${assessment.riskScore}, decision=${assessment.decision}`);
    expect(assessment.decision).not.toBe("intervene");
  });

  it.each(["symlink", "copy"])("rejects held-out data accessed through a %s alias", (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "qalqan-heldout-alias-"));
    try {
      const alias = join(dir, "training.jsonl");
      const original = resolve("data/dataset/challenge-2.jsonl");
      if (mode === "symlink") symlinkSync(original, alias);
      else copyFileSync(original, alias);
      expect(() => loadTraining([alias])).toThrow(/Отложенн/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trainModel itself rejects explicitly named held-out data", () => {
    const file = "data/dataset/challenge-2.jsonl";
    const { items } = parseDataset(readFileSync(file, "utf8"));
    expect(() => trainModel(items, [file], { epochs: 1 })).toThrow(/Отложенн/);
  });
});
