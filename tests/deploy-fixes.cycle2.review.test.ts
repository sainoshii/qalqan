import { describe, expect, it } from "vitest";
import { describeDbError } from "@/lib/db/diagnose";
import { MigrationError } from "@/lib/db/schema";

const privateText = "synthetic-private-token https://synthetic-db.invalid";

describe("deploy fixes cycle 2: diagnostic boundary", () => {
  it.each([401, 403, 404])("retains status %i and its hint at the fifth level", (status) => {
    let error: Error = Object.assign(new Error(`HTTP status ${status}: ${privateText}`), { code: "SERVER_ERROR" });
    for (let i = 0; i < 3; i++) error = new Error(privateText, { cause: error });
    const result = describeDbError(new MigrationError("read_version", "UNKNOWN", { cause: error }));
    expect(result).toMatchObject({ code: "SERVER_ERROR", step: "read_version", httpStatus: status });
    expect(result.hint).toMatch(status === 404 ? /не найдена/ : /отклонил токен/);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|synthetic-db|cause|stack/);
  });

  it("ignores information beyond the five-level limit", () => {
    let error: Error = Object.assign(new Error("HTTP status 401"), { code: "SERVER_ERROR" });
    for (let i = 0; i < 5; i++) error = new Error(privateText, { cause: error });
    expect(describeDbError(error)).toMatchObject({ code: "UNKNOWN", httpStatus: undefined });
  });

  it.each(["self", "pair"])("terminates for a %s cycle without serializing it", (kind) => {
    const first = Object.assign(new Error(privateText), { code: "SERVER_ERROR", cause: undefined as unknown });
    const second = new Error(`HTTP status 403 ${privateText}`, { cause: first });
    first.cause = kind === "self" ? first : second;
    const result = describeDbError(first);
    expect(result.code).toBe("SERVER_ERROR");
    if (kind === "pair") expect(result.httpStatus).toBe(403);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|synthetic-db|cause|stack/);
  });

  it("keeps output bounded for long messages and rejected fields", () => {
    const text = privateText.repeat(40_000);
    const error = Object.assign(new Error(`${text} HTTP status 401`), { code: text, step: text });
    const result = describeDbError(new MigrationError("create", text, { cause: error }));
    expect(result).toMatchObject({ code: "UNKNOWN", step: "create", httpStatus: 401 });
    expect(JSON.stringify(result).length).toBeLessThan(500);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it.each([null, undefined, false, 0, 1, BigInt(1), Symbol("synthetic-private"), privateText, [], Object.create(null)])(
    "handles non-Error input %# without coercing or exposing it", (value) => {
      expect(describeDbError(value)).toMatchObject({ code: "UNKNOWN", step: undefined, httpStatus: undefined });
      expect(describeDbError(new Error(privateText, { cause: value })).code).toBe("UNKNOWN");
    },
  );

  it("traverses plain objects without serializing their messages or invoking toJSON", () => {
    const value = {
      message: privateText,
      code: "unsafe-code",
      step: privateText,
      cause: Object.assign(new Error("HTTP status 404"), { code: "SERVER_ERROR" }),
      toJSON() { throw new Error("must not serialize the input"); },
    };
    const result = describeDbError(value);
    expect(result).toMatchObject({ code: "SERVER_ERROR", step: undefined, httpStatus: 404 });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it.each(["A", "A".repeat(65), "SERVER_ERROR\n", "SERVER_ERROR\r", "server_error", privateText, 123, {}])(
    "rejects malformed code %# at every level", (code) => {
      expect(describeDbError({ code, cause: { code } }).code).toBe("UNKNOWN");
    },
  );

  it.each(["AB", "A".repeat(64), "SERVER_ERROR"])("accepts valid code %s", (code) => {
    expect(describeDbError({ cause: { code } }).code).toBe(code);
  });

  it.each(["read_version", "create", "upgrade_v1"])("accepts allowed step %s", (step) => {
    expect(describeDbError({ step }).step).toBe(step);
  });

  it.each(["create\n", "CREATE", privateText, 123, {}])("omits invalid step %# from JSON", (step) => {
    expect(JSON.parse(JSON.stringify(describeDbError({ step })))).not.toHaveProperty("step");
  });

  it("prefers the deepest HTTP status when a wrapper mentions a different status", () => {
    const sdkError = Object.assign(new Error(`HTTP status 401 ${privateText}`), { code: "SERVER_ERROR" });
    const wrapper = new Error("Earlier attempt returned HTTP status 404", { cause: sdkError });
    const result = describeDbError(new MigrationError("read_version", "UNKNOWN", { cause: wrapper }));
    expect(result.httpStatus).toBe(401);
    expect(result.hint).toMatch(/отклонил токен/);
  });
});
