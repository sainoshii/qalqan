import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { findHighlights, normalizeWithMap } from "@/lib/detector/highlights";
import { evaluateRules, normalize } from "@/lib/detector/rules";
import { parseDataset } from "@/lib/dataset";
import type { AnalysisResult } from "@/lib/domain";
import { ON_CALL_REASON, assessTransfer } from "@/lib/transfer/risk";
import { AssessRequestSchema } from "@/lib/transfer/request";

const fragments = (text: string, r: { highlights?: { start: number; end: number }[] }) =>
  (r.highlights ?? []).map((h) => text.slice(h.start, h.end));

describe("normalizeWithMap", () => {
  it("совпадает с normalize на всём размеченном наборе", () => {
    const { items } = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));
    for (const item of items) expect(normalizeWithMap(item.text).text).toBe(normalize(item.text));
  });

  it("каждая позиция указывает на исходный символ", () => {
    const src = "  Ёлка\n\n  ИДЁТ  ";
    const { text, map } = normalizeWithMap(src);
    expect(text).toBe("елка идет");
    for (let i = 0; i < text.length; i++) {
      if (text[i] === " ") expect(/\s/.test(src[map[i]])).toBe(true);
      else expect(src[map[i]].toLowerCase().replace("ё", "е")).toBe(text[i]);
    }
  });
});

describe("findHighlights", () => {
  it("подсвечивает опасные фразы в исходном регистре и через переносы строк", async () => {
    const text = "Здравствуйте, СЛУЖБА БЕЗОПАСНОСТИ банка. Срочно переведите деньги на безопасный\nсчёт.";
    const r = await analyzeMessage(text);
    const parts = fragments(text, r);
    expect(parts).toContain("СЛУЖБА БЕЗОПАСНОСТИ");
    expect(parts).toContain("безопасный\nсчёт");
    expect(parts.some((p) => p.startsWith("Срочно"))).toBe(true);
    for (const h of r.highlights ?? []) expect(h.reason.length).toBeGreaterThan(0);
  });

  it("длинное совпадение подсвечивается по краям, до границ слов", async () => {
    const text = "Не спрашивайте зачем и назовите, пожалуйста, мне прямо сейчас все цифры, код из SMS.";
    const parts = fragments(text, await analyzeMessage(text));
    expect(parts.join(" ")).toMatch(/назовите/);
    expect(parts.join(" ")).toMatch(/код/);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
  });

  it("подсвечивает подозрительную ссылку, но не официальную", async () => {
    const text = "Ваша карта заблокирована. Подтвердите данные: http://bcc-secure.top/login или bcc.kz";
    const parts = fragments(text, await analyzeMessage(text));
    expect(parts).toContain("http://bcc-secure.top/login");
    expect(parts).not.toContain("bcc.kz");
  });

  it("настоящее уведомление банка и обычное сообщение — без подсветки", async () => {
    for (const text of [
      "Код для входа: 4821. Никому не сообщайте этот код, сотрудники банка никогда его не спрашивают.",
      "Скинь, пожалуйста, 3 000 за пиццу, которую вчера заказывали на всех.",
    ]) {
      expect((await analyzeMessage(text)).highlights).toEqual([]);
    }
  });

  it("фрагменты не пересекаются, отсортированы и лежат в пределах текста", () => {
    const { items } = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));
    for (const { text } of items) {
      const hs = findHighlights(text, evaluateRules(text).signals);
      let last = 0;
      for (const h of hs) {
        expect(h.start).toBeGreaterThanOrEqual(last);
        expect(h.end).toBeGreaterThan(h.start);
        expect(h.end).toBeLessThanOrEqual(text.length);
        last = h.end;
      }
    }
  });

  it("слабые признаки внутри цитаты в предупреждении не подсвечиваются", () => {
    const text = "Мошенники пишут: «срочно, прямо сейчас». Не верьте.";
    expect(findHighlights(text, ["urgency"])).toEqual([]);
  });

  it("неизвестные и защитные id ничего не подсвечивают", () => {
    expect(findHighlights("Никому не сообщайте код", ["protective_code_warning", "model", "nope"])).toEqual([]);
  });

  it("быстро работает на длинном тексте", () => {
    const text = "Срочно назовите код из SMS, служба безопасности. ".repeat(100).slice(0, 5000);
    const t0 = performance.now();
    findHighlights(text, evaluateRules(text).signals);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

const msg = (riskScore: number, evidence: AnalysisResult["evidence"]): AnalysisResult => ({
  riskScore,
  scamType: riskScore >= 40 ? "code_request" : null,
  reasons: ["причина"],
  recommendation: "",
  mode: "rules",
  evidence,
});

describe("assessTransfer: идёт звонок", () => {
  it("звонок без подозрительного сообщения и знакомому получателю ничего не меняет", () => {
    expect(assessTransfer({ amount: 450_000, newRecipient: false, message: null, onCall: true }).decision).toBe("allow");
  });

  it("звонок + новый получатель без сообщения — только предупреждение", () => {
    const a = assessTransfer({ amount: 450_000, newRecipient: true, message: null, onCall: true });
    expect(a.decision).toBe("warn");
    expect(a.riskScore).toBeLessThan(70);
    expect(assessTransfer({ amount: 5_000_000, newRecipient: true, message: null, onCall: true }).decision).toBe("warn");
  });

  it("подозрение одной модели + звонок — два независимых сигнала → вмешательство", () => {
    const without = assessTransfer({ amount: 450_000, newRecipient: true, message: msg(60, "model") });
    expect(without.decision).toBe("warn");
    const withCall = assessTransfer({ amount: 450_000, newRecipient: true, message: msg(60, "model"), onCall: true });
    expect(withCall.decision).toBe("intervene");
    expect(withCall.reasons[0]).toBe(ON_CALL_REASON);
  });

  it("низкий риск сообщения + звонок знакомому — без вмешательства", () => {
    expect(assessTransfer({ amount: 3000, newRecipient: false, message: msg(20, "none"), onCall: true }).decision).toBe("allow");
  });

  it("onCall необязателен в запросе и проверяется по типу", () => {
    expect(AssessRequestSchema.safeParse({ amount: 1000, newRecipient: true }).success).toBe(true);
    expect(AssessRequestSchema.safeParse({ amount: 1000, newRecipient: true, onCall: true }).success).toBe(true);
    expect(AssessRequestSchema.safeParse({ amount: 1000, newRecipient: true, onCall: "yes" }).success).toBe(false);
  });
});
