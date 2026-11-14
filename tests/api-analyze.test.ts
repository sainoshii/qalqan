import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, MAX_TEXT_LENGTH } from "@/lib/api/analyze-request";

const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://localhost/api/analyze", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/analyze", () => {
  let POST: (r: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules(); // свежий ограничитель частоты на каждый тест
    vi.stubEnv("ANTHROPIC_API_KEY", ""); // без LLM: детерминированно и без сети
    ({ POST } = await import("@/app/api/analyze/route"));
  });

  it("возвращает результат по контракту", async () => {
    const res = await POST(post({ text: "Служба безопасности банка. Назовите код из SMS." }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["evidence", "highlights", "mode", "reasons", "recommendation", "riskScore", "scamType"]);
    expect(json.evidence).toBe("rules");
    expect(json.riskScore).toBeGreaterThanOrEqual(70);
    expect(json.mode).toBe("rules");
    expect(Array.isArray(json.reasons)).toBe(true);
  });

  it("принимает казахский текст и явный lang", async () => {
    const res = await POST(post({ text: "Барлық ақшаңызды дереу қауіпсіз шотқа аударыңыз", lang: "kk" }));
    expect(res.status).toBe(200);
    expect((await res.json()).scamType).toBe("safe_account");
  });

  it.each([
    ["пустой текст", { text: "   " }],
    ["нет поля text", {}],
    ["text не строка", { text: 42 }],
    ["неизвестный lang", { text: "привет", lang: "en" }],
    ["слишком длинный текст", { text: "а".repeat(MAX_TEXT_LENGTH + 1) }],
    ["тело не объект", [1, 2]],
  ])("400: %s", async (_, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("400: некорректный JSON", async () => {
    expect((await POST(post("{oops"))).status).toBe(400);
  });

  it("415: не JSON", async () => {
    expect((await POST(post("text", { "content-type": "text/plain" }))).status).toBe(415);
  });

  it("413: слишком большое тело", async () => {
    expect((await POST(post({ text: "a", pad: "x".repeat(40_000) }))).status).toBe(413);
  });

  it("429 после 30 запросов в минуту с одного адреса, другой адрес не затронут", async () => {
    const from = (ip: string) => post({ text: "привет" }, { "content-type": "application/json", "x-forwarded-for": ip });
    for (let i = 0; i < 30; i++) expect((await POST(from("1.1.1.1"))).status).toBe(200);
    const blocked = await POST(from("1.1.1.1"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await POST(from("2.2.2.2"))).status).toBe(200);
  });
});

describe("createRateLimiter", () => {
  it("окно скользит, число ключей ограничено", () => {
    const allow = createRateLimiter(2, 1000, 2);
    expect([allow("a", 0), allow("a", 1), allow("a", 2)]).toEqual([true, true, false]);
    expect(allow("a", 1002)).toBe(true);
    allow("b", 1003);
    allow("c", 1004); // вытесняет самый старый ключ
    expect(allow("a", 1005)).toBe(true);
  });
});
