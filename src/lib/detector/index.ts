import { HIGH_RISK, type AnalysisResult, type Language } from "../domain";
import { maskSensitive } from "../privacy";
import { askLlm, llmConfigured, type LlmVerdict } from "./llm";
import { CompiledModel, type ModelVerdict, type ModelWeights } from "./model";
import weights from "./model-weights.json";
import { detectLanguage, evaluateRules, type RuleResult } from "./rules";

/**
 * Детектор — единая точка входа для `/api/analyze`, мока приложения и eval.
 *
 * Три слоя:
 * 1. Правила — всегда: быстро, без сети, объяснимо; однозначные признаки дают нижнюю границу риска.
 * 2. Статистическая модель (символьные n-граммы, `npm run train`) — всегда: ловит
 *    перефразированные схемы, которые правила пропускают. Работает локально, бесплатно.
 * 3. LLM — если настроена: уточняет скор и добавляет объяснения. При любой ошибке LLM
 *    результат даёт локальный слой (правила + модель) — `mode: "rules"`.
 */
export interface AnalyzeOptions {
  /** Язык, если известен; иначе определяется автоматически. */
  lang?: Language;
  /** Разрешить вызов LLM (по умолчанию — если задан ANTHROPIC_API_KEY). */
  useLlm?: boolean;
  /** Подмена вызова LLM (для тестов). */
  llm?: (maskedText: string, lang: Language) => Promise<LlmVerdict | null>;
  /** Использовать статистическую модель (по умолчанию да). */
  useModel?: boolean;
  /** Подмена модели (для тестов и честной оценки на отложенных данных). */
  model?: CompiledModel;
}

const defaultModel = new CompiledModel(weights as unknown as ModelWeights);

/**
 * Калибровка вероятности модели в риск-скор: порог MODEL_THRESHOLD (подобран перекрёстной
 * проверкой на обучающих данных) соответствует высокому риску (70).
 */
export const MODEL_THRESHOLD = 0.6;

export function modelRisk(probability: number): number {
  const p = Math.max(0, Math.min(1, probability));
  const score = p >= MODEL_THRESHOLD ? HIGH_RISK + ((p - MODEL_THRESHOLD) / (1 - MODEL_THRESHOLD)) * 30 : (p / MODEL_THRESHOLD) * (HIGH_RISK - 1);
  return Math.round(score);
}

/** Защитные признаки правил (настоящее уведомление банка, вопрос «это мошенники?») снижают вес модели. */
const PROTECTIVE = new Set(["protective_code_warning", "official_channel", "asks_about_scam", "warning_context"]);
const PROTECTIVE_PENALTY = 30;

/** Локальный вердикт: правила + модель. */
/** Модель учитывается, только если уверена и текст не слишком короткий (на «Привет.» сигнала нет). */
export const MODEL_MIN_PROBABILITY = 0.5;
export const MODEL_MIN_WORDS = 4;

export function combineLocal(rules: RuleResult, model: ModelVerdict | null, text = ""): RuleResult {
  if (!model || model.probability < MODEL_MIN_PROBABILITY) return rules;
  if (text && text.trim().split(/\s+/u).length < MODEL_MIN_WORDS) return rules;
  const protective = rules.signals.some((s) => PROTECTIVE.has(s));
  let fromModel = Math.max(0, modelRisk(model.probability) - (protective ? PROTECTIVE_PENALTY : 0));
  // Два независимых сигнала: без подтверждения правил (ни одного признака мошенничества)
  // модель даёт только предупреждение, но не вмешательство.
  const corroborated = rules.signals.some((s) => !PROTECTIVE.has(s));
  if (!corroborated) fromModel = Math.min(fromModel, HIGH_RISK - 1);
  if (fromModel <= rules.score) return rules;

  const score = Math.min(100, fromModel);
  const reasons = [...rules.reasons];
  if (score >= 40) {
    reasons.push(
      `Текст похож на известные мошеннические сообщения (статистическая модель, уверенность ${Math.round(model.probability * 100)}%)`,
    );
  }
  return {
    ...rules,
    score,
    scamType: score >= 40 ? (rules.scamType ?? model.scamType) : null,
    reasons: score >= 40 ? reasons : [],
    // model_type — тип схемы назван моделью, а не правилами (LLM его может уточнить)
    signals: [...rules.signals, "model", ...(rules.scamType ? [] : ["model_type"])],
  };
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

  // Приоритет типа: правила → LLM → статистическая модель
  const rulesType = rules.signals.includes("model_type") ? null : rules.scamType;
  const scamType = riskScore >= 40 ? (rulesType ?? llm.scamType ?? rules.scamType) : null;
  return { riskScore, scamType, reasons: riskScore >= 40 ? reasons.slice(0, MAX_REASONS) : [], mode: "hybrid" };
}

export async function analyzeMessage(text: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const lang = options.lang ?? detectLanguage(text);
  const model = options.useModel === false ? null : (options.model ?? defaultModel).predict(text);
  const rules = combineLocal(evaluateRules(text), model, text);

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
