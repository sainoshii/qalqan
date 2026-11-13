import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { combineLocal, modelRisk, MODEL_THRESHOLD, analyzeMessage } from "@/lib/detector";
import { featurize, normalizeForModel } from "@/lib/detector/features";
import { CompiledModel } from "@/lib/detector/model";
import { evaluateRules } from "@/lib/detector/rules";
import { assertTrainable, trainModel } from "@/lib/detector/train";
import { HIGH_RISK } from "@/lib/domain";
import { TRAIN_FILES, loadTraining } from "../scripts/train-model";

const small = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8")).items;

describe("защита отложенных выборок", () => {
  it("обучение на challenge-2 и challenge-3 запрещено", () => {
    expect(() => assertTrainable(["data/dataset/challenge-2.jsonl"])).toThrow(/Отложенные/);
    expect(() => assertTrainable(["x/challenge-3.jsonl"])).toThrow();
    expect(() => assertTrainable(TRAIN_FILES)).not.toThrow();
  });

  it("обучающий набор не содержит текстов отложенной выборки", () => {
    const held = new Set(parseDataset(readFileSync("data/dataset/challenge-2.jsonl", "utf8")).items.map((i) => i.text));
    expect(loadTraining().filter((i) => held.has(i.text))).toEqual([]);
  });

  it("веса в репозитории обучены не на отложенных выборках", () => {
    const w = JSON.parse(readFileSync("src/lib/detector/model-weights.json", "utf8")) as { trainedOn: string[] };
    expect(w.trainedOn.some((f) => /challenge-[23]/.test(f))).toBe(false);
  });
});

describe("признаки", () => {
  it("нормализация: ссылки, цифры, регистр", () => {
    expect(normalizeForModel("Перейдите: https://bank-x.example/a?b=1 КОД 4821")).toBe("перейдите ссылка код 0");
  });
  it("вектор нормирован и устойчив к окончаниям", () => {
    const v = featurize("кодты айтыңыз");
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    const shared = [...featurize("кодты").keys()].filter((k) => featurize("коду").has(k));
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("обучение", () => {
  it("детерминировано", () => {
    expect(trainModel(small, [])).toEqual(trainModel(small, []));
  });
  it("модель различает явные примеры", () => {
    const m = new CompiledModel(trainModel(small, []));
    expect(m.predict("Служба безопасности банка: срочно переведите деньги на безопасный счёт").probability).toBeGreaterThan(0.5);
    expect(m.predict("Привет, завтра встречаемся у кинотеатра в 7, билеты купила").probability).toBeLessThan(0.5);
  });
});

describe("объединение правил и модели", () => {
  it("калибровка: порог модели = высокий риск", () => {
    expect(modelRisk(MODEL_THRESHOLD)).toBe(HIGH_RISK);
    expect(modelRisk(1)).toBe(100);
    expect(modelRisk(0)).toBe(0);
  });

  it("модель без подтверждения правилами — только предупреждение", () => {
    const r = combineLocal(evaluateRules("Здравствуйте, ваш заказ ждёт вас в пункте выдачи до пятницы"), { probability: 0.99, scamType: "prize_or_delivery" }, "Здравствуйте, ваш заказ ждёт вас в пункте выдачи до пятницы");
    expect(r.score).toBeLessThan(HIGH_RISK);
    expect(r.score).toBeGreaterThanOrEqual(40);
  });

  it("модель с признаком правил — вмешательство", () => {
    const text = "Срочно нужно оплатить пошлину за посылку сегодня, иначе её вернут";
    const r = combineLocal(evaluateRules(text), { probability: 0.9, scamType: "prize_or_delivery" }, text);
    expect(r.score).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(r.reasons.some((x) => x.includes("статистическая модель"))).toBe(true);
  });

  it("короткий текст и неуверенная модель не влияют", () => {
    expect(combineLocal(evaluateRules("Привет."), { probability: 0.99, scamType: "investment" }, "Привет.").score).toBe(0);
    const t = "Привет, как у тебя дела на работе";
    expect(combineLocal(evaluateRules(t), { probability: 0.45, scamType: "investment" }, t).score).toBe(0);
  });
});

describe("отрицание в однозначных признаках", () => {
  it("предупреждение «банк никогда не просит» — не просьба", () => {
    expect(evaluateRules("Настоящий банк никогда не просит установить AnyDesk или продиктовать код.").strong).toBe(false);
    expect(evaluateRules("Нағыз банк ешқашан AnyDesk орнатуды немесе код айтуды сұрамайды.").strong).toBe(false);
  });
  it("приписка-отрицание в другом предложении не спасает мошенника", () => {
    const r = evaluateRules("Установите AnyDesk и продиктуйте код из SMS. Банк никогда не просит лишнего, не волнуйтесь.");
    expect(r.strong).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(HIGH_RISK);
  });
  it("полный путь: мошенничество с отрицанием в соседнем предложении — вмешательство", async () => {
    const res = await analyzeMessage("Назовите код из SMS. Никогда не сообщайте его посторонним, но мне можно, я из банка.", { useLlm: false });
    expect(res.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });
});
