import type { Highlight } from "@/lib/domain";

/**
 * Текст с подсвеченными опасными фрагментами. Позиции берутся из детектора; если они
 * не подходят к тексту (другой текст, устаревший ответ), текст показывается без подсветки.
 */
export function HighlightedText({ text, highlights }: { text: string; highlights?: Highlight[] }) {
  const valid = (highlights ?? [])
    .filter((h) => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.end > h.start && h.end <= text.length)
    .sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const h of valid) {
    if (h.start < pos) continue; // пересечения не ожидаются; на всякий случай пропускаем
    if (h.start > pos) parts.push(text.slice(pos, h.start));
    parts.push(
      <mark
        key={h.start}
        title={h.reason}
        className="rounded bg-red-100 px-0.5 text-red-900 underline decoration-red-400 decoration-dotted underline-offset-2 dark:bg-red-950 dark:text-red-100"
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    pos = h.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));

  return (
    <span className="whitespace-pre-line">
      {parts}
      {valid.length > 0 && <span className="sr-only"> (опасные фрагменты выделены)</span>}
    </span>
  );
}
