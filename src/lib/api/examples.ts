import { analyzeMessage } from "../detector";
import { assessTransfer } from "../transfer/risk";

/**
 * Примеры для страницы /docs. Ответы не пишутся вручную — их вычисляет тот же код, что
 * отвечает в API (без LLM), поэтому документация не может разойтись с поведением сервиса.
 * Тексты вымышлены.
 */
export const ANALYZE_EXAMPLE = {
  text: "Здравствуйте, служба безопасности банка. Срочно переведите деньги на безопасный счёт, никому не говорите.",
};

export const ASSESS_EXAMPLE = {
  amount: 450000,
  newRecipient: true,
  messageText: ANALYZE_EXAMPLE.text,
  onCall: true,
};

/** Сценарии решения по переводу: что меняет каждый сигнал. */
export const DECISION_SCENARIOS: Array<{ title: string; request: { amount: number; newRecipient: boolean; messageText?: string; onCall?: boolean } }> = [
  { title: "Обычный перевод знакомому", request: { amount: 15000, newRecipient: false } },
  { title: "Новому получателю во время звонка, без подозрительного текста", request: { amount: 450000, newRecipient: true, onCall: true } },
  { title: "Звонок «службы безопасности» + новый получатель", request: ASSESS_EXAMPLE },
  {
    title: "Настоящее уведомление банка",
    request: {
      amount: 15000,
      newRecipient: false,
      messageText: "Код для входа: 4821. Никому не сообщайте этот код, сотрудники банка никогда его не спрашивают.",
    },
  },
];

async function assess(request: (typeof DECISION_SCENARIOS)[number]["request"]) {
  const message = request.messageText ? await analyzeMessage(request.messageText, { useLlm: false }) : null;
  return { ...assessTransfer({ amount: request.amount, newRecipient: request.newRecipient, message, onCall: request.onCall }), message };
}

export async function computeExamples() {
  const analyze = await analyzeMessage(ANALYZE_EXAMPLE.text, { useLlm: false });
  const transfer = await assess(ASSESS_EXAMPLE);
  const scenarios = await Promise.all(
    DECISION_SCENARIOS.map(async (s) => {
      const r = await assess(s.request);
      return { title: s.title, decision: r.decision, riskScore: r.riskScore };
    }),
  );
  return { analyze, transfer, scenarios };
}
