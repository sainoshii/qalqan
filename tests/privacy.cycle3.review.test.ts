import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { excerpt, maskSensitive } from "@/lib/privacy";

// Synthetic fixtures only. These assertions describe the expected behavior,
// including regressions that deliberately fail on the cycle-3 snapshot.
describe("cycle 3: privacy regressions", () => {
  it.each([
    "Код не сообщайте: 4821",
    "Код не передавайте: 4821",
  ])("C2: masks a secret in a warning: %s", (input) => {
    expect(maskSensitive(input)).toBe(input.replace("4821", "[КОД]"));
  });

  it.each([
    "Код: 4821\n125 300 тг.",
    "Код: 4821\n2026 год",
    "Код: 4821\nГод выпуска: 2026",
  ])("C3: keeps context from the following line separate: %s", (input) => {
    const expected = input.replace("4821", "[КОД]");
    expect.soft(maskSensitive(input)).toBe(expected);
    expect.soft(excerpt(input)).toBe(expected.replace(/\s+/g, " "));
  });

  it.each([
    "20.11.2026 — код действителен до этой даты",
    "20/11/2026 — код действителен до этой даты",
  ])("C4: preserves a whole date before a code label: %s", (input) => {
    expect(maskSensitive(input)).toBe(input);
  });

  it("C5: preserves a Kazakh negation after a backward label", () => {
    const input = "1234 — код қажет емес";
    expect(maskSensitive(input)).toBe(input);
  });

  it.each([
    "Заказ: 7015551234",
    "Тапсырыс: 7015551234",
  ])("C6: preserves an order identifier after a colon: %s", (input) => {
    expect(maskSensitive(input)).toBe(input);
  });

  it.each([
    ["Код: 4821\nСумма: 125 300 тг.", "Код: [КОД]\nСумма: 125 300 тг."],
    ["Код не нужен: 125 300 тг.", "Код не нужен: 125 300 тг."],
    ["Код қажет емес: 1234", "Код қажет емес: 1234"],
    ["Код: 4821, CVV: 123", "Код: [КОД], CVV: [КОД]"],
    ["Телефон: +7 (701) 555-12-34", "Телефон: [ТЕЛЕФОН]"],
  ])("retains supported behavior: %s", (input, expected) => {
    expect(maskSensitive(input)).toBe(expected);
  });
});

describe("cycle 3: 10,000-character inputs", () => {
  // A synchronous regexp can block Vitest's own timeout. Run the actual function
  // in a child with an OS-enforced timeout and report its startup separately.
  it.each([
    ["spaces", " ".repeat(10_000)],
    ["digits", "1".repeat(10_000)],
    ["digits and spaces", "1 ".repeat(5_000)],
    ["C1: code label followed by spaces", "Код" + " ".repeat(9_997)],
    ["code label, spaces and value", "Код" + " ".repeat(9_993) + "4821"],
    ["value followed by spaces", "4821" + " ".repeat(9_996)],
    ["value, spaces and dash", "4821" + " ".repeat(9_995) + "—"],
  ])("finishes within 3 seconds: %s", (_name, input) => {
    expect(input).toHaveLength(10_000);
    const script = `
      const { maskSensitive } = require('./src/lib/privacy.ts');
      console.log('ready');
      const started = performance.now();
      maskSensitive(${JSON.stringify(input)});
      console.log(JSON.stringify({ elapsedMs: performance.now() - started }));
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 3_000,
      killSignal: "SIGKILL",
    });
    expect(result.stdout, result.stderr).toContain("ready");
    expect(result.error, `${_name}: ${result.error?.message}; ${result.stderr}`).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const timing = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { elapsedMs: number };
    console.log(`${_name}: ${timing.elapsedMs.toFixed(2)} ms`);
    expect(timing.elapsedMs).toBeLessThan(3_000);
  }, 10_000);
});
