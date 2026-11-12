"use client";

import { useEffect, useRef, useState } from "react";
import { SCAM_TYPE_LABELS, riskLevel, type AnalysisResult, type CaseOutcome } from "@/lib/domain";
import { RECIPIENTS, SCENARIOS, type Scenario } from "./scenarios";

/** Пауза перед тем, как клиент сможет продолжить рискованный перевод (в демо — короткая). */
const PAUSE_SECONDS = 20;

interface Assessment {
  decision: "allow" | "warn" | "intervene";
  riskScore: number;
  reasons: string[];
  message: AnalysisResult | null;
}

type Step = "form" | "warn" | "intervene" | "trusted" | "sent" | "cancelled";

const tenge = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "Сервис недоступен");
  return json as T;
}

const LEVEL_STYLE = {
  high: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  low: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
} as const;
const LEVEL_LABEL = { high: "Высокий риск", medium: "Подозрительно", low: "Признаков нет" } as const;

function RiskBadge({ score }: { score: number }) {
  const level = riskLevel(score);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${LEVEL_STYLE[level]}`}>
      {LEVEL_LABEL[level]} · {score}
    </span>
  );
}

const btn = "min-h-11 rounded-xl px-4 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${btn} bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:outline-emerald-600`;
const secondary = `${btn} border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`;
const card = "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

export function BankDemo() {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [customText, setCustomText] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [recipientId, setRecipientId] = useState("new");
  const [amount, setAmount] = useState("450000");

  const [step, setStep] = useState<Step>("form");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(PAUSE_SECONDS);
  const [understood, setUnderstood] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const messageText = (scenario?.text ?? customText).trim();
  const recipient = RECIPIENTS.find((r) => r.id === recipientId) ?? RECIPIENTS[0];
  const amountNumber = Number(amount.replace(/\s/g, ""));
  const amountValid = Number.isInteger(amountNumber) && amountNumber > 0 && amountNumber <= 100_000_000;

  // Пауза на экране вмешательства
  useEffect(() => {
    if (step !== "intervene" || secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, secondsLeft]);

  // При смене экрана фокус уходит на его заголовок (для клавиатуры и экранных дикторов)
  useEffect(() => {
    if (step !== "form") headingRef.current?.focus();
  }, [step]);

  async function analyze(text: string) {
    setAnalysis(null);
    setError(null);
    if (!text.trim()) return;
    setAnalyzing(true);
    try {
      setAnalysis(await postJson<AnalysisResult>("/api/analyze", { text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось проверить сообщение");
    } finally {
      setAnalyzing(false);
    }
  }

  function pickScenario(s: Scenario) {
    setScenario(s);
    setCustomText("");
    void analyze(s.text);
  }

  function record(outcome: CaseOutcome) {
    // Запись для панели антифрода; сбой записи не должен мешать клиенту
    void postJson("/api/cases", {
      amount: amountNumber,
      newRecipient: !recipient.known,
      messageText: messageText || undefined,
      channel: scenario?.channel,
      outcome,
    }).catch(() => undefined);
  }

  async function submitTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!amountValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<Assessment>("/api/transfer/assess", {
        amount: amountNumber,
        newRecipient: !recipient.known,
        messageText: messageText || undefined,
      });
      setAssessment(result);
      if (result.decision === "allow") {
        setStep("sent");
      } else {
        setSecondsLeft(PAUSE_SECONDS);
        setUnderstood(false);
        setStep(result.decision);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось проверить перевод");
    } finally {
      setBusy(false);
    }
  }

  function finish(outcome: CaseOutcome, next: Step) {
    record(outcome);
    setStep(next);
  }

  function reset() {
    setStep("form");
    setAssessment(null);
    setError(null);
  }

  const scamLabel = assessment?.message?.scamType ? SCAM_TYPE_LABELS[assessment.message.scamType] : null;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
      {/* ───────── Что клиент получил перед переводом ───────── */}
      <section aria-labelledby="context-title" className="flex flex-col gap-4">
        <div>
          <h2 id="context-title" className="text-lg font-semibold">
            1. Что произошло перед переводом
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Выберите сценарий или вставьте свой текст — сообщение или расшифровку звонка на русском или казахском.
          </p>
        </div>

        <ul className="grid gap-2 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => pickScenario(s)}
                aria-pressed={scenario?.id === s.id}
                className={`w-full rounded-xl border p-3 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 ${
                  scenario?.id === s.id
                    ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
              >
                <span className="block font-medium">{s.title}</span>
                <span className="block text-xs text-zinc-500">{s.from}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2">
          <label htmlFor="custom-text" className="text-sm font-medium">
            Свой текст
          </label>
          <textarea
            id="custom-text"
            rows={3}
            maxLength={5000}
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              setScenario(null);
              setAnalysis(null);
            }}
            placeholder="Например: «Здравствуйте, это банк, назовите код из SMS…»"
            className="rounded-xl border border-zinc-300 bg-white p-3 text-base dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button type="button" onClick={() => analyze(customText)} disabled={!customText.trim() || analyzing} className={`${secondary} self-start`}>
            Проверить текст
          </button>
        </div>

        <div className={card} aria-live="polite">
          <h3 className="text-sm font-semibold">Анализ Qalqan</h3>
          {analyzing && <p className="mt-2 text-sm text-zinc-500">Проверяем…</p>}
          {!analyzing && !analysis && <p className="mt-2 text-sm text-zinc-500">Сообщение не выбрано — перевод оценивается без контекста.</p>}
          {analysis && (
            <div className="mt-2 flex flex-col gap-2 text-sm">
              {scenario && <blockquote className="border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{scenario.text}</blockquote>}
              <div className="flex flex-wrap items-center gap-2">
                <RiskBadge score={analysis.riskScore} />
                {analysis.scamType && <span className="text-xs text-zinc-600 dark:text-zinc-400">{SCAM_TYPE_LABELS[analysis.scamType]}</span>}
              </div>
              {analysis.reasons.length > 0 && (
                <ul className="list-disc space-y-1 pl-5">
                  {analysis.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="text-zinc-600 dark:text-zinc-400">{analysis.recommendation}</p>
              <p className="text-xs text-zinc-500">
                Режим: {analysis.mode === "hybrid" ? "правила + LLM" : "правила (LLM не подключена)"}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ───────── Телефон: мобильный банк ───────── */}
      <section aria-labelledby="bank-title" className="lg:sticky lg:top-6">
        <h2 id="bank-title" className="mb-3 text-lg font-semibold">
          2. Перевод в мобильном банке
        </h2>
        <div className="mx-auto max-w-[400px] rounded-[2rem] border border-zinc-300 bg-zinc-50 p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-950">
          <div className="mb-4 flex items-center justify-between text-xs text-zinc-500">
            <span className="font-semibold text-emerald-700 dark:text-emerald-400">Демо-банк</span>
            <span>Баланс: {tenge(1_280_500)}</span>
          </div>

          {step === "form" && (
            <form onSubmit={submitTransfer} className="flex flex-col gap-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Кому</legend>
                {RECIPIENTS.map((r) => (
                  <label
                    key={r.id}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${
                      recipientId === r.id ? "border-emerald-600 bg-white dark:bg-zinc-900" : "border-zinc-200 dark:border-zinc-800"
                    }`}
                  >
                    <input type="radio" name="recipient" value={r.id} checked={recipientId === r.id} onChange={() => setRecipientId(r.id)} className="accent-emerald-600" />
                    <span>
                      <span className="block font-medium">{r.name}</span>
                      <span className="block text-xs text-zinc-500">{r.hint}</span>
                    </span>
                  </label>
                ))}
                {!recipient.known && (
                  <p className="text-xs text-zinc-500">В демо реквизиты не вводятся: номер карты получателя в Qalqan не передаётся.</p>
                )}
              </fieldset>

              <div className="flex flex-col gap-1">
                <label htmlFor="amount" className="text-sm font-medium">
                  Сумма, ₸
                </label>
                <input
                  id="amount"
                  inputMode="numeric"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d\s]/g, ""))}
                  aria-invalid={!amountValid}
                  aria-describedby={!amountValid ? "amount-error" : undefined}
                  className="min-h-11 rounded-xl border border-zinc-300 bg-white px-3 text-base tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                />
                {!amountValid && (
                  <p id="amount-error" className="text-xs text-red-700 dark:text-red-400">
                    Введите сумму от 1 до 100 000 000 ₸
                  </p>
                )}
              </div>

              {error && (
                <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                  {error}
                </p>
              )}

              <button type="submit" disabled={!amountValid || busy} className={primary}>
                {busy ? "Проверяем перевод…" : `Перевести ${amountValid ? tenge(amountNumber) : ""}`}
              </button>
            </form>
          )}

          {step === "warn" && assessment && (
            <div className="flex flex-col gap-4">
              <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
                Проверьте перевод
              </h3>
              <RiskBadge score={assessment.riskScore} />
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {assessment.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {tenge(amountNumber)} → {recipient.name}. Если вас торопят или просят никому не говорить — остановитесь.
              </p>
              <button type="button" className={primary} onClick={() => finish("cancelled_by_client", "cancelled")}>
                Отменить перевод
              </button>
              <button type="button" className={secondary} onClick={() => finish("proceeded", "sent")}>
                Всё верно, перевести
              </button>
            </div>
          )}

          {step === "intervene" && assessment && (
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl bg-red-50 p-4 dark:bg-red-950/60">
                <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-red-900 outline-none dark:text-red-100">
                  Стоп. Это похоже на мошенничество
                </h3>
                {scamLabel && <p className="mt-1 text-sm text-red-900 dark:text-red-200">Схема: {scamLabel}</p>}
                <p className="mt-2 text-sm text-red-900 dark:text-red-200">
                  Мы приостановили перевод {tenge(amountNumber)}. Деньги не списаны.
                </p>
              </div>

              <div>
                <h4 className="text-sm font-semibold">Почему мы так думаем</h4>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {assessment.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>

              <p className="rounded-xl bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
                Банк никогда не просит переводить деньги на «безопасный счёт» и не спрашивает коды. Положите трубку и сами
                позвоните в банк по номеру на обороте карты.
              </p>

              <button type="button" className={primary} onClick={() => finish("cancelled_by_client", "cancelled")}>
                Отменить перевод
              </button>
              <button type="button" className={secondary} onClick={() => finish("held_for_trusted_contact", "trusted")}>
                Спросить доверенного человека
              </button>

              <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <p className="text-sm text-zinc-600 dark:text-zinc-400" role="timer" aria-live="off">
                  {secondsLeft > 0
                    ? `Пауза: продолжить можно через ${secondsLeft} с. Используйте это время, чтобы перезвонить в банк.`
                    : "Пауза закончилась."}
                </p>
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                    disabled={secondsLeft > 0}
                    className="mt-1 size-4 accent-red-700"
                  />
                  <span>Я сам знаю получателя, меня никто не торопит и не просил скрывать перевод</span>
                </label>
                <button
                  type="button"
                  disabled={secondsLeft > 0 || !understood}
                  onClick={() => finish("proceeded", "sent")}
                  className={`${btn} mt-3 w-full border border-red-300 text-red-800 hover:bg-red-50 dark:border-red-900 dark:text-red-200 dark:hover:bg-red-950`}
                >
                  Всё равно перевести
                </button>
              </div>
            </div>
          )}

          {step === "trusted" && (
            <div className="flex flex-col gap-4">
              <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
                Перевод на удержании
              </h3>
              <p className="text-sm">
                Мы отправили запрос вашему доверенному человеку: <strong>Айгүл (дочь)</strong>. Перевод {tenge(amountNumber)} не
                будет выполнен, пока она не подтвердит. Деньги не списаны.
              </p>
              <p className="text-xs text-zinc-500">В демо запрос не отправляется; в продукте — пуш и звонок доверенному лицу.</p>
              <button type="button" className={primary} onClick={reset}>
                Вернуться
              </button>
            </div>
          )}

          {step === "cancelled" && (
            <div className="flex flex-col gap-4">
              <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
                Перевод отменён
              </h3>
              <p className="text-sm">
                Деньги остались на счёте: {tenge(amountNumber)}. Если вам звонили «из банка», сообщите об этом по номеру на
                обороте карты.
              </p>
              <button type="button" className={primary} onClick={reset}>
                Готово
              </button>
            </div>
          )}

          {step === "sent" && (
            <div className="flex flex-col gap-4">
              <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
                Перевод выполнен
              </h3>
              <p className="text-sm">
                {tenge(amountNumber)} → {recipient.name}.
                {assessment?.decision === "allow" && " Признаков риска не найдено, дополнительных вопросов не было."}
              </p>
              <button type="button" className={primary} onClick={reset}>
                Новый перевод
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
