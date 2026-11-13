import { SCAM_TYPES, type ScamType } from "../domain";
import type { DatasetItem } from "../dataset";
import { featurize, type SparseVector } from "./features";
import { CompiledModel, sigmoid, type LinearModel, type ModelWeights } from "./model";

/**
 * Обучение модели (детерминированное). Используется скриптом `npm run train` и тестами.
 * Отложенная выборка `challenge-2` в обучение не попадает никогда — проверка в
 * `assertTrainable` и в тестах.
 */

export const HELD_OUT_FILES = ["challenge-2.jsonl", "challenge-3.jsonl", "challenge-4.jsonl"];

export function assertTrainable(files: string[]): void {
  const bad = files.filter((f) => HELD_OUT_FILES.some((h) => f.endsWith(h)));
  if (bad.length) throw new Error(`Отложенные выборки нельзя использовать для обучения: ${bad.join(", ")}`);
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  /** Веса меньше по модулю отбрасываются при сохранении (размер файла). */
  prune?: number;
  /** Сколько самых значимых весов оставить в модели «мошенничество / нет». */
  maxWeights?: number;
  /** Сколько самых значимых весов оставить в каждой модели типа схемы. */
  maxTypeWeights?: number;
  seed?: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], r: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Бинарная логистическая регрессия, SGD с L2. Классы взвешены по частоте. */
function trainBinary(data: Array<{ x: SparseVector; y: 0 | 1 }>, o: Required<TrainOptions>, keep: number): LinearModel {
  const w = new Map<number, number>();
  let bias = 0;
  const pos = data.filter((d) => d.y === 1).length;
  const neg = data.length - pos;
  const cw = { 1: pos ? data.length / (2 * pos) : 1, 0: neg ? data.length / (2 * neg) : 1 };
  const r = rng(o.seed);

  for (let epoch = 0; epoch < o.epochs; epoch++) {
    const lr = o.learningRate / (1 + epoch * 0.1);
    for (const { x, y } of shuffle(data, r)) {
      let z = bias;
      for (const [i, v] of x) z += v * (w.get(i) ?? 0);
      const g = (sigmoid(z) - y) * cw[y];
      for (const [i, v] of x) {
        const wi = w.get(i) ?? 0;
        w.set(i, wi - lr * (g * v + o.l2 * wi));
      }
      bias -= lr * g;
    }
  }
  const weights = [...w.entries()]
    .filter(([, v]) => Math.abs(v) >= o.prune)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, keep)
    .map(([i, v]) => [i, Math.round(v * 1e4) / 1e4] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return { bias: Math.round(bias * 1e4) / 1e4, weights };
}

export function trainModel(items: DatasetItem[], trainedOn: string[], options: TrainOptions = {}): ModelWeights {
  assertTrainable(trainedOn);
  const o: Required<TrainOptions> = { epochs: 40, learningRate: 0.5, l2: 1e-4, prune: 0.002, maxWeights: 12000, maxTypeWeights: 1200, seed: 20261120, ...options };
  const data = items.map((i) => ({ x: featurize(i.text), item: i }));

  const scam = trainBinary(
    data.map((d) => ({ x: d.x, y: d.item.label === "scam" ? 1 : 0 })),
    o,
    o.maxWeights,
  );

  // Тип схемы: один-против-остальных только среди мошеннических примеров
  const scams = data.filter((d) => d.item.label === "scam");
  const types = Object.fromEntries(
    // Для 9 моделей типа хранится меньше весов (размер файла)
    SCAM_TYPES.map((t) => [t, trainBinary(scams.map((d) => ({ x: d.x, y: d.item.scamType === t ? 1 : 0 })), o, o.maxTypeWeights)]),
  ) as Record<ScamType, LinearModel>;

  return { version: 1, trainedOn, examples: items.length, scam, types };
}

/** k-кратная перекрёстная проверка: предсказания для каждого примера моделью, не видевшей его. */
export function crossValidate(items: DatasetItem[], k = 5, options: TrainOptions = {}) {
  const r = rng(options.seed ?? 7);
  const order = shuffle(
    items.map((_, i) => i),
    r,
  );
  const fold = new Map(order.map((idx, pos) => [idx, pos % k]));
  const predictions: Array<{ item: DatasetItem; probability: number; scamType: ScamType | null }> = [];
  for (let f = 0; f < k; f++) {
    const train = items.filter((_, i) => fold.get(i) !== f);
    const test = items.filter((_, i) => fold.get(i) === f);
    const model = new CompiledModel(trainModel(train, [], options));
    for (const item of test) predictions.push({ item, ...model.predict(item.text) });
  }
  return predictions;
}
