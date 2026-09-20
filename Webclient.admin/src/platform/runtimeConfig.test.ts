import { describe, expect, test } from "vitest";
import { createRuntimeConfig } from "./runtimeConfig";

const locationLike = {
  origin: "https://admin.example.test",
  protocol: "https:",
  hostname: "admin.example.test",
} as Pick<Location, "origin" | "protocol" | "hostname">;

describe("admin runtime config", () => {
  test("defaults to same-origin API and bounded timeout", () => {
    const config = createRuntimeConfig({}, locationLike);
    expect(config.apiBaseUrl).toBe("/api");
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.appVersion).toBe("dev");
  });

  test("prefers Vite env names while supporting temporary CRA compatibility", () => {
    const config = createRuntimeConfig({
      VITE_API_URL: "/v2/api/",
      REACT_APP_API_URL: "/legacy/",
      VITE_APP_VERSION: "2.1.0",
      REACT_APP_VERSION: "1.0.0",
    }, locationLike);
    expect(config.apiBaseUrl).toBe("/v2/api");
    expect(config.appVersion).toBe("2.1.0");
  });

  test("uses CRA env names when Vite names are absent", () => {
    const config = createRuntimeConfig({
      REACT_APP_API_URL: "/legacy-api",
      REACT_APP_VERSION: "1.0.6",
    }, locationLike);
    expect(config.apiBaseUrl).toBe("/legacy-api");
    expect(config.appVersion).toBe("1.0.6");
  });

  test("accepts secure external API origins", () => {
    const config = createRuntimeConfig({
      VITE_API_URL: "https://api.example.test/admin/",
    }, locationLike);
    expect(config.apiBaseUrl).toBe("https://api.example.test/admin");
  });

  test("rejects insecure non-local HTTP origins", () => {
    expect(() => createRuntimeConfig({
      VITE_API_URL: "http://api.example.test/admin",
    }, locationLike)).toThrow(/HTTPS/);
  });

  test("accepts localhost HTTP for development", () => {
    expect(createRuntimeConfig({
      VITE_API_URL: "http://localhost:5000/admin/",
    }, locationLike).apiBaseUrl).toBe("http://localhost:5000/admin");
  });

  test("rejects malformed URL values", () => {
    expect(() => createRuntimeConfig({
      VITE_API_URL: "not a url",
    }, locationLike)).toThrow(/geçerli/);
  });

  test("clamps timeout to a safe range", () => {
    expect(createRuntimeConfig({ VITE_REQUEST_TIMEOUT_MS: "10" }, locationLike).requestTimeoutMs).toBe(1_000);
    expect(createRuntimeConfig({ VITE_REQUEST_TIMEOUT_MS: "999999" }, locationLike).requestTimeoutMs).toBe(60_000);
    expect(createRuntimeConfig({ VITE_REQUEST_TIMEOUT_MS: "5000" }, locationLike).requestTimeoutMs).toBe(5_000);
  });

  test("supports explicit product titles", () => {
    const config = createRuntimeConfig({
      VITE_APP_TITLE_PRIMARY: "Kent ",
      VITE_APP_TITLE_SECONDARY: "Yönetim",
    }, locationLike);
    expect(config.appTitlePrimary).toBe("Kent ");
    expect(config.appTitleSecondary).toBe("Yönetim");
  });
});
