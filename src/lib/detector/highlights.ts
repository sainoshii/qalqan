import type { Highlight } from "../domain";
import { canonicalize, linkSpans } from "./normalize";
import { QUOTED, SIGNALS, SUSPICIOUS_LINK_REASON, WARNING_CONTEXT, isTrustedLink } from "./rules";

/**
 * Подсветка: какие фрагменты исходного текста дали сработавшие признаки правил.
 *
 * Правила работают по канонической форме текста (нижний регистр, ё→е, схлопнутые пробелы,
 * латиница и смешанная раскладка приведены к кириллице — см. normalize.ts). Та же функция
 * возвращает карту «позиция → позиция в исходнике», по ней найденные места переводятся
 * обратно: клиент видит подсветку в своём исходном тексте, а не в нормализованном.
 * Позиции — в UTF-16, как `String.prototype.slice`.
 */

const MAX_HIGHLIGHTS = 30;
/** Длинное совпадение («назовите … код») подсвечивается по краям, а не целиком. */
const LONG_MATCH = 40;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Начало кодовой точки перед позицией `i` (UTF-16). */
function prevPoint(text: string, i: number): number {
  const low = text.charCodeAt(i - 1);
  return i >= 2 && low >= 0xdc00 && low <= 0xdfff && text.charCodeAt(i - 2) >= 0xd800 && text.charCodeAt(i - 2) <= 0xdbff ? i - 2 : i - 1;
}

const pointLength = (text: string, i: number) => (text.codePointAt(i)! > 0xffff ? 2 : 1);
const isWordAt = (text: string, i: number) => WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i)!));

interface Normalized {
  text: string;
  /** map[i] — индекс исходного символа, из которого получен i-й символ нормализованного текста. */
  map: number[];
}

/**
 * То же, что `normalize` из правил, но с картой позиций: обе функции — это `canonicalize`
 * из normalize.ts, поэтому текст, по которому ищут правила, и текст, по которому строится
 * подсветка, совпадают по построению.
 */
export function normalizeWithMap(source: string): Normalized {
  return canonicalize(source);
}

type Span = [number, number]; // [начало, конец) в нормализованном тексте

function* matches(pattern: RegExp, text: string): Generator<Span> {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    yield [m.index, m.index + m[0].length];
  }
}

/** Длинное совпадение → первое и последнее слово; короткое — как есть. */
function trimLong([start, end]: Span, text: string): Span[] {
  if (end - start <= LONG_MATCH) return [[start, end]];
  const piece = text.slice(start, end);
  const firstSpace = piece.indexOf(" ");
  const lastSpace = piece.lastIndexOf(" ");
  if (firstSpace < 0 || lastSpace <= firstSpace) return [[start, end]];
  return [
    [start, start + firstSpace],
    [start + lastSpace + 1, end],
  ];
}

/**
 * Фрагменты исходного текста, на которых сработали признаки `signalIds`
 * (id из `evaluateRules`; защитные и служебные id пропускаются).
 */
export function findHighlights(source: string, signalIds: readonly string[]): Highlight[] {
  const ids = new Set(signalIds);
  if (ids.size === 0) return [];
  const { text, map } = normalizeWithMap(source);

  // Слабые признаки правила ищут в тексте без цитат (если это предупреждение) — здесь то же
  // представление: каждая цитата заменена пробелом, wmap переводит позиции обратно в `text`.
  const quoted: Span[] = WARNING_CONTEXT.test(text)
    ? [...text.matchAll(QUOTED)].map((m) => [m.index, m.index + m[0].length])
    : [];
  let weak = text;
  let wmap = Array.from({ length: text.length }, (_, i) => i);
  if (quoted.length > 0) {
    weak = "";
    wmap = [];
    let pos = 0;
    for (const [qs, qe] of quoted) {
      weak += text.slice(pos, qs) + " ";
      for (let i = pos; i < qs; i++) wmap.push(i);
      wmap.push(qs);
      pos = qe;
    }
    weak += text.slice(pos);
    for (let i = pos; i < text.length; i++) wmap.push(i);
  }
  /** Совпадение в слабом тексте → части в `text` вне цитат. */
  const fromWeak = ([s, e]: Span): Span[] => {
    let parts: Span[] = [[wmap[s], wmap[e - 1] + 1]];
    for (const [qs, qe] of quoted) {
      parts = parts.flatMap(([a, b]): Span[] => {
        if (b <= qs || a >= qe) return [[a, b]];
        const out: Span[] = [];
        if (a < qs) out.push([a, qs]);
        if (b > qe) out.push([qe, b]);
        return out;
      });
    }
    return parts.map(([a, b]): Span => {
      // без пробелов по краям частей
      while (a < b && text[a] === " ") a++;
      while (b > a && text[b - 1] === " ") b--;
      return [a, b];
    }).filter(([a, b]) => b > a);
  };

  const raw: Array<{ span: Span; reason: string }> = [];
  for (const sig of SIGNALS) {
    if (sig.weight <= 0 || !ids.has(sig.id)) continue;
    for (const p of sig.patterns) {
      if (sig.strong) {
        for (const span of matches(p, text)) for (const part of trimLong(span, text)) raw.push({ span: part, reason: sig.reason });
      } else {
        for (const span of matches(p, weak))
          for (const piece of fromWeak(span)) for (const part of trimLong(piece, text)) raw.push({ span: part, reason: sig.reason });
      }
    }
  }
  if (ids.has("suspicious_link")) {
    for (const [from, to] of linkSpans(weak)) {
      if (isTrustedLink(weak.slice(from, to))) continue;
      for (const span of fromWeak([from, to])) raw.push({ span, reason: SUSPICIOUS_LINK_REASON });
    }
  }
  if (raw.length === 0) return [];

  // В координаты исходного текста, с расширением до границ слов
  const spans = raw.map(({ span: [s, e], reason }) => {
    let start = map[s];
    const last = map[e - 1];
    // Конец — после всей исходной кодовой точки (символ вне BMP занимает две UTF-16 единицы)
    let end = last + (source.codePointAt(last)! > 0xffff ? 2 : 1);
    // Расширение до границ слова — по кодовым точкам: буква вне BMP (𐐀) — две UTF-16 единицы
    while (start > 0 && isWordAt(source, prevPoint(source, start)) && isWordAt(source, start)) start = prevPoint(source, start);
    while (end < source.length && isWordAt(source, end) && isWordAt(source, prevPoint(source, end))) end += pointLength(source, end);
    return { start, end, reasons: [reason] };
  });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  // Слить пересекающиеся
  const merged: typeof spans = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      for (const r of s.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
    } else {
      merged.push({ ...s, reasons: [...s.reasons] });
    }
  }
  return merged.slice(0, MAX_HIGHLIGHTS).map((s) => ({ start: s.start, end: s.end, reason: s.reasons.join(" · ") }));
}
