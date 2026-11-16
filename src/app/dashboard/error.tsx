"use client";

import Link from "next/link";

export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as { digest?: string }).digest ?? "") : "";
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Панель временно недоступна</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Не удалось получить данные из базы. Демо мобильного банка и анализ сообщений при этом работают.
      </p>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Диагностика: <a href="/api/health" className="text-emerald-700 underline dark:text-emerald-400">/api/health</a>
        {digest && <> · код {digest}</>}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => retry()} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
          Повторить
        </button>
        <Link href="/bank" className="min-h-11 content-center rounded-lg border border-zinc-300 px-4 text-sm font-semibold dark:border-zinc-700">
          Демо банка
        </Link>
      </div>
    </main>
  );
}
