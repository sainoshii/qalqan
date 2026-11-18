/**
 * Маскирование чувствительных данных перед сохранением или передачей во внешние сервисы.
 *
 * Qalqan не хранит номера карт, CVV, коды из SMS, IBAN, ИИН и номера телефонов:
 * в базу и в LLM попадает только текст, прошедший через `maskSensitive`.
 *
 * Подход: регулярное выражение находит кандидата целиком (всё число, без отката
 * к префиксу), а функция проверяет контекст — сумма, дата, номер заказа или код.
 * Флаг `u` и явные Unicode-границы (`(?<!\p{L})…(?!\p{L})`): в JS `\b` и `\w`
 * не понимают кириллицу. `\s` уже включает U+00A0, U+202F и переносы строк.
 */

type Replacer = (match: string, ...args: unknown[]) => string;

/** Горизонтальный пробел (без переноса строки): контекст не переходит на соседнюю строку. */
const H = String.raw`[^\S\n]`;

/**
 * Формы слов, рядом с которыми число может быть секретным кодом (RU, KZ, EN), в любой записи:
 * кириллица, латиница («kod», «parol», «qupiya soz»), «упрощённые» казахские буквы («купия соз»,
 * «кодыныз») и латинские буквы-двойники внутри кириллического слова («кoд» с латинской o).
 */
const CODE_KEY = [
  String.raw`[кk][оo][дd](?:[аеуы]|ом|ты|ын|ыңыз|ыныз|ыңызды|ынызды|[aeuy]|om|ty|yn|ynyz|yñyz|ynyzdy|iniz)?`,
  String.raw`[кk][ .\-][оo][ .\-][дd]`, // разрядка: «к о д», «к.о.д»
  String.raw`[пp][аa][рpr][оo][лl](?:[ьяюе]|[ia])?|пароли`,
  String.raw`[құк][ұу]пия${H}?с[өо]з\p{L}*|[qk][uū]pi(?:ya|ia|a)${H}?s[oö]z\p{L}*`,
  String.raw`cvv2?|cvc2?|pin|пин(?:-?код)?|code|codes|passcode|otp`,
].join("|");

/**
 * Число из цифр с одиночным пробелом или дефисом между цифрами, захватывается целиком.
 * Каждый шаг обязательно поглощает цифру — квантификатор однозначен, без бэктрекинга.
 * Перенос строки число не продолжает.
 */
const NUMBER = String.raw`\d(?:(?:${H}|-)?\d)*`;

/**
 * Разделитель между ключом и кодом: «: », « — », « («», « "»…
 * Только ограниченные квантификаторы: соседние `\s*` давали квадратичный бэктрекинг
 * на длинных строках пробелов (ревью Codex, цикл 3, C1).
 */
const SEP = String.raw`${H}{0,3}[:\-–—]?${H}{0,3}[(«"“']?${H}{0,2}`;

/** Слова, превращающие «код» в идентификатор, а не секрет: «код заказа», «код акции». */
const ID_NOUN = /(?<!\p{L})(?:заказ\p{L}*|акци\p{L}*|товар\p{L}*|купон\p{L}*|промо\p{L}*|скидк\p{L}*|регион\p{L}*|город\p{L}*|филиал\p{L}*|отделени\p{L}*|клиент\p{L}*|тапсырыс\p{L}*|order|promo\p{L}*|product|zakaz\p{L}*|tapsyrys\p{L}*|akci\p{L}*|aktsi\p{L}*|tovar\p{L}*)(?!\p{L})/iu;

/**
 * Код не нужен — конкретные фразы, а не любое «не»: «не сообщайте: 4821» остаётся секретом.
 */
const NOT_NEEDED = /(?<!\p{L})(?:не[^\S\n]+(?:нуж\p{L}*|требу\p{L}*|обязател\p{L}*)|қажет[^\S\n]+емес|керек[^\S\n]+емес|not[^\S\n]+(?:needed|required))(?!\p{L})/iu;

/** Сразу после числа (на той же строке) — валюта или «год»: это сумма/год, а не код. */
const AMOUNT_AFTER = /^[^\S\n]*(?:тенге|теңге|тг|₸|kzt|tg|tenge|teñge|руб\p{L}*|\$|год\p{L}*|жыл\p{L}*)(?!\p{L})/iu;

/** Число продолжается точкой/слэшем и цифрами — часть даты или дробного числа. */
const DATE_TAIL = /^[./-]\d/;
const DATE_HEAD = /\d[./-]$/;

/** Перед числом — признак номера заказа/документа: «Заказ №…», «Заказ: …», «order #». */
const ORDER_BEFORE = /(?:№|#|(?<!\p{L})(?:заказ\p{L}*|тапсырыс\p{L}*|order|договор\p{L}*|счёт\p{L}*|счет\p{L}*))[^\S\n]{0,3}[:№#]?[^\S\n]{0,3}№?[^\S\n]{0,3}$/iu;

/** Даты: 2026-11-20, 20.11.2026, 20/11/26. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})$/;

/** Слова, допустимые между числом и ключом в форме «4821 — код для входа». */
const BACKWARD_LABEL_WORDS = /^(?:ваш\p{L}*|сіздің|для|из|sms|смс|кіру|растау|одноразов\p{L}*|подтвержд\p{L}*|входа|one-time|your|бір)$/iu;

const digitCount = (s: string) => s.replace(/\D/g, "").length;

function isCodeValue(value: string, after: string): boolean {
  const n = digitCount(value);
  if (n < 3 || n > 8) return false;
  if (DATE.test(value.replace(/\s/g, ""))) return false;
  if (DATE_TAIL.test(after) || AMOUNT_AFTER.test(after)) return false;
  return true;
}

/** «Код: 4821», «код для входа 4821», «CVV: (123)», «Код: «4821»», «SMS code: 4821». */
const forwardCode: [RegExp, Replacer] = [
  new RegExp(
    String.raw`(?<!\p{L})(${CODE_KEY})(?!\p{L})((?:${H}{1,3}\p{L}+){0,4})(${SEP})(${NUMBER})`,
    "giu",
  ),
  (match, ...args) => {
    const [key, gap, sep, value, offset, whole] = args as [string, string, string, string, number, string];
    const after = whole.slice(offset + match.length);
    // «код заказа: 58213» — идентификатор; «код подтверждения оплаты заказа: 4821» — секрет.
    const firstGapWord = gap.trim().split(/\s+/u)[0] ?? "";
    if (ID_NOUN.test(firstGapWord) || NOT_NEEDED.test(gap)) return match;
    if (!isCodeValue(value, after)) return match;
    return `${key}${gap}${sep}[КОД]`;
  },
];

/** «4821 — код для входа», «123 — CVV», «4 8 2 1 — кіру коды». */
const backwardCode: [RegExp, Replacer] = [
  new RegExp(
    String.raw`(?<![\p{L}\d])(${NUMBER})(${H}{0,3}[:\-–—]${H}{0,3})((?:\p{L}+${H}{1,3}){0,2})(${CODE_KEY})(?!\p{L})`,
    "giu",
  ),
  (match, ...args) => {
    const [value, dash, label, key, offset, whole] = args as [string, string, string, string, number, string];
    const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
    const before = whole.slice(Math.max(lineStart, offset - 30), offset);
    const after = whole.slice(offset + match.length);
    const labelWords = label.trim() ? label.trim().split(/\s+/u) : [];
    if (!labelWords.every((w) => BACKWARD_LABEL_WORDS.test(w))) return match;
    // «— код акции …», «— код не требуется», «— код қажет емес»: уточнение после ключа
    const tail = after.match(/^[^\S\n]+((?:\p{L}+[^\S\n]*){1,3})/u)?.[1] ?? "";
    const nextWord = tail.split(/\s+/u)[0] ?? "";
    if (ID_NOUN.test(nextWord) || NOT_NEEDED.test(tail)) return match;
    if (DATE_HEAD.test(before) || ORDER_BEFORE.test(before)) return match;
    if (ID_NOUN.test(before.trim().split(/\s+/u).slice(-2).join(" "))) return match;
    if (!isCodeValue(value, "")) return match;
    return `[КОД]${dash}${label}${key}`;
  },
];

/** Не маскировать номера заказов/документов вида «Заказ №7015551234» (телефон, ИИН группами). */
function unlessOrder(pattern: RegExp, label: string): [RegExp, Replacer] {
  return [
    pattern,
    (match, ...args) => {
      const offset = args[args.length - 2] as number;
      const whole = args[args.length - 1] as string;
      return ORDER_BEFORE.test(whole.slice(Math.max(0, offset - 30), offset)) ? match : label;
    },
  ];
}

const phone = (pattern: RegExp) => unlessOrder(pattern, "[ТЕЛЕФОН]");

/** Прямо перед числом — метка ИИН: «ИИН», «ЖСН», «IIN», «IIN:», «ИИН №». */
const IIN_LABEL_BEFORE = /(?<!\p{L})(?:иин|жсн|iin|zhsn|jsn)[^\S\n]{0,3}[:№#]?[^\S\n]{0,3}$/iu;

/**
 * ИИН группами (6+6, 4+4+4): как unlessOrder, но если сразу после числа валюта или «год»
 * («1000 2000 3000 тг»), это сумма, а не ИИН — не маскируется. Явная метка «ИИН»/«ЖСН» перед
 * числом важнее валюты: «ИИН 900101 123456 тг» маскируется (ревью iin-amount, цикл 1, C1).
 */
function iinGrouped(pattern: RegExp): [RegExp, Replacer] {
  const [, unlessOrderReplace] = unlessOrder(pattern, "[ИИН]");
  return [
    pattern,
    (match, ...args) => {
      const offset = args[args.length - 2] as number;
      const whole = args[args.length - 1] as string;
      const labelled = IIN_LABEL_BEFORE.test(whole.slice(Math.max(0, offset - 15), offset));
      if (labelled) return "[ИИН]"; // метка важнее и валюты, и «№» («ИИН №900101 123456»)
      if (AMOUNT_AFTER.test(whole.slice(offset + match.length))) return match;
      return unlessOrderReplace(match, ...args);
    },
  ];
}

const RULES: Array<[RegExp, string | Replacer]> = [
  // IBAN Казахстана: KZ + 2 цифры + 16 символов (допускаем пробелы)
  [/(?<![\p{L}\d])KZ\d{2}(?:\s?[A-Z0-9]){16}(?![\p{L}\d])/giu, "[IBAN]"],

  // Номера карт: 13–19 цифр, между группами — любой пробельный символ или дефис
  [/(?<!\d)\d(?:[\s-]?\d){12,18}(?!\d)/gu, "[КАРТА]"],

  // Телефоны с кодом страны: +7 / 7 / 8 и 10 цифр в любом распространённом формате
  phone(/(?:\+\s?7|(?<![\d+])[78])[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu),

  // Мобильные KZ без кода страны: 70x, 747, 77x + 7 цифр
  phone(/(?<!\d)\(?(?:70\d|747|77\d)\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu),

  // ИИН: ровно 12 цифр — подряд или группами 6+6 и 4+4+4 («900101 123456»)
  [/(?<!\d)\d{12}(?!\d)/gu, "[ИИН]"],
  iinGrouped(/(?<!\d[\s-]?)(?:\d{6}[\s-]\d{6}|\d{4}[\s-]\d{4}[\s-]\d{4})(?![\s-]?\d)/gu),

  forwardCode,
  backwardCode,
];

/** Невидимые символы (мягкий перенос, zero-width, управление направлением): ими разбивают «4\u200b8\u200b2\u200b1». */
const INVISIBLE = /[\u00ad\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff]/g;
/** Комбинируемые знаки после цифры (4\u03018): у цифр их не бывает, ими тоже разбивают число. */
const MARKS_AFTER_DIGIT = /(\d)\p{M}+/gu;

/**
 * Перед маскированием: невидимые символы удаляются, полноширинные цифры и буквы («４８２１», «＋７»)
 * и «математические» цифры («𝟒») приводятся к обычным. Иначе такие записи кода, карты, телефона
 * проходили бы маскирование как есть. Остальной текст не меняется.
 */
function foldForMasking(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u{1d7ce}-\u{1d7ff}]/gu, (c) => c.normalize("NFKC"))
    // после приведения цифр к ASCII: иначе «４\u0301» не распознаётся как цифра (ревью, цикл 3, C1)
    .replace(MARKS_AFTER_DIGIT, "$1");
}

export function maskSensitive(text: string): string {
  return RULES.reduce(
    (acc, [pattern, replacement]) =>
      typeof replacement === "string" ? acc.replace(pattern, replacement) : acc.replace(pattern, replacement),
    foldForMasking(text),
  );
}

/** Короткий фрагмент для панели банка: замаскированный и обрезанный. */
export function excerpt(text: string, maxLength = 280): string {
  const masked = maskSensitive(text).replace(/\s+/g, " ").trim();
  return masked.length > maxLength ? `${masked.slice(0, maxLength - 1)}…` : masked;
}
