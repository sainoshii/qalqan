/**
 * Обучение статистической модели детектора.
 *
 *   npm run train              — перекрёстная проверка на обучающих данных + обучение + запись весов
 *   npm run train -- --cv-only — только перекрёстная проверка
 *
 * Обучающие файлы перечислены в TRAIN_FILES. Отложенные выборки (challenge-2, challenge-3)
 * сюда не входят и не могут быть добавлены: проверка в assertTrainable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDataset, type DatasetItem } from "../src/lib/dataset";
import { assertTrainable, crossValidate, trainModel } from "../src/lib/detector/train";
import { combineLocal } from "../src/lib/detector";
import { evaluateRules } from "../src/lib/detector/rules";
import { HIGH_RISK } from "../src/lib/domain";

export const TRAIN_FILES = [
  "data/dataset/messages.jsonl",
  "data/dataset/challenge-1.jsonl",
  "data/dataset/train-2.jsonl",
  "data/dataset/train-3.jsonl", // участник A; пока файла нет — пропускается
];

export function loadTraining(files = TRAIN_FILES): DatasetItem[] {
  assertTrainable(files);
  const items: DatasetItem[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // файл ещё не создан
    }
    const { items: parsed, errors } = parseDataset(text);
    if (errors.length) throw new Error(`${f}:\n${errors.join("\n")}`);
    items.push(...parsed);
  }
  return items;
}

function report(preds: ReturnType<typeof crossValidate>, threshold: number) {
  const scam = preds.filter((p) => p.item.label === "scam");
  const legit = preds.filter((p) => p.item.label === "legit");
  const caught = scam.filter((p) => p.probability >= threshold);
  const fp = legit.filter((p) => p.probability >= threshold);
  const typeOk = caught.filter((p) => p.scamType === p.item.scamType).length;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  return `порог ${threshold}: поймано ${pct(caught.length, scam.length)} (${caught.length}/${scam.length}), ложные ${pct(fp.length, legit.length)} (${fp.length}/${legit.length}), тип ${pct(typeOk, caught.length)}`;
}

function main() {
  const items = loadTraining();
  const files = TRAIN_FILES.filter((f) => {
    try {
      readFileSync(f);
      return true;
    } catch {
      return false;
    }
  });
  console.log(`Обучающих примеров: ${items.length} (${files.join(", ")})`);

  const preds = crossValidate(items, 5);
  console.log("Перекрёстная проверка (5 частей):");
  for (const t of [0.5, 0.6, 0.7]) console.log("  " + report(preds, t));

  // Связка, как в продукте: правила + модель (модель не видела пример), порог riskScore >= 70.
  // Внимание: правила настраивались на этих же данных, поэтому их вклад здесь завышен.
  const combined = preds.map((p) => {
    const r = combineLocal(evaluateRules(p.item.text), { probability: p.probability, scamType: p.scamType }, p.item.text);
    return { ...p, probability: r.score / 100, scamType: r.scamType };
  });
  console.log("Правила + модель (перекрёстная проверка модели):");
  console.log("  " + report(combined, HIGH_RISK / 100));

  if (process.argv.includes("--cv-only")) return;
  const weights = trainModel(items, files);
  const path = "src/lib/detector/model-weights.json";
  writeFileSync(path, JSON.stringify(weights));
  const size = Math.round(JSON.stringify(weights).length / 1024);
  console.log(`Записано: ${path} (${size} КБ, ненулевых весов: ${weights.scam.weights.length})`);
}

if (process.argv[1]?.endsWith("train-model.ts")) main();
