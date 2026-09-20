import { describe, expect, test } from "vitest";
import {
  asAdminSession,
  asLoginResponse,
  isRecord,
  normalizeIdentifier,
  normalizeServiceResult,
  readBoolean,
  readFiniteNumber,
  readString,
  readStringArray,
  safeErrorMessage,
  toJsonSafe,
} from "./contracts";

describe("admin platform contracts", () => {
  test("recognizes records without accepting arrays or null", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test("normalizes strings and finite numbers", () => {
    expect(readString("  Ankara  ")).toBe("Ankara");
    expect(readString("   ")).toBeNull();
    expect(readString(42)).toBe("42");
    expect(readFiniteNumber("12.5")).toBe(12.5);
    expect(readFiniteNumber("")).toBeNull();
    expect(readFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("normalizes boolean-like service values without broad truthiness", () => {
    expect(readBoolean(true)).toBe(true);
    expect(readBoolean("true")).toBe(true);
    expect(readBoolean("1")).toBe(true);
    expect(readBoolean("false")).toBe(false);
    expect(readBoolean(0)).toBe(false);
    expect(readBoolean("yes")).toBeNull();
  });

  test("filters string arrays deterministically", () => {
    expect(readStringArray(["admin", " ", 42, null, "ops"])).toEqual(["admin", "42", "ops"]);
  });

  test("accepts a minimally valid bearer session", () => {
    expect(asAdminSession({ accessToken: " token ", userName: " operator " })).toEqual({
      accessToken: "token",
      userName: "operator",
    });
  });

  test("rejects sessions without a non-empty access token", () => {
    expect(asAdminSession({ userName: "operator" })).toBeNull();
    expect(asAdminSession({ accessToken: " " })).toBeNull();
    expect(asAdminSession(null)).toBeNull();
  });

  test("preserves optional roles and expiry when valid", () => {
    expect(asAdminSession({
      accessToken: "t",
      expiresAt: "2030-01-01T00:00:00Z",
      roles: ["admin", "", "gis"],
    })).toEqual({
      accessToken: "t",
      expiresAt: "2030-01-01T00:00:00Z",
      roles: ["admin", "gis"],
    });
  });

  test("normalizes login envelopes without assuming data shape", () => {
    expect(asLoginResponse({ isSuccess: true, data: { accessToken: "x" }, message: "ok" })).toEqual({
      isSuccess: true,
      data: { accessToken: "x" },
      message: "ok",
    });
    expect(asLoginResponse({ isSuccess: "yes" })).toBeNull();
  });

  test("normalizes service envelopes through caller parser", () => {
    const parsed = normalizeServiceResult(
      { isSuccess: true, data: { id: 3 }, message: "ok" },
      (value) => isRecord(value) && typeof value.id === "number" ? value.id : null,
    );
    expect(parsed).toMatchObject({ isSuccess: true, data: 3, message: "ok" });
  });

  test("fails closed when a successful envelope contains invalid data", () => {
    const parsed = normalizeServiceResult(
      { isSuccess: true, data: "bad" },
      (value) => typeof value === "number" ? value : null,
    );
    expect(parsed.isSuccess).toBe(false);
    expect(parsed.data).toBeNull();
  });

  test("normalizes identifiers without manufacturing values", () => {
    expect(normalizeIdentifier(0)).toBe(0);
    expect(normalizeIdentifier(" 15 ")).toBe("15");
    expect(normalizeIdentifier(" ")).toBeNull();
    expect(normalizeIdentifier(Number.NaN)).toBeNull();
  });

  test("extracts safe error messages", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
    expect(safeErrorMessage({ message: "network" })).toBe("network");
    expect(safeErrorMessage(null, "fallback")).toBe("fallback");
  });

  test("creates bounded JSON-safe diagnostic values", () => {
    const circular: Record<string, unknown> = { token: "secret" };
    circular.self = circular;
    const value = toJsonSafe(circular, 0, 2, 5);
    expect(value).toEqual({
      token: "secret",
      self: {
        token: "secret",
        self: "[depth-limit]",
      },
    });
  });

  test("truncates large objects by item count", () => {
    const source = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index]));
    const value = toJsonSafe(source, 0, 4, 3);
    expect(value).toMatchObject({ k0: 0, k1: 1, k2: 2, __truncated__: true });
  });
});
