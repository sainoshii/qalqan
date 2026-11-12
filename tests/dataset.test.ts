import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset, summarize, validateItem } from "@/lib/dataset";

const { items, errors } = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));

describe("data/dataset/messages.jsonl", () => {
  it("корректен", () => {
    expect(errors).toEqual([]);
    expect(items.length).toBeGreaterThanOrEqual(80);
  });

  it("сбалансирован по меткам и языкам", () => {
    const s = summarize(items);
    expect(Math.abs(s.scam - s.legit)).toBeLessThanOrEqual(Math.ceil(s.total * 0.1));
    expect(s.byLang.kk).toBeGreaterThanOrEqual(20);
    expect(s.hardNegative).toBeGreaterThanOrEqual(8);
    expect(s.bySplit.holdout).toBeGreaterThanOrEqual(Math.floor(s.total * 0.25));
  });

  it("покрывает каждый тип схемы хотя бы двумя примерами", () => {
    for (const [type, n] of Object.entries(summarize(items).byScamType)) {
      expect(n, type).toBeGreaterThanOrEqual(2);
    }
  });

  it("в holdout есть и мошеннические, и обычные сообщения на обоих языках", () => {
    for (const lang of ["ru", "kk"]) {
      for (const label of ["scam", "legit"]) {
        expect(items.some((i) => i.split === "holdout" && i.lang === lang && i.label === label)).toBe(true);
      }
    }
  });
});

describe("validateItem", () => {
  const valid = {
    id: "ru-scam-001",
    lang: "ru",
    channel: "sms",
    label: "scam",
    scamType: "phishing_link",
    split: "dev",
    text: "Перейдите по ссылке для разблокировки карты",
  };

  it("принимает корректную запись", () => {
    expect(validateItem(valid)).toEqual([]);
  });

  it.each([
    [{ ...valid, scamType: null }, "scam без"],
    [{ ...valid, label: "legit", id: "ru-legit-001" }, "legit должен"],
    [{ ...valid, lang: "kk" }, "id не совпадает с lang"],
    [{ ...valid, split: "test" }, "split"],
    [{ ...valid, hardNegative: true }, "hardNegative"],
  ])("отклоняет некорректную запись (%#)", (item, message) => {
    expect(validateItem(item).join("; ")).toContain(message);
  });
});
