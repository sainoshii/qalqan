import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES } from "@/lib/api/http";

describe("review: API boundary", () => {
  let POST: (request: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in review")));
    ({ POST } = await import("@/app/api/analyze/route"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["text/plain; note=application/json", "application/jsonp"])("C6: rejects unsupported media type %s", async (contentType) => {
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST", headers: { "content-type": contentType }, body: JSON.stringify({ text: "Привет!" }),
    }));
    expect(response.status).toBe(415);
  });

  it("accepts JSON with a charset and the exact 5000-character limit", async () => {
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: "а".repeat(5000), lang: "ru" }),
    }));
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("C5: stops consuming an oversized chunked request at the body limit", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const chunk = new Uint8Array(MAX_BODY_BYTES).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(chunk);
        if (chunksRead === 64) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    };
    const response = await POST(new Request("http://localhost/api/analyze", init));
    expect(response.status).toBe(413);
    console.log(JSON.stringify({ chunksRead, bytesRead: chunksRead * chunk.length, cancelled }));
    expect(chunksRead).toBeLessThanOrEqual(3); // one chunk beyond the limit + stream prefetch
    expect(cancelled).toBe(true);
  });
});
