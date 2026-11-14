import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzeRequestSchema } from "@/lib/api/analyze-request";
import { ANALYZE_EXAMPLE, ASSESS_EXAMPLE, DECISION_SCENARIOS, computeExamples } from "@/lib/api/examples";
import { AssessRequestSchema } from "@/lib/transfer/request";

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("примеры /docs совпадают с настоящим API", () => {
  let analyze: (r: Request) => Promise<Response>;
  let assess: (r: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    ({ POST: analyze } = await import("@/app/api/analyze/route"));
    ({ POST: assess } = await import("@/app/api/transfer/assess/route"));
  });

  it("запросы-примеры проходят схемы API", () => {
    expect(AnalyzeRequestSchema.safeParse(ANALYZE_EXAMPLE).success).toBe(true);
    expect(AssessRequestSchema.safeParse(ASSESS_EXAMPLE).success).toBe(true);
    for (const s of DECISION_SCENARIOS) expect(AssessRequestSchema.safeParse(s.request).success).toBe(true);
  });

  it("ответ /api/analyze в документации — это ответ API", async () => {
    const ex = await computeExamples();
    const res = await analyze(post("/api/analyze", ANALYZE_EXAMPLE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ex.analyze);
  });

  it("ответ /api/transfer/assess и таблица решений — это ответы API", async () => {
    const ex = await computeExamples();
    const res = await assess(post("/api/transfer/assess", ASSESS_EXAMPLE));
    expect(await res.json()).toEqual(ex.transfer);
    for (const [i, s] of DECISION_SCENARIOS.entries()) {
      const r = await (await assess(post("/api/transfer/assess", s.request))).json();
      expect({ decision: r.decision, riskScore: r.riskScore }).toEqual({ decision: ex.scenarios[i].decision, riskScore: ex.scenarios[i].riskScore });
    }
  });

  it("таблица показывает все три решения", async () => {
    const decisions = new Set((await computeExamples()).scenarios.map((s) => s.decision));
    expect(decisions).toEqual(new Set(["allow", "warn", "intervene"]));
  });
});
