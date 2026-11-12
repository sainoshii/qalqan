import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataset } from "@/lib/dataset";
import { excerpt, maskSensitive } from "@/lib/privacy";

// All fixtures are synthetic. Assert full output so partial masking cannot pass.
describe("cycle 2: preserve amounts, dates and order identifiers", () => {
  it.each([
    "Код не нужен: 125 300 тг.",
    "Код не нужен: 125\u202f300 теңге.",
    "Код действителен до 2026-11-20.",
    "Код заказа: 58213",
    "Заказ №7015551234 доставлен.",
    "Заказ №77015551234 доставлен.",
    "Скидка 5000 — код акции SALE.",
    "Заказ 58213 — код не требуется.",
  ])("preserves %s", (input) => {
    expect(maskSensitive(input)).toBe(input);
  });
});

describe("cycle 2: codes before their labels", () => {
  it.each([
    ["123 — CVV", "[КОД] — CVV"],
    ["482 113 — код для входа", "[КОД] — код для входа"],
    ["482-113 — код для входа", "[КОД] — код для входа"],
    ["4 8 2 1 — кіру коды", "[КОД] — кіру коды"],
  ])("masks %s completely", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
    expect(excerpt(input)).toBe(expected);
  });
});

describe("cycle 2: explicit code labels and quotation marks", () => {
  it.each([
    ["SMS code: 4821", "SMS code: [КОД]"],
    ["Код: «4821»", "Код: «[КОД]»"],
    ['Код: "4821"', 'Код: "[КОД]"'],
  ])("masks %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });
});

describe("cycle 2: all dataset texts", () => {
  const { items, errors } = parseDataset(readFileSync("data/dataset/messages.jsonl", "utf8"));
  const sensitive: Record<string, [string, string]> = {
    "ru-scam-024": ["+7 708 555 12 34", "[ТЕЛЕФОН]"],
    "ru-legit-001": ["4821", "[КОД]"],
    "ru-legit-015": ["5567", "[КОД]"],
    "kk-legit-001": ["7392", "[КОД]"],
  };

  it("loads the complete reviewed fixture", () => {
    expect(errors).toEqual([]);
    expect(items).toHaveLength(83);
  });

  it.each(items)("masks only sensitive values in $id", (item) => {
    const replacement = sensitive[item.id];
    const expected = replacement ? item.text.replace(...replacement) : item.text;
    expect(maskSensitive(item.text)).toBe(expected);
    expect(maskSensitive(expected)).toBe(expected);
  });
});
