import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { maskSensitive, excerpt } from "@/lib/privacy";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules, URL_PATTERN } from "@/lib/detector/rules";
import { canonicalize, linkSpans } from "@/lib/detector/normalize";

// Synthetic inputs only; never load the reserved challenge datasets.
describe("C1: privacy across supported representations", () => {
  it.each([
    ["Код: ４８２１", "Код: [КОД]"],
    ["Код: 4\u200b8\u200b2\u200b1", "Код: [КОД]"],
    ["К\u200bод: 4821", "Код: [КОД]"], // невидимые символы удаляются при маскировании (решение лида, цикл 1)
    ["к о д: 4821", "к о д: [КОД]"],
    ["Карта: ４４００４３０１２３４５６７８９", "Карта: [КАРТА]"],
    ["ИИН: 900101 123456", "ИИН: [ИИН]"],
    ["Телефон: +７ ７０１ ５５５ １２ ３４", "Телефон: [ТЕЛЕФОН]"],
    ["Код: 4 8 2 1", "Код: [КОД]"],
    ["Kod: 4821", "Kod: [КОД]"],
  ])("%s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });

  it("masks the original text before calling the LLM", async () => {
    const sent: string[] = [];
    await analyzeMessage("Salem! Kod: ４８２１", {
      llmZone: "all",
      llm: async (text) => { sent.push(text); return null; },
    });
    expect(sent).toEqual(["Salem! Kod: [КОД]"]);
  });

  it("masks the excerpt used for storage", () => {
    expect(excerpt("Salem! Kod: ４８２１")).toBe("Salem! Kod: [КОД]");
  });
});

it.each([
  "Кодты окып жибермениз",
  "Кодты жазып жибермениз",
  "Кодты беріңізші дегенге сенбеңіз",
])("C2: prohibition or warning must not become strong: %s", (input) => {
  const source = execFileSync("git", [
    "show", "aa54e21e85f4e0f05cc9e2eeab86b3bc2be5da0c:src/lib/detector/rules.ts",
  ], { encoding: "utf8" });
  const context = { exports: {} as { evaluateRules: typeof evaluateRules } };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  expect(context.exports.evaluateRules(input).strong).toBe(false);
  expect(evaluateRules(input).strong).toBe(false);
});

it("synthetic normalization remains idempotent and maps into the source", () => {
  for (const input of ["😀 Ко\u0301дты jiberiniz", "𝐊𝐨𝐝ty jiberiniz", "к о д", "sh sh d", "Кодты айту қажет емес"]) {
    const result = canonicalize(input);
    expect(canonicalize(result.text).text).toBe(result.text);
    expect(result.map).toHaveLength(result.text.length);
    result.map.forEach((at, i) => {
      expect(at).toBeGreaterThanOrEqual(i ? result.map[i - 1] : 0);
      expect(at).toBeLessThan(input.length);
    });
  }
});

it("link spans match the old regex on synthetic boundaries", () => {
  for (const input of ["https://a.example/path?q=x", "a.aa1.b2.cc--", "a.aa/a.bb c.kz", "a".repeat(5000)]) {
    expect(linkSpans(input)).toEqual([...input.matchAll(URL_PATTERN)].map(m => [m.index, m.index + m[0].length]));
  }
});
