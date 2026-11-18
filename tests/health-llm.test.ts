import { afterEach, describe, expect, it, vi } from "vitest";

async function health() {
  vi.resetModules();
  vi.doMock("next/server", () => ({ connection: async () => {} }));
  vi.doMock("@/lib/cases/repository", () => ({
    db: async () => ({ execute: async () => ({ rows: [{ n: 3 }] }) }),
  }));
  return (await import("@/app/api/health/route")).GET();
}

describe("/api/health — состояние LLM без ключа", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/cases/repository");
  });

  it("LLM не подключена", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const body = await (await health()).json();
    expect(body.llm).toEqual({ configured: false, model: null, zone: "30-69", paused: false, budgetExhausted: false });
  });

  it("подключена: модель и зона видны, ключ — нет", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-secret-key-value");
    vi.stubEnv("QALQAN_LLM_MODEL", "claude-haiku-5-5");
    vi.stubEnv("QALQAN_LLM_ZONE", "all");
    const res = await health();
    const text = await res.text();
    expect(text).not.toContain("synthetic-secret-key-value");
    expect(JSON.parse(text).llm).toEqual({ configured: true, model: "claude-haiku-5-5", zone: "all", paused: false, budgetExhausted: false });
  });
});
