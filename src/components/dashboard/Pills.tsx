import { riskLevel, type CaseStatus } from "@/lib/domain";
import { STATUS_LABELS } from "./labels";

/** Статусные цвета всегда с текстом: цвет — не единственный носитель смысла. */
const RISK_STYLE = {
  high: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  low: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
} as const;
const RISK_LABEL = { high: "Высокий", medium: "Средний", low: "Низкий" } as const;

export function RiskPill({ score }: { score: number }) {
  const level = riskLevel(score);
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${RISK_STYLE[level]}`}>
      {RISK_LABEL[level]} · {score}
    </span>
  );
}

const STATUS_STYLE: Record<CaseStatus, string> = {
  new: "border-emerald-600 text-emerald-800 dark:text-emerald-300",
  reviewing: "border-amber-600 text-amber-900 dark:text-amber-300",
  confirmed_fraud: "border-red-600 text-red-800 dark:text-red-300",
  false_positive: "border-zinc-400 text-zinc-700 dark:text-zinc-300",
};

export function StatusPill({ status }: { status: CaseStatus }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
