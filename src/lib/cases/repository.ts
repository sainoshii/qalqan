import type { Client } from "@libsql/client";
import { getDb } from "../db/client";
import { migrate } from "../db/schema";
import type { AnalysisResult, CaseOutcome, Channel, Language } from "../domain";
import { excerpt } from "../privacy";

let ready: Promise<void> | undefined;

/** Клиент с гарантированно применённой схемой (миграция один раз на процесс). */
export async function db(): Promise<Client> {
  const client = getDb();
  ready ??= migrate(client).catch((err) => {
    ready = undefined;
    throw err;
  });
  await ready;
  return client;
}

export interface NewCase {
  messageText: string;
  language: Language;
  channel: Channel;
  analysis: AnalysisResult;
  riskScore: number; // итоговый риск перевода
  reasons: string[];
  amount: number | null;
  newRecipient: boolean;
  outcome: CaseOutcome;
}

/** Сохраняет случай. В базу попадает только замаскированный фрагмент текста. */
export async function insertCase(client: Client, c: NewCase, now = new Date()): Promise<string> {
  const id = `case-${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await client.execute({
    sql: `INSERT INTO cases (id, created_at, client_alias, channel, language, text_excerpt, risk_score, scam_type,
            reasons, recommendation, analysis_mode, transfer_amount, new_recipient, outcome, status, synthetic)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0)`,
    args: [
      id,
      now.toISOString(),
      "Демо-клиент",
      c.channel,
      c.language,
      excerpt(c.messageText),
      c.riskScore,
      c.analysis.scamType,
      JSON.stringify(c.reasons),
      c.analysis.recommendation,
      c.analysis.mode,
      c.amount,
      c.newRecipient ? 1 : 0,
      c.outcome,
    ],
  });
  return id;
}
