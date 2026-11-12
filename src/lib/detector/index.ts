import type { AnalysisResult, Language } from "../domain";

/**
 * Контракт детектора — единая точка входа для `/api/analyze`, мока приложения и eval.
 *
 * ЭТАП 1: заглушка с фиксированным контрактом, чтобы зоны команды (eval, панель)
 * могли разрабатываться параллельно. ЭТАП 2: правила + LLM с фолбэком.
 */
export interface AnalyzeOptions {
  /** Язык, если известен; иначе определяется автоматически. */
  lang?: Language;
  /** Разрешить вызов LLM (по умолчанию — если задан ANTHROPIC_API_KEY). */
  useLlm?: boolean;
}

export async function analyzeMessage(text: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  void text;
  void options;
  return {
    riskScore: 0,
    scamType: null,
    reasons: [],
    recommendation: "",
    mode: "rules",
  };
}
