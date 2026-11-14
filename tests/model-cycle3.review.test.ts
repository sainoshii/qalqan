import { describe, expect, it } from "vitest";
import { analyzeMessage, evaluateRules } from "@/lib/detector";
import { HIGH_RISK } from "@/lib/domain";

describe("cycle 3: policy scope and quote attribution", () => {
  it.each([
    "Банк не просит ждать и назовите код из SMS",
    "Не спрашивайте зачем и назовите код из SMS",
    "Не верьте мошенникам. Оператор говорит: «Назовите код из SMS».",
    "Не верьте мошенникам. Наша фраза для проверки: «Назовите код из SMS».",
  ])("keeps an executable demand: %s", async (text) => {
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, rules: evaluateRules(text).score, final: result.riskScore }));
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  // Решение лида (вариант A): однозначные требования засчитываются всегда, поэтому памятки,
  // дословно повторяющие требование мошенника, получают тревогу — принятая цена защиты от обходов.
  // Без LLM по смыслу их не отличить.
  it.each([
    "Банк предупреждает: никогда не переводите деньги на безопасный счет.",
    "Не верьте мошенникам. Они говорят: «Назовите код из SMS».",
    "Банк никогда не просит установить AnyDesk.",
  ])("variant A: accepted false alarm on a warning that repeats the demand: %s", async (text) => {
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  it("a Kazakh warning without an imperative demand gets no alarm", async () => {
    expect((await analyzeMessage("Банк кодты айтуды сұрамайды.", { useLlm: false })).riskScore).toBeLessThan(HIGH_RISK);
  });
});
