/**
 * Допуск записи казахских слов в шаблонах правил.
 *
 * Шаблон пишется в обычной казахской орфографии («қауіпсіз шот»), а `kk` превращает его в
 * выражение, которое совпадает со всеми способами записи после нормализации
 * (`canonicalize`): настоящими казахскими буквами, «упрощёнными» («кауипсиз шот») и
 * латиницей («qauipsiz shot» → «қауипсиз шот»).
 *
 * Допуск действует только в одну сторону — от точной буквы шаблона к её упрощению:
 * «ә» в шаблоне совпадает с «ә» и «а», но «а» в шаблоне не совпадает с «ә» в тексте.
 * Иначе «санды» (цифру) совпало бы с «сәнді» (модный), и однозначный признак возникал бы
 * из случайного совпадения. Исключение — «ы», «і», «и», «й»: латинские i и y пишут на месте
 * любой из них, поэтому в казахском шаблоне эти четыре буквы взаимозаменяемы.
 *
 * Буквы без допуска (а, о, у, к, г, н и остальные) остаются как есть, поэтому шаблон по-прежнему
 * совпадает со всем, с чем совпадал раньше. К русским шаблонам `kk` не применяется.
 */

const I = "[ыіий]";

const TOLERANT: Record<string, string> = {
  ә: "[әа]",
  ғ: "[ғг]",
  қ: "[қк]",
  ң: "(?:ң|нг?)", // латиницей «ң» пишут и как n, и как ng
  ө: "[өо]",
  ұ: "[ұу]",
  ү: "[үу]",
  һ: "[һх]",
  і: I,
  ы: I,
  и: I,
  й: I,
  э: "[эе]", // ekran → екран
  х: "[хһ]",
  щ: "[щш]",
  ц: "(?:ц|тс|с)", // operaciya, operatsiya, operasiya
  ю: "(?:ю|[йи]?у)", // qoyu → қою, qoiu → қойу
  ь: "ь?", // parol → парол
  ъ: "ъ?",
};

/** Источник выражения в обычной орфографии → источник с допуском записи. Синтаксис не трогается. */
export function kkSource(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      // Экранированный символ и классы \p{…}, \P{…}, \u{…}, \k<…> копируются как есть
      const next = source[i + 1] ?? "";
      let end = i + 1;
      if ((next === "p" || next === "P" || next === "u") && source[i + 2] === "{") end = source.indexOf("}", i);
      else if (next === "k" && source[i + 2] === "<") end = source.indexOf(">", i);
      if (end < 0) end = source.length - 1;
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "[") {
      // Класс символов — как есть: допуск внутри класса задаёт автор шаблона
      let end = i + 1;
      while (end < source.length && source[end] !== "]") end += source[end] === "\\" ? 2 : 1;
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    const tolerant = TOLERANT[ch];
    if (tolerant === undefined) {
      out += ch;
      continue;
    }
    // «ь?» в шаблоне уже необязателен — не превращать в «ь??»
    const quantified = "?*+{".includes(source[i + 1] ?? " ");
    out += (ch === "ь" || ch === "ъ") && quantified ? ch : tolerant;
  }
  return out;
}

/** Выражение в обычной казахской орфографии → выражение с допуском записи (флаги сохраняются). */
export function kk(pattern: RegExp): RegExp {
  return new RegExp(kkSource(pattern.source), pattern.flags);
}

const FRONT_VOWELS = "әеөүіи";
const BACK_VOWELS = "аоұыуя";

/** Сингармонизм: по последней гласной основы — мягкий (передний) ряд или твёрдый. */
function isFrontStem(stem: string): boolean {
  for (let i = stem.length - 1; i >= 0; i--) {
    if (FRONT_VOWELS.includes(stem[i])) return true;
    if (BACK_VOWELS.includes(stem[i])) return false;
  }
  return false;
}

const WORD_END = String.raw`(?!\p{L})`;
/** Вспомогательный глагол в повелительной форме после деепричастия на -ып/-іп: «айтып беріңіз», «жіберіп қойыңыз». */
const AUX_IMPERATIVE = String.raw`(?:(?:бер|жібер)(?:іңіз(?:ші)?|ші|іңдер)?|қой(?:ыңыз(?:шы)?|шы|ыңдар)?)`;
/** «…а салыңыз», «…е салшы» — просьба сделать быстро. */
const SAL_IMPERATIVE = String.raw`сал(?:ыңыз(?:шы)?|шы|ыңдар)?`;

/**
 * Формы просьбы и требования от основы казахского глагола (источник выражения в обычной
 * орфографии; допуск записи добавляет `kkSource`). Совпадают:
 * - повелительное наклонение: «айт», «айтшы», «айтыңыз», «айтыңызшы», «айтыңдар»;
 * - с вспомогательным глаголом: «айтып беріңіз», «жіберіп қойыңыз», «айта салыңыз»;
 * - «достаточно, если…»: «айтсаңыз болды», «айтсаңшы»;
 * - необходимость: «айту керек», «айтуыңыз қажет» (но не «айту керек емес»).
 * Не совпадают отрицание («айтпаңыз»), прошедшее и будущее время («айтты», «айтамын»),
 * третье лицо («айтсын»), причастия («айтқан») и основа внутри другого слова («қайт»).
 */
export function demandForms(stem: string): string {
  const front = isFrontStem(stem);
  const vowelEnd = (FRONT_VOWELS + BACK_VOWELS).includes(stem[stem.length - 1]);
  const y = front ? "і" : "ы";
  const a = front ? "е" : "а";
  const shy = front ? "ші" : "шы";
  const polite = `${vowelEnd ? "" : y}ң${y}з`;
  const plural = `${vowelEnd ? "" : y}ң${front ? "дер" : "дар"}`;
  const converbP = vowelEnd ? "п" : `${y}п`;
  const converbA = vowelEnd ? "й" : a;
  const conditional = `с${a}ң`;
  const forms = [
    `(?:${polite}(?:${shy})?|${plural}|${shy})?${WORD_END}`,
    `${converbP} ${AUX_IMPERATIVE}${WORD_END}`,
    `${converbA} ${SAL_IMPERATIVE}${WORD_END}`,
    `${conditional}(?:${y}з)? болды${WORD_END}`,
    `${conditional}${shy}${WORD_END}`,
    // Не требование: «айту керек емес / те емес», «қажет болмады», «керек деп ойламаңыз», вопрос «керек пе?»
    `у(?:${y}ң${y}з)? (?:керек|қажет)(?! (?:(?:те|та|да|де) )?емес| болма| деп ойлама| жоқ| (?:па|пе|ма|ме|ба|бе)(?!\\p{L}))${WORD_END}`,
  ];
  return String.raw`(?<!\p{L})${stem}(?:${forms.join("|")})`;
}
