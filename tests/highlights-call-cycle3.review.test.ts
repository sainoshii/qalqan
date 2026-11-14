import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HighlightedText } from "@/components/HighlightedText";
import { findHighlights, normalizeWithMap } from "@/lib/detector/highlights";
import { evaluateRules, normalize } from "@/lib/detector/rules";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/detector");
  vi.doUnmock("@/lib/cases/repository");
  vi.resetModules();
});

describe("highlights-call cycle 3: independent boundary and API checks", () => {
  it("preserves valid UTF-16 slices around supplementary and combining characters", () => {
    const edges = ["", "😀", "𐐀", "İ", "и\u0301", "\u0301", "\u00a0\u2028"];
    for (const left of edges) for (const right of edges) {
      for (const phrase of ["безопасный счёт", "назовите код", "https://fake.test/😀"]) {
        const text = left + phrase + right;
        const normalized = normalizeWithMap(text);
        expect(normalized.text).toBe(normalize(text));
        expect(normalized.map).toHaveLength(normalized.text.length);
        const hs = findHighlights(text, evaluateRules(text).signals);
        expect(hs.length).toBeGreaterThan(0);
        let end = 0;
        for (const h of hs) {
          expect(h.start).toBeGreaterThanOrEqual(end);
          expect(h.end).toBeGreaterThan(h.start);
          expect(h.end).toBeLessThanOrEqual(text.length);
          // No lone surrogate introduced at either boundary.
          expect(text.slice(h.start, h.end)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
          end = h.end;
        }
      }
    }
  });

  it("renders escaped text and ignores invalid/overlapping positions without losing content", () => {
    vi.stubGlobal("React", React);
    const text = "<script>😀</script>";
    const html = renderToStaticMarkup(React.createElement(HighlightedText, {
      text,
      highlights: [
        { start: -1, end: 3, reason: "invalid" },
        { start: 0, end: 8, reason: "<danger>" },
        { start: 2, end: 9, reason: "overlap" },
        { start: 9, end: 999, reason: "stale" },
      ],
    }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("😀&lt;/script&gt;");
    expect(html.match(/<mark /g)).toHaveLength(1);
    expect(html).toContain('title="&lt;danger&gt;"');
  });

  it("passes onCall through both route handlers and stores the same assessed risk", async () => {
    vi.resetModules();
    vi.doMock("@/lib/detector", () => ({
      analyzeMessage: vi.fn(async () => ({ riskScore: 50, evidence: "model", reasons: [], mode: "rules", scamType: null, recommendation: "" })),
      detectLanguage: () => "ru",
    }));
    const insert = vi.fn(async () => "synthetic-case");
    vi.doMock("@/lib/cases/repository", () => ({ db: async () => ({}), insertCase: insert }));
    const assess = (await import("@/app/api/transfer/assess/route")).POST;
    const save = (await import("@/app/api/cases/route")).POST;
    const request = (onCall: unknown) => new Request("http://localhost/api/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1000, newRecipient: false, messageText: "Синтетический текст", onCall, outcome: "cancelled_by_client" }),
    });
    expect((await (await assess(request(false))).json()).decision).toBe("warn");
    const result = await (await assess(request(true))).json();
    expect(result.decision).toBe("intervene");
    expect(result.riskScore).toBe(70);
    expect((await save(request(true))).status).toBe(201);
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ riskScore: 70, reasons: result.reasons }));
    for (const invalid of ["true", 1, null, {}]) {
      expect((await assess(request(invalid))).status).toBe(400);
      expect((await save(request(invalid))).status).toBe(400);
    }
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
