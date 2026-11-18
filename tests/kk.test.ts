import { describe, expect, it } from "vitest";
import { demandForms, kk, kkSource } from "@/lib/detector/kk";
import { canonicalize } from "@/lib/detector/normalize";

/**
 * Допуск записи в казахских шаблонах: шаблон пишется в обычной орфографии, а совпадает и с
 * «упрощёнными» буквами, и с латиницей (после нормализации). Все примеры синтетические.
 */
const canon = (t: string) => canonicalize(t).text;
const L = { i: "i", o: "o" }; // латинские буквы-двойники

describe("kk: один шаблон — все способы записи", () => {
  it.each([
    [/қауіпсіз шот/, ["қауіпсіз шот", "кауипсиз шот", "qauipsiz shot", "kauipsiz shot", "qauıpsız şot", `қау${L.i}пс${L.i}з ш${L.o}т`, "қ а у і п с і з шот"]],
    [/кодты айтыңыз/, ["кодты айтыңыз", "кодты айтыныз", "kodty aitynyz", "kodty aytynyz", "kodti aitiniz", "KODTY AITYÑYZ"]],
    [/жіберіңіз/, ["жіберіңіз", "жибериниз", "jiberiniz", "zhiberiniz", "jıberıñız", "jiberingiz"]],
    [/құпиясөз/, ["құпиясөз", "купиясоз", "qupiyasoz", "qupiasoz", "kupiyasoz", "qūpiasöz"]],
    [/бермесеңіз/, ["бермесеңіз", "бермесениз", "bermeseniz", "bermesengiz", "bermeseñiz"]],
    [/ертеңге/, ["ертеңге", "ертенге", "ertenge", "erteñge"]],
    [/үшін/, ["үшін", "ушин", "ushin", "ushyn", "üşın", "uşin"]],
    [/операция/, ["операция", "operaciya", "operatsiya", "operasiya"]],
    [/қою керек/, ["қою керек", "кою керек", "qoyu kerek", "qoiu kerek"]],
    [/пароль/, ["пароль", "парол", "parol"]],
    [/экранды көрсет/, ["экранды көрсет", "екранды корсет", "ekrandy korset", "ekrandi körset"]],
    [/хабарлаңыз/, ["хабарлаңыз", "хабарланыз", "habarlanyz", "xabarlanyz", "khabarlanyz", "һабарлаңыз"]],
    [/ащы/, ["ащы", "ашы", "ashy", "ashchy"]],
  ] as Array<[RegExp, string[]]>)("%s", (pattern, variants) => {
    const tolerant = kk(pattern);
    for (const v of variants) expect(tolerant.test(canon(v)), `${v} → ${canon(v)}`).toBe(true);
  });

  it("шаблон по-прежнему совпадает с тем, с чем совпадал до допуска", () => {
    const phrases = ["қауіпсіз шот", "экранға кіруге рұқсат", "ешкімге айтпаңыз", "кепілдендірілген табыс", "жаңа нөмірден", "ұтып алдыңыз", "картаның артындағы нөмірге"];
    for (const p of phrases) expect(kk(new RegExp(p)).test(p), p).toBe(true);
  });
});

describe("kk: допуск только в одну сторону", () => {
  it("«а» в шаблоне не совпадает с «ә» в тексте: «санды» (цифру) ≠ «сәнді» (модный)", () => {
    expect(kk(/санды/).test("санды")).toBe(true);
    expect(kk(/санды/).test("сәнді")).toBe(false);
    expect(kk(/шот/).test("шөт")).toBe(false);
    expect(kk(/кол/).test("қол")).toBe(false);
    expect(kk(/ун/).test("ұн")).toBe(false);
  });

  it("а вот «ә» в шаблоне совпадает с упрощённым «а»", () => {
    expect(kk(/сәнді/).test("санди")).toBe(true);
    expect(kk(/қол/).test("кол")).toBe(true);
  });

  it("отрицательная форма не совпадает с повелительной и при допуске", () => {
    const say = kk(/айтыңыз/);
    for (const v of ["айтпаңыз", "aitpanyz", "айтпаныз", "aitpañyz"]) expect(say.test(canon(v)), v).toBe(false);
  });
});

describe("kk: синтаксис выражения не трогается", () => {
  it.each([
    [String.raw`\d+ минут`, String.raw`\d+ м[ыіий]нут`],
    [String.raw`(?<!\p{L})код\p{L}*`, String.raw`(?<!\p{L})код\p{L}*`],
    [String.raw`шот[а-яәғқңөұүһі]*`, String.raw`шот[а-яәғқңөұүһі]*`],
    [String.raw`[^.!?\n]{0,40}төле`, String.raw`[^.!?\n]{0,40}т[өо]ле`],
    ["банк|карта", "банк|карта"],
    [String.raw`парол\ь`, String.raw`парол\ь`],
  ])("%s → %s", (source, want) => {
    expect(kkSource(source)).toBe(want);
  });

  it("квантификатор после буквы с допуском относится ко всей букве", () => {
    const re = kk(/таң?ба/);
    for (const v of ["таба", "таңба", "танба", "тангба"]) expect(re.test(v), v).toBe(true);
    expect(kk(/парольь?/).test("парол")).toBe(true);
  });

  it("флаги сохраняются, а исходное выражение не меняется", () => {
    const original = /(?<!\p{L})қауіп/u;
    const tolerant = kk(original);
    expect(tolerant.flags).toBe("u");
    expect(original.source).toBe(String.raw`(?<!\p{L})қауіп`);
    expect(tolerant.test("кауип")).toBe(true);
  });
});

describe("demandForms: просьба и требование от основы глагола", () => {
  const demand = (stem: string) => new RegExp(kkSource(demandForms(stem)), "u");

  it.each([
    ["айт", ["айт", "айтшы", "айтыңыз", "айтыңызшы", "айтыңдар", "айтып бер", "айтып беріңіз", "айтып жіберші", "айта салыңыз", "айта салыңызшы", "айтсаңыз болды", "айтсаңшы", "айту керек", "айтуыңыз керек"]],
    ["жібер", ["жібер", "жіберші", "жіберіңіз", "жіберіңізші", "жіберіп қойыңыз", "жібере салшы", "жібере салыңызшы", "жіберсең болды", "жіберу қажет"]],
    ["жаз", ["жаз", "жазыңыз", "жазып жібер", "жазып жіберіңіз", "жаза салшы"]],
    ["хабарла", ["хабарла", "хабарлаңыз", "хабарлаңызшы", "хабарлап жіберіңіз", "хабарлай салыңыз", "хабарлау керек"]],
    ["төле", ["төле", "төлеңіз", "төлеп жіберіңіз", "төлей салыңыз", "төлесеңіз болды", "төлеу керек", "төлеуіңіз қажет"]],
    ["аудар", ["аудар", "аударшы", "аударыңыз", "аударып жіберіңіз", "аудара салшы", "аудару керек", "аударуыңыз керек"]],
  ] as Array<[string, string[]]>)("%s: формы требования совпадают", (stem, forms) => {
    for (const f of forms) expect(demand(stem).test(f), f).toBe(true);
  });

  it.each([
    ["айт", ["айтпаңыз", "айтпа", "айтпашы", "айтпаңдар", "айтады", "айтты", "айтамын", "айтайын", "айтсын", "айтқан", "айтсаңыз", "айтудың қажеті жоқ", "айту керек емес", "айту керек те емес", "айту қажет те емес", "айту қажет болмады", "айту керек деп ойламаңыз", "айту керек пе", "айту керек жоқ", "айтып берді", "айтып бермеңіз"]],
    ["жібер", ["жібермеңіз", "жіберме", "жіберемін", "жіберем", "жібердім", "жібердік", "жіберейін", "жіберерсің", "жіберген", "жіберіп қойса", "жіберіп қойдым", "жібермеңдер", "жібере алмаймын"]],
    ["төле", ["төлемеңіз", "төлеген", "төлейсіз", "төлеп қойдым", "төлеудің қажеті жоқ", "төлеу қажет емес", "төлем", "төлемі", "төлесе"]],
    ["хабарла", ["хабарламаңыз", "хабарласыңыз", "хабарласпаңыз", "хабарлама", "хабарламасы", "хабарлады"]],
    ["аудар", ["аудармаңыз", "аударым", "аударымды", "аударды", "аударамын", "аударып жіберіппін"]],
  ] as Array<[string, string[]]>)("%s: отрицание, прошедшее, будущее и чужое лицо не совпадают", (stem, forms) => {
    for (const f of forms) expect(demand(stem).test(f), f).toBe(false);
  });

  it("формы требования узнаются в латинице и в упрощённых буквах", () => {
    for (const v of ["aitynyz", "aityñyz", "айтыныз", "aityp beriniz", "aita salynyzshy", "aitu kerek"]) {
      expect(demand("айт").test(canon(v)), `${v} → ${canon(v)}`).toBe(true);
    }
    for (const v of ["jiberiniz", "jibershi", "жибере салшы", "jibere salshy", "zhiberiñiz"]) {
      expect(demand("жібер").test(canon(v)), `${v} → ${canon(v)}`).toBe(true);
    }
    for (const v of ["aitpanyz", "aitpañyz", "jibermeniz", "jibermeñiz", "жибермениз"]) {
      expect(demand("айт").test(canon(v)) || demand("жібер").test(canon(v)), v).toBe(false);
    }
  });

  it("основа внутри другого слова не считается", () => {
    expect(demand("айт").test("қайт")).toBe(false);
    expect(demand("жаз").test("жазда")).toBe(false);
    expect(demand("сал").test("салық")).toBe(false);
  });
});
