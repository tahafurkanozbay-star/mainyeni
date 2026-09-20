// @vitest-environment jsdom
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthSessionStore, SessionSnapshot } from "./authSession";
import { createAdminHttpClient, normalizeRequestFailure } from "./httpClient";

const createMemorySessionStore = (): AuthSessionStore & { clear: ReturnType<typeof vi.fn> } => {
  let session: { accessToken: string } | null = { accessToken: "secret-token" };
  let reason: SessionSnapshot["reason"] = "initialized";
  const clear = vi.fn((nextReason: SessionSnapshot["reason"] = "logout") => {
    session = null;
    reason = nextReason;
  });
  return {
    read: () => session,
    write: () => true,
    clear,
    snapshot: () => ({ session, authenticated: session !== null, reason }),
    subscribe: () => () => undefined,
  };
};

const adapter = (handler: (config: AxiosRequestConfig) => unknown): AxiosAdapter =>
  async (config) => {
    const data = handler(config);
    return {
      data,
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

describe("admin http client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("attaches bearer session and JSON accept header", async () => {
    const store = createMemorySessionStore();
    const client = createAdminHttpClient({
      baseURL: "/api",
      sessionStore: store,
    });
    let captured: AxiosRequestConfig | null = null;
    client.defaults.adapter = adapter((config) => {
      captured = config;
      return { ok: true };
    });

    await client.get("/settings");

    const headers = AxiosHeaders.from(captured?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("Accept")).toBe("application/json");
  });

  test("does not send authorization when session is absent", async () => {
    const store = createMemorySessionStore();
    store.clear();
    const client = createAdminHttpClient({ baseURL: "/api", sessionStore: store });
    let captured: AxiosRequestConfig | null = null;
    client.defaults.adapter = adapter((config) => {
      captured = config;
      return {};
    });
    await client.get("/settings");
    expect(AxiosHeaders.from(captured?.headers).has("Authorization")).toBe(false);
  });

  test("clears session and notifies observer on 401", async () => {
    const store = createMemorySessionStore();
    const onAuthFailure = vi.fn();
    const client = createAdminHttpClient({ baseURL: "/api", sessionStore: store, onAuthFailure });
    client.defaults.adapter = async (config) => {
      throw new AxiosError(
        "Unauthorized",
        AxiosError.ERR_BAD_RESPONSE,
        config,
        {},
        { data: {}, status: 401, statusText: "Unauthorized", headers: {}, config },
      );
    };

    await expect(client.get("/private")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
      retriable: false,
    });
    expect(store.clear).toHaveBeenCalledWith("expired");
    expect(onAuthFailure).toHaveBeenCalledWith(401);
  });

  test("classifies forbidden responses", () => {
    const error = new AxiosError(
      "Forbidden",
      AxiosError.ERR_BAD_RESPONSE,
      undefined,
      {},
      {
        data: { message: "denied" },
        status: 403,
        statusText: "Forbidden",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );
    expect(normalizeRequestFailure(error)).toMatchObject({
      kind: "forbidden",
      status: 403,
      retriable: false,
    });
  });

  test("uses safe server messages for ordinary HTTP failures", () => {
    const error = new AxiosError(
      "Bad Request",
      AxiosError.ERR_BAD_RESPONSE,
      undefined,
      {},
      {
        data: { message: "Alan doğrulaması başarısız." },
        status: 400,
        statusText: "Bad Request",
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );
    expect(normalizeRequestFailure(error)).toMatchObject({
      kind: "http",
      status: 400,
      message: "Alan doğrulaması başarısız.",
      retriable: false,
    });
  });

  test("marks server and throttling failures retriable", () => {
    for (const status of [408, 425, 429, 500, 503]) {
      const error = new AxiosError(
        "retry",
        AxiosError.ERR_BAD_RESPONSE,
        undefined,
        {},
        {
          data: {},
          status,
          statusText: "retry",
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      expect(normalizeRequestFailure(error).retriable).toBe(true);
    }
  });

  test("classifies cancellation and timeout without leaking details", () => {
    expect(normalizeRequestFailure(new AxiosError("cancel", AxiosError.ERR_CANCELED))).toMatchObject({
      kind: "aborted",
      retriable: false,
    });
    expect(normalizeRequestFailure(new AxiosError("timeout", AxiosError.ETIMEDOUT))).toMatchObject({
      kind: "timeout",
      retriable: true,
    });
  });

  test("classifies ordinary unknown errors safely", () => {
    expect(normalizeRequestFailure(new Error("boom"))).toMatchObject({
      kind: "unknown",
      status: null,
      message: "boom",
      retriable: false,
    });
  });
});
