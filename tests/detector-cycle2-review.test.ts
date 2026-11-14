import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { analyzeMessage, combine, evaluateRules } from "@/lib/detector";
import { HIGH_RISK } from "@/lib/domain";
import { maskSensitive } from "@/lib/privacy";

describe("cycle 2: C2-C4 and C7 regression probes, no network", () => {
  it.each([['«', '»'], ['"', '"'], ['“', '”']])(
    "C2: a malicious instruction stays high risk inside %s%s after a memo prefix", async (open, close) => {
      const demand = "Назовите код из SMS нашему оператору.";
      expect(evaluateRules(demand).score).toBeGreaterThanOrEqual(HIGH_RISK);
      const text = `Памятка клиенту. Выполните обязательное указание: ${open}${demand}${close}`;
      const result = await analyzeMessage(text, { useLlm: false });
      console.log("C2_QUOTED " + JSON.stringify({ text, result }));
      expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    },
  );

  it("C2: investment disclaimer stays below the threshold", () => {
    expect(evaluateRules("Доходность не гарантирована. Цена бумаг может снизиться.").score).toBeLessThan(HIGH_RISK);
  });

  // Решение лида (вариант A): однозначные требования засчитываются всегда, в том числе в цитатах
  // памяток. Это принятые ложные тревоги — цена защиты от обходов формулировками.
  it.each([
    "Памятка: «Назовите код из SMS» — это уловка. Не верьте звонящему.",
    "Ескерту: «Ақшаны қауіпсіз шотқа аударыңыз» деген сөзге сенбеңіз.",
  ])("variant A: a warning quoting a strong demand is an accepted false alarm: %s", (text) => {
    expect(evaluateRules(text).strong).toBe(true);
  });

  it.each(["Назовите код из SMS.", "Установите AnyDesk.", "Переведите деньги на безопасный счет."])(
    "C3: protective footer and low LLM verdict cannot remove a strong signal: %s", (text) => {
      const rules = evaluateRules(`${text} Никому не сообщайте код. Позвоните по номеру на обороте карты.`);
      expect(rules.strong).toBe(true);
      expect(rules.score).toBeGreaterThanOrEqual(HIGH_RISK);
      expect(combine(rules, { riskScore: 0, scamType: null, reasons: [] }).riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    },
  );

  it.each([80, 95, 100])("C4: a confident named LLM scheme raises zero rules at score %i", async (riskScore) => {
    const result = await analyzeMessage("Привет.", {
      llm: async () => ({ riskScore, scamType: "marketplace", reasons: ["Синтетический вердикт для проверки объединения"] }),
    });
    expect(result.mode).toBe("hybrid");
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(result.scamType).toBe("marketplace");
  });

  it("C4: checks the confidence boundary and the named-scheme requirement", () => {
    const rules = evaluateRules("Привет.");
    expect(combine(rules, { riskScore: 79, scamType: "marketplace", reasons: [] }).riskScore).toBe(55);
    expect(combine(rules, { riskScore: 80, scamType: null, reasons: [] }).riskScore).toBe(56);
  });

  it("phishing type takes precedence over a concurrent code request", () => {
    const result = evaluateRules("Перейдите по ссылке https://refund.example и введите CVV.");
    expect(result.score).toBeGreaterThanOrEqual(HIGH_RISK);
    expect(result.scamType).toBe("phishing_link");
  });

  it.each([
    "Код для подтверждения перевода: 4821.",
    "Код для подтверждения вашего перевода: 4821.",
    "Растау үшін бір реттік құпиясөз: 4821.",
  ])("C7: masks a conventional code before the LLM boundary: %s", async (text) => {
    const llm = vi.fn(async () => null);
    await analyzeMessage(text, { llm });
    expect(llm).toHaveBeenCalledOnce();
    expect(llm.mock.calls[0]).toBeDefined();
    const sent = (llm.mock.calls as unknown as [string, string][])[0][0];
    expect(sent).toContain("[КОД]");
    expect(sent).not.toContain("4821");
  });

  it("C7: a payment authorization OTP is not an order identifier", async () => {
    const text = "Код подтверждения оплаты заказа: 4821. Никому не сообщайте этот код.";
    const llm = vi.fn(async (_text: string) => { void _text; return null; });
    await analyzeMessage(text, { llm });
    console.log("C7_PAYMENT " + JSON.stringify({ masked: maskSensitive(text), sent: llm.mock.calls[0][0] }));
    expect(llm.mock.calls[0][0]).not.toContain("4821");
    expect(llm.mock.calls[0][0]).toContain("[КОД]");
  });

  it("new rule and masking patterns finish on 5000-character near matches", () => {
    const script = `
      const { evaluateRules } = require('./src/lib/detector/rules.ts');
      const { maskSensitive } = require('./src/lib/privacy.ts');
      const seeds = ['памятка «', 'памятка "', 'код код код код ', 'құпиясөз ', 'ешкімге айтпаңыз ', 'кодтарын ешкімге айтпаңыз ', 'никому не сообщайте ', 'доходность не гарантирован', 'остаток вывести ', 'anydesk ', 'a', 'a.', '1 ', 'код ' + ' '.repeat(30), 'код ' + 'а'.repeat(100)];
      console.log(JSON.stringify(seeds.map(seed => {
        const input = seed.repeat(Math.ceil(5000 / seed.length)).slice(0, 4999) + '!';
        const start = performance.now();
        for (let i = 0; i < 10; i++) { evaluateRules(input); maskSensitive(input); }
        return { seed, chars: input.length, msForTen: +(performance.now() - start).toFixed(2) };
      })));
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 8000,
    });
    console.log("CYCLE2_REGEX " + output.trim());
    const rows = JSON.parse(output) as { chars: number; msForTen: number }[];
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.chars === 5000 && row.msForTen < 2000)).toBe(true);
  }, 10_000);
});
