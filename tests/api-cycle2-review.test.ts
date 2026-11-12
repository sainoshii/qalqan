import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES } from "@/lib/api/http";

describe("cycle 2: API stream and media-type boundaries", () => {
  let POST: (request: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in review")));
    ({ POST } = await import("@/app/api/analyze/route"));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("C5: rejects excessive Content-Length without acquiring a reader", async () => {
    const request = new Request("http://localhost/api/analyze", {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) },
    });
    const reader = vi.spyOn(request.body!, "getReader");
    expect((await POST(request)).status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("C5: enforces the stream limit even with Content-Length=%s", async (contentLength) => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(8192).fill(32)); }, cancel,
    }, { highWaterMark: 0 });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (contentLength !== undefined) headers["content-length"] = contentLength;
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, headers, duplex: "half" };
    expect((await POST(new Request("http://localhost/api/analyze", init))).status).toBe(413);
    expect(pulls).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("C5: accepts exactly 32 KiB and decodes a multibyte character split across chunks", async () => {
    const json = JSON.stringify({ text: "Ә" });
    const bytes = new TextEncoder().encode(json);
    const full = new Uint8Array(MAX_BODY_BYTES).fill(32);
    full.set(bytes);
    const cut = bytes.indexOf(0xd3) + 1;
    expect(cut).toBeGreaterThan(0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(full.slice(0, cut)); controller.enqueue(full.slice(cut)); controller.close(); },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", body, duplex: "half",
      headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES) },
    };
    const response = await POST(new Request("http://localhost/api/analyze", init));
    expect(response.status).toBe(200);
    expect((await response.json()).mode).toBe("rules");
  });

  it.each([
    ["application/json; charset=utf-8", 200],
    ["Application/JSON", 200],
    ["application/jsonp", 415],
    ["text/plain; note=application/json", 415],
    ["application/json-bogus", 415],
    ["application/problem+json", 415],
  ])("C6: handles %s as %i", async (contentType, status) => {
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST", body: JSON.stringify({ text: "Привет." }), headers: { "content-type": contentType },
    }));
    expect(response.status).toBe(status);
  });
});
