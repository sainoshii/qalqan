import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules, SIGNALS } from "@/lib/detector/rules";

// Independent synthetic cases; no held-out datasets or network calls.
const ordinary = [
  "Кураторға төлем туралы түбіртекті жіберіңіз, сабаққа тіркелу үшін керек.",
  "Менеджерге ақша туралы мақаланы жіберіңіз, аудармасын тексереміз.",
  "Қолдауға жазба жіберіңіз, маман мәселені шешеді.",
  "Қолдауға жазбаша өтініш жіберіңіз, ақшаңызды қайтару үшін керек.",
  "Әкеңе айтпа, туған күніне сыйлық алу үшін ақша жинап жатырмыз.",
  "Апа, менің картама 5 мың жіберші, азық-түлік аламын.",
  "Жүргізушіге жол ақысын төлеңіз, автобус билетін алыңыз.",
  "Ұйымдастырушыға қатысу жарнасын төлеңіз, шахмат турнирі ертең басталады.",
  "Кепілді 15% табыс жоқ, инвестицияда шығын болуы мүмкін.",
  "Бұл депозитте тәуекел жоқ деп айта алмаймыз, шарттарын оқыңыз.",
  "Сақтандыру ақысын ресми қосымшада төлеңіз, полис дайын болады.",
  "Анықтама алу үшін мемлекеттік бажды eGov арқылы төлеңіз.",
  "Кураторға төлем туралы есепті жіберіңіз, бүгін тексеру үшін қажет.",
  "Қаражатты қайтару үшін менеджерге түбіртекті жіберіңіз.",
];

describe("cycle 3: ordinary Kazakh messages", () => {
  it.each(ordinary)("no intervention: %s", async (text) => {
    const rules = evaluateRules(text);
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, signals: rules.signals, risk: result.riskScore }));
    expect(result.riskScore).toBeLessThan(70);
  });
});

describe("cycle 3: performance", () => {
  it("matches 5000-character numeric near misses within two seconds", () => {
    const inputs = ["1 ".repeat(2500), "1234567890".repeat(500), "кураторға " + "1 ".repeat(2495)];
    const start = performance.now();
    for (const text of inputs) {
      evaluateRules(text);
      for (const signal of SIGNALS.filter((s) => ["transfer_demand", "upfront_fee", "personal_money_request", "income_promise", "secrecy"].includes(s.id))) {
        for (const pattern of signal.patterns) pattern.test(text);
      }
    }
    console.log(`Cycle 3 long inputs: ${(performance.now() - start).toFixed(1)} ms`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
