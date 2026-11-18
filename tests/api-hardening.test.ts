import { beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

/**
 * Общий потолок запросов на экземпляр и заголовок CSP.
 * Лимит по адресу клиента (30 в минуту) обходится сменой адреса; общий потолок (600 в минуту) — нет.
 */
const GLOBAL_LIMIT = 600;

const post = (path: string, body: unknown, ip: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  });

describe.each([
  ["/api/analyze", "@/app/api/analyze/route", { text: "Привет, во сколько встречаемся?" }],
  ["/api/transfer/assess", "@/app/api/transfer/assess/route", { amount: 5000, newRecipient: false }],
])("%s: общий потолок на экземпляр", (path, modulePath, body) => {
  let POST: (r: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules(); // свежие ограничители на каждый тест
    vi.stubEnv("ANTHROPIC_API_KEY", ""); // без LLM: детерминированно и без сети
    ({ POST } = await import(modulePath));
  });

  it("с разных адресов: после потолка — 429 с Retry-After", async () => {
    for (let i = 0; i < GLOBAL_LIMIT; i++) {
      // каждый адрес — по одному запросу: лимит на адрес не срабатывает
      const res = await POST(post(path, body, `10.0.${Math.floor(i / 250)}.${i % 250}`));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(post(path, body, "10.9.9.9"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await blocked.json()).error).toMatch(/Слишком много запросов/);
  });

  it("лимит на адрес по-прежнему 30 в минуту", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(post(path, body, "10.1.1.1"))).status).toBe(200);
    expect((await POST(post(path, body, "10.1.1.1"))).status).toBe(429);
    expect((await POST(post(path, body, "10.1.1.2"))).status).toBe(200);
  });
});

describe("заголовки безопасности", () => {
  it("CSP запрещает плагины, подмену <base>, чужие формы и встраивание страницы", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    const csp = all?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Скрипты CSP не ограничивает: для этого нужны nonce у встроенных скриптов Next.js
    expect(csp).not.toMatch(/script-src/);
  });
});
