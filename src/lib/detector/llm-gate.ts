import { HIGH_RISK } from "../domain";

/**
 * Когда вызывать LLM. LLM — самый медленный (сотни миллисекунд и больше) и платный слой,
 * поэтому её спрашивают только там, где локальный вердикт (правила + модель) не уверен:
 *
 * - риск в зоне («серая зона», по умолчанию 30–69) — LLM уточняет;
 * - ниже и выше зоны — локальный вердикт остаётся как есть.
 *
 * Это компромисс между ценой/задержкой и полнотой: вне зоны LLM не исправит ни пропуск
 * мошенничества с риском ниже 30, ни ложное срабатывание от 70. Риск от 70 не всегда
 * означает однозначный признак (`strong`): запрет снижать оценку ниже правил действует
 * только для однозначных признаков, а без них LLM в режиме «all» могла бы риск снизить.
 * На отложенных наборах (challenge-2, -4) все 4 ложных срабатывания от 70 — однозначные
 * признаки, которые LLM снизить и не могла бы; пропуск ниже зоны — 1. `npm run eval`
 * печатает этот расчёт для любого набора.
 *
 * Зона задаётся `QALQAN_LLM_ZONE`: «30-69» (по умолчанию), «all» — для каждого сообщения.
 */
export type LlmZone = { min: number; max: number } | "all";

export const DEFAULT_LLM_ZONE = { min: 30, max: HIGH_RISK - 1 } as const;

export function parseLlmZone(value: string | undefined): LlmZone {
  const v = value?.trim().toLowerCase();
  if (!v) return DEFAULT_LLM_ZONE;
  if (v === "all") return "all";
  const m = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(v);
  if (!m) return DEFAULT_LLM_ZONE;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min > max || max > 100) return DEFAULT_LLM_ZONE;
  return { min, max };
}

export function llmZoneFromEnv(): LlmZone {
  return parseLlmZone(process.env.QALQAN_LLM_ZONE);
}

export function inLlmZone(localRisk: number, zone: LlmZone): boolean {
  return zone === "all" || (localRisk >= zone.min && localRisk <= zone.max);
}

export function describeLlmZone(zone: LlmZone): string {
  return zone === "all" ? "all" : `${zone.min}-${zone.max}`;
}

/**
 * Автоотключение: после FAILURE_LIMIT сбоев подряд (таймаут, ошибка API) LLM не вызывается
 * PAUSE_MS — иначе при недоступном API каждый запрос ждал бы таймаута. Состояние — в памяти
 * экземпляра процесса; первый успешный ответ сбрасывает счётчик.
 */
export const FAILURE_LIMIT = 3;
export const PAUSE_MS = 60_000;

export class LlmBreaker {
  private failures = 0;
  private pausedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  open(): boolean {
    return this.now() < this.pausedUntil;
  }

  success() {
    this.failures = 0;
    this.pausedUntil = 0;
  }

  failure() {
    this.failures += 1;
    if (this.failures >= FAILURE_LIMIT) {
      this.pausedUntil = this.now() + PAUSE_MS;
      this.failures = 0;
    }
  }
}

export const llmBreaker = new LlmBreaker();
