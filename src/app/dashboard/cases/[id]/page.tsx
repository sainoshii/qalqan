import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CHANNEL_LABELS, LANGUAGE_LABELS, OUTCOME_LABELS, STATUS_LABELS, formatDateTime, tenge } from "@/components/dashboard/labels";
import { RiskPill, StatusPill } from "@/components/dashboard/Pills";
import { HighlightedText } from "@/components/HighlightedText";
import { db } from "@/lib/cases/repository";
import { findHighlights } from "@/lib/detector/highlights";
import { evaluateRules } from "@/lib/detector/rules";
import { STATUS_TRANSITIONS, getCase } from "@/lib/dashboard/queries";
import { SCAM_TYPE_LABELS, type CaseStatus } from "@/lib/domain";
import { changeStatus } from "./actions";

export const metadata: Metadata = { title: "Qalqan — карточка случая" };

const ACTION_LABELS: Record<CaseStatus, string> = {
  new: "Вернуть в новые",
  reviewing: "Взять в проверку",
  confirmed_fraud: "Подтвердить мошенничество",
  false_positive: "Отметить как ложное срабатывание",
};

const ERRORS: Record<string, string> = {
  invalid: "Статус уже изменился или такой переход недопустим. Обновите страницу.",
  not_found: "Случай не найден.",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

type CaseProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function CasePage(props: CaseProps) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-3xl px-4 py-10 text-sm text-zinc-500 dark:text-zinc-400 sm:px-6" role="status">
          Загружаем случай…
        </main>
      }
    >
      <CaseData {...props} />
    </Suspense>
  );
}

async function CaseData({ params, searchParams }: CaseProps) {
  await connection();
  const { id } = await params;
  const { error } = await searchParams;
  // Next.js уже декодировал сегмент URL — повторный decodeURIComponent ломается на «%»
  const c = await getCase(await db(), id);
  if (!c) notFound();
  const errorText = typeof error === "string" && Object.hasOwn(ERRORS, error) ? ERRORS[error] : undefined;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
        ← Все случаи
      </Link>

      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{c.scamType ? SCAM_TYPE_LABELS[c.scamType] : "Схема не определена"}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <RiskPill score={c.riskScore} />
          <StatusPill status={c.status} />
          {c.synthetic ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">синтетический случай</span>
          ) : (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">из демо мобильного банка</span>
          )}
        </div>
      </header>

      {errorText && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {errorText}
        </p>
      )}

      <section aria-labelledby="text-title" className="flex flex-col gap-2">
        <h2 id="text-title" className="text-sm font-semibold">
          Сообщение (фрагмент, чувствительные данные скрыты)
        </h2>
        <blockquote className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <HighlightedText text={c.textExcerpt} highlights={findHighlights(c.textExcerpt, evaluateRules(c.textExcerpt).signals)} />
        </blockquote>
      </section>

      <section aria-labelledby="reasons-title" className="flex flex-col gap-2">
        <h2 id="reasons-title" className="text-sm font-semibold">
          Почему Qalqan пометил случай
        </h2>
        {c.reasons.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {c.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Причины не сохранены.</p>
        )}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Рекомендация клиенту: {c.recommendation || "—"}</p>
      </section>

      <section aria-labelledby="details-title">
        <h2 id="details-title" className="text-sm font-semibold">
          Детали
        </h2>
        <dl className="divide-y divide-zinc-200 dark:divide-zinc-800">
          <Row label="Время">{formatDateTime(c.createdAt)} (Алматы)</Row>
          <Row label="Клиент">{c.clientAlias}</Row>
          <Row label="Канал">
            {CHANNEL_LABELS[c.channel]}, {LANGUAGE_LABELS[c.language].toLowerCase()} язык
          </Row>
          <Row label="Перевод">
            {c.transferAmount === null ? "не было" : `${tenge(c.transferAmount)}${c.newRecipient ? ", новому получателю" : ""}`}
          </Row>
          <Row label="Исход">{OUTCOME_LABELS[c.outcome]}</Row>
          <Row label="Анализ">{c.analysisMode === "hybrid" ? "правила + LLM" : "правила"}</Row>
          <Row label="ID">
            <code className="text-xs">{c.id}</code>
          </Row>
        </dl>
      </section>

      <section aria-labelledby="status-title" className="flex flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 id="status-title" className="text-sm font-semibold">
          Решение аналитика · сейчас: {STATUS_LABELS[c.status]}
        </h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_TRANSITIONS[c.status].map((next) => (
            <form key={next} action={changeStatus}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="status" value={next} />
              <button
                type="submit"
                className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${
                  next === "confirmed_fraud"
                    ? "bg-red-700 text-white hover:bg-red-800"
                    : "border border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                }`}
              >
                {ACTION_LABELS[next]}
              </button>
            </form>
          ))}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {c.synthetic
            ? "Синтетический случай — в обучение модели не попадает."
            : "Решение «подтверждено» или «ложное срабатывание» попадёт в обучающие данные модели при следующей выгрузке (npm run feedback:export → npm run train)."}
        </p>
      </section>
    </main>
  );
}
