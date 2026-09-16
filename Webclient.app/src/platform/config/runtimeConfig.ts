import { normalizeApplicationPath } from '../network/endpointPolicy';

const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_ESRI_API_VERSION = '4.21';

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
  const candidate = globalThis as typeof globalThis & {
    readonly process?: { readonly env?: RuntimeEnvironmentSource };
  };
  return candidate.process?.env ?? {};
};

const getViteEnv = (): RuntimeEnvironmentSource =>
  (import.meta.env ?? {}) as unknown as RuntimeEnvironmentSource;

const getDefaultEnvironmentSource = (): RuntimeEnvironmentSource => Object.freeze({
  ...getProcessEnv(),
  ...getViteEnv(),
});

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

const normalizeRelativeApiPath = (value: string): string | null => {
  if (containsControlCharacter(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const normalized = normalizeApplicationPath(value, { allowQuery: false, allowHash: false });
    return normalized.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
};

export const normalizeApiBaseUrl = (value: unknown): string => {
  const raw = String(value || DEFAULT_API_BASE_URL);
  if (containsControlCharacter(raw)) return DEFAULT_API_BASE_URL;
  const candidate = raw.trim();

  const relative = normalizeRelativeApiPath(candidate);
  if (relative) return relative;

  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : null;
    if (!origin) return DEFAULT_API_BASE_URL;
    const parsed = new URL(candidate, origin);
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash || parsed.search) {
      return DEFAULT_API_BASE_URL;
    }
    return normalizeRelativeApiPath(parsed.pathname) ?? DEFAULT_API_BASE_URL;
  } catch {
    // Build/runtime configuration is untrusted input and fails closed.
  }

  return DEFAULT_API_BASE_URL;
};

/**
 * esri-loader is still the compatibility transport for the existing GIS surface.
 * Never allow a free-form build variable to become part of a CDN URL: only an
 * explicit ArcGIS Maps SDK 4.x release token is accepted, otherwise the known
 * project baseline is used.
 */
export const normalizeEsriApiVersion = (value: unknown): string => {
  const normalized = safeText(value, DEFAULT_ESRI_API_VERSION, 16);
  return /^4\.\d{1,3}$/.test(normalized) ? normalized : DEFAULT_ESRI_API_VERSION;
};

const detectBuildMode = (source: RuntimeEnvironmentSource): RuntimeConfig['buildMode'] => {
  const keys = Object.keys(source);
  const hasVite = keys.some((key) => key.startsWith('VITE_'))
    || ['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'].some((key) => key in source);
  if (hasVite) return 'vite-ready';
  const hasCra = keys.some((key) => key.startsWith('REACT_APP_'));
  if (hasCra) return 'legacy-cra';
  return 'unknown';
};

export const createRuntimeConfig = (source: RuntimeEnvironmentSource = getDefaultEnvironmentSource()): RuntimeConfig => {
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
    esriApiVersion: normalizeEsriApiVersion(firstDefined(env, ['VITE_ESRI_API_VERSION', 'REACT_APP_ESRI_API_VERSION'])),
    tkgmCityId: safeText(firstDefined(env, ['VITE_TKGM_CITY_ID', 'REACT_APP_TKGM_CITY_ID']), '', 40),
    buildMode: detectBuildMode(env),
    features,
  });
};

export const assertSafeRuntimeConfig = (config: RuntimeConfig): true => {
  const normalizedApi = normalizeApiBaseUrl(config.apiBaseUrl);
  if (normalizedApi !== config.apiBaseUrl) {
    throw new Error('API base URL must be a canonical same-origin relative path');
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
  if (!/^4\.\d{1,3}$/.test(config.esriApiVersion)) {
    throw new Error('ArcGIS Maps SDK version must be an explicit 4.x release');
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
