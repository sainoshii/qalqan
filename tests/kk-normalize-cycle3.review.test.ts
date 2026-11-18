import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { maskSensitive, excerpt } from "@/lib/privacy";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";

// Handwritten synthetic inputs only; never read held-out datasets.
const context = { exports: {} as { evaluateRules: typeof evaluateRules } };
runInNewContext(ts.transpileModule(execFileSync("git", [
  "show", "aa54e21e85f4e0f05cc9e2eeab86b3bc2be5da0c:src/lib/detector/rules.ts",
], { encoding: "utf8" }), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const oldRules = context.exports;

describe("C1: digit folding must precede removal of combining marks", () => {
  for (const [style, zero] of [["fullwidth", 0xff10], ["mathematical", 0x1d7ce]] as const) {
    it.each([
      ["Код", "4821", "КОД"],
      ["Карта", "4400430123456789", "КАРТА"],
      ["Телефон", "77015551234", "ТЕЛЕФОН"],
      ["ИИН", "900101123456", "ИИН"],
    ])(`${style}: %s`, (label, digits, marker) => {
      const value = [...digits].map((d) => String.fromCodePoint(zero + Number(d))).join("\u0301");
      expect(maskSensitive(`${label}: ${value}`)).toBe(`${label}: [${marker}]`);
    });
  }

  it("does not pass readable secrets to the LLM callback or storage excerpt", async () => {
    const input = "Salem! Kod: ４\u0301８\u0301２\u0301１";
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
  "Кодты айту қажет болмады",
  "Кодты айту керек деп ойламаңыз",
])("C2: negative necessity must not introduce strong: %s", (input) => {
  expect(oldRules.evaluateRules(input).strong).toBe(false);
  expect(evaluateRules(input).strong).toBe(false);
});

it.each([
  "Кодталған мәтінді оқыңыз",
  "Кодекті оқыңыз",
  "Кодер туралы оқыңыз",
])("C3: non-secret code-related words must not introduce strong: %s", (input) => {
  expect(oldRules.evaluateRules(input).strong).toBe(false);
  expect(evaluateRules(input).strong).toBe(false);
});

it.each([
  ["Код: 4\u03018\u03012\u03011", "Код: [КОД]"],
  ["Код: ４８２１", "Код: [КОД]"],
  ["Код: 4\ufe0f8\ufe0f2\ufe0f1", "Код: [КОД]"],
  ["№123456 234567", "№123456 234567"],
  ["#1234 2345 3456", "#1234 2345 3456"],
  ["договор 123456 234567", "договор 123456 234567"],
])("cycle-2 masking controls: %s", (input, expected) => {
  expect(maskSensitive(input)).toBe(expected);
});
