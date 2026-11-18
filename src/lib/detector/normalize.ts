/**
 * Каноническая форма текста для детектора: одна запись для кириллицы, латиницы и
 * смешанной раскладки. Правила и модель сравнивают именно её; клиенту и в базу она
 * не попадает (подсветка возвращается к исходному тексту по карте позиций, маскирование
 * `maskSensitive` работает по исходному тексту).
 *
 * Выбран способ «латиница → кириллица», а не отдельный алфавит-скелет:
 * - обычный русский и казахский текст в кириллице проходит БЕЗ изменений — результат
 *   посимвольно совпадает с прежней нормализацией правил (нижний регистр, ё→е, пробелы),
 *   поэтому существующие шаблоны правил не теряют срабатываний по построению;
 * - казахские буквы (ә ғ қ ң ө ұ ү һ і) в канонической форме сохраняются. Их «упрощения»
 *   (ә→а, қ→к…) сворачивает отдельная функция `skeleton` — она нужна там, где совпадение
 *   статистическое (модель). Правила допускают упрощение в самом шаблоне и только в одну
 *   сторону, иначе «сәнді» (модный) и «санды» (цифру) стали бы одним словом.
 *
 * Что делает `canonicalize`:
 * 1. нижний регистр, ё→е, пробельные символы → один пробел (как раньше);
 * 2. убирает невидимые символы (мягкий перенос, zero-width) и знаки ударения, собирает
 *    «й»/«ё» из буквы и комбинируемого знака, полноширинные и «математические» буквы
 *    приводит к обычным;
 * 3. склеивает разрядку: «к о д», «к.о.д», «к-о-д» → «код»;
 * 4. слово целиком латиницей → кириллица (диграфы sh/ch/zh/kh/gh, казахская латиница с
 *    диакритикой ş ñ ğ ū ü ö ä ı, q→қ), кроме слов, которые правила ищут как есть (sms, cvv…);
 * 5. слово со смешанной раскладкой: латинские «двойники» среди кириллицы (a, e, o, p, c, x…)
 *    → кириллические буквы; кириллица среди латиницы — латинская часть читается по звучанию;
 * 6. три и более одинаковых буквы подряд внутри слова → одна («сроооочно» → «срочно»).
 *
 * Не меняются: цифры и знаки между ними (по ним работают маскирование и правила про коды),
 * ссылки и домены (по ним работает проверка ссылок), эмодзи, пунктуация.
 *
 * Чего функция НЕ делает (известные ограничения):
 * - слово целиком из латинских «двойников» («HOMEP», «KAPTA») читается по звучанию, а не по
 *   виду: отличить его от настоящего латинского слова без словаря нельзя;
 * - замена букв цифрами («к0д») и разрядка с двумя знаками («к. о. д.») не разбираются;
 * - латиница читается по самым частым привычкам письма; где запись неоднозначна
 *   (i / y — «и», «ы», «і» или «й»; ng — «ң» или «нг»), допуск задаётся в шаблонах правил;
 * - настоящие три одинаковые буквы подряд внутри слова тоже сжимаются («СССР» → «ср»).
 *
 * Функция чистая, без регулярных выражений; время линейно от длины текста.
 */

export interface Canonical {
  /** Текст в канонической форме. */
  text: string;
  /** map[i] — позиция (UTF-16) исходного символа, из которого получен i-й символ `text`. */
  map: number[];
}

// ───────────── Таблицы ─────────────

const cc = (s: string) => s.charCodeAt(0);

/** Латинские слова, которые правила ищут как есть: в кириллицу не переводятся. */
const KEEP_LATIN = new Set(["sms", "cvv", "cvc", "anydesk", "rustdesk", "teamviewer", "http", "https", "www"]);
const KEEP_MAX_LENGTH = 10;

// Классы символов
const OTHER = 0;
const CYR = 1;
const LAT = 2;
const DIGIT = 3;
const FIXED = 4; // часть ссылки: копируется как есть

// Что было перед текущей латинской буквой (для чтения i, y, u)
const START = 0;
const CONS = 1;
const VOWEL = 2;
const GLIDE = 3; // «у» после гласной (ау, еу): дальше идёт гласная (қауіп, ауыл), а не «й»
const VOWEL_I = 4; // гласная «и»: следующая i — тоже «и» (киім), а не «й»

const SPACE = 32;
const YO = cc("ё");
const YE = cc("е");

/** Коды букв по именам; обращение к букве, которой нет в списке, — ошибка компиляции, а не `undefined`. */
function codesOf<K extends string>(letters: readonly K[]): Record<K, number> {
  return Object.fromEntries(letters.map((ch) => [ch, cc(ch)])) as Record<K, number>;
}
/** Кириллические буквы, которые выдаёт перевод латиницы с учётом соседей. */
const CY = codesOf(["г", "ғ", "ж", "з", "и", "й", "к", "с", "т", "у", "х", "ц", "ч", "ш", "щ", "ы", "ю", "я"] as const);
/** Латинские буквы, чтение которых зависит от соседей. */
const LA = codesOf(["a", "c", "e", "g", "h", "i", "k", "s", "t", "u", "y", "z"] as const);

/** Латинская буква → кириллическая, когда чтение от соседей не зависит. */
const DIRECT = new Uint16Array(128);
for (const [from, to] of ["aа", "bб", "dд", "eе", "fф", "hх", "jж", "lл", "mм", "nн", "oо", "pп", "qқ", "rр", "vв", "wв", "xх"]) {
  DIRECT[cc(from)] = cc(to);
}

/** Латинские буквы с диакритикой → казахская кириллица (алфавиты 2018 и 2021 годов, турецкая запись). */
const EXT_TO_CYR = new Map<number, number>();
for (const [from, to] of [["äáə", "ә"], ["öó", "ө"], ["üú", "ү"], ["ū", "ұ"], ["ı", "і"], ["ğǵ", "ғ"], ["ñńŋ", "ң"], ["şš", "ш"], ["çč", "ч"], ["ž", "ж"]]) {
  for (const ch of from) EXT_TO_CYR.set(cc(ch), cc(to));
}
/** Остальные латинские буквы с диакритикой читаются как базовая буква (é → e); ý — как u (алфавит 2018 года). */
const EXT_TO_ASCII = new Map<number, number>([[cc("ý"), cc("u")]]);

function baseLetter(c: number): number {
  let base = EXT_TO_ASCII.get(c);
  if (base === undefined) {
    const first = String.fromCharCode(c).normalize("NFD").charCodeAt(0);
    base = first >= 0x61 && first <= 0x7a ? first : 0;
    EXT_TO_ASCII.set(c, base); // кэш: результат зависит только от буквы
  }
  return base;
}

/** Латинские буквы, неотличимые на вид от кириллических (с учётом регистра): B — «В», но b — нет. */
const LOOKALIKE = new Uint16Array(128);
for (const [from, to] of ["Aа", "Bв", "Cс", "Eе", "Hн", "Kк", "Mм", "Oо", "Pр", "Tт", "Xх", "Yу", "Iі", "aа", "cс", "eе", "oо", "pр", "xх", "yу", "kк", "iі", "mм", "tт"]) {
  LOOKALIKE[cc(from)] = cc(to);
}

const CYR_VOWELS = new Set([..."аеёиоуыэюяәөұүі"].map(cc));
const SEPARATORS = new Set([..." .-_*·"].map(cc));
/** Слова из одной буквы: «а я в банке» — обычный текст, а не разрядка. */
const ONE_LETTER_WORDS = new Set([..."абвжикосуяэabvjikosu"].map(cc));

/** Казахские буквы → «упрощённые»: так их пишут без казахской раскладки. */
const FOLD: Record<string, string> = { ә: "а", ғ: "г", қ: "к", ң: "н", ө: "о", ұ: "у", ү: "у", һ: "х", і: "и" };

// ───────────── Вспомогательные функции ─────────────

function isSpace(c: number): boolean {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** Невидимые символы: мягкий перенос, zero-width, управление направлением, селекторы начертания. */
function isInvisible(c: number): boolean {
  return (
    c === 0xad || c === 0x180e || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || (c >= 0xfe00 && c <= 0xfe0f)
  );
}

function isCombining(c: number): boolean {
  return (
    (c >= 0x300 && c <= 0x36f) || (c >= 0x483 && c <= 0x489) || (c >= 0x1ab0 && c <= 0x1aff) ||
    (c >= 0x1dc0 && c <= 0x1dff) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe20 && c <= 0xfe2f)
  );
}

function classOf(c: number): number {
  if (c < 0x80) {
    if (c >= 0x61 && c <= 0x7a) return LAT;
    if (c >= 0x30 && c <= 0x39) return DIGIT;
    return OTHER;
  }
  if (c >= 0x400 && c <= 0x52f) return CYR;
  if ((c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) || c === 0x259) return LAT;
  return OTHER;
}

const isLetterClass = (k: number) => k === CYR || k === LAT;
const isWordClass = (k: number) => k !== OTHER;

function fromCodes(codes: number[]): string {
  if (codes.length < 4096) return String.fromCharCode.apply(null, codes);
  let s = "";
  for (let i = 0; i < codes.length; i += 4096) s += String.fromCharCode.apply(null, codes.slice(i, i + 4096));
  return s;
}

/** Нижний регистр с сохранением длины (İ → i): нужен, когда `toLowerCase` меняет число символов. */
function lowerAligned(raw: string): string {
  let s = "";
  for (let i = 0; i < raw.length; ) {
    const ch = String.fromCodePoint(raw.codePointAt(i)!);
    const lower = ch.toLowerCase();
    s += lower.length === ch.length ? lower : lower.slice(0, ch.length);
    i += ch.length;
  }
  return s;
}

/**
 * Шаги 1–2: пробелы → один пробел (по краям убираются), невидимые символы и знаки ударения
 * убираются, «и» + бреве → «й», полноширинные и «математические» буквы → обычные.
 */
function clean(source: string, code: number[], pos: number[]): void {
  let pending = -1; // позиция первого пробела в ещё не записанной серии
  const push = (c: number, at: number) => {
    if (pending >= 0) {
      code.push(SPACE);
      pos.push(pending);
      pending = -1;
    }
    code.push(c);
    pos.push(at);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (isSpace(c)) {
      if (code.length > 0 && pending < 0) pending = i;
    } else if (c < 0x80) {
      push(c, i);
    } else if (isInvisible(c)) {
      // пропуск
    } else if (isCombining(c)) {
      // «и» + бреве → «й», «е» + две точки → «ё»; знак без готовой буквы (ударение) отбрасывается
      if (code.length > 0 && pending < 0) {
        const composed = String.fromCharCode(code[code.length - 1], c).normalize("NFC");
        if (composed.length === 1) code[code.length - 1] = composed.charCodeAt(0);
      }
    } else if (c >= 0xff01 && c <= 0xff5e) {
      push(c - 0xfee0, i); // полноширинные буквы и цифры
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < source.length) {
      const d = source.charCodeAt(i + 1);
      if (d < 0xdc00 || d > 0xdfff) {
        push(c, i);
        continue;
      }
      const cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
      i++;
      if (cp >= 0xe0100 && cp <= 0xe01ef) continue; // дополнительные селекторы начертания
      if (cp >= 0x1d400 && cp <= 0x1d7ff) {
        const plain = String.fromCodePoint(cp).normalize("NFKC");
        if (plain.length === 1 && plain.charCodeAt(0) < 0x80) {
          push(plain.charCodeAt(0), i - 1); // «математические» буквы и цифры: 𝐤 → k
          continue;
        }
      }
      push(c, i - 1);
      push(d, i);
    } else {
      push(c, i);
    }
  }
}

/**
 * Шаг 3: разрядка. Три и более одиночных букв через один и тот же разделитель
 * («к о д», «к.о.д») — разделители помечаются на удаление. Через пробел не склеиваются
 * последовательности из одних однобуквенных слов («а я в банке»).
 */
function markSpaced(lc: ArrayLike<number>, cls: Uint8Array, n: number): Uint8Array | null {
  let del: Uint8Array | null = null;
  for (let i = 0; i + 4 < n; i++) {
    if (!isLetterClass(cls[i]) || (i > 0 && isWordClass(cls[i - 1]))) continue;
    const sep = lc[i + 1];
    if (!SEPARATORS.has(sep)) continue;
    let j = i;
    let count = 1;
    let plain = ONE_LETTER_WORDS.has(lc[i]);
    while (j + 2 < n && lc[j + 1] === sep && isLetterClass(cls[j + 2]) && !(j + 3 < n && isWordClass(cls[j + 3]))) {
      j += 2;
      count++;
      if (plain && !ONE_LETTER_WORDS.has(lc[j])) plain = false;
    }
    if (count >= 3 && !(sep === SPACE && plain)) {
      del ??= new Uint8Array(n);
      for (let t = i + 1; t < j; t += 2) del[t] = 1;
    }
    i = j;
  }
  return del;
}

function put(out: number[], map: number[], c: number, at: number): void {
  out.push(c);
  map.push(at);
}

/**
 * Шаг 4: латинский отрезок слова → кириллица по звучанию. Возвращает, чем отрезок
 * закончился (гласная / согласная), чтобы продолжить слово со смешанной раскладкой.
 *
 * i и y читаются по соседям: после гласной — «й» (aitpa → айтпа, koyynyz → койыныз),
 * иначе «и» / «ы» (kodty → кодты). «у» после гласной — часть дифтонга, после неё снова
 * гласная (qauip → қауип, auyl → ауыл).
 */
function translit(
  lc: number[],
  pos: number[],
  from: number,
  to: number,
  wordStart: boolean,
  state: number,
  out: number[],
  map: number[],
): number {
  let kind = state;
  for (let i = from; i < to; ) {
    let c = lc[i];
    const at = pos[i];
    if (c > 0x7a) {
      const cyr = EXT_TO_CYR.get(c);
      if (cyr !== undefined) {
        put(out, map, cyr, at);
        kind = CYR_VOWELS.has(cyr) ? VOWEL : CONS;
        i++;
        continue;
      }
      c = baseLetter(c);
      if (c === 0) {
        put(out, map, lc[i], at); // буква без соответствия (ł, ø) остаётся как есть
        kind = CONS;
        i++;
        continue;
      }
    }
    const next = i + 1 < to ? lc[i + 1] : 0;
    const afterVowel = kind === VOWEL || kind === VOWEL_I;
    let step = 1;
    let after = CONS;
    switch (c) {
      case LA.c:
        if (next === LA.h) {
          put(out, map, CY.ч, at);
          step = 2;
        } else if (next === LA.k) {
          put(out, map, CY.к, at);
          step = 2;
        } else {
          // ce, ci, cy — «ц» (policiya → полиция), иначе «к» (credit → кредит)
          put(out, map, next === LA.e || next === LA.i || next === LA.y ? CY.ц : CY.к, at);
        }
        break;
      case LA.g:
        if (next === LA.h) {
          put(out, map, CY.ғ, at);
          step = 2;
        } else put(out, map, CY.г, at);
        break;
      case LA.i:
        if (next === LA.a) {
          // ia: после гласной — «я» (aiaq → аяқ), после согласной — «ия» (qupia → қупия)
          if (!afterVowel) put(out, map, CY.и, at);
          put(out, map, CY.я, afterVowel ? at : pos[i + 1]);
          step = 2;
          after = VOWEL;
        } else if (kind === VOWEL) {
          put(out, map, CY.й, at);
        } else {
          put(out, map, CY.и, at);
          after = VOWEL_I;
        }
        break;
      case LA.k:
        if (next === LA.h) {
          put(out, map, CY.х, at);
          step = 2;
        } else put(out, map, CY.к, at);
        break;
      case LA.s:
        if (next !== LA.h) put(out, map, CY.с, at);
        else if (i + 3 < to && lc[i + 2] === LA.c && lc[i + 3] === LA.h) {
          put(out, map, CY.щ, at);
          step = 4;
        } else {
          put(out, map, CY.ш, at);
          step = 2;
        }
        break;
      case LA.t:
        // ts — «ц» только в начале слова (tsifry); внутри казахского слова это «т» + «с» (ketse → кетсе)
        if (next === LA.s && wordStart && i === from) {
          put(out, map, CY.ц, at);
          step = 2;
        } else put(out, map, CY.т, at);
        break;
      case LA.u:
        put(out, map, CY.у, at);
        after = afterVowel ? GLIDE : VOWEL;
        break;
      case LA.y:
        if (next === LA.a) {
          put(out, map, CY.я, at);
          step = 2;
          after = VOWEL;
        } else if (next === LA.u) {
          put(out, map, CY.ю, at);
          step = 2;
          after = VOWEL;
        } else if (afterVowel) {
          put(out, map, CY.й, at);
        } else {
          put(out, map, CY.ы, at);
          after = VOWEL;
        }
        break;
      case LA.z:
        if (next === LA.h) {
          put(out, map, CY.ж, at);
          step = 2;
        } else put(out, map, CY.з, at);
        break;
      default: {
        const cyr = DIRECT[c];
        put(out, map, cyr, at);
        if (CYR_VOWELS.has(cyr)) after = VOWEL;
      }
    }
    kind = after;
    i += step;
  }
  return kind;
}

/**
 * Шаг 5: слово со смешанной раскладкой. Если все его латинские буквы — «двойники»
 * кириллических, это кириллическое слово с подменёнными буквами («кoд», «пapoль»).
 * Иначе латинские отрезки читаются по звучанию («kuшinde» → «кушинде»).
 */
function mixedWord(
  code: number[],
  low: string,
  lc: number[],
  cls: Uint8Array,
  pos: number[],
  from: number,
  to: number,
  out: number[],
  map: number[],
): void {
  let lookalikes = true;
  for (let t = from; t < to; t++) {
    if (cls[t] === LAT && (code[t] >= 128 || LOOKALIKE[code[t]] === 0)) {
      lookalikes = false;
      break;
    }
  }
  if (lookalikes) {
    for (let t = from; t < to; t++) put(out, map, cls[t] === LAT ? LOOKALIKE[code[t]] : lc[t], pos[t]);
    return;
  }
  let kind = START;
  for (let t = from; t < to; ) {
    if (cls[t] === CYR) {
      put(out, map, lc[t], pos[t]);
      kind = lc[t] === CY.и ? VOWEL_I : CYR_VOWELS.has(lc[t]) ? VOWEL : CONS;
      t++;
      continue;
    }
    let end = t;
    while (end < to && cls[end] === LAT) end++;
    if (end - t <= KEEP_MAX_LENGTH && KEEP_LATIN.has(low.slice(t, end))) {
      for (let s = t; s < end; s++) put(out, map, lc[s], pos[s]);
      kind = CONS;
    } else {
      kind = translit(lc, pos, t, end, t === from, kind, out, map);
    }
    t = end;
  }
}

/**
 * Шаг 6: три и более одинаковых буквы подряд → одна; слово из одной буквы («ооо») не трогается.
 * Латинские буквы слов «как есть» (www, sms) не сжимаются — иначе слово перестало бы быть собой.
 */
function collapseRepeats(out: number[], map: number[], start: number): void {
  const end = out.length;
  let triple = false;
  for (let i = start + 2; i < end; i++) {
    if (out[i] >= 0x400 && out[i] === out[i - 1] && out[i] === out[i - 2]) {
      triple = true;
      break;
    }
  }
  if (!triple) return;
  let same = true;
  for (let i = start + 1; i < end; i++) {
    if (out[i] !== out[start]) {
      same = false;
      break;
    }
  }
  if (same) return;
  let w = start;
  for (let i = start; i < end; ) {
    let j = i + 1;
    while (j < end && out[j] === out[i]) j++;
    const keep = j - i >= 3 && out[i] >= 0x400 ? 1 : j - i;
    for (let k = 0; k < keep; k++) {
      out[w] = out[i + k];
      map[w] = map[i + k];
      w++;
    }
    i = j;
  }
  out.length = w;
  map.length = w;
}

const DOT = 0x2e;
const SLASH = 0x2f;
const isLowerLatin = (c: number) => c >= 0x61 && c <= 0x7a;
/** Символ метки домена: a–z, 0–9, дефис. */
const isLabelChar = (c: number) => isLowerLatin(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;

/**
 * Границы ссылок и доменов в тексте в нижнем регистре: [начало, конец).
 *
 * Находит ровно то же, что выражение правил
 * `/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/g`, но за линейное время:
 * выражение на длинной строке без пробелов («aaaa….1») перебирает начала квадратично.
 * Совпадение с выражением проверяется тестом на случайных строках.
 *
 * Разбор: блок — метки через одиночные точки; ссылка есть, если какая-то метка, кроме
 * первой, начинается с двух и более букв (домен верхнего уровня); берётся самая правая такая
 * метка — как у «жадного» выражения. Перед блоком может стоять http:// или https://,
 * после домена — путь до пробела.
 */
export function linkSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = text.length;
  let consumed = 0; // конец предыдущей ссылки: её символы не могут стать схемой следующей
  for (let i = 0; i < n; ) {
    if (!isLabelChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const blockStart = i;
    let tldEnd = -1;
    let j = i;
    for (let first = true; ; first = false) {
      const label = j;
      while (j < n && isLabelChar(text.charCodeAt(j))) j++;
      if (!first) {
        let t = label;
        while (t < j && isLowerLatin(text.charCodeAt(t))) t++;
        if (t - label >= 2) tldEnd = t;
      }
      if (j + 1 < n && text.charCodeAt(j) === DOT && isLabelChar(text.charCodeAt(j + 1))) j++;
      else break;
    }
    if (tldEnd < 0) {
      i = j;
      continue;
    }
    let start = blockStart;
    if (start - 8 >= consumed && text.startsWith("https://", start - 8)) start -= 8;
    else if (start - 7 >= consumed && text.startsWith("http://", start - 7)) start -= 7;
    let end = tldEnd;
    if (end < n && text.charCodeAt(end) === SLASH) {
      while (end < n && !isSpace(text.charCodeAt(end))) end++;
    }
    spans.push([start, end]);
    consumed = end;
    i = Math.max(end, j);
  }
  return spans;
}

// ───────────── Основные функции ─────────────

export function canonicalize(source: string): Canonical {
  let code: number[] = []; // символы после очистки, исходный регистр
  let pos: number[] = []; // их позиции в source
  clean(source, code, pos);
  let n = code.length;
  if (n === 0) return { text: "", map: [] };

  // Нижний регистр — как `toLowerCase` у всей строки (контекстные правила сохраняются)
  const raw = fromCodes(code);
  let low = raw.toLowerCase();
  if (low.length !== n) low = lowerAligned(raw);
  let lc: number[] = new Array<number>(n);
  let cls = new Uint8Array(n);
  let hasLatin = false;
  for (let i = 0; i < n; i++) {
    const c = low.charCodeAt(i);
    lc[i] = c === YO ? YE : c; // ё → е сразу: «е», «ё», «е» подряд — это три одинаковые буквы
    const k = classOf(c);
    cls[i] = k;
    if (k === LAT) hasLatin = true;
  }

  // Ссылки остаются как есть
  if (hasLatin) for (const [from, to] of linkSpans(low)) cls.fill(FIXED, from, to);

  // Разрядка
  const del = markSpaced(lc, cls, n);
  if (del) {
    const keep = (_: unknown, i: number) => del[i] === 0;
    code = code.filter(keep);
    pos = pos.filter(keep);
    lc = lc.filter(keep);
    cls = cls.filter(keep);
    low = fromCodes(lc);
    n = lc.length;
  }

  const out: number[] = [];
  const map: number[] = [];
  const fixed: number[] = []; // границы ссылок в out: начало, конец, начало, конец…
  let digraphWord = false; // диграф дал слово из одной буквы («sh» → «ш»): возможна новая разрядка
  for (let i = 0; i < n; ) {
    const k = cls[i];
    if (!isLetterClass(k)) {
      if (k === FIXED && (i === 0 || cls[i - 1] !== FIXED)) fixed.push(out.length);
      put(out, map, lc[i], pos[i]);
      i++;
      if (k === FIXED && (i === n || cls[i] !== FIXED)) fixed.push(out.length);
      continue;
    }
    let end = i;
    let lat = 0;
    while (end < n && isLetterClass(cls[end])) {
      if (cls[end] === LAT) lat++;
      end++;
    }
    const start = out.length;
    if (lat === 0 || (lat === end - i && end - i <= KEEP_MAX_LENGTH && KEEP_LATIN.has(low.slice(i, end)))) {
      for (let t = i; t < end; t++) put(out, map, lc[t], pos[t]); // кириллица или слово «как есть»
    } else if (lat === end - i) {
      translit(lc, pos, i, end, true, START, out, map);
    } else {
      mixedWord(code, low, lc, cls, pos, i, end, out, map);
    }
    collapseRepeats(out, map, start);
    if (out.length - start === 1 && end - i > 1) digraphWord = true;
    i = end;
  }

  // Редкий случай: «sh sh d» → «ш ш д» — разрядка появилась только после перевода диграфов.
  // Склеиваем её и ещё раз сжимаем повторы в получившихся словах.
  if (digraphWord) {
    const m = out.length;
    const outCls = new Uint8Array(m);
    for (let i = 0; i < m; i++) outCls[i] = classOf(out[i]);
    for (let r = 0; r < fixed.length; r += 2) outCls.fill(FIXED, fixed[r], fixed[r + 1]);
    const again = markSpaced(out, outCls, m);
    if (again) {
      const codes: number[] = [];
      const positions: number[] = [];
      for (let i = 0; i < m; ) {
        if (again[i]) {
          i++;
          continue;
        }
        if (!isLetterClass(outCls[i])) {
          put(codes, positions, out[i], map[i]);
          i++;
          continue;
        }
        const start = codes.length;
        for (; i < m && (again[i] || isLetterClass(outCls[i])); i++) {
          if (!again[i]) put(codes, positions, out[i], map[i]);
        }
        collapseRepeats(codes, positions, start);
      }
      return { text: fromCodes(codes), map: positions };
    }
  }

  return { text: fromCodes(out), map };
}

/** Каноническая форма с «упрощёнными» казахскими буквами: «кодты» = «kodty», «жіберіңіз» = «jiberiniz». */
export function skeleton(source: string): string {
  return canonicalize(source).text.replace(/[әғқңөұүһі]/g, (ch) => FOLD[ch]);
}
