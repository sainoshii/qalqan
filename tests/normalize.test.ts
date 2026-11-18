import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { canonicalize, linkSpans, skeleton } from "@/lib/detector/normalize";
import { SIGNALS, URL_PATTERN } from "@/lib/detector/rules";

/**
 * Нормализация: единая форма текста для правил и модели.
 * Все примеры синтетические. Буквы «чужой» раскладки внутри слова заданы явно через L/C,
 * чтобы при чтении теста латинскую «o» нельзя было спутать с кириллической «о».
 */
const L = { a: "a", c: "c", e: "e", i: "i", o: "o", p: "p", A: "A", B: "B", K: "K", O: "O" };
const C = { o: "о", sh: "ш" };

/** Прежняя нормализация правил (до этой задачи) — эталон для «русский текст не меняется». */
const legacy = (t: string) => t.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

const canon = (t: string) => canonicalize(t).text;

describe("латиница → кириллица", () => {
  it.each([
    ["kodty", "кодты"],
    ["Kodty aitynyz", "кодты айтыныз"],
    ["jiberiniz", "жибериниз"],
    ["zhiberiniz", "жибериниз"],
    ["shotqa", "шотқа"],
    ["qosymsha", "қосымша"],
    ["audarynyz", "аударыныз"],
    ["qupiya soz", "қупия соз"],
    ["silteme", "силтеме"],
    ["qauipsizdik", "қауипсиздик"],
    ["eshkimge aitpanyz", "ешкимге айтпаныз"],
    ["aqsha", "ақша"],
    ["bankten jazyp otyrmyn", "банктен жазып отырмын"],
    ["uaqytsha", "уақытша"],
    ["koyynyz", "койыныз"],
    ["toqtatam", "тоқтатам"],
    ["aiaq", "аяқ"],
    ["qoian", "қоян"],
    ["KODTY", "кодты"],
  ])("казахский без диакритики: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    ["şotyñyz", "шотыңыз"],
    ["būğattalady", "бұғатталады"],
    ["qūpiasöz", "құпиясөз"],
    ["jıberıñız", "жіберіңіз"],
    ["aitpañyz", "айтпаңыз"],
    ["qauıpsız", "қауіпсіз"],
    ["üide", "үйде"],
    ["ädemi", "әдеми"],
  ])("казахская латиница с диакритикой даёт настоящие казахские буквы: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    ["aǵa", "аға"],
    ["sizdiń", "сиздиң"],
    ["ýaqyt", "уақыт"],
    ["Əli", "әли"],
    ["šot", "шот"],
    ["café", "кафе"],
    ["İ kod", "и код"],
  ])("алфавит 2018 года, турецкая и прочая диакритика: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    ["khabar", "хабар"],
    ["aghai", "ағай"],
    ["eshche", "еще"],
    ["click", "клик"],
    ["credit", "кредит"],
    ["tsifry", "цифры"],
    ["ketse aitsa", "кетсе айтса"],
    ["moyu", "мою"],
    ["auyl", "ауыл"],
    ["kiim", "киим"],
    ["garantia", "гарантия"],
  ])("диграфы и чтение i / y / u по соседям: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    ["sluzhba bezopasnosti", "служба безопасности"],
    ["prodiktuite kod", "продиктуйте код"],
    ["na schet", "на счет"],
    ["policiya", "полиция"],
    ["srochno", "срочно"],
    ["dlya vas", "для вас"],
  ])("русский транслит: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it("любые сочетания двух и трёх латинских букв дают только кириллические буквы", () => {
    const letters = [..."abcdefghijklmnopqrstuvwxyz"];
    const asIs = new Set(["sms", "cvv", "cvc", "www"]);
    const bad: string[] = [];
    const check = (word: string) => {
      if (!asIs.has(word) && !/^[а-яәғқңөұүһі]+$/.test(canon(word))) bad.push(`${word} → ${JSON.stringify(canon(word))}`);
    };
    for (const a of letters) {
      for (const b of letters) {
        check(a + b);
        for (const c of letters) check(a + b + c);
      }
    }
    expect(bad).toEqual([]);
  });

  it("латинские слова, на которые опираются правила, остаются как есть", () => {
    expect(canon("Назовите код из SMS")).toBe("назовите код из sms");
    expect(canon("CVV kodty aitynyz")).toBe("cvv кодты айтыныз");
    expect(canon("Установите AnyDesk или RustDesk, TeamViewer")).toBe("установите anydesk или rustdesk, teamviewer");
    expect(canon("SMS-ten kelgen kod")).toBe("sms-тен келген код");
    expect(canon("https:// сайт")).toBe("https:// сайт");
  });
});

describe("скелет: казахские буквы и их упрощения совпадают", () => {
  it.each([
    ["кодты", ["кодты", "kodty", "KODTY", `к${L.o}дты`, "к о д т ы"]],
    ["жибериниз", ["жіберіңіз", "жибериниз", "jiberiniz", "zhiberiniz", `ж${L.i}бер${L.i}ң${L.i}з`, "jıberıñız"]],
    ["кауипсиздик", ["қауіпсіздік", "кауипсиздик", "qauipsizdik", "kauipsizdik", "qauıpsızdık"]],
    ["косымша", ["қосымша", "косымша", "qosymsha", "kosymsha"]],
    ["шотка", ["шотқа", "шотка", "shotqa", "shotka", "şotqa"]],
    ["аударыныз", ["аударыңыз", "аударыныз", "audarynyz", "audaryñyz"]],
    ["купиясоз", ["құпиясөз", "купиясоз", "qupiyasoz", "kupiyasoz", "qūpiasöz"]],
    ["силтеме", ["сілтеме", "силтеме", "silteme", "sılteme"]],
    ["ешкимге айтпаныз", ["ешкімге айтпаңыз", "ешкимге айтпаныз", "eshkimge aitpanyz", "eşkımge aitpañyz"]],
    ["бугатталады", ["бұғатталады", "бугатталады", "bugattalady", "būğattalady"]],
    ["ушин", ["үшін", "ушин", "ushin", "üşın"]],
    ["хабарласыныз", ["хабарласыңыз", "хабарласыныз", "habarlasynyz", "xabarlasynyz"]],
  ] as Array<[string, string[]]>)("%s", (want, variants) => {
    for (const v of variants) expect(skeleton(v), v).toBe(want);
  });

  it("русский текст скелет не меняет", () => {
    expect(skeleton("Назовите код из SMS, это служба безопасности")).toBe("назовите код из sms, это служба безопасности");
  });
});

describe("смешанная раскладка внутри слова", () => {
  it.each([
    [`К${L.o}дты`, "кодты"],
    [`ж${L.i}бер${L.i}ң${L.i}з`, "жіберіңіз"],
    [`п${L.a}р${L.o}ль`, "пароль"],
    [`${L.B}${L.A}Ш ${L.K}${L.O}Д`, "ваш код"],
    [`${L.c}рочн${L.o}`, "срочно"],
    [`б${L.e}зоп${L.a}сный`, "безопасный"],
    [`${L.p}е${L.c}у${L.p}с`, "ресурс"],
    ["HOMEР", "номер"], // латинские H, O, M, E + кириллическая Р
    ["СYMMА", "сумма"], // латинские Y, M, M
    ["TЕKCT", "текст"], // латинские T, K, C, T
  ])("латинские двойники среди кириллицы: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it("заглавная латинская B — двойник «В», а строчная b читается по звучанию", () => {
    expect(canon("Bход")).toBe("вход");
    expect(canon("bанк")).toBe("банк");
  });

  it.each([
    [`ku${C.sh}inde`, "кушинде"],
    [`k${C.o}dty`, "кодты"],
  ])("кириллические буквы среди латиницы: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });
});

describe("регистр, ё, повторы и разделители внутри слов", () => {
  it.each([
    ["СЧЁТ", "счет"],
    ["  Ёлка\n\n  ИДЁТ  ", "елка идет"],
    ["сроооочно", "срочно"],
    ["КОООД", "код"],
    ["sroooochno", "срочно"],
    ["к о д", "код"],
    ["К.О.Д", "код"],
    ["к-о-д", "код"],
    ["к_о_д", "код"],
    ["к*о*д", "код"],
    ["к·о·д", "код"],
    ["Привееет, дааа", "привет, да"],
    ["Назовите к о д из SMS", "назовите код из sms"],
    ["п а р о л ь: 739155", "пароль: 739155"],
    ["k o d t y", "кодты"],
    ["с ч ё т", "счет"],
  ])("%s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    "а я в банке",
    "и я с ним",
    "а у вас как дела",
    "а.с. пушкин",
    "т.е. завтра",
    "ооо «ромашка»",
    "ааа, понял",
    "сообщите, ввести, касса, ботты",
    "к о",
  ])("обычный текст не склеивается и не сжимается: %s", (text) => {
    expect(canon(text)).toBe(text);
  });

  it("невидимые символы и составные буквы", () => {
    expect(canon("ко​д")).toBe("код");
    expect(canon("безо­пас­ный счёт")).toBe("безопасный счет");
    expect(canon("мой счёт")).toBe("мой счет");
    expect(canon("поня́тому")).toBe("понятому");
  });

  it("полноширинные и «математические» буквы", () => {
    expect(canon("ｋｏｄ")).toBe("код");
    expect(canon("\u{1d424}\u{1d428}\u{1d41d}")).toBe("код");
  });
});

describe("сохраняются: пустые строки, эмодзи, ссылки, числа", () => {
  it.each(["", " ", " \n\t ", "  "])("пустая строка: %j", (text) => {
    expect(canonicalize(text)).toEqual({ text: "", map: [] });
  });

  it("эмодзи", () => {
    // ⚠️ — знак «внимание» с невидимым селектором начертания: селектор убирается, знак остаётся
    expect(canon("Срочно \u{1f61f} переведите \u{1f44d}\u{1f3fd} деньги ⚠️")).toBe("срочно \u{1f61f} переведите \u{1f44d}\u{1f3fd} деньги ⚠");
    expect(canon("\u{1f600}")).toBe("\u{1f600}");
  });

  it.each([
    ["Перейдите: https://Bank-KZ-secure.top/Unlock?id=5 и введите код", "перейдите: https://bank-kz-secure.top/unlock?id=5 и введите код"],
    ["подробности на https://www.BCC.kz/cards и egov.kz", "подробности на https://www.bcc.kz/cards и egov.kz"],
    ["Silteme: kaspi-bonus.top/kz, tez kiriniz", "силтеме: kaspi-bonus.top/kz, тез кириниз"],
    ["поддельный bcc.kz.evil.top", "поддельный bcc.kz.evil.top"],
  ])("ссылка остаётся в исходном виде: %s", (input, want) => {
    expect(canon(input)).toBe(want);
  });

  it.each([
    "Код: 4821",
    "Kod: 4821. Eshkimge aitpanyz",
    "Карта 4400 4301 2345 6789, тел +7 701 555 12 34, ИИН 900101300123",
    "20 myn jiber, ertenge 26 myn qaytaram",
    "25 000 тг до 18:00, 20.11.2026, 5% в день",
    "к о д 4 8 2 1",
    "1000000 теңге, 111, 0000",
  ])("цифры не меняются и не переставляются: %s", (text) => {
    const digits = (s: string) => s.replace(/\D/g, "");
    expect(digits(canon(text))).toBe(digits(text));
  });

  it("число не сливается с соседними цифрами и не теряет разделители", () => {
    expect(canon("Код: 4821")).toBe("код: 4821");
    expect(canon("к о д 4 8 2 1")).toBe("код 4 8 2 1");
    expect(canon("тел +7 701 555 12 34")).toBe("тел +7 701 555 12 34");
    expect(canon("1000000 теңге, 111")).toBe("1000000 теңге, 111");
  });

  it("метки маскирования остаются узнаваемыми", () => {
    expect(canon("Код: [КОД], карта [КАРТА], тел [ТЕЛЕФОН]")).toBe("код: [код], карта [карта], тел [телефон]");
  });
});

describe("границы ссылок без регулярного выражения", () => {
  /** Эталон — выражение, которым ссылки ищут правила. */
  const byPattern = (text: string) => [...text.matchAll(URL_PATTERN)].map((m): [number, number] => [m.index, m.index + m[0].length]);

  it.each([
    ["перейдите на bank-kz-secure.top/unlock?id=5 и введите код", [[13, 43]]],
    ["https://www.bcc.kz/cards и egov.kz", [[0, 24], [27, 34]]],
    ["a.bc1.d", [[0, 4]]],
    ["a.b..c.de x.y", [[5, 9]]],
    ["a.http://b.kz", [[0, 6], [9, 13]]],
    ["xhttps://a.kz/п у т ь", [[1, 15]]],
    ["код. жибер, 4821.ешкимге, т.е. и т.д.", []],
  ] as Array<[string, Array<[number, number]>]>)("%s", (text, want) => {
    expect(byPattern(text)).toEqual(want); // сам эталон даёт ожидаемые границы
    expect(linkSpans(text)).toEqual(want);
  });

  it("совпадает с выражением из правил на случайных строках", () => {
    const parts = [..."ab1-", "c", "kz", "top", ".", ".", ".", "/", ":", " ", " ", "д", "http://", "https://", "?", "x9"];
    let seed = 20261117;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let n = 0; n < 20000; n++) {
      let text = "";
      const len = next() % 24;
      for (let k = 0; k < len; k++) text += parts[next() % parts.length];
      expect(linkSpans(text), JSON.stringify(text)).toEqual(byPattern(text));
    }
  });

  it("длинная строка без пробелов разбирается за линейное время", () => {
    // На этих строках выражение из правил перебирает начала квадратично (десятки миллисекунд)
    for (const text of ["a".repeat(100_000) + ".1 x.kz", "a-".repeat(50_000) + "..x.kz", "a.b1.".repeat(20_000) + " x.kz"]) {
      const start = performance.now();
      const spans = linkSpans(text);
      const ms = performance.now() - start;
      expect(spans.at(-1)).toEqual([text.length - 4, text.length]);
      expect(ms, `${ms.toFixed(1)} мс`).toBeLessThan(100);
    }
  });
});

describe("русский текст не меняется", () => {
  it.each([
    "Здравствуйте, это служба безопасности банка. Срочно переведите деньги на безопасный счёт.",
    "Код для входа: 4821. Никому не сообщайте этот код, сотрудники банка никогда его не спрашивают.",
    "Мам, я попал в ДТП, телефон разбился.\nСкинь 150 000 на эту карту, потом объясню…",
    "Заказ №58213 ждёт вас в пункте выдачи до пятницы — код получения придёт отдельно!",
    "Вы выиграли приз!!! Оплатите доставку (990 тг) и получите подарок :)",
    "«Не верьте», — сказал оператор. Я ничего не нажимал?",
  ])("%s", (text) => {
    expect(canon(text)).toBe(legacy(text));
  });

  it("казахский в правильной кириллице тоже не меняется", () => {
    const text = "Барлық ақшаңызды дереу қауіпсіз шотқа аударыңыз, кодты ешкімге айтпаңыз";
    expect(canon(text)).toBe(legacy(text));
  });

  it.each(["ΟΣ ΣΟΣ", "אבג ТЕСТ", "中文 Тест", "\u{10400}\u{10428}"])("другие письменности — как раньше: %s", (text) => {
    expect(canon(text)).toBe(legacy(text));
  });
});

describe("dev-наборы", () => {
  const dev = ["messages", "challenge-1", "train-2", "train-3"].flatMap((f) =>
    parseDataset(readFileSync(`data/dataset/${f}.jsonl`, "utf8")).items.map((i) => ({ ...i, file: f })),
  );
  const LATIN = /[a-zÀ-ɏ]/i;
  /** Знаки ударения (комбинируемые) новая форма убирает — в эталоне убираем их же. */
  const noMarks = (t: string) => t.replace(/[̀-ͯ]/g, "");

  it("сообщения без латинских букв совпадают с прежней нормализацией посимвольно", () => {
    const plain = dev.filter((i) => !LATIN.test(i.text));
    expect(plain.length).toBeGreaterThanOrEqual(300);
    for (const item of plain) expect(canon(item.text), `${item.file}/${item.id}`).toBe(legacy(noMarks(item.text)));
  });

  it("существующие правила не теряют срабатываний на кириллических сообщениях", () => {
    const share = (t: string) => {
      const s = t.toLowerCase().replace(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/g, " ");
      return (s.match(/[a-z]/g) ?? []).length / Math.max(1, (s.match(/\p{L}/gu) ?? []).length);
    };
    const cyrillic = dev.filter((i) => share(i.text) < 0.3);
    expect(cyrillic.length).toBeGreaterThanOrEqual(420);
    const lost: string[] = [];
    for (const item of cyrillic) {
      const before = legacy(item.text);
      const after = canon(item.text);
      for (const sig of SIGNALS) {
        if (sig.patterns.some((p) => p.test(before)) && !sig.patterns.some((p) => p.test(after))) lost.push(`${item.file}/${item.id}: ${sig.id}`);
      }
    }
    expect(lost).toEqual([]);
  });
});

describe("карта позиций", () => {
  it.each([
    ["  Привет,   МИР ", "привет, мир", [2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14]],
    ["shot", "шот", [0, 2, 3]],
    ["к о д", "код", [0, 2, 4]],
    ["кооод", "код", [0, 1, 4]],
    ["😟 kod", "😟 код", [0, 1, 2, 3, 4, 5]],
    ["qupia", "қупия", [0, 1, 2, 3, 4]],
    ["ко​д", "код", [0, 1, 3]],
    ["Kodty", "кодты", [0, 1, 2, 3, 4]],
    ["İ kod", "и код", [0, 1, 2, 3, 4]],
    ["aiaq", "аяқ", [0, 1, 3]],
    ["sh sh d", "шшд", [0, 3, 6]],
  ] as Array<[string, string, number[]]>)("%j → %s", (source, text, map) => {
    expect(canonicalize(source)).toEqual({ text, map });
  });

  it("по карте каждое слово находится в исходном тексте", () => {
    const source = "Salem!  SMS-ten kelgen  К.О.Д-ты   magan jiberiniz";
    const { text, map } = canonicalize(source);
    expect(text).toBe("салем! sms-тен келген код-ты маган жибериниз");
    const at = (word: string) => {
      const i = text.indexOf(word);
      return source.slice(map[i], map[i + word.length - 1] + 1);
    };
    expect(at("салем")).toBe("Salem");
    expect(at("келген")).toBe("kelgen");
    expect(at("код")).toBe("К.О.Д");
    expect(at("жибериниз")).toBe("jiberiniz");
  });
});

describe("свойства на произвольных строках", () => {
  // Детерминированный генератор: кириллица, латиница, цифры, разделители, эмодзи, невидимые символы
  const alphabet = [..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһіАБВКОДabcdehijknopqstuyzKODSMSşñūğöüäı0123456789  ..,-_!?:/\n\t«»\"'[]", "😟", "​", "­", "́", "https://a.kz/x "];
  const samples: string[] = [];
  let seed = 20261120;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let n = 0; n < 400; n++) {
    let s = "";
    const len = next() % 60;
    for (let k = 0; k < len; k++) s += alphabet[next() % alphabet.length];
    samples.push(s);
  }

  it("карта: длина равна длине текста, позиции в пределах исходника и не убывают", () => {
    for (const s of samples) {
      const { text, map } = canonicalize(s);
      expect(map, JSON.stringify(s)).toHaveLength(text.length);
      for (let i = 0; i < map.length; i++) {
        expect(map[i] >= 0 && map[i] < s.length, JSON.stringify(s)).toBe(true);
        if (i > 0) expect(map[i] >= map[i - 1], JSON.stringify(s)).toBe(true);
      }
    }
  });

  it("форма: нижний регистр, без ё, одиночные пробелы без пробелов по краям", () => {
    for (const s of samples) {
      const { text } = canonicalize(s);
      expect(text, JSON.stringify(s)).toBe(text.toLowerCase());
      expect(/ё|\s{2}|^\s|\s$|[\n\t]/.test(text), JSON.stringify(s)).toBe(false);
    }
  });

  it("повторная нормализация ничего не меняет", () => {
    for (const s of samples) {
      const once = canon(s);
      expect(canon(once), JSON.stringify(s)).toBe(once);
    }
  });

  it.each([
    ["Дбwww.Ок", "дбwww.ок"], // слово «как есть» (www), склеенное с кириллицей, не сжимается и не переводится
    ["sh sh d", "шшд"], // разрядка, появившаяся после перевода диграфов
    ["SMSпен келген", "smsпен келген"],
    ["аааwwwбб", "аwwwбб"],
    ["веЁед", "вед"], // «е», «ё», «е» — три одинаковые буквы после ё→е
    ["sh sh sh a", "ша"], // склейка после перевода диграфов, затем повторы
  ])("повторная нормализация устойчива и на склейках: %s → %s", (input, want) => {
    expect(canon(input)).toBe(want);
    expect(canon(want)).toBe(want);
  });

  it("длинные и «вредные» входы обрабатываются без заметной задержки", () => {
    const inputs = [
      "a".repeat(5000),
      "a.".repeat(2500),
      "а ".repeat(2500),
      "к.о.д.".repeat(833),
      "о".repeat(5000),
      "Kodty aitynyz, shotynyz bugattalady. ".repeat(140).slice(0, 5000),
      "​".repeat(5000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      const { text, map } = canonicalize(input);
      const ms = performance.now() - start;
      expect(map).toHaveLength(text.length);
      expect(ms, `${JSON.stringify(input.slice(0, 12))}… ${ms.toFixed(1)} мс`).toBeLessThan(100);
    }
  });
});
