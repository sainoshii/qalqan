/**
 * Простые графики без библиотек: одна серия — один цвет (--series-1), подписи значений
 * текстовыми цветами, подсказка при наведении и фокусе, таблица для экранных дикторов.
 */
import { formatDay } from "./labels";

export function BarList({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Нет данных</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-center sm:gap-3">
              {/* На телефоне подпись целиком над полосой: подсказки при наведении там нет */}
              <span className="text-zinc-700 sm:truncate dark:text-zinc-300" title={r.label}>
                {r.label}
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="h-3 rounded-r-[4px]"
                  style={{ width: `${(r.value / max) * 85}%`, minWidth: r.value ? 4 : 0, background: "var(--series-1)" }}
                  aria-hidden
                />
                <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{r.value}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export function DayColumns({ title, rows }: { title: string; rows: Array<{ day: string; count: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">{title}</span>
        <span className="text-zinc-500 dark:text-zinc-400">всего {total}</span>
      </figcaption>
      <div className="flex h-36 items-end gap-[2px] border-b border-zinc-300 dark:border-zinc-700" aria-hidden>
        {rows.map((r) => (
          <div key={r.day} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-[4px]"
              style={{ height: `${(r.count / max) * 100}%`, minHeight: r.count ? 3 : 0, background: "var(--series-1)" }}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
              {formatDay(r.day)}: {r.count}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400" aria-hidden>
        <span>{rows[0] && formatDay(rows[0].day)}</span>
        <span>{rows.at(-1) && formatDay(rows.at(-1)!.day)}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">День</th>
            <th scope="col">Случаев</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <td>{formatDay(r.day)}</td>
              <td>{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
