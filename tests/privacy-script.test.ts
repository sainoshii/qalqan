import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/lib/privacy";

/**
 * Маскирование кодов в латинице, «упрощённых» казахских буквах и смешанной раскладке.
 * До этой задачи «Kod: 4821» и «Кoд: 4821» (латинская o) уходили бы в LLM и в базу как есть.
 * Все примеры синтетические.
 */
const LAT_O = "o";
const LAT_A = "a";

describe("код маскируется в любой записи", () => {
  it.each([
    "Kod: 4821",
    "Vash kod: 4821. Nikomu ne soobshayte.",
    "Sizdin kodynyz: 4821",
    "Rastau kody 482193",
    "SMS kodty: 4821",
    "Parol: 739155",
    "Qupiya soz: 4821",
    "Qupiyasoz: 4821",
    "Купия соз: 4821",
    "Кодыныз: 4821",
    "Кодыңызды 4821 ешкімге айтпаңыз",
    `К${LAT_O}д: 4821`,
    `П${LAT_A}р${LAT_O}ль: 739155`,
    "4821 — kod dlya vhoda",
    "KOD: 4821",
  ])("%s", (text) => {
    const masked = maskSensitive(text);
    expect(masked).toContain("[КОД]");
    expect(masked).not.toMatch(/\d{3}/);
  });
});

describe("суммы и номера заказов латиницей не маскируются", () => {
  it.each([
    ["Kod zakaza: 58213", "Kod zakaza: 58213"],
    ["Kod: 4500 tg", "Kod: 4500 tg"],
    ["Kod: 4500 tenge", "Kod: 4500 tenge"],
  ])("%s", (text, want) => {
    expect(maskSensitive(text)).toBe(want);
  });
});

it("латиница маскируется так же, как та же фраза кириллицей", () => {
  // «Тапсырыс коды» (код заказа, казахский порядок слов) маскировалось и раньше — лишнее маскирование безопасно
  expect(maskSensitive("Tapsyrys kody: 58213")).toBe("Tapsyrys kody: [КОД]");
  expect(maskSensitive("Тапсырыс коды: 58213")).toBe("Тапсырыс коды: [КОД]");
});

it("в LLM уходит замаскированный исходный текст, а не нормализованный: латинский код и карта скрыты", async () => {
  const { analyzeMessage } = await import("@/lib/detector");
  const sent: string[] = [];
  const llm = async (masked: string) => {
    sent.push(masked);
    return null;
  };
  await analyzeMessage("Salem! Kodty jiberiniz: 4821, karta 4400 4301 2345 6789, tel +7 701 555 12 34", { llm, llmZone: "all" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Kodty jiberiniz"); // исходная запись, а не «кодты жибериниз»
  expect(sent[0]).toContain("[КОД]");
  expect(sent[0]).toContain("[КАРТА]");
  expect(sent[0]).toContain("[ТЕЛЕФОН]");
  expect(sent[0]).not.toMatch(/\d{3}/);
});

describe("ИИН группами: суммы с валютой не маскируются", () => {
  it.each([
    ["сумма 1000 2000 3000 тг", "сумма 1000 2000 3000 тг"],
    ["Аударым 150000 250000 теңге", "Аударым 150000 250000 теңге"],
    ["Итого 1000 2000 3000 ₸", "Итого 1000 2000 3000 ₸"],
    ["ИИН 900101 123456", "ИИН [ИИН]"],
    ["ЖСН: 9001 0112 3456", "ЖСН: [ИИН]"],
    ["Заказ №900101 123456", "Заказ №900101 123456"],
  ])("%s", (text, expected) => {
    expect(maskSensitive(text)).toBe(expected);
  });
});
