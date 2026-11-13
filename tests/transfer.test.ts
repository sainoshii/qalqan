import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/schema";
import { insertCase } from "@/lib/cases/repository";
import { analyzeMessage } from "@/lib/detector";
import { assessTransfer } from "@/lib/transfer/risk";
import type { AnalysisResult } from "@/lib/domain";

const msg = (riskScore: number, reasons: string[] = ["причина"], evidence: AnalysisResult["evidence"] = "rules"): AnalysisResult => ({
  riskScore,
  scamType: riskScore >= 40 ? "safe_account" : null,
  reasons,
  recommendation: "",
  mode: "rules",
  evidence,
});

describe("assessTransfer", () => {
  it("обычный перевод без контекста проходит", () => {
    expect(assessTransfer({ amount: 5000, newRecipient: false, message: null })).toEqual({ decision: "allow", riskScore: 0, reasons: [] });
  });

  it("мошенническое сообщение → вмешательство даже для знакомого получателя и малой суммы", () => {
    const a = assessTransfer({ amount: 1000, newRecipient: false, message: msg(85) });
    expect(a.decision).toBe("intervene");
    expect(a.reasons).toContain("причина");
  });

  it("новый получатель и крупная сумма усиливают подозрительное сообщение", () => {
    expect(assessTransfer({ amount: 10_000, newRecipient: false, message: msg(50) }).decision).toBe("warn");
    const a = assessTransfer({ amount: 600_000, newRecipient: true, message: msg(50) });
    expect(a.decision).toBe("intervene");
    expect(a.riskScore).toBe(75);
  });

  it("риск одной модели контекст не поднимает до вмешательства", () => {
    expect(assessTransfer({ amount: 600_000, newRecipient: true, message: msg(60, ["модель"], "model") }).decision).toBe("warn");
    expect(assessTransfer({ amount: 600_000, newRecipient: true, message: { ...msg(60, ["?"]), evidence: undefined } }).decision).toBe("warn");
    expect(assessTransfer({ amount: 600_000, newRecipient: true, message: msg(60, ["llm"], "llm") }).decision).toBe("intervene");
  });

  it("контекст не превращает обычное сообщение в подозрение", () => {
    expect(assessTransfer({ amount: 600_000, newRecipient: true, message: msg(20) }).decision).toBe("allow");
  });

  it("очень крупный перевод новому получателю без сообщения — только предупреждение", () => {
    expect(assessTransfer({ amount: 1_000_000, newRecipient: true, message: null }).decision).toBe("warn");
    expect(assessTransfer({ amount: 1_000_000, newRecipient: false, message: null }).decision).toBe("allow");
  });

  it("скор ограничен 100", () => {
    expect(assessTransfer({ amount: 9_000_000, newRecipient: true, message: msg(100) }).riskScore).toBe(100);
  });
});

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const SCAM = "Служба безопасности банка. Срочно переведите деньги на безопасный счёт. Карта 4400 4301 2345 6789.";

describe("POST /api/transfer/assess", () => {
  let POST: (r: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    ({ POST } = await import("@/app/api/transfer/assess/route"));
  });

  it("сценарий «служба безопасности → новый счёт» приводит к вмешательству", async () => {
    const res = await POST(post("/api/transfer/assess", { amount: 450_000, newRecipient: true, messageText: SCAM }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision).toBe("intervene");
    expect(json.message.scamType).toBe("safe_account");
    expect(json.reasons.length).toBeGreaterThan(0);
  });

  it("обычный перевод проходит без вмешательства", async () => {
    const res = await POST(post("/api/transfer/assess", { amount: 3000, newRecipient: false, messageText: "Скинь 3 000 за пиццу" }));
    expect((await res.json()).decision).toBe("allow");
  });

  it.each([
    [{ amount: 0, newRecipient: true }],
    [{ amount: -5, newRecipient: true }],
    [{ amount: 1.5, newRecipient: true }],
    [{ amount: "100", newRecipient: true }],
    [{ amount: 100 }],
    [{ amount: 1e12, newRecipient: false }],
  ])("400 на некорректный вход %#", async (body) => {
    expect((await POST(post("/api/transfer/assess", body))).status).toBe(400);
  });
});

describe("POST /api/cases", () => {
  let POST: (r: Request) => Promise<Response>;
  const db = createDb(":memory:");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await migrate(db);
    await db.execute("DELETE FROM cases");
    vi.doMock("@/lib/cases/repository", async (orig) => ({
      ...(await orig<typeof import("@/lib/cases/repository")>()),
      db: async () => db,
    }));
    ({ POST } = await import("@/app/api/cases/route"));
  });

  it("сохраняет подозрительный случай: риск считает сервер, текст замаскирован", async () => {
    const res = await POST(post("/api/cases", { amount: 450_000, newRecipient: true, messageText: SCAM, channel: "call", outcome: "cancelled_by_client", riskScore: 0 }));
    expect(res.status).toBe(201);
    const { rows } = await db.execute("SELECT * FROM cases");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "cancelled_by_client", channel: "call", language: "ru", scam_type: "safe_account", transfer_amount: 450_000, new_recipient: 1, synthetic: 0, status: "new" });
    expect(Number(rows[0].risk_score)).toBeGreaterThanOrEqual(70);
    expect(String(rows[0].text_excerpt)).toContain("[КАРТА]");
    expect(String(rows[0].text_excerpt)).not.toMatch(/\d{4} \d{4}/);
  });

  it("не сохраняет обычные переводы и переводы без сообщения", async () => {
    for (const body of [
      { amount: 3000, newRecipient: false, messageText: "Скинь 3 000 за пиццу", outcome: "proceeded" },
      { amount: 3000, newRecipient: false, outcome: "proceeded" },
    ]) {
      const res = await POST(post("/api/cases", body));
      expect((await res.json()).stored).toBe(false);
    }
    expect((await db.execute("SELECT COUNT(*) AS n FROM cases")).rows[0].n).toBe(0);
  });

  it("400 на недопустимый исход", async () => {
    expect((await POST(post("/api/cases", { amount: 1, newRecipient: true, messageText: SCAM, outcome: "stolen" }))).status).toBe(400);
  });
});

describe("insertCase", () => {
  it("идентификаторы уникальны", async () => {
    const d = createDb(":memory:");
    await migrate(d);
    const analysis = await analyzeMessage(SCAM, { useLlm: false });
    const base = { messageText: SCAM, language: "ru" as const, channel: "sms" as const, analysis, riskScore: 90, reasons: [], amount: null, newRecipient: false, outcome: "no_transfer" as const };
    const now = new Date();
    const ids = await Promise.all([insertCase(d, base, now), insertCase(d, base, now)]);
    expect(new Set(ids).size).toBe(2);
    d.close();
  });
});
