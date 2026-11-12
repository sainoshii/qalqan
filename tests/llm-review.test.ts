import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { parse: sdk.parse }; },
}));

import { analyzeMessage, evaluateRules } from "@/lib/detector";

describe("review: actual LLM adapter with mocked SDK, no network", () => {
  beforeEach(() => {
    sdk.parse.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    vi.stubEnv("QALQAN_LLM_TIMEOUT_MS", "6000");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in review")));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["refusal", { stop_reason: "refusal", parsed_output: null }],
    ["missing output", { stop_reason: "end_turn", parsed_output: null }],
    ["invalid numeric output", { stop_reason: "end_turn", parsed_output: { riskScore: NaN, scamType: null, reasons: [] } }],
  ])("falls back on %s", async (_, response) => {
    sdk.parse.mockResolvedValue(response);
    const text = "Продиктуйте код из SMS.";
    const result = await analyzeMessage(text);
    expect(result.mode).toBe("rules");
    expect(result.riskScore).toBe(evaluateRules(text).score);
  });

  it("falls back without logging the request or SDK exception", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sdk.parse.mockRejectedValue(new Error("synthetic SDK timeout"));
    expect((await analyzeMessage("Назовите код из SMS.")).mode).toBe("rules");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("masks conventional synthetic secrets before the SDK and disables retries", async () => {
    sdk.parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { riskScore: 90, scamType: "code_request", reasons: ["  Просьба назвать секрет  ", ""] } });
    const result = await analyzeMessage("Код: 4821. Карта 4400 4301 2345 6789. Телефон +7 701 555 12 34. ИИН 000000000000.", { lang: "kk" });
    const [request, options] = sdk.parse.mock.calls[0];
    const sent = request.messages[0].content as string;
    expect(sent).toContain("Язык сообщения: казахский");
    expect(sent).toContain("[КОД]");
    expect(sent).toContain("[КАРТА]");
    expect(sent).toContain("[ТЕЛЕФОН]");
    expect(sent).toContain("[ИИН]");
    expect(sent).not.toMatch(/4821|4400|701|000000000000/);
    expect(options).toEqual({ timeout: 6000, maxRetries: 0 });
    expect(result.mode).toBe("hybrid");
    expect(result.reasons).toContain("Просьба назвать секрет");
  });

  it("C7: masks an OTP after a natural three-word purpose before sending it to the SDK", async () => {
    sdk.parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    await analyzeMessage("Код для подтверждения перевода: 4821. Никому его не передавайте.");
    const sent = sdk.parse.mock.calls[0][0].messages[0].content as string;
    expect(sent).not.toContain("4821");
    expect(sent).toContain("[КОД]");
  });
});
