import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules, SIGNALS } from "@/lib/detector/rules";

// Independent synthetic examples only; no dataset access or network.
const ordinary = [
  "Депозит бойынша жылдық 15% табыс аласыз, шартты банк бөлімшесінде оқыңыз.",
  "Банк депозитіне кепілді 14% жылдық сыйақы есептеледі.",
  "Депозиттің жылдық мөлшерлемесі 16%, тәуекел жоқ деп айту дұрыс емес.",
  "Инвестицияда риск жоқ деген сөзге сенуге болмайды, ақшаны жоғалтуға болады.",
  "Дүкенде 20% пайда қалды, қалғаны тауар мен жалдау шығынына кетті.",
  "Компанияның есебінде 12% таза пайда көрсетілген, құжатты бухгалтер тексерді.",
  "Жаттығуда қайталау санын екі есе көбейт, бапкер бақылап тұрады.",
  "Жеңілдік кезінде сатылым екі есе өсті, қоймада тауар аз қалды.",
  "Бұл есепте минус болмайды, тек оң сандарды қосамыз.",
  "Жөндеуге гарант береміз, ақауы болса тегін түзетеміз.",
  "Грантқа құжат тапсырдым, гарант керек емес.",
  "Аға, түскі асқа 3 мың салшы, ертең бірге тамақтанамыз.",
  "Досым, 7 мың жіберші, кешегі билет ақысын бөлісейік.",
  "Апа, 12 мың аударшы, дүкеннен азық-түлік аламын.",
  "Тортқа 5 мың сала тұршы, туған күнге сыйлық дайындаймыз.",
  "Маған 2 мың жіберші, кешке қайтарам.",
  "Бүгін 10 мың салшы, ертең қайтарам, жалақым кешігіп жатыр.",
  "Депозитке 20 мың сал, бір жылдан кейін 23 мың аласың, шарт банк бөлімшесінде бар.",
  "Ойынның ұпайын екі есе көбейт, бұл ақша емес.",
  "Кепілді 10% табыс болмайды, нарық құбылып тұрады.",
];

describe("narrow review: ordinary messages with actual local model", () => {
  // Решение лида после цикла: шаблон «N мың салшы» убран; этот случай — регрессия, а не изоляция бага.
  it("C1 fixed: a cake collection gets no rule signal and no intervention", async () => {
    const text = "Тортқа 5 мың сала тұршы, туған күнге сыйлық дайындаймыз.";
    expect(evaluateRules(text).signals).toEqual([]);
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeLessThan(70);
  });
  it.each(ordinary)("no intervention: %s", async (text) => {
    const rules = evaluateRules(text);
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, signals: rules.signals, risk: result.riskScore }));
    expect(result.riskScore).toBeLessThan(70);
  });
});

describe("narrow review: performance", () => {
  it("bounds numeric near misses and repeated investment prefixes at 5000 characters", () => {
    const patterns = SIGNALS.filter(s => ["personal_money_request", "income_promise"].includes(s.id)).flatMap(s => s.patterns);
    const inputs = ["1234567890".repeat(500), "1 ".repeat(2500), "1".repeat(4999) + "%",
      "салшы " + "1 ".repeat(2497), "20 мың сал ".repeat(500).slice(0, 5000)];
    const start = performance.now();
    for (const text of inputs) {
      evaluateRules(text);
      for (const pattern of patterns) pattern.test(text);
    }
    const elapsed = performance.now() - start;
    console.log(`Narrow review adversarial matching: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
