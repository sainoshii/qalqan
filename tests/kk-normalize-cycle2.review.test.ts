import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { maskSensitive, excerpt } from "@/lib/privacy";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";
import { canonicalize } from "@/lib/detector/normalize";

// Only handwritten synthetic inputs. Never load held-out datasets.
function baseline<T>(path: string): T {
  const source = execFileSync("git", ["show", `aa54e21e85f4e0f05cc9e2eeab86b3bc2be5da0c:${path}`], { encoding: "utf8" });
  const context = { exports: {} as T };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context.exports;
}
const oldRules = baseline<{ evaluateRules: typeof evaluateRules }>("src/lib/detector/rules.ts");
const oldPrivacy = baseline<{ maskSensitive: typeof maskSensitive }>("src/lib/privacy.ts");

describe("C1: invisible combining grapheme joiner must not bypass masking", () => {
  it.each([
    ["Код: 4\u034f8\u034f2\u034f1", "Код: [КОД]"],
    ["Карта: 4400\u034f4301\u034f2345\u034f6789", "Карта: [КАРТА]"],
    ["ИИН: 900101\u034f123456", "ИИН: [ИИН]"],
  ])("%s", (input, expected) => {
    expect(canonicalize(input).text).not.toContain("\u034f");
    expect(maskSensitive(input)).toBe(expected);
  });

  it("masks before both LLM callback and storage excerpt", async () => {
    const input = "Salem! Kod: 4\u034f8\u034f2\u034f1";
    const sent: string[] = [];
    await analyzeMessage(input, {
      llmZone: "all",
      llm: async (text) => { sent.push(text); return null; },
    });
    expect.soft(sent).toEqual(["Salem! Kod: [КОД]"]);
    expect.soft(excerpt(input)).toBe("Salem! Kod: [КОД]");
  });
});

it.each([
  "Кодты айту керек те емес",
  "Кодты айту қажет те емес",
])("C2: emphatic negation must not introduce strong: %s", (input) => {
  expect(oldRules.evaluateRules(input).strong).toBe(false);
  expect(evaluateRules(input).strong).toBe(false);
});

it.each([
  "Кодексті оқыңыз",
  "Еңбек кодексін оқыңыз",
])("C3: reading a legal code is not requesting a secret: %s", (input) => {
  expect(oldRules.evaluateRules(input).strong).toBe(false);
  expect(evaluateRules(input).strong).toBe(false);
});

it.each([
  "Заказ №123456 234567",
  "Заказ №1234 2345 3456",
])("C4: grouped order identifiers remain intact: %s", (input) => {
  expect(oldPrivacy.maskSensitive(input)).toBe(input);
  expect(maskSensitive(input)).toBe(input);
});

it.each([
  ["Сумма 100 000 000 000 тенге", "Сумма 100 000 000 000 тенге"],
  ["Код: ２０.１１.２０２６", "Код: 20.11.2026"],
  ["Код заказа: ５８２１３", "Код заказа: 58213"],
  ["Код: ４５００ тг", "Код: 4500 тг"],
  ["Код: 𝟒𝟖𝟐𝟏", "Код: [КОД]"],
  ["ИИН: 900101 123456", "ИИН: [ИИН]"],
  ["ИИН: 9001 0112 3456", "ИИН: [ИИН]"],
])("masking controls: %s", (input, expected) => {
  expect(maskSensitive(input)).toBe(expected);
});
