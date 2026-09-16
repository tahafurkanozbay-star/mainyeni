const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;

const getProcessEnv = () => {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env;
};

const getViteEnv = () => import.meta.env || {};

const readEnv = (env, modernName, legacyName) => {
  const modernValue = env?.[modernName];
  if (modernValue !== undefined && modernValue !== '') return modernValue;
  const legacyValue = env?.[legacyName];
  return legacyValue !== undefined ? legacyValue : undefined;
};

const parseInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeApiBaseUrl = (value) => {
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
  } catch (_error) {
    // Build-time configuration is still input: invalid values intentionally fall back.
  }

  return DEFAULT_API_BASE_URL;
};

export const createRuntimeConfig = (source) => {
  const env = source || { ...getProcessEnv(), ...getViteEnv() };
  return Object.freeze({
    apiBaseUrl: normalizeApiBaseUrl(readEnv(env, 'VITE_API_URL', 'REACT_APP_API_URL') || readEnv(env, 'VITE_API_BASE_URL', 'REACT_APP_API_BASE_URL')),
    requestTimeoutMs: parseInteger(readEnv(env, 'VITE_API_TIMEOUT_MS', 'REACT_APP_API_TIMEOUT_MS'), DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60000),
    cacheTtlMs: parseInteger(readEnv(env, 'VITE_API_CACHE_TTL_MS', 'REACT_APP_API_CACHE_TTL_MS'), DEFAULT_CACHE_TTL_MS, 0, 600000),
    maxRetries: parseInteger(readEnv(env, 'VITE_API_MAX_RETRIES', 'REACT_APP_API_MAX_RETRIES'), DEFAULT_MAX_RETRIES, 0, 4),
    environment: String(readEnv(env, 'VITE_APP_ENV', 'REACT_APP_ENV') || 'production').trim() || 'production',
    release: String(readEnv(env, 'VITE_APP_VERSION', 'REACT_APP_VERSION') || readEnv(env, 'VITE_APP_RELEASE', 'REACT_APP_RELEASE') || 'local').trim() || 'local',
    esriApiVersion: String(readEnv(env, 'VITE_ESRI_API_VERSION', 'REACT_APP_ESRI_API_VERSION') || '').trim(),
    tkgmCityId: String(readEnv(env, 'VITE_TKGM_CITY_ID', 'REACT_APP_TKGM_CITY_ID') || '').trim()
  });
};

export const runtimeConfig = createRuntimeConfig();

export const assertSafeRuntimeConfig = (config = runtimeConfig) => {
  if (!config.apiBaseUrl.startsWith('/') || config.apiBaseUrl.startsWith('//')) {
    throw new Error('API base URL must resolve to a same-origin relative path');
  }
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
    throw new Error('API timeout is outside the supported range');
  }
  if (config.maxRetries < 0 || config.maxRetries > 4) {
    throw new Error('API retry count is outside the supported range');
  }
  return true;
};

assertSafeRuntimeConfig();
