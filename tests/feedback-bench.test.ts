import { describe, expect, it } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { insertCase } from "@/lib/cases/repository";
import { analyzeMessage } from "@/lib/detector";
import { parseDataset } from "@/lib/dataset";
import { buildFeedbackDataset, normFeedbackText, readFeedbackRows, toJsonl, type FeedbackRow } from "@/lib/feedback";
import { isAnalysis, percentile, stats } from "../scripts/bench";
import { TRAIN_FILES } from "../scripts/train-model";

const row = (over: Partial<FeedbackRow>): FeedbackRow => ({
  id: "case-1",
  created_at: "2026-11-15T10:00:00.000Z",
  channel: "call",
  language: "ru",
  text_excerpt: "Служба безопасности банка: срочно переведите деньги на безопасный счёт.",
  scam_type: "safe_account",
  status: "confirmed_fraud",
  ...over,
});

describe("buildFeedbackDataset", () => {
  it("подтверждённое → scam, ложное срабатывание → legit; записи проходят проверку набора", () => {
    const { items, skipped } = buildFeedbackDataset([
      row({}),
      row({ id: "case-2", status: "false_positive", scam_type: "code_request", text_excerpt: "Скажите, когда придёт код из SMS — я подожду у кассы." }),
      row({ id: "case-3", language: "kk", channel: "sms", scam_type: "code_request", text_excerpt: "Кодты операторға айтыңыз, әйтпесе ақша есептен шығарылады." }),
    ]);
    expect(skipped).toEqual([]);
    expect(items.map((i) => [i.id, i.label, i.scamType])).toEqual([
      ["ru-scam-001", "scam", "safe_account"],
      ["ru-legit-001", "legit", null],
      ["kk-scam-001", "scam", "code_request"],
    ]);
    const parsed = parseDataset(toJsonl(items));
    expect(parsed.errors).toEqual([]);
    expect(parsed.items).toHaveLength(3);
  });

  it("пропускает без решения, без типа, короткие, повторы и тексты отложенных наборов", () => {
    const heldOut = "Это текст из отложенного набора, его нельзя учить.";
    const { items, skipped } = buildFeedbackDataset(
      [
        row({ id: "a", status: "new" }),
        row({ id: "b", status: "reviewing" }),
        row({ id: "c", scam_type: null }),
        row({ id: "d", text_excerpt: "коротко" }),
        row({ id: "e", status: "false_positive", text_excerpt: heldOut }),
        row({ id: "f" }),
        row({ id: "g", text_excerpt: "  СЛУЖБА безопасности банка:   срочно переведите деньги на безопасный счёт. " }),
      ],
      new Set([normFeedbackText(heldOut)]),
    );
    expect(items.map((i) => i.id)).toEqual(["ru-scam-001"]);
    expect(skipped).toEqual([
      { caseId: "c", reason: "no_scam_type" },
      { caseId: "d", reason: "too_short" },
      { caseId: "e", reason: "held_out" },
      { caseId: "g", reason: "duplicate" },
    ]);
  });

  it("повторно маскирует чувствительные данные", () => {
    const { items } = buildFeedbackDataset([row({ text_excerpt: "Назовите номер карты 4400 4300 1234 5678 и код из SMS сотруднику." })]);
    expect(items[0].text).not.toMatch(/4400 4300 1234 5678/);
  });

  it("пустой результат — пустой файл", () => {
    expect(toJsonl([])).toBe("");
  });
});

describe("readFeedbackRows", () => {
  it("берёт только решения аналитиков по реальным (не синтетическим) случаям", async () => {
    const d = createDb(":memory:");
    await migrate(d);
    const text = "Служба безопасности банка: срочно переведите деньги на безопасный счёт.";
    const analysis = await analyzeMessage(text);
    const base = { messageText: text, language: "ru" as const, channel: "call" as const, analysis, riskScore: 100, reasons: [], amount: 450_000, newRecipient: true, outcome: "cancelled_by_client" as const };
    const [confirmed, fp, untouched, synthetic] = await Promise.all([1, 2, 3, 4].map((i) => insertCase(d, base, new Date(Date.UTC(2026, 10, 15, 10, i)))));
    await d.execute({ sql: "UPDATE cases SET status = 'confirmed_fraud' WHERE id IN (?, ?)", args: [confirmed, synthetic] });
    await d.execute({ sql: "UPDATE cases SET status = 'false_positive' WHERE id = ?", args: [fp] });
    await d.execute({ sql: "UPDATE cases SET synthetic = 1 WHERE id = ?", args: [synthetic] });
    const rows = await readFeedbackRows(d);
    expect(rows.map((r) => r.id)).toEqual([confirmed, fp]);
    expect(rows.map((r) => r.id)).not.toContain(untouched);
    d.close();
  });
});

describe("обучение", () => {
  it("feedback.jsonl входит в обучающие файлы, отложенные наборы — нет", () => {
    expect(TRAIN_FILES).toContain("data/dataset/feedback.jsonl");
    expect(TRAIN_FILES.some((f) => /challenge-[234]/.test(f))).toBe(false);
  });
});

describe("bench: статистика", () => {
  it("перцентили по отсортированной выборке", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 100)).toBe(100);
    expect(percentile([], 50)).toBeNaN();
    expect(stats([3, 1, 2])).toMatchObject({ n: 3, mean: 2, p50: 2, max: 3 });
  });
});

describe("двухшаговая выгрузка и контракт замера", () => {
  it("кандидаты несут caseId, но парсятся как набор; одобренный файл — без caseId", () => {
    const { items, sources } = buildFeedbackDataset([row({ id: "case-42" })]);
    const candidates = toJsonl(items, sources);
    expect(JSON.parse(candidates.trim()).caseId).toBe("case-42");
    expect(parseDataset(candidates).errors).toEqual([]);
    expect(JSON.parse(toJsonl(items).trim())).not.toHaveProperty("caseId");
  });

  it("кандидаты не входят в обучающие файлы", () => {
    expect(TRAIN_FILES).not.toContain("data/dataset/feedback.candidates.jsonl");
  });

  it("isAnalysis отличает ответ API от страницы ошибки", () => {
    expect(isAnalysis({ riskScore: 70, reasons: [] })).toBe(true);
    expect(isAnalysis(null)).toBe(false);
    expect(isAnalysis({ riskScore: "70", reasons: [] })).toBe(false);
    expect(isAnalysis({ error: "x" })).toBe(false);
  });
});
