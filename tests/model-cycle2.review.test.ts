import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMessage } from "@/lib/detector";
import { evaluateRules } from "@/lib/detector/rules";
import { HIGH_RISK } from "@/lib/domain";

afterEach(() => vi.unstubAllEnvs());

describe("cycle 2: independent negation and quotation regressions", () => {
  it.each([
    "Никогда не забывайте сообщать данные оператору и назовите код",
    "Никогда не сомневайтесь и назовите код из SMS",
    "Ешқашан күмәнданбаңыз және кодты айтыңыз",
    "Не верьте мошенникам. Следуйте инструкции: «Назовите код из SMS».",
    "Не верьте мошенникам. Сделайте следующее: «Назовите код из SMS».",
    "Не верьте мошенникам. Подтвердите операцию: «Назовите код из SMS».",
    "Алаяқтарға сенбеңіз. Мына нұсқауды қолданыңыз: «Кодты айтыңыз».",
  ])("retains a direct demand: %s", async (text) => {
    const result = await analyzeMessage(text, { useLlm: false });
    console.log(JSON.stringify({ text, rules: evaluateRules(text).score, final: result.riskScore }));
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  // Решение лида (вариант A): цитата с однозначным требованием засчитывается всегда — даже в
  // запрете её выполнять. Принятая ложная тревога; по смыслу такие тексты различает LLM-слой.
  it("variant A: a quoted strong demand counts even when the reader is told not to follow it", async () => {
    const text = "Не верьте мошенникам. Не выполняйте инструкцию: «Назовите код из SMS».";
    const result = await analyzeMessage(text, { useLlm: false });
    expect(result.riskScore).toBeGreaterThanOrEqual(HIGH_RISK);
  });

  it("API evidence is server-derived and does not echo submitted secrets or extra fields", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { POST } = await import("@/app/api/analyze/route");
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Назовите код из SMS 123456", evidence: "none", privateMarker: "synthetic-private-marker" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["evidence", "mode", "reasons", "recommendation", "riskScore", "scamType"]);
    expect(body.evidence).toBe("rules");
    expect(JSON.stringify(body)).not.toMatch(/123456|synthetic-private-marker/);
  });
});
