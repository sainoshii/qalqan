/**
 * Признаки для статистической модели: символьные n-граммы слов и словесные биграммы,
 * захешированные в фиксированное пространство (hashing trick).
 *
 * Символьные n-граммы устойчивы к тому, что ломает регулярные выражения: опечаткам,
 * транслиту, казахским и русским окончаниям («кодты», «кодын», «коду»), склейкам.
 */

export const FEATURE_BITS = 16;
const DIM = 1 << FEATURE_BITS;
const MIN_N = 2;
const MAX_N = 5;

/** FNV-1a 32-бит. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function normalizeForModel(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/https?:\/\/\S+|\b[a-z0-9-]+\.(?:top|click|site|online|info|cc|xyz|kz|ru|com|net|org|example)\b\S*/g, " ссылка ")
    .replace(/\d+/g, "0")
    .replace(/[^\p{L}0\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Разреженный вектор: индекс признака → вес (L2-нормирован). */
export type SparseVector = Map<number, number>;

export function featurize(text: string): SparseVector {
  const words = normalizeForModel(text).split(" ").filter(Boolean);
  const v: SparseVector = new Map();
  const add = (key: string) => {
    const i = hash(key) % DIM;
    v.set(i, (v.get(i) ?? 0) + 1);
  };

  for (const w of words) {
    const padded = ` ${w} `;
    for (let n = MIN_N; n <= MAX_N; n++) {
      for (let i = 0; i + n <= padded.length; i++) add(`c${n}:${padded.slice(i, i + n)}`);
    }
    add(`w:${w}`);
  }
  for (let i = 0; i + 1 < words.length; i++) add(`b:${words[i]} ${words[i + 1]}`);

  // Сублинейные частоты и L2-нормировка: длинный текст не перевешивает короткий
  let norm = 0;
  for (const [k, c] of v) {
    const x = 1 + Math.log(c);
    v.set(k, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [k, x] of v) v.set(k, x / norm);
  return v;
}
