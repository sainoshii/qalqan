/**
 * Обучение статистической модели детектора.
 *
 *   npm run train              — перекрёстная проверка на обучающих данных + обучение + запись весов
 *   npm run train -- --cv-only — только перекрёстная проверка
 *
 * Обучающие файлы перечислены в TRAIN_FILES. Отложенные выборки (challenge-2, challenge-3, challenge-4)
 * сюда не входят и не могут быть добавлены: проверка в assertTrainable.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { parseDataset, type DatasetItem } from "../src/lib/dataset";
import { HELD_OUT_FILES, assertTrainable, crossValidate, trainModel } from "../src/lib/detector/train";
import { combineLocal } from "../src/lib/detector";
import { evaluateRules } from "../src/lib/detector/rules";
import { HIGH_RISK } from "../src/lib/domain";
import { heldOutRepresentations, matchesHeldOut } from "../src/lib/feedback";

export const TRAIN_FILES = [
  "data/dataset/messages.jsonl",
  "data/dataset/challenge-1.jsonl",
  "data/dataset/train-2.jsonl",
  "data/dataset/train-3.jsonl", // участник A
  "data/dataset/train-4.jsonl", // участник A, казахский и латиница (PR #2, 19 ноября)
  "data/dataset/train-5.jsonl", // лид: 70 обычных казахских сообщений о деньгах, учёбе, банке (20 ноября)
  "data/dataset/feedback.jsonl", // решения аналитиков: npm run feedback:export; нет файла — пропускается
];

const HELD_OUT_PATHS = HELD_OUT_FILES.map((f) => `data/dataset/${f}`);
export const normText = (t: string) => t.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/**
 * Защита отложенных выборок не только по имени: файл-ссылка (symlink) или копия под другим
 * именем тоже отклоняются — по реальному пути и по совпадению текстов.
 */
export function heldOutGuard() {
  const real = new Set<string>();
  const texts = new Set<string>();
  for (const f of HELD_OUT_PATHS) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
      real.add(realpathSync(f));
    } catch (err) {
      // набора нет (challenge-3 не создавался) — пропускаем; любая другая ошибка — стоп
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const { items, errors } = parseDataset(content);
    if (errors.length) throw new Error(`Отложенная выборка ${f} некорректна — защита от утечки невозможна:\n${errors.join("\n")}`);
    // Тексты могут попасть в обучение замаскированными или обрезанными (из базы) — храним все представления
    for (const item of items) for (const r of heldOutRepresentations(item.text)) texts.add(r);
  }
  return { real, texts };
}

export function loadTraining(files = TRAIN_FILES): DatasetItem[] {
  assertTrainable(files);
  const guard = heldOutGuard();
  const items: DatasetItem[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // файл ещё не создан
    }
    if (guard.real.has(realpathSync(f))) throw new Error(`Отложенная выборка под другим именем: ${f}`);
    const { items: parsed, errors } = parseDataset(text);
    if (errors.length) throw new Error(`${f}:\n${errors.join("\n")}`);
    const leaked = parsed.filter((i) => matchesHeldOut(i.text, guard.texts));
    if (leaked.length) throw new Error(`Отложенные тексты в обучающем файле ${f}: ${leaked.map((i) => i.id).join(", ")}`);
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
