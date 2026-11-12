import { describe, expect, it } from "vitest";
import { excerpt, maskSensitive } from "@/lib/privacy";

// Synthetic fixtures only; these cases exercise the persistence/LLM boundary.
describe("review: sensitive data in common message formats", () => {
  it.each([
    ["Телефон: 77015551234", "Телефон: [ТЕЛЕФОН]"],
    ["Телефон: 7 (701) 555-12-34", "Телефон: [ТЕЛЕФОН]"],
    ["Телефон: 701 555 12 34", "Телефон: [ТЕЛЕФОН]"],
  ])("masks a KZ telephone: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });

  it.each(["\u00a0", "\u202f", "\n"])("masks card groups separated by %j", (separator) => {
    const input = `Карта: ${["4400", "4301", "2345", "6789"].join(separator)}`;
    expect(maskSensitive(input)).toBe("Карта: [КАРТА]");
    expect(excerpt(input)).toBe("Карта: [КАРТА]");
  });

  it.each([
    ["4821 — код для входа", "[КОД] — код для входа"],
    ["4821 — кіру коды", "[КОД] — кіру коды"],
    ["Код: 482 113", "Код: [КОД]"],
    ["Код: 482-113", "Код: [КОД]"],
    ["Код: 4 8 2 1", "Код: [КОД]"],
    ["CVV: (123)", "CVV: ([КОД])"],
    ["Құпия сөз: 4821", "Құпия сөз: [КОД]"],
  ])("masks the complete code: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });

  it.each([
    "По промокоду скидка 500 тенге.",
    "Не сообщайте код при переводе 50000 тенге.",
    "Пинск: 2026 год.",
  ])("preserves ordinary words and amounts: %s", (input) => {
    expect(maskSensitive(input)).toBe(input);
  });

  it.each([
    ["IBAN: KZ86 125K ZT50 0410 0100", "IBAN: [IBAN]"],
    ["IBAN: kz86125kzt5004100100", "IBAN: [IBAN]"],
    ["ЖСН: 990101300123", "ЖСН: [ИИН]"],
    ["PIN: 4821", "PIN: [КОД]"],
    ["ПИН-код: 4821", "ПИН-код: [КОД]"],
  ])("retains supported formats: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
    expect(maskSensitive(expected)).toBe(expected);
  });
});
