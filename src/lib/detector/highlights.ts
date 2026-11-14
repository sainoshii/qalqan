import type { Highlight } from "../domain";
import { QUOTED, SIGNALS, SUSPICIOUS_LINK_REASON, URL_PATTERN, WARNING_CONTEXT, isTrustedLink } from "./rules";

/**
 * Подсветка: какие фрагменты исходного текста дали сработавшие признаки правил.
 *
 * Правила работают по нормализованному тексту (нижний регистр, ё→е, схлопнутые пробелы),
 * поэтому здесь строится такая же нормализация с картой «позиция → позиция в исходнике»,
 * а найденные места переводятся обратно. Позиции — в UTF-16, как `String.prototype.slice`.
 */

const MAX_HIGHLIGHTS = 30;
/** Длинное совпадение («назовите … код») подсвечивается по краям, а не целиком. */
const LONG_MATCH = 40;
const WORD_CHAR = /[\p{L}\p{N}]/u;

interface Normalized {
  text: string;
  /** map[i] — индекс исходного символа, из которого получен i-й символ нормализованного текста. */
  map: number[];
}

/**
 * То же, что `normalize` из правил, но с картой позиций. Регистр меняется у всей строки
 * сразу (как в `normalize`: контекстные правила, например греческая сигма), а карта
 * строится по кодовым точкам — длина нижнего регистра у кодовой точки от контекста не зависит.
 */
export function normalizeWithMap(source: string): Normalized {
  // 1. Схлопнуть пробельные символы и обрезать края, запоминая позицию каждого UTF-16 символа
  let collapsed = "";
  const collapsedMap: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (/\s/.test(ch)) {
      if (pendingSpace < 0) pendingSpace = i;
    } else {
      if (pendingSpace >= 0 && collapsed.length > 0) {
        collapsed += " ";
        collapsedMap.push(pendingSpace);
      }
      pendingSpace = -1;
      collapsed += ch;
      for (let k = 0; k < ch.length; k++) collapsedMap.push(i);
    }
    i += ch.length;
  }

  // 2. Нижний регистр всей строки; карта — по длине нижнего регистра каждой кодовой точки
  const text = collapsed.toLowerCase().replace(/ё/g, "е");
  const map: number[] = [];
  for (let j = 0; j < collapsed.length; ) {
    const ch = String.fromCodePoint(collapsed.codePointAt(j)!);
    const len = ch.toLowerCase().length;
    for (let k = 0; k < len; k++) map.push(collapsedMap[j]);
    j += ch.length;
  }
  if (map.length !== text.length) {
    // Не ожидается; на всякий случай — без подсветки, но без неверных позиций
    return { text, map: Array.from({ length: text.length }, () => -1) };
  }
  return { text, map };
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
  if (map[0] === -1) return [];

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
    for (const m of weak.matchAll(URL_PATTERN)) {
      if (isTrustedLink(m[0])) continue;
      for (const span of fromWeak([m.index, m.index + m[0].length])) raw.push({ span, reason: SUSPICIOUS_LINK_REASON });
    }
  }
  if (raw.length === 0) return [];

  // В координаты исходного текста, с расширением до границ слов
  const spans = raw.map(({ span: [s, e], reason }) => {
    let start = map[s];
    const last = map[e - 1];
    // Конец — после всей исходной кодовой точки (символ вне BMP занимает две UTF-16 единицы)
    let end = last + (source.codePointAt(last)! > 0xffff ? 2 : 1);
    while (start > 0 && WORD_CHAR.test(source[start - 1]) && WORD_CHAR.test(source[start])) start--;
    while (end < source.length && WORD_CHAR.test(source[end]) && WORD_CHAR.test(source[end - 1])) end++;
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
