import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/lib/privacy";

// Handwritten synthetic fixtures only. No held-out datasets or external services.
describe("iin-amount cycle 1: currency and rule ordering", () => {
  it.each(["тг", "теңге", "₸", "tg", "kzt", "руб", "$", "год", "жыл"])(
    "preserves both grouped amount formats before %s",
    (suffix) => {
      for (const value of ["1000 2000 3000", "150000 250000"]) {
        const text = `Сумма ${value} ${suffix}`;
        expect(maskSensitive(text)).toBe(text);
      }
    },
  );

  it.each([
    ["ИИН 900101 123456", "ИИН [ИИН]"],
    ["ЖСН: 9001 0112 3456", "ЖСН: [ИИН]"],
    ["900101-123456", "[ИИН]"],
    ["9001-0112-3456", "[ИИН]"],
    ["９００１０１ １２３４５６", "[ИИН]"],
    ["900\u200b101 123\u2060456", "[ИИН]"],
    ["900101\u00a0123456", "[ИИН]"],
    ["9001\u202f0112\u202f3456", "[ИИН]"],
    ["１０００ ２０００ ３０００ тг", "1000 2000 3000 тг"],
    ["1000 2000 3000 т\u200bг", "1000 2000 3000 тг"],
    ["900101123456 тг", "[ИИН] тг"],
    ["900101 123456\nтг", "[ИИН]\nтг"],
    ["900101 123456 тгabc", "[ИИН] тгabc"],
    ["Заказ №900101 123456", "Заказ №900101 123456"],
    ["order #9001 0112 3456", "order #9001 0112 3456"],
    ["4400 4301 2345 6789 тг", "[КАРТА] тг"],
    ["+7 701 555 12 34 тг", "[ТЕЛЕФОН] тг"],
    ["701 555 12 34 тг", "[ТЕЛЕФОН] тг"],
    ["1000 2000 3000 тг; ИИН 900101 123456", "1000 2000 3000 тг; ИИН [ИИН]"],
  ])("%s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });

  // Characterization of the requested heuristic, NOT a privacy guarantee:
  // an unlabelled grouped number before a currency stays open, as for codes.
  it.each(["900101 123456 тг", "Код: 4821 тг"])(
    "documents currency-suffix bypass: %s",
    (input) => expect(maskSensitive(input)).toBe(input),
  );

  // C1 fixed: an explicit IIN label outranks the currency exemption.
  it.each([
    ["ИИН 900101 123456 тг", "ИИН [ИИН] тг"],
    ["ЖСН: 9001 0112 3456 kzt", "ЖСН: [ИИН] kzt"],
    ["IIN 900101 123456 tg", "IIN [ИИН] tg"],
    ["иин №900101 123456 ₸", "иин №[ИИН] ₸"],
  ])("labelled IIN is masked despite currency: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });
});
