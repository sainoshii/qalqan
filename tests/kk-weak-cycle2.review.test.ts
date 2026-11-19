import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules, SIGNALS } from "@/lib/detector/rules";

// Independent synthetic cases; no datasets or external services.
const nonPayments = [
  "Кураторға ақылды оқушы туралы есепті жіберіңіз.",
  "Мыңдаған оқушы туралы кураторға есепті жіберіңіз.",
  "Сомалиец туралы кураторға мәтінді жіберіңіз.",
  "Кураторға ақыл кеңес жазылған хатты жіберіңіз.",
  "Кураторға 2 тапсырманы жіберіңіз.",
];
const nonFees = [
  "Кітапты сақтау үшін оны сөмкеге салып қойыңыз.",
  "Рұқсат алу үшін менеджерге өтінішті жіберіңіз.",
  "Егінді сақтау үшін қойма салу керек.",
];

describe("cycle 2: payment semantics", () => {
  it.each(nonPayments)("no transfer demand: %s", (text) => {
    expect(evaluateRules(text).signals).not.toContain("transfer_demand");
  });
  it.each(nonFees)("no upfront fee: %s", (text) => {
    expect(evaluateRules(text).signals).not.toContain("upfront_fee");
  });
  it.each([...nonPayments, ...nonFees,
    "Бөлімшеге бармаңыз, анықтама алу үшін менеджерге өтінішті жіберіңіз.",
    "Ақылды инвестор туралы кураторға мақаланы жіберіңіз, сабақта талқылаймыз.",
    "Сіздің өтінішіңіз мақұлданды, рұқсат алу үшін менеджерге құжаттарды жіберіңіз.",
  ])("ordinary message stays below intervention: %s", async (text) => {
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, signals: evaluateRules(text).signals, risk: result.riskScore }));
    expect(result.riskScore).toBeLessThan(70);
  });
  // Цикл 4 (решение лида): казахские шаблоны «посредник» и «предоплата» убраны — позитивные примеры
  // («payment paraphrases remain detected») удалены; проверки «без сигнала / без вмешательства» выше остались.
});

describe("cycle 2: adversarial performance", () => {
  it("bounded matching of repeated money and middleman prefixes", () => {
    const inputs = ["ақы" + "аб".repeat(2498), "куратор" + "аб".repeat(2496),
      "кураторға ақы ".repeat(400).slice(0, 5000), "1 кураторға ".repeat(500).slice(0, 5000),
      "сақтау үшін ".repeat(500).slice(0, 5000)];
    const affected = SIGNALS.filter((s) => ["transfer_demand", "upfront_fee"].includes(s.id));
    const start = performance.now();
    for (const text of inputs) {
      evaluateRules(text);
      for (const signal of affected) for (const pattern of signal.patterns) pattern.test(text);
    }
    const elapsed = performance.now() - start;
    console.log(`Cycle 2 adversarial inputs: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
