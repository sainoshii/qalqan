import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules, SIGNALS } from "@/lib/detector/rules";

// Independently written synthetic inputs only. No datasets, network or LLM.
const ordinary = [
  "Кешкі ас үшін менің картама аудар, чекті топқа жібердім.",
  "Бөлімшеге бармаңыз, анықтаманы қосымшадан тегін жүктеп алыңыз.",
  "Бөлімшеге барсаңыз, менеджер құжаттарды тексеріп береді.",
  "Сабаққа тіркелу үшін кураторға төлеңіз, оқу келісімшарты беріледі.",
  "Дүкендегі тауар сапасына гарант бар, ақауы болса ауыстырамыз.",
  "Бүгін түскі асқа 2 мың жіберші, бірге тамақтанайық.",
  "Жұмыс кестесін менеджерге жіберіңіз, ертең жиналыста талқылаймыз.",
  "Кураторға есепті жіберіңіз, студенттердің сабаққа қатысуын тексереміз.",
  "Тапсырысты алу үшін кассаға төлеңіз, чек беріледі.",
  "Сақтандыру ақысы шартта көрсетілген, кеңседе кеңес ала аласыз.",
  "Әкеңе айтпа, туған күніне тосын сый дайындап жатырмыз.",
  "Алаяқтардың «минус болмайды» деген уәдесіне сенбеңіз.",
  "Инспекторға өтінішті жіберіңіз, жауап он жұмыс күні ішінде келеді.",
  "Сіздің өтінішіңіз мақұлданды. Бөлімшеге барсаңыз, менеджер құжаттарды береді.",
  "Бөлімшеге барсаңыз, несие алу үшін өтінішті сол жерде рәсімдей аласыз.",
  "Кураторға сабақ кестесін жіберіңіз, төлеу керек емес.",
  "Менің картама аудармаңыз, тапсырыстың ақысын дүкеннің кассасында төлеңіз.",
  "Депозит бойынша кепілді 10% табыс шартта көрсетілген, банк бөлімшесінде кеңес алыңыз.",
];

describe("cycle 1: ordinary Kazakh messages with the real local model", () => {
  it.each(ordinary)("no intervention: %s", async (text) => {
    const rules = evaluateRules(text);
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, rules: rules.score, signals: rules.signals, risk: result.riskScore }));
    expect(result.riskScore).toBeLessThan(70);
  });
});

describe("cycle 1: semantic boundaries and paraphrases", () => {
  it("an invitation to a branch is not secrecy", () => {
    expect(evaluateRules("Бөлімшеге барсаңыз, құжаттарды аласыз.").signals).not.toContain("secrecy");
  });

  it.each([
    "Кураторға мысал жазыңыз, қазақ тілі сабағына керек.",
    "Кураторға есепті жіберіңіз, студенттердің сабаққа қатысуын тексереміз.",
  ])("not a payment demand: %s", (text) => {
    expect(evaluateRules(text).signals).not.toContain("transfer_demand");
  });

  // Цикл 4 (решение лида): казахские шаблоны transfer_demand, secrecy и upfront_fee убраны — за 3 цикла
  // давали ложные вмешательства; их позитивные примеры отсюда удалены, негативные — остались.
  it.each([
    ["income_promise", "Ай сайын 18% таза табыс түседі, шығын болмайды."],
  ])("paraphrased %s: %s", (signal, text) => {
    const result = evaluateRules(text);
    expect(result.signals).toContain(signal);
    expect(result.strong).toBe(false);
  });
});

describe("cycle 1: weak signal invariants", () => {
  it.each(["transfer_demand", "secrecy", "upfront_fee", "personal_money_request", "income_promise"])("%s stays weak and Unicode boundaries are active", (id) => {
    const signal = SIGNALS.find((s) => s.id === id)!;
    expect(signal.weight).toBeLessThanOrEqual(30);
    expect(signal.strong).not.toBe(true);
    for (const pattern of signal.patterns) {
      if (pattern.source.includes("\\p{")) expect(pattern.unicode).toBe(true);
    }
  });

  it("bounded processing of 5000-character adversarial inputs", () => {
    const inputs = ["9".repeat(5000), "а".repeat(5000), "куратор" + "а".repeat(4993), "алу үшін " + "1 ".repeat(2495), "20 мың сал ".repeat(455).slice(0, 5000)];
    const start = performance.now();
    for (const text of inputs) {
      evaluateRules(text);
      // Also exercise uncompressed input: normalization collapses repeated letters.
      for (const signal of SIGNALS.filter((s) => ["transfer_demand", "secrecy", "upfront_fee", "personal_money_request", "income_promise"].includes(s.id))) {
        for (const pattern of signal.patterns) pattern.test(text);
      }
    }
    const elapsed = performance.now() - start;
    console.log(`Five long inputs: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
