/**
 * Runtime configuration boundary.
 *
 * Public build-time values are intentionally limited to non-secret routing/config
 * data. Secrets, passwords and private API tokens must stay server-side.
 */

const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;

const readEnv = (key, fallback = '') => {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : fallback;
};

const readInteger = (key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = readEnv(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const currentOrigin = () => (typeof window !== 'undefined' && window.location
  ? window.location.origin
  : 'http://localhost');

const normalizeBasePath = (value) => {
  if (!value) return DEFAULT_API_BASE_URL;
  if (value.startsWith('/')) return value.replace(/\/$/, '') || '/';

  try {
    const url = new URL(value, currentOrigin());
    if (typeof window !== 'undefined' && url.origin === window.location.origin) {
      return `${url.pathname}${url.search}`.replace(/\/$/, '') || '/';
    }
  } catch (error) {
    // Invalid public configuration falls back to same-origin instead of becoming
    // an arbitrary outbound endpoint.
  }

  return DEFAULT_API_BASE_URL;
};

export const createRuntimeConfig = (source) => {
  const env = source || (typeof process !== 'undefined' ? process.env || {} : {});
  const apiBaseUrl = normalizeBasePath(env.REACT_APP_API_BASE_URL || readEnv('REACT_APP_API_BASE_URL'));

  return Object.freeze({
    apiBaseUrl,
    requestTimeoutMs: readInteger('REACT_APP_API_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, { min: 1000, max: 60000 }),
    cacheTtlMs: readInteger('REACT_APP_API_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS, { min: 0, max: 600000 }),
    maxRetries: readInteger('REACT_APP_API_MAX_RETRIES', DEFAULT_MAX_RETRIES, { min: 0, max: 4 }),
    environment: readEnv('REACT_APP_ENV', 'production') || 'production',
    release: readEnv('REACT_APP_RELEASE', 'local') || 'local',
    enableTelemetry: readEnv('REACT_APP_ENABLE_TELEMETRY', 'false').toLowerCase() === 'true',
  });
};

export const runtimeConfig = createRuntimeConfig();

export const isProduction = runtimeConfig.environment === 'production';

export const assertSafeRuntimeConfig = (config = runtimeConfig) => {
  if (!config.apiBaseUrl.startsWith('/')) {
    throw new Error('API base URL must be same-origin relative path');
  }
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
    throw new Error('API timeout is outside the supported range');
  }
  return true;
};
