import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";
import { HIGH_RISK, type ScamType } from "@/lib/domain";

/**
 * Казахские правила в любой записи: кириллица, латиница, «упрощённые» буквы, смешанная раскладка.
 * Все сообщения синтетические, написаны для этого теста.
 */
const SIMPLE: Record<string, string> = { ә: "а", ғ: "г", қ: "к", ң: "н", ө: "о", ұ: "у", ү: "у", һ: "х", і: "и" };
const simplified = (t: string) => [...t].map((ch) => SIMPLE[ch] ?? (SIMPLE[ch.toLowerCase()] ? SIMPLE[ch.toLowerCase()].toUpperCase() : ch)).join("");
/** Каждая вторая кириллическая «а/е/о/р/с/х» заменена латинским двойником. */
const HOMO: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", х: "x" };
const mixed = (t: string) => {
  let n = 0;
  return [...t].map((ch) => (HOMO[ch] && n++ % 2 === 0 ? HOMO[ch] : ch)).join("");
};

const SCHEMES: Array<{ type: ScamType; cyrillic: string; latin: string }> = [
  {
    type: "code_request",
    cyrillic: "Сәлеметсіз бе, банктен жазып отырмын. SMS-пен келген кодты маған айтыңыз, әйтпесе картаңыз бұғатталады.",
    latin: "Salemetsiz be, bankten jazyp otyrmyn. SMS-pen kelgen kodty magan aitynyz, aitpese kartanyz bugattalady.",
  },
  {
    type: "safe_account",
    cyrillic: "Ақшаңыз қауіпте, барлығын дереу қауіпсіз шотқа аударыңыз.",
    latin: "Aqshanyz qauipte, barlygyn dereu qauipsiz shotqa audarynyz.",
  },
  {
    type: "fake_security_service",
    cyrillic: "Банктің қауіпсіздік қызметі. Бағдарламаны орнатып, экранды бізге көрсетіңіз.",
    latin: "Bankting qauipsizdik qyzmeti. Bagdarlamany ornatyp, ekrandy bizge korsetiniz.",
  },
  {
    type: "phishing_link",
    cyrillic: "Картаңыз бұғатталды, сілтеме арқылы кіріңіз: bcc-kz-secure.top/unlock",
    latin: "Kartanyz bugattaldy, silteme arqyly kiriniz: bcc-kz-secure.top/unlock",
  },
  {
    type: "official_impersonation",
    cyrillic: "Мен тергеушімін, сізге қылмыстық іс ашылды. Ақшаны дереу қауіпсіз шотқа аударыңыз.",
    latin: "Men tergeushimin, sizge qylmystyq is ashyldy. Aqshany dereu qauipsiz shotqa audarynyz.",
  },
  {
    type: "relative_in_trouble",
    cyrillic: "Апа, менмін, жаңа нөмірден жазып отырмын. Досым жол апатына түсті, шұғыл 50 000 теңге керек, қоңырау шалма.",
    latin: "Apa, menmin, jana nomirden jazyp otyrmyn. Dosym jol apatyna tusti, shugyl 50 000 tenge kerek, qongyrau shalma.",
  },
  {
    type: "investment",
    cyrillic: "Жабық топқа қосылыңыз: кепілдендірілген табыс, күн сайын пайда.",
    latin: "Jabyq topqa qosylynyz: kepildendirilgen tabys, kun saiyn paida.",
  },
  {
    type: "prize_or_delivery",
    cyrillic: "Құттықтаймыз, сіз ұтып алдыңыз! Сыйлықты алу үшін жеткізу ақысын бүгін төлеңіз.",
    latin: "Quttyqtaimyz, siz utyp aldynyz! Syilyqty alu ushin jetkizu aqysyn bugin tolenyz.",
  },
  {
    type: "marketplace",
    cyrillic: "Сатып алушымын, қауіпсіз мәміле арқылы төлеймін, деректерді осында енгізіңіз: olx-pay.top/get",
    latin: "Satyp alushymyn, qauipsiz mamile arqyly toleimin, derekterdi osynda engiziniz: olx-pay.top/get",
  },
];

describe("каждая схема ловится в любой записи (только правила)", () => {
  for (const { type, cyrillic, latin } of SCHEMES) {
    const variants: Array<[string, string]> = [
      ["кириллица", cyrillic],
      ["латиница", latin],
      ["латиница ЗАГЛАВНЫМИ", latin.toUpperCase()],
      ["упрощённые буквы", simplified(cyrillic)],
      ["смешанная раскладка", mixed(cyrillic)],
    ];
    it.each(variants)(`${type}: %s`, (_, text) => {
      const r = evaluateRules(text);
      expect(r.score, r.signals.join(",")).toBeGreaterThanOrEqual(HIGH_RISK);
      expect(r.scamType).toBe(type);
    });
  }
});

describe("«ловушки» не получают однозначного признака (strong) ни в какой записи", () => {
  const TRAPS = [
    // уведомление банка с кодом
    "Растау коды: 4821. Кодты ешкімге айтпаңыз.",
    "Rastau kody: 4821. Kodty eshkimge aitpanyz.",
    "Банк қызметкерлері кодты ешқашан сұрамайды, оны ешкімге айтпаңыз.",
    "Bank qyzmetkerleri kodty eshqashan suramaidy, ony eshkimge aitpanyz.",
    "Кіру коды: 7392. Кодты ешкімге жібермеңіз.",
    "Kiru kody: 7392. Kodty eshkimge jibermeniz.",
    // просьба друга вернуть долг
    "Досым, кеше такси үшін мен төлеп едім. Өз үлесіңді ертең жіберерсің, асықпа.",
    "Dosym, keshe taksi ushin men tolep edim. Oz ulesindi erteng jiberersin, asyqpa.",
    "Апа, түскі асқа 3000 жіберші, әмиянымды үйде ұмытып кетіппін.",
    "Apa, tuski asqa 3000 jibershi, amiyanymdy uide umytyp ketippin.",
    // запрет отправлять код (цикл 1 ревью, C2: префикс «жазып жібер» совпадал с «жазып жібермеңіз»)
    "Кодты оқып жібермеңіз, ол тек сізге арналған.",
    "Kodty oqyp jibermeniz, ol tek sizge arnalgan.",
    "SMS kodty eshkimge jazyp jibermeniz.",
    // похожие слова: «сәнді» (модный) — не «санды» (цифру)
    "Сәнді көйлектің суретін жіберіңізші, бүгін сатып аламын.",
  ];
  const variants = TRAPS.flatMap((t): Array<[string, string]> => [
    ["как есть", t],
    ["упрощённые буквы", simplified(t)],
    ["смешанная раскладка", mixed(t)],
  ]);
  it.each(variants)("%s: %s", async (_, text) => {
    expect(evaluateRules(text).strong).toBe(false);
    expect((await analyzeMessage(text, { useLlm: false })).riskScore).toBeLessThan(HIGH_RISK);
  });
});

describe("подсветка и причины — по исходному тексту", () => {
  it("подсвечен латинский фрагмент как написан, причины — человеческим языком", async () => {
    const text = "Salem! SMS-pen kelgen KODTY magan aitynyz, tez.";
    const r = await analyzeMessage(text, { useLlm: false, useModel: false });
    expect(r.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    const fragments = (r.highlights ?? []).map((h) => text.slice(h.start, h.end));
    expect(fragments.join(" ")).toMatch(/KODTY|aitynyz/);
    for (const f of fragments) expect(text).toContain(f);
    for (const reason of r.reasons) expect(reason).not.toMatch(/кодты|айтыныз/);
  });
});

describe("слово «код»: настоящие формы ловятся, похожие слова — нет (ревью, циклы 2–3)", () => {
  it.each([
    "Кодыңызды маған айтыңыз",
    "Кодтарды жіберіңіз",
    "SMS кодын жазып жіберші",
    "Назовите код из SMS",
    "Продиктуйте коды, которые придут",
    "Kodynyzdy aitynyz",
  ])("требование: %s", (text) => {
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["Кодексті оқыңыз", "Кодек туралы жазыңыз", "Кодталған мәтінді оқыңыз", "Кодер туралы оқыңыз", "Кодты айту керек пе? Жоқ."])(
    "не требование: %s",
    (text) => {
      expect(evaluateRules(text).strong).toBe(false);
    },
  );
});

