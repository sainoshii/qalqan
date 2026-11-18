import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/lib/privacy";

// Independent synthetic examples; no dataset imports.
describe("iin-amount cycle 2: label boundaries and locality", () => {
  it.each(["ИИН", "ЖСН", "IIN", "zhsn", "jsn", "иИн"])(
    "recognizes standalone %s with supported separators",
    (label) => {
      for (const sep of [" ", ": ", " №", "#", "   :   ", "\u00a0№\u202f"]) {
        for (const value of ["900101 123456", "9001-0112-3456"]) {
          const prefix = `Документ: ${label}${sep}`;
          expect(maskSensitive(`${prefix}${value} тг`)).toBe(`${prefix}[ИИН] тг`);
        }
      }
    },
  );

  it.each(["Хиин", "киин", "xiin", "skiin", "azhsn", "ajsn", "ИИНы", "iins"])(
    "does not recognize a label inside %s",
    (word) => {
      for (const prefix of ["", "Длинный префикс "]) {
        for (const sep of [" ", "   :   "]) {
          const text = `${prefix}${word}${sep}1000 2000 3000 тг`;
          expect(maskSensitive(text)).toBe(text);
        }
      }
    },
  );

  it.each([
    "ИИН: отсутствует; сумма 1000 2000 3000 тг",
    "ИИН: 42; 1000 2000 3000 тг",
    "ИИН\n1000 2000 3000 тг",
    "ИИН: 10 тг; 150000 250000 теңге",
    "ИИН                  1000 2000 3000 тг",
    "Заказ №900101 123456",
    "order #9001 0112 3456",
    "Код заказа: 4821",
    "Код: 4821 тг",
  ])("preserves unrelated amounts and identifiers: %s", (text) => {
    expect(maskSensitive(text)).toBe(text);
  });

  it.each([
    ["ИИН 900101 123456 тг; 1000 2000 3000 тг", "ИИН [ИИН] тг; 1000 2000 3000 тг"],
    ["1000 2000 3000 тг; ИИН №900101 123456", "1000 2000 3000 тг; ИИН №[ИИН]"],
    ["ИИН: 900101 123456; ЖСН: 9001 0112 3456 ₸", "ИИН: [ИИН]; ЖСН: [ИИН] ₸"],
    ["ИИН №900101 123456", "ИИН №[ИИН]"],
    ["ИИН 4400 4301 2345 6789 тг", "ИИН [КАРТА] тг"],
    ["ИИН +7 701 555 12 34 тг", "ИИН [ТЕЛЕФОН] тг"],
    ["Код: 4821; ИИН 900101 123456 тг", "Код: [КОД]; ИИН [ИИН] тг"],
    ["ＩＩＮ: ９００１０１ １２３４５６ тг", "IIN: [ИИН] тг"],
    ["И\u200bИН: 900101 123456 тг", "ИИН: [ИИН] тг"],
  ])("masks only the intended values: %s", (text, expected) => {
    expect(maskSensitive(text)).toBe(expected);
    expect(maskSensitive(expected)).toBe(expected);
  });
});
