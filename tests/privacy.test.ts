import { describe, expect, it } from "vitest";
import { excerpt, maskSensitive } from "@/lib/privacy";

describe("maskSensitive", () => {
  it.each([
    ["Карта 4400 4301 2345 6789, срок 12/28", "[КАРТА]"],
    ["Номер карты 4400430123456789", "[КАРТА]"],
    ["Перезвоните на +7 (701) 123-45-67", "[ТЕЛЕФОН]"],
    ["Мой номер 8 777 123 45 67", "[ТЕЛЕФОН]"],
    ["ИИН 990101300123", "[ИИН]"],
    ["IBAN KZ86125KZT5004100100", "[IBAN]"],
  ])("маскирует: %s", (input, token) => {
    const masked = maskSensitive(input);
    expect(masked).toContain(token);
    expect(masked).not.toMatch(/\d{6,}/);
  });

  it.each([
    ["Код для входа: 4821", "Код для входа: [КОД]"],
    ["продиктуйте код 482113", "продиктуйте код [КОД]"],
    ["CVV 123", "CVV [КОД]"],
    ["Кіру коды: 7392", "Кіру коды: [КОД]"],
  ])("маскирует коды рядом с ключевыми словами: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });

  it("не трогает суммы и обычный текст", () => {
    const text = "Покупка 3 450 тг, доступно 125 300 тг. Встречаемся в 7.";
    expect(maskSensitive(text)).toBe(text);
  });
});

describe("excerpt", () => {
  it("маскирует, схлопывает пробелы и обрезает", () => {
    const long = `Код: 1234\n\n${"слово ".repeat(100)}`;
    const result = excerpt(long, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.startsWith("Код: [КОД] слово")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("maskSensitive: производительность на враждебных входах", () => {
  const n = 100_000;
  it.each([
    ["ключ и пробелы", "Код" + " ".repeat(n)],
    ["ключ, двоеточие, пробелы", "Код:" + " ".repeat(n)],
    ["повтор ключа", "код ".repeat(n / 4)],
    ["цифры через дефис", "1-".repeat(n / 2)],
    ["число, пробелы, тире", "4821" + " ".repeat(n) + "—"],
    ["переносы строк", "Код:\n".repeat(n / 5)],
  ])("%s — 100 000 символов быстрее 500 мс", (_, input) => {
    const start = performance.now();
    maskSensitive(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
