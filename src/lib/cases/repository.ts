import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";
import { getDb } from "../db/client";
import { migrate } from "../db/schema";
import type { AnalysisResult, CaseOutcome, Channel, Language } from "../domain";
import { excerpt } from "../privacy";
import { seedSynthetic } from "../seed/synthetic";

let ready: Promise<void> | undefined;

/**
 * Автозаполнение пустой базы синтетикой — чтобы задеплоенная панель не была пустой.
 * Включено на Vercel и по QALQAN_AUTO_SEED=1; выключается QALQAN_AUTO_SEED=0.
 */
export function autoSeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.QALQAN_AUTO_SEED === "0") return false;
  return env.QALQAN_AUTO_SEED === "1" || Boolean(env.VERCEL);
}

let seeded = false;

/** Заполняет пустую базу синтетикой. Сбой не пробрасывается: попытка повторится при следующем обращении. */
async function autoSeed(client: Client): Promise<void> {
  if (seeded || !autoSeedEnabled()) return;
  try {
    const { rows } = await client.execute("SELECT COUNT(*) AS n FROM cases WHERE synthetic = 1");
    if (Number(rows[0]?.n ?? 0) === 0) {
      const jsonl = await readFile(path.join(process.cwd(), "data/dataset/messages.jsonl"), "utf8");
      await seedSynthetic(client, jsonl);
    }
    seeded = true;
  } catch (err) {
    console.warn("Qalqan: автозаполнение базы пропущено, повтор при следующем запросе:", err instanceof Error ? err.name : "ошибка");
  }
}

let seeding: Promise<void> | undefined;

/** Клиент с гарантированно применённой схемой (миграция один раз на процесс). */
export async function db(): Promise<Client> {
  const client = getDb();
  ready ??= migrate(client).catch((err) => {
    ready = undefined;
    throw err;
  });
  await ready;
  // Автозаполнение необязательно: его сбой не закрывает доступ к рабочей базе.
  // Одновременные запросы ждут одну и ту же попытку — без двойной вставки.
  seeding ??= autoSeed(client).finally(() => {
    seeding = undefined;
  });
  await seeding;
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
