import { SCAM_TYPES, type ScamType } from "../domain";
import { featurize, type SparseVector } from "./features";

/**
 * Статистическая модель детектора: логистическая регрессия (мошенничество или нет)
 * и полиномиальная логистическая регрессия по типу схемы. Обучается скриптом
 * `npm run train`; веса хранятся в `model-weights.json` в разреженном виде.
 */

export interface LinearModel {
  bias: number;
  /** [индекс признака, вес] — только ненулевые после отсечения. */
  weights: Array<[number, number]>;
}

export interface ModelWeights {
  version: number;
  trainedOn: string[]; // файлы обучающих данных
  examples: number;
  scam: LinearModel;
  types: Record<ScamType, LinearModel>;
}

export interface ModelVerdict {
  probability: number; // вероятность мошенничества 0–1
  scamType: ScamType | null;
}

export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** Скомпилированная модель: быстрый доступ к весам по индексу. */
export class CompiledModel {
  private readonly scam: { bias: number; w: Map<number, number> };
  private readonly types: Array<{ type: ScamType; bias: number; w: Map<number, number> }>;

  constructor(readonly weights: ModelWeights) {
    this.scam = { bias: weights.scam.bias, w: new Map(weights.scam.weights) };
    this.types = SCAM_TYPES.map((type) => ({
      type,
      bias: weights.types[type].bias,
      w: new Map(weights.types[type].weights),
    }));
  }

  private static dot(x: SparseVector, w: Map<number, number>, bias: number): number {
    let z = bias;
    for (const [i, v] of x) z += v * (w.get(i) ?? 0);
    return z;
  }

  predict(text: string): ModelVerdict {
    const x = featurize(text);
    const probability = sigmoid(CompiledModel.dot(x, this.scam.w, this.scam.bias));
    let best: { type: ScamType; z: number } | null = null;
    for (const t of this.types) {
      const z = CompiledModel.dot(x, t.w, t.bias);
      if (!best || z > best.z) best = { type: t.type, z };
    }
    return { probability, scamType: best?.type ?? null };
  }
}
