import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFeedbackDataset, readFeedbackRows, toJsonl, normFeedbackText, type FeedbackRow } from "@/lib/feedback";
import { parseDataset } from "@/lib/dataset";
import { excerpt } from "@/lib/privacy";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { heldOutGuard, loadTraining, normText } from "../scripts/train-model";

const row = (text: string): FeedbackRow => ({
  id: "review-case", created_at: "2026-11-15T00:00:00Z", channel: "sms",
  language: "kk", text_excerpt: text, scam_type: null, status: "false_positive",
});
const heldItem = parseDataset(readFileSync("data/dataset/challenge-2.jsonl", "utf8")).items.find(i => i.id === "kk-legit-231")!;

describe("feedback cycle 1: leakage and boundary audit", () => {
  it("C1: masked held-out message is rejected by export", () => {
    const result = buildFeedbackDataset([row(excerpt(heldItem.text))], heldOutGuard().texts);
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([{ caseId: "review-case", reason: "held_out" }]);
  });

  it("C1: training rejects the masked held-out message independently", () => {
    const dir = mkdtempSync(join(tmpdir(), "qalqan-feedback-review-"));
    try {
      const file = join(dir, "feedback.jsonl");
      writeFileSync(file, toJsonl([{ ...heldItem, split: "dev", text: excerpt(heldItem.text) }]));
      expect(() => loadTraining([file])).toThrow(/Отложенн/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("C1: a long held-out text cannot leak through the repository excerpt format", () => {
    const full = "Синтетический отложенный пример для проверки обрезки. ".repeat(8);
    expect(excerpt(full)).toHaveLength(280);
    const result = buildFeedbackDataset([row(excerpt(full))], new Set([normText(full)]));
    expect(result.items).toEqual([]);
  });

  it("normalizers agree and case/whitespace variants of unmasked holdout are rejected", () => {
    const text = "Это отложенный текст с буквой ё для проверки.";
    const variant = text.toUpperCase().replaceAll(" ", " \n\t ");
    expect(normFeedbackText(variant)).toBe(normText(text));
    expect(buildFeedbackDataset([row(variant)], new Set([normText(text)])).items).toEqual([]);
  });

  it("empty migrated DB returns nothing and database errors propagate", async () => {
    const db = createDb(":memory:");
    try {
      await expect(readFeedbackRows(db)).rejects.toThrow();
      await migrate(db);
      expect(await readFeedbackRows(db)).toEqual([]);
    } finally { db.close(); }
  });

  it("exports at most 999 unique valid IDs per group", () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row(`Синтетический пример для проверки уникальности ${i}.`));
    const result = buildFeedbackDataset(rows);
    expect(result.items).toHaveLength(999);
    expect(result.skipped.filter(s => s.reason === "limit")).toHaveLength(2);
    expect(parseDataset(toJsonl(result.items)).errors).toEqual([]);
  });

  it("remasks card, phone, IIN and code before export", () => {
    const result = buildFeedbackDataset([row("Карта 4400 4300 1234 5678; телефон +7 701 555 12 34; ИИН 990101300123; код: 593842.")]);
    expect(result.items[0].text).toBe("Карта [КАРТА]; телефон [ТЕЛЕФОН]; ИИН [ИИН]; код: [КОД].");
    expect(parseDataset(toJsonl(result.items)).errors).toEqual([]);
  });
});
