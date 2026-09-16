const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export type RuntimeEnvironmentSource = Record<string, string | boolean | undefined>;

export interface RuntimeConfig {
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly maxRetries: number;
  readonly environment: string;
  readonly release: string;
  readonly esriApiVersion: string;
  readonly tkgmCityId: string;
}

const getBuildEnv = (): RuntimeEnvironmentSource => import.meta.env as RuntimeEnvironmentSource;

const readEnv = (
  source: RuntimeEnvironmentSource,
  key: string,
  legacyKey?: string
): string | undefined => {
  const value = source[key] ?? (legacyKey ? source[legacyKey] : undefined);
  return typeof value === 'string' ? value : undefined;
};

const parseInteger = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeApiBaseUrl = (value?: string): string => {
  const candidate = String(value || DEFAULT_API_BASE_URL).trim();
  if (candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')) {
    return candidate.replace(/\/$/, '') || '/';
  }

  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : null;
    const parsed = new URL(candidate, origin || 'http://localhost');
    if (origin && parsed.origin === origin) {
      return `${parsed.pathname}${parsed.search}`.replace(/\/$/, '') || '/';
    }
  } catch {
    // Build configuration is untrusted input. Invalid values intentionally fall back.
  }

  return DEFAULT_API_BASE_URL;
};

/**
 * Builds the browser-safe runtime configuration from Vite's explicitly exposed
 * VITE_* namespace. REACT_APP_* aliases remain temporarily accepted only when
 * a source object is passed explicitly, which lets deployments migrate without
 * reintroducing a browser-side `process` shim.
 */
export const createRuntimeConfig = (
  source: RuntimeEnvironmentSource = getBuildEnv()
): Readonly<RuntimeConfig> => {
  const env = source || {};

  return Object.freeze({
    apiBaseUrl: normalizeApiBaseUrl(
      readEnv(env, 'VITE_API_URL', 'REACT_APP_API_URL') ||
        readEnv(env, 'VITE_API_BASE_URL', 'REACT_APP_API_BASE_URL')
    ),
    requestTimeoutMs: parseInteger(
      readEnv(env, 'VITE_API_TIMEOUT_MS', 'REACT_APP_API_TIMEOUT_MS'),
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      60_000
    ),
    cacheTtlMs: parseInteger(
      readEnv(env, 'VITE_API_CACHE_TTL_MS', 'REACT_APP_API_CACHE_TTL_MS'),
      DEFAULT_CACHE_TTL_MS,
      0,
      600_000
    ),
    maxRetries: parseInteger(
      readEnv(env, 'VITE_API_MAX_RETRIES', 'REACT_APP_API_MAX_RETRIES'),
      DEFAULT_MAX_RETRIES,
      0,
      4
    ),
    environment:
      String(readEnv(env, 'VITE_ENV', 'REACT_APP_ENV') || 'production').trim() || 'production',
    release:
      String(
        readEnv(env, 'VITE_VERSION', 'REACT_APP_VERSION') ||
          readEnv(env, 'VITE_RELEASE', 'REACT_APP_RELEASE') ||
          'local'
      ).trim() || 'local',
    esriApiVersion: String(
      readEnv(env, 'VITE_ESRI_API_VERSION', 'REACT_APP_ESRI_API_VERSION') || ''
    ).trim(),
    tkgmCityId: String(
      readEnv(env, 'VITE_TKGM_CITY_ID', 'REACT_APP_TKGM_CITY_ID') || ''
    ).trim()
  });
};

export const runtimeConfig = createRuntimeConfig();

export const assertSafeRuntimeConfig = (config: Readonly<RuntimeConfig> = runtimeConfig): true => {
  if (!config.apiBaseUrl.startsWith('/') || config.apiBaseUrl.startsWith('//')) {
    throw new Error('API base URL must resolve to a same-origin relative path');
  }
  if (config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 60_000) {
    throw new Error('API timeout is outside the supported range');
  }
  if (config.maxRetries < 0 || config.maxRetries > 4) {
    throw new Error('API retry count is outside the supported range');
  }
  return true;
};

assertSafeRuntimeConfig();
