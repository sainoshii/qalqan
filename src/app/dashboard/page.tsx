import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BarList, DayColumns } from "@/components/dashboard/Charts";
import { CHANNEL_LABELS, LANGUAGE_LABELS, OUTCOME_LABELS, STATUS_LABELS, formatDateTime, tenge } from "@/components/dashboard/labels";
import { RiskPill, StatusPill } from "@/components/dashboard/Pills";
import { db } from "@/lib/cases/repository";
import { PAGE_SIZE, getStats, listCases, parseFilters, type CaseFilters } from "@/lib/dashboard/queries";
import { CASE_STATUSES, LANGUAGES, SCAM_TYPES, SCAM_TYPE_LABELS } from "@/lib/domain";

export const metadata: Metadata = {
  title: "Qalqan — панель антифрода",
  description: "Помеченные случаи социальной инженерии, статистика по типам схем и карточки случаев.",
};

const select =
  "min-h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-xl font-semibold tabular-nums sm:text-2xl">{value}</span>
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

function pageHref(filters: CaseFilters, page: number) {
  const q = new URLSearchParams();
  if (filters.status) q.set("status", filters.status);
  if (filters.scamType) q.set("type", filters.scamType);
  if (filters.language) q.set("lang", filters.language);
  if (filters.risk) q.set("risk", filters.risk);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

export default function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          ← Qalqan
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Панель антифрода</h1>
        <p className="max-w-3xl text-zinc-600 dark:text-zinc-400">
          Случаи, где перед переводом клиент получил подозрительное сообщение или звонок. Данные синтетические, кроме
          случаев из демо мобильного банка. Время — Алматы (UTC+5).
        </p>
      </header>

      <Suspense fallback={<p className="text-sm text-zinc-500" role="status">Загружаем случаи…</p>}>
        <DashboardData searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function DashboardData({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection(); // данные панели всегда свежие: рендер в момент запроса
  const filters = parseFilters(await searchParams);
  const client = await db();
  const [{ cases, total }, stats] = await Promise.all([listCases(client, filters), getStats(client)]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(filters.status || filters.scamType || filters.language || filters.risk);


  return (
    <>

      <section aria-label="Ключевые показатели" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Случаев всего" value={String(stats.total)} hint={`высокий риск: ${stats.highRisk}`} />
        <Tile label="Ждут проверки" value={String(stats.newCount)} hint="статус «Новый»" />
        <Tile
          label="Остановлено переводов"
          value={tenge(stats.preventedAmount)}
          hint={`${stats.preventedCount} попыток: отменены или ждут доверенное лицо`}
        />
        <Tile
          label="Доля остановленных"
          value={stats.stopRate === null ? "—" : `${Math.round(stats.stopRate * 100)}%`}
          hint="среди попыток перевода после вмешательства"
        />
      </section>

      <section aria-label="Статистика" className="grid gap-8 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800 lg:grid-cols-2">
        <BarList
          title="Случаи по типам схем"
          rows={stats.byScamType.map((r) => ({ label: SCAM_TYPE_LABELS[r.scamType], value: r.count }))}
        />
        <DayColumns title="Случаи по дням, последние 30 дней" rows={stats.byDay} />
        <BarList
          title="Чем закончились попытки"
          rows={stats.byOutcome.map((r) => ({ label: OUTCOME_LABELS[r.outcome], value: r.count }))}
        />
        <div className="flex flex-col gap-3 text-sm">
          <h2 className="font-semibold">Итоги проверки аналитиками</h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            Подтверждено мошенничество: <strong className="text-foreground tabular-nums">{stats.confirmed}</strong>
            <br />
            Ложных срабатываний: <strong className="text-foreground tabular-nums">{stats.falsePositive}</strong>
          </p>
          <p className="text-xs text-zinc-500">
            Ложные срабатывания помогают настраивать правила детектора без подгонки под отложенную выборку.
          </p>
        </div>
      </section>

      <section aria-labelledby="cases-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="cases-title" className="text-lg font-semibold">
            Случаи {filtered && <span className="font-normal text-zinc-500">· найдено {total}</span>}
          </h2>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Фильтры">
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Статус
            <select name="status" defaultValue={filters.status ?? ""} className={select}>
              <option value="">Все</option>
              {CASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Схема
            <select name="type" defaultValue={filters.scamType ?? ""} className={select}>
              <option value="">Все</option>
              {SCAM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SCAM_TYPE_LABELS[t]}
                </option>
              ))}
              <option value="none">Не определена</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Язык
            <select name="lang" defaultValue={filters.language ?? ""} className={select}>
              <option value="">Все</option>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            Риск
            <select name="risk" defaultValue={filters.risk ?? ""} className={select}>
              <option value="">Любой</option>
              <option value="high">Высокий (70+)</option>
              <option value="medium">Средний (40–69)</option>
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700">
            Применить
          </button>
          {filtered && (
            <Link href="/dashboard" className="min-h-11 content-center px-2 text-sm text-emerald-700 hover:underline dark:text-emerald-400">
              Сбросить
            </Link>
          )}
        </form>

        {cases.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
            Случаев не найдено. {filtered ? "Измените фильтры." : "Запустите npm run db:seed или пройдите сценарий в демо банка."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Время</th>
                  <th scope="col" className="px-3 py-2 font-medium">Риск</th>
                  <th scope="col" className="px-3 py-2 font-medium">Схема</th>
                  <th scope="col" className="px-3 py-2 font-medium">Канал</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Сумма</th>
                  <th scope="col" className="px-3 py-2 font-medium">Исход</th>
                  <th scope="col" className="px-3 py-2 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {cases.map((c) => (
                  <tr key={c.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      <Link href={`/dashboard/cases/${encodeURIComponent(c.id)}`} className="text-emerald-700 hover:underline dark:text-emerald-400">
                        {formatDateTime(c.createdAt)}
                      </Link>
                      {!c.synthetic && <span className="ml-2 rounded bg-zinc-100 px-1.5 text-xs dark:bg-zinc-800">демо</span>}
                    </td>
                    <td className="px-3 py-2">
                      <RiskPill score={c.riskScore} />
                    </td>
                    <td className="px-3 py-2">{c.scamType ? SCAM_TYPE_LABELS[c.scamType] : <span className="text-zinc-500">—</span>}</td>
                    <td className="px-3 py-2">
                      {CHANNEL_LABELS[c.channel]} · {c.language.toUpperCase()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{c.transferAmount === null ? "—" : tenge(c.transferAmount)}</td>
                    <td className="px-3 py-2">{OUTCOME_LABELS[c.outcome]}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Страницы" className="flex items-center justify-between text-sm">
            {filters.page > 1 ? (
              <Link href={pageHref(filters, filters.page - 1)} className="min-h-11 content-center text-emerald-700 hover:underline dark:text-emerald-400">
                ← Назад
              </Link>
            ) : (
              <span />
            )}
            <span className="text-zinc-500">
              Страница {Math.min(filters.page, pages)} из {pages}
            </span>
            {filters.page < pages ? (
              <Link href={pageHref(filters, filters.page + 1)} className="min-h-11 content-center text-emerald-700 hover:underline dark:text-emerald-400">
                Дальше →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>
    </>
  );
}
