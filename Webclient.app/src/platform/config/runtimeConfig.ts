const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;

export interface RuntimeEnvironmentSource {
  readonly [key: string]: unknown;
}

export interface RuntimeFeatureFlags {
  readonly adaptiveRuntime: boolean;
  readonly privacyTelemetry: boolean;
  readonly typedBootstrap: boolean;
  readonly strictEndpointPolicy: boolean;
}

export interface RuntimeConfig {
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly maxRetries: number;
  readonly environment: string;
  readonly release: string;
  readonly esriApiVersion: string;
  readonly tkgmCityId: string;
  readonly buildMode: 'legacy-cra' | 'vite-ready' | 'unknown';
  readonly features: RuntimeFeatureFlags;
}

const getProcessEnv = (): RuntimeEnvironmentSource => {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env as RuntimeEnvironmentSource;
};

const firstDefined = (source: RuntimeEnvironmentSource, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
};

const parseInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
};

const safeText = (value: unknown, fallback: string, maxLength = 120): string => {
  const normalized = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim();
  return (normalized || fallback).slice(0, maxLength);
};

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

export const normalizeApiBaseUrl = (value: unknown): string => {
  const raw = String(value || DEFAULT_API_BASE_URL);
  if (containsControlCharacter(raw)) return DEFAULT_API_BASE_URL;
  const candidate = raw.trim();
  if (candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')) {
    return candidate.replace(/\/$/, '') || '/';
  }

  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : null;
    const parsed = new URL(candidate, origin || 'http://localhost');
    if (origin && parsed.origin === origin && !parsed.username && !parsed.password) {
      return `${parsed.pathname}${parsed.search}`.replace(/\/$/, '') || '/';
    }
  } catch {
    // Build-time configuration is input and must fail closed to the same-origin default.
  }

  return DEFAULT_API_BASE_URL;
};

const detectBuildMode = (source: RuntimeEnvironmentSource): RuntimeConfig['buildMode'] => {
  const hasVite = Object.keys(source).some((key) => key.startsWith('VITE_'));
  if (hasVite) return 'vite-ready';
  const hasCra = Object.keys(source).some((key) => key.startsWith('REACT_APP_'));
  if (hasCra) return 'legacy-cra';
  return 'unknown';
};

export const createRuntimeConfig = (source: RuntimeEnvironmentSource = getProcessEnv()): RuntimeConfig => {
  const env = source || {};
  const features: RuntimeFeatureFlags = Object.freeze({
    adaptiveRuntime: parseBoolean(firstDefined(env, ['VITE_ADAPTIVE_RUNTIME', 'REACT_APP_ADAPTIVE_RUNTIME']), true),
    privacyTelemetry: parseBoolean(firstDefined(env, ['VITE_PRIVACY_TELEMETRY', 'REACT_APP_PRIVACY_TELEMETRY']), true),
    typedBootstrap: parseBoolean(firstDefined(env, ['VITE_TYPED_BOOTSTRAP', 'REACT_APP_TYPED_BOOTSTRAP']), true),
    strictEndpointPolicy: parseBoolean(firstDefined(env, ['VITE_STRICT_ENDPOINT_POLICY', 'REACT_APP_STRICT_ENDPOINT_POLICY']), true),
  });

  return Object.freeze({
    apiBaseUrl: normalizeApiBaseUrl(firstDefined(env, [
      'VITE_API_URL',
      'VITE_API_BASE_URL',
      'REACT_APP_API_URL',
      'REACT_APP_API_BASE_URL',
    ])),
    requestTimeoutMs: parseInteger(
      firstDefined(env, ['VITE_API_TIMEOUT_MS', 'REACT_APP_API_TIMEOUT_MS']),
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000,
      60000,
    ),
    cacheTtlMs: parseInteger(
      firstDefined(env, ['VITE_API_CACHE_TTL_MS', 'REACT_APP_API_CACHE_TTL_MS']),
      DEFAULT_CACHE_TTL_MS,
      0,
      600000,
    ),
    maxRetries: parseInteger(
      firstDefined(env, ['VITE_API_MAX_RETRIES', 'REACT_APP_API_MAX_RETRIES']),
      DEFAULT_MAX_RETRIES,
      0,
      4,
    ),
    environment: safeText(firstDefined(env, ['VITE_ENV', 'MODE', 'REACT_APP_ENV']), 'production', 40),
    release: safeText(firstDefined(env, ['VITE_VERSION', 'VITE_RELEASE', 'REACT_APP_VERSION', 'REACT_APP_RELEASE']), 'local', 120),
    esriApiVersion: safeText(firstDefined(env, ['VITE_ESRI_API_VERSION', 'REACT_APP_ESRI_API_VERSION']), '', 40),
    tkgmCityId: safeText(firstDefined(env, ['VITE_TKGM_CITY_ID', 'REACT_APP_TKGM_CITY_ID']), '', 40),
    buildMode: detectBuildMode(env),
    features,
  });
};

export const assertSafeRuntimeConfig = (config: RuntimeConfig): true => {
  if (!config.apiBaseUrl.startsWith('/') || config.apiBaseUrl.startsWith('//') || config.apiBaseUrl.includes('\\')) {
    throw new Error('API base URL must resolve to a same-origin relative path');
  }
  if (containsControlCharacter(config.apiBaseUrl)) {
    throw new Error('API base URL contains unsupported control characters');
  }
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
    throw new Error('API timeout is outside the supported range');
  }
  if (config.cacheTtlMs < 0 || config.cacheTtlMs > 600000) {
    throw new Error('API cache TTL is outside the supported range');
  }
  if (config.maxRetries < 0 || config.maxRetries > 4) {
    throw new Error('API retry count is outside the supported range');
  }
  return true;
};

export const runtimeConfig = createRuntimeConfig();
assertSafeRuntimeConfig(runtimeConfig);

export const runtimeConfigFingerprint = (config: RuntimeConfig = runtimeConfig): string => {
  const source = [
    config.apiBaseUrl,
    config.requestTimeoutMs,
    config.cacheTtlMs,
    config.maxRetries,
    config.environment,
    config.release,
    config.esriApiVersion,
    config.tkgmCityId,
    config.buildMode,
    Number(config.features.adaptiveRuntime),
    Number(config.features.privacyTelemetry),
    Number(config.features.typedBootstrap),
    Number(config.features.strictEndpointPolicy),
  ].join('|');

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const describeRuntimeConfig = (config: RuntimeConfig = runtimeConfig): Readonly<Record<string, unknown>> => Object.freeze({
  apiBaseUrl: config.apiBaseUrl,
  requestTimeoutMs: config.requestTimeoutMs,
  cacheTtlMs: config.cacheTtlMs,
  maxRetries: config.maxRetries,
  environment: config.environment,
  release: config.release,
  esriApiVersion: config.esriApiVersion,
  tkgmCityIdConfigured: Boolean(config.tkgmCityId),
  buildMode: config.buildMode,
  features: config.features,
  fingerprint: runtimeConfigFingerprint(config),
});
