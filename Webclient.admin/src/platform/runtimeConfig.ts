import { readString } from "./contracts";

export interface AdminRuntimeConfig {
  readonly apiBaseUrl: string;
  readonly appVersion: string;
  readonly appTitlePrimary: string;
  readonly appTitleSecondary: string;
  readonly requestTimeoutMs: number;
  readonly sessionStorageKey: string;
}

export interface RuntimeEnvironment {
  readonly VITE_API_URL?: unknown;
  readonly REACT_APP_API_URL?: unknown;
  readonly VITE_APP_VERSION?: unknown;
  readonly REACT_APP_VERSION?: unknown;
  readonly VITE_REQUEST_TIMEOUT_MS?: unknown;
  readonly VITE_APP_TITLE_PRIMARY?: unknown;
  readonly VITE_APP_TITLE_SECONDARY?: unknown;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const normalizedTimeout = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(readString(value));
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.min(60_000, Math.max(1_000, Math.trunc(parsed)));
};

const normalizeBaseUrl = (
  value: unknown,
  locationLike?: Pick<Location, "origin" | "protocol" | "hostname">,
): string => {
  const raw = readString(value) ?? "/api";
  if (raw.startsWith("/")) return raw.replace(/\/+$/u, "") || "/";

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Admin API URL geçerli bir URL ya da same-origin path olmalıdır.");
  }

  const isLocal = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
    throw new Error("Admin API URL HTTPS kullanmalıdır; yalnız localhost geliştirme ortamında HTTP kabul edilir.");
  }

  if (
    locationLike
    && parsed.origin !== locationLike.origin
    && parsed.protocol !== "https:"
  ) {
    throw new Error("Cross-origin admin API yalnız HTTPS üzerinden kullanılabilir.");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
};

export const createRuntimeConfig = (
  environment: RuntimeEnvironment,
  locationLike?: Pick<Location, "origin" | "protocol" | "hostname">,
): AdminRuntimeConfig => {
  const apiSource = environment.VITE_API_URL ?? environment.REACT_APP_API_URL;
  const versionSource = environment.VITE_APP_VERSION ?? environment.REACT_APP_VERSION;
  return Object.freeze({
    apiBaseUrl: normalizeBaseUrl(apiSource, locationLike),
    appVersion: readString(versionSource) ?? "dev",
    appTitlePrimary: readString(environment.VITE_APP_TITLE_PRIMARY) ?? "ABB Rehber ",
    appTitleSecondary: readString(environment.VITE_APP_TITLE_SECONDARY) ?? "Admin",
    requestTimeoutMs: normalizedTimeout(environment.VITE_REQUEST_TIMEOUT_MS),
    sessionStorageKey: "_cviaıq34gmx",
  });
};

const browserLocation = typeof window === "undefined" ? undefined : window.location;
const importMetaEnvironment = import.meta.env as RuntimeEnvironment;

export const runtimeConfig = createRuntimeConfig(importMetaEnvironment, browserLocation);
