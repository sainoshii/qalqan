import { HIGH_RISK, type AnalysisResult, type Language } from "../domain";
import { maskSensitive } from "../privacy";
import { askLlm, llmConfigured, type LlmVerdict } from "./llm";
import { detectLanguage, evaluateRules, type RuleResult } from "./rules";

/**
 * Детектор — единая точка входа для `/api/analyze`, мока приложения и eval.
 *
 * Гибрид: правила считаются всегда (быстро, без сети, объяснимо); если LLM настроена
 * и разрешена, её оценка уточняет скор и добавляет объяснения. При любой ошибке LLM
 * (нет ключа, таймаут, отказ, сбой сети) возвращается результат правил — `mode: "rules"`.
 */
export interface AnalyzeOptions {
  /** Язык, если известен; иначе определяется автоматически. */
  lang?: Language;
  /** Разрешить вызов LLM (по умолчанию — если задан ANTHROPIC_API_KEY). */
  useLlm?: boolean;
  /** Подмена вызова LLM (для тестов). */
  llm?: (maskedText: string, lang: Language) => Promise<LlmVerdict | null>;
}

const RECOMMENDATIONS = {
  high: "Не переводите деньги и не сообщайте коды. Завершите разговор и сами позвоните в банк по номеру на обороте карты.",
  medium:
    "Не спешите. Проверьте информацию через официальное приложение банка или по номеру на обороте карты, прежде чем что-либо делать.",
  low: "Явных признаков мошенничества не найдено. Всё равно никому не сообщайте коды из SMS и данные карты.",
} as const;

const MAX_REASONS = 5;
/** С какой оценки вердикт LLM считается уверенным. */
const LLM_CONFIDENT = 80;

/** Объединение оценок правил и LLM. */
export function combine(rules: RuleResult, llm: LlmVerdict | null): Omit<AnalysisResult, "recommendation"> {
  if (!llm) {
    return { riskScore: rules.score, scamType: rules.scamType, reasons: rules.reasons.slice(0, MAX_REASONS), mode: "rules" };
  }

  let riskScore = Math.round(0.3 * rules.score + 0.7 * llm.riskScore);
  // Однозначный признак (просят код, «безопасный счёт»…) LLM не может «отменить»:
  // это защита и от ошибки модели, и от текста, который пытается ею управлять.
  if (rules.strong && rules.score >= HIGH_RISK) riskScore = Math.max(riskScore, rules.score);
  // Уверенный вердикт LLM с названной схемой достаточен для высокого риска, даже если
  // правила ничего не нашли: перефразированные схемы правила пропускают.
  if (llm.riskScore >= LLM_CONFIDENT && llm.scamType) riskScore = Math.max(riskScore, HIGH_RISK);
  riskScore = Math.max(0, Math.min(100, riskScore));

  const reasons = [...rules.reasons];
  for (const r of llm.reasons) {
    if (reasons.length >= MAX_REASONS) break;
    if (!reasons.some((x) => x.toLowerCase() === r.toLowerCase())) reasons.push(r);
  }

  const scamType = riskScore >= 40 ? (rules.scamType ?? llm.scamType) : null;
  return { riskScore, scamType, reasons: riskScore >= 40 ? reasons.slice(0, MAX_REASONS) : [], mode: "hybrid" };
}

export async function analyzeMessage(text: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const lang = options.lang ?? detectLanguage(text);
  const rules = evaluateRules(text);

  const useLlm = options.useLlm ?? (options.llm !== undefined || llmConfigured());
  let verdict: LlmVerdict | null = null;
  if (useLlm) {
    try {
      // В LLM уходит только замаскированный текст
      verdict = await (options.llm ?? askLlm)(maskSensitive(text), lang);
    } catch {
      verdict = null; // фолбэк на правила
    }
  }

  const combined = combine(rules, verdict);
  const level = combined.riskScore >= HIGH_RISK ? "high" : combined.riskScore >= 40 ? "medium" : "low";
  return { ...combined, recommendation: RECOMMENDATIONS[level] };
}

export { detectLanguage, evaluateRules } from "./rules";
