// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createAuthSessionStore } from "./authSession";

describe("AuthSessionStore", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  test("stores bearer sessions only in sessionStorage", () => {
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    expect(store.write({ accessToken: "token", userName: "operator" })).toBe(true);
    expect(window.localStorage.getItem("session")).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem("session") ?? "{}")).toEqual({
      accessToken: "token",
      userName: "operator",
    });
  });

  test("removes legacy persistent copies during read", () => {
    window.localStorage.setItem("session", "legacy");
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem("session")).toBeNull();
  });

  test("rejects invalid payloads fail closed", () => {
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    expect(store.write({ userName: "operator" })).toBe(false);
    expect(store.snapshot().authenticated).toBe(false);
  });

  test("rejects expired sessions", () => {
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      now: () => Date.parse("2030-01-02T00:00:00Z"),
    });
    expect(store.write({
      accessToken: "token",
      expiresAt: "2030-01-01T00:00:00Z",
    })).toBe(false);
    expect(store.snapshot().reason).toBe("expired");
  });

  test("reads a valid existing session", () => {
    window.sessionStorage.setItem("session", JSON.stringify({ accessToken: "token" }));
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    expect(store.read()).toEqual({ accessToken: "token" });
    expect(store.snapshot().authenticated).toBe(true);
  });

  test("clears malformed JSON", () => {
    window.sessionStorage.setItem("session", "{broken");
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    expect(store.read()).toBeNull();
    expect(window.sessionStorage.getItem("session")).toBeNull();
    expect(store.snapshot().reason).toBe("invalid");
  });

  test("notifies subscribers on login and logout", () => {
    const listener = vi.fn();
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    const unsubscribe = store.subscribe(listener);
    store.write({ accessToken: "token" });
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ authenticated: true, reason: "login" });
    expect(listener.mock.calls[1]?.[0]).toMatchObject({ authenticated: false, reason: "logout" });
    unsubscribe();
  });

  test("unsubscribe is safe and deterministic", () => {
    const listener = vi.fn();
    const store = createAuthSessionStore({
      key: "session",
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    });
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    unsubscribe();
    store.write({ accessToken: "token" });
    expect(listener).not.toHaveBeenCalled();
  });
});
