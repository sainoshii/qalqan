import { describe, expect, it } from "vitest";
import { AnalyzeRequestSchema } from "@/lib/api/analyze-request";
import { AssessRequestSchema, CaseRequestSchema } from "@/lib/transfer/request";

const CYRILLIC = /[а-яё]/i;

describe("ошибки проверки входа — на русском", () => {
  const bad: Array<[string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, unknown]> = [
    ["text не строка", AnalyzeRequestSchema, { text: 42 }],
    ["lang неизвестен", AnalyzeRequestSchema, { text: "привет мир", lang: "en" }],
    ["amount строкой", AssessRequestSchema, { amount: "1", newRecipient: true }],
    ["newRecipient строкой", AssessRequestSchema, { amount: 1, newRecipient: "yes" }],
    ["messageText числом", AssessRequestSchema, { amount: 1, newRecipient: false, messageText: 42 }],
    ["onCall строкой", AssessRequestSchema, { amount: 1, newRecipient: false, onCall: "yes" }],
    ["channel неизвестен", CaseRequestSchema, { amount: 1, newRecipient: false, channel: "fax", outcome: "proceeded" }],
    ["outcome неизвестен", CaseRequestSchema, { amount: 1, newRecipient: false, outcome: "maybe" }],
  ];
  for (const [name, schema, input] of bad) {
    it(name, () => {
      const r = schema.safeParse(input);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].message).toMatch(CYRILLIC);
    });
  }
});

describe("тело не объект", () => {
  it("массив и строка — понятная ошибка на русском", () => {
    expect(AssessRequestSchema.safeParse([]).error?.issues[0].message).toBe("Тело запроса должно быть JSON-объектом");
    expect(AnalyzeRequestSchema.safeParse("x").error?.issues[0].message).toBe("Тело запроса должно быть JSON-объектом");
    expect(CaseRequestSchema.safeParse(null).error?.issues[0].message).toMatch(CYRILLIC);
  });
});
