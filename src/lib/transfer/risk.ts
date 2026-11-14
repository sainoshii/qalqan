import { HIGH_RISK, type AnalysisResult } from "../domain";

/**
 * Оценка перевода перед подтверждением. Обычный антифрод видит штатную операцию;
 * здесь к ней добавляется контекст: что клиенту писали или говорили незадолго до
 * перевода, новый ли получатель и насколько крупная сумма.
 */
export interface TransferContext {
  amount: number; // тенге
  newRecipient: boolean;
  message: AnalysisResult | null; // анализ недавнего сообщения/звонка, если есть
  /**
   * Сигнал устройства: во время перевода идёт телефонный разговор. Так мошенники
   * «ведут» клиента. Это независимый от текста сигнал (в продукте — от ОС телефона
   * с согласия клиента; в демо — переключатель).
   */
  onCall?: boolean;
}

export type TransferDecision = "allow" | "warn" | "intervene";

export interface TransferAssessment {
  decision: TransferDecision;
  riskScore: number; // 0–100
  reasons: string[];
}

export const LARGE_AMOUNT = 500_000;
export const VERY_LARGE_AMOUNT = 1_000_000;
export const WARN_RISK = 40;

export const ON_CALL_BONUS = 20;
export const ON_CALL_REASON = "Во время перевода идёт телефонный разговор — так мошенники диктуют, что нажимать";
export const ON_CALL_NEW_RECIPIENT_RISK = 45;

export function assessTransfer({ amount, newRecipient, message, onCall = false }: TransferContext): TransferAssessment {
  const messageRisk = message?.riskScore ?? 0;
  let riskScore = messageRisk;
  const reasons: string[] = [];

  if (messageRisk >= WARN_RISK) {
    reasons.push(...(message?.reasons ?? []));
    // Контекст усиливает подозрение, только когда оно уже есть
    if (newRecipient) {
      riskScore += 15;
      reasons.push("Перевод новому получателю сразу после подозрительного сообщения или звонка");
    }
    if (amount >= LARGE_AMOUNT) {
      riskScore += 10;
      reasons.push("Крупная сумма");
    }
    if (onCall) {
      riskScore += ON_CALL_BONUS;
      reasons.unshift(ON_CALL_REASON);
    }
  } else if (onCall && newRecipient) {
    // Звонок + новый получатель без подозрительного текста — предупреждение, не вмешательство
    riskScore = Math.max(riskScore, ON_CALL_NEW_RECIPIENT_RISK + (amount >= LARGE_AMOUNT ? 10 : 0));
    reasons.push("Перевод новому получателю во время телефонного разговора");
    if (amount >= LARGE_AMOUNT) reasons.push("Крупная сумма");
  } else if (newRecipient && amount >= VERY_LARGE_AMOUNT) {
    // Без подозрительного сообщения — только мягкое предупреждение
    riskScore = Math.max(riskScore, 45);
    reasons.push("Крупный перевод получателю, которому вы раньше не переводили");
  }

  // Правило двух сигналов и для перевода: контекст (новый получатель, сумма) поднимает
  // предупреждение до вмешательства, только если риск сообщения подтверждён правилами или LLM.
  // Риск одной статистической модели (или неизвестного происхождения) остаётся предупреждением.
  // Идущий звонок — второй, независимый от текста сигнал: подозрение модели + звонок достаточно.
  const textEvidence = message?.evidence === "rules" || message?.evidence === "llm";
  const confirmed = textEvidence || (onCall && messageRisk >= WARN_RISK);
  if (!confirmed && messageRisk < HIGH_RISK) riskScore = Math.min(riskScore, HIGH_RISK - 1);
  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));
  const decision: TransferDecision = riskScore >= HIGH_RISK ? "intervene" : riskScore >= WARN_RISK ? "warn" : "allow";
  return { decision, riskScore, reasons: decision === "allow" ? [] : reasons.slice(0, 5) };
}
