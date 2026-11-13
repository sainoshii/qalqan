import type { Client, InValue } from "@libsql/client";
import {
  CASE_OUTCOMES,
  CASE_STATUSES,
  CHANNELS,
  HIGH_RISK,
  LANGUAGES,
  SCAM_TYPES,
  type CaseOutcome,
  type CaseStatus,
  type Channel,
  type Language,
  type ScamType,
} from "../domain";

/** Случай для панели антифрода (строка таблицы `cases`). */
export interface CaseRow {
  id: string;
  createdAt: string;
  clientAlias: string;
  channel: Channel;
  language: Language;
  textExcerpt: string;
  riskScore: number;
  scamType: ScamType | null;
  reasons: string[];
  recommendation: string;
  analysisMode: "rules" | "hybrid";
  transferAmount: number | null;
  newRecipient: boolean;
  outcome: CaseOutcome;
  status: CaseStatus;
  synthetic: boolean;
}

export interface CaseFilters {
  status?: CaseStatus;
  scamType?: ScamType | "none";
  language?: Language;
  risk?: "high" | "medium";
}

export const PAGE_SIZE = 25;

const pick = <T extends string>(values: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : undefined;

/** Фильтры из адресной строки: неизвестные значения игнорируются. */
export function parseFilters(params: Record<string, string | string[] | undefined>): CaseFilters & { page: number } {
  const one = (k: string) => (Array.isArray(params[k]) ? params[k]?.[0] : params[k]);
  const page = Math.max(1, Math.min(1000, Number.parseInt(one("page") ?? "1", 10) || 1));
  return {
    status: pick(CASE_STATUSES, one("status")),
    scamType: one("type") === "none" ? "none" : pick(SCAM_TYPES, one("type")),
    language: pick(LANGUAGES, one("lang")),
    risk: pick(["high", "medium"] as const, one("risk")),
    page,
  };
}

function where(f: CaseFilters): { sql: string; args: InValue[] } {
  const parts: string[] = [];
  const args: InValue[] = [];
  if (f.status) {
    parts.push("status = ?");
    args.push(f.status);
  }
  if (f.scamType === "none") parts.push("scam_type IS NULL");
  else if (f.scamType) {
    parts.push("scam_type = ?");
    args.push(f.scamType);
  }
  if (f.language) {
    parts.push("language = ?");
    args.push(f.language);
  }
  if (f.risk === "high") {
    parts.push("risk_score >= ?");
    args.push(HIGH_RISK);
  } else if (f.risk === "medium") {
    parts.push("risk_score >= 40 AND risk_score < ?");
    args.push(HIGH_RISK);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

function parseReasons(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function toCase(r: Record<string, unknown>): CaseRow {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    clientAlias: String(r.client_alias),
    channel: pick(CHANNELS, r.channel) ?? "sms",
    language: pick(LANGUAGES, r.language) ?? "ru",
    textExcerpt: String(r.text_excerpt),
    riskScore: Number(r.risk_score),
    scamType: pick(SCAM_TYPES, r.scam_type) ?? null,
    reasons: parseReasons(r.reasons),
    recommendation: String(r.recommendation ?? ""),
    analysisMode: r.analysis_mode === "hybrid" ? "hybrid" : "rules",
    transferAmount: r.transfer_amount === null || r.transfer_amount === undefined ? null : Number(r.transfer_amount),
    newRecipient: Number(r.new_recipient) === 1,
    outcome: pick(CASE_OUTCOMES, r.outcome) ?? "no_transfer",
    status: pick(CASE_STATUSES, r.status) ?? "new",
    synthetic: Number(r.synthetic) === 1,
  };
}

export async function listCases(db: Client, f: CaseFilters & { page?: number }) {
  const w = where(f);
  const page = f.page ?? 1;
  const [rows, total] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM cases ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      args: [...w.args, PAGE_SIZE, (page - 1) * PAGE_SIZE],
    }),
    db.execute({ sql: `SELECT COUNT(*) AS n FROM cases ${w.sql}`, args: w.args }),
  ]);
  return { cases: rows.rows.map((r) => toCase(r as Record<string, unknown>)), total: Number(total.rows[0]?.n ?? 0) };
}

export async function getCase(db: Client, id: string): Promise<CaseRow | null> {
  const { rows } = await db.execute({ sql: "SELECT * FROM cases WHERE id = ?", args: [id] });
  return rows[0] ? toCase(rows[0] as Record<string, unknown>) : null;
}

/** Допустимые переходы статуса: аналитик не может «потерять» случай, вернув его в new. */
export const STATUS_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  new: ["reviewing", "confirmed_fraud", "false_positive"],
  reviewing: ["confirmed_fraud", "false_positive"],
  confirmed_fraud: ["reviewing"],
  false_positive: ["reviewing"],
};

export async function updateStatus(db: Client, id: string, next: CaseStatus): Promise<"ok" | "not_found" | "invalid"> {
  const current = await getCase(db, id);
  if (!current) return "not_found";
  if (!STATUS_TRANSITIONS[current.status].includes(next)) return "invalid";
  // Условие на прежний статус защищает от гонки двух аналитиков
  const res = await db.execute({ sql: "UPDATE cases SET status = ? WHERE id = ? AND status = ?", args: [next, id, current.status] });
  return res.rowsAffected === 1 ? "ok" : "invalid";
}

export interface DashboardStats {
  total: number;
  highRisk: number;
  newCount: number;
  confirmed: number;
  falsePositive: number;
  /** Сумма переводов, которые клиенты отменили или задержали после вмешательства. */
  preventedAmount: number;
  preventedCount: number;
  /** Доля попыток перевода, остановленных вмешательством. */
  stopRate: number | null;
  byScamType: Array<{ scamType: ScamType; count: number }>;
  byOutcome: Array<{ outcome: CaseOutcome; count: number }>;
  byDay: Array<{ day: string; count: number }>; // YYYY-MM-DD в часовом поясе Алматы (UTC+5)
}

/** Сдвиг UTC+5 для группировки по дням: даты в базе — UTC. */
const ALMATY_OFFSET = "+5 hours";

export async function getStats(db: Client, days = 30, now = new Date()): Promise<DashboardStats> {
  const [totals, types, outcomes, daily] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS total,
              SUM(risk_score >= ?) AS high,
              SUM(status = 'new') AS new_count,
              SUM(status = 'confirmed_fraud') AS confirmed,
              SUM(status = 'false_positive') AS fp,
              SUM(CASE WHEN outcome IN ('cancelled_by_client','held_for_trusted_contact') THEN transfer_amount ELSE 0 END) AS prevented,
              SUM(outcome IN ('cancelled_by_client','held_for_trusted_contact')) AS prevented_n,
              SUM(outcome <> 'no_transfer') AS attempts
            FROM cases`,
      args: [HIGH_RISK],
    }),
    db.execute("SELECT scam_type, COUNT(*) AS n FROM cases WHERE scam_type IS NOT NULL GROUP BY scam_type ORDER BY n DESC, scam_type"),
    db.execute("SELECT outcome, COUNT(*) AS n FROM cases GROUP BY outcome"),
    db.execute({
      sql: `SELECT date(created_at, ?) AS day, COUNT(*) AS n FROM cases
            WHERE created_at >= ? GROUP BY day ORDER BY day`,
      args: [ALMATY_OFFSET, new Date(now.getTime() - days * 86_400_000).toISOString()],
    }),
  ]);

  const t = totals.rows[0] ?? {};
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const attempts = num(t.attempts);

  // Непрерывная шкала дней: пропуски заполняются нулями
  const counts = new Map(daily.rows.map((r) => [String(r.day), num(r.n)]));
  const byDay: DashboardStats["byDay"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() + 5 * 3_600_000 - i * 86_400_000).toISOString().slice(0, 10);
    byDay.push({ day, count: counts.get(day) ?? 0 });
  }

  return {
    total: num(t.total),
    highRisk: num(t.high),
    newCount: num(t.new_count),
    confirmed: num(t.confirmed),
    falsePositive: num(t.fp),
    preventedAmount: num(t.prevented),
    preventedCount: num(t.prevented_n),
    stopRate: attempts ? num(t.prevented_n) / attempts : null,
    byScamType: types.rows
      .map((r) => ({ scamType: pick(SCAM_TYPES, r.scam_type), count: num(r.n) }))
      .filter((r): r is { scamType: ScamType; count: number } => r.scamType !== undefined),
    byOutcome: CASE_OUTCOMES.map((o) => ({ outcome: o, count: num(outcomes.rows.find((r) => r.outcome === o)?.n) })),
    byDay,
  };
}
