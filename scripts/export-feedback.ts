/**
 * Выгрузка решений аналитиков в обучающие данные модели — в два шага.
 *
 *   npm run feedback:export              — 1) кандидаты: data/dataset/feedback.candidates.jsonl
 *   npm run feedback:export -- --dry     —    только показать, что будет выгружено
 *   npm run feedback:export -- --approve — 2) после просмотра: кандидаты → data/dataset/feedback.jsonl
 *
 * В обучение (`npm run train`) идёт только одобренный файл feedback.jsonl. Кандидаты — нет:
 * решения в открытой демо-панели может поставить кто угодно, поэтому человек просматривает
 * кандидатов (у каждой записи есть caseId — источник в базе) и удаляет лишние строки,
 * прежде чем одобрить. В продукте панель закрыта паролем (QALQAN_DASHBOARD_PASSWORD).
 *
 * Для боевой базы (Turso) задайте DATABASE_URL и DATABASE_AUTH_TOKEN в окружении.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getDb } from "../src/lib/db/client";
import {
  FEEDBACK_CANDIDATES_FILE,
  FEEDBACK_FILE,
  approveCandidates,
  buildFeedbackDataset,
  readFeedbackRows,
  toJsonl,
} from "../src/lib/feedback";
import { heldOutGuard } from "./train-model";

/**
 * Атомарная запись: во временный файл рядом с целевым, затем переименование. При ошибке
 * (например, нет места на диске) прежний файл остаётся целым, временный удаляется.
 */
export function writeAtomic(file: string, data: string) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function approve() {
  let content: string;
  try {
    content = readFileSync(FEEDBACK_CANDIDATES_FILE, "utf8");
  } catch {
    throw new Error(`Нет файла кандидатов ${FEEDBACK_CANDIDATES_FILE}: сначала npm run feedback:export`);
  }
  // Формат, повторное маскирование, утечка, повторы — всё до записи; ошибка — файл не меняется
  const items = approveCandidates(content, heldOutGuard().texts);
  // caseId — только для просмотра; в обучающий файл не переносится
  writeAtomic(FEEDBACK_FILE, toJsonl(items));
  console.log(`Одобрено: ${items.length} записей → ${FEEDBACK_FILE}. Дальше: npm run train → npm run eval.`);
}

async function exportCandidates(dry: boolean) {
  const rows = await readFeedbackRows(getDb());
  const { items, skipped, sources } = buildFeedbackDataset(rows, heldOutGuard().texts);

  const scam = items.filter((i) => i.label === "scam").length;
  console.log(`Решений аналитиков: ${rows.length}. Кандидатов в обучение: ${items.length} (мошенничество ${scam}, ложные срабатывания ${items.length - scam}).`);
  if (skipped.length) {
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    console.log(`Пропущено: ${[...byReason].map(([r, n]) => `${r} ${n}`).join(", ")}`);
  }
  if (dry) return;
  writeAtomic(FEEDBACK_CANDIDATES_FILE, toJsonl(items, sources));
  console.log(`Записано: ${FEEDBACK_CANDIDATES_FILE}. Просмотрите, удалите лишнее → npm run feedback:export -- --approve.`);
}

async function main() {
  if (process.argv.includes("--approve")) approve();
  else await exportCandidates(process.argv.includes("--dry"));
}

if (process.argv[1]?.endsWith("export-feedback.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
