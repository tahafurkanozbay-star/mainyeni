export interface RuntimeEnvironmentSource {
  [key: string]: string | undefined;
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
  readonly diagnosticsEnabled: boolean;
  readonly offlineEnabled: boolean;
  readonly performanceBudgetProfile: RuntimeBudgetProfile;
}

export type RuntimeBudgetProfile = 'conservative' | 'balanced' | 'aggressive';

export interface RuntimeConfigValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_RELEASE = 'local';
const DEFAULT_BUDGET_PROFILE: RuntimeBudgetProfile = 'balanced';
const SAFE_FALLBACK_ORIGIN = 'https://localhost.invalid';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const ALLOWED_BUDGET_PROFILES = new Set<RuntimeBudgetProfile>([
  'conservative',
  'balanced',
  'aggressive'
]);

const getProcessEnv = (): RuntimeEnvironmentSource => {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env as RuntimeEnvironmentSource;
};

const boundedString = (value: unknown, fallback: string, maxLength = 160): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
};

const parseInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
};

const parseBudgetProfile = (value: unknown): RuntimeBudgetProfile => {
  const normalized = String(value ?? '').trim().toLowerCase() as RuntimeBudgetProfile;
  return ALLOWED_BUDGET_PROFILES.has(normalized) ? normalized : DEFAULT_BUDGET_PROFILE;
};

const currentOrigin = (): string | null => {
  if (typeof window === 'undefined') return null;
  const origin = window.location?.origin;
  return typeof origin === 'string' && origin ? origin : null;
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

export const normalizeApiBaseUrl = (value: unknown): string => {
  const raw = String(value || DEFAULT_API_BASE_URL);
  if (hasControlCharacter(raw)) return DEFAULT_API_BASE_URL;
  const candidate = raw.trim();

  if (
    candidate.startsWith('/')
    && !candidate.startsWith('//')
    && !candidate.includes('\\')
  ) {
    return candidate.replace(/\/$/, '') || '/';
  }

  try {
    const origin = currentOrigin();
    const parsed = new URL(candidate, origin || SAFE_FALLBACK_ORIGIN);
    if (origin && parsed.origin === origin) {
      const relative = `${parsed.pathname}${parsed.search}`;
      return relative.replace(/\/$/, '') || '/';
    }
  } catch (_error) {
    // Invalid build-time configuration falls back to the same-origin default.
  }

  return DEFAULT_API_BASE_URL;
};

export const createRuntimeConfig = (
  source: RuntimeEnvironmentSource = getProcessEnv()
): RuntimeConfig => {
  const env = source || {};
  return Object.freeze({
    apiBaseUrl: normalizeApiBaseUrl(env.REACT_APP_API_URL || env.REACT_APP_API_BASE_URL),
    requestTimeoutMs: parseInteger(
      env.REACT_APP_API_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000,
      60000
    ),
    cacheTtlMs: parseInteger(
      env.REACT_APP_API_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS,
      0,
      600000
    ),
    maxRetries: parseInteger(
      env.REACT_APP_API_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      0,
      4
    ),
    environment: boundedString(env.REACT_APP_ENV, DEFAULT_ENVIRONMENT, 64),
    release: boundedString(env.REACT_APP_VERSION || env.REACT_APP_RELEASE, DEFAULT_RELEASE, 96),
    esriApiVersion: boundedString(env.REACT_APP_ESRI_API_VERSION, '', 32),
    tkgmCityId: boundedString(env.REACT_APP_TKGM_CITY_ID, '', 32),
    diagnosticsEnabled: parseBoolean(env.REACT_APP_DIAGNOSTICS_ENABLED, true),
    offlineEnabled: parseBoolean(env.REACT_APP_OFFLINE_ENABLED, false),
    performanceBudgetProfile: parseBudgetProfile(env.REACT_APP_PERFORMANCE_BUDGET_PROFILE)
  });
};

export const validateRuntimeConfig = (config: RuntimeConfig): RuntimeConfigValidationResult => {
  const issues: string[] = [];

  if (!config.apiBaseUrl.startsWith('/') || config.apiBaseUrl.startsWith('//')) {
    issues.push('API base URL must resolve to a same-origin relative path');
  }
  if (config.apiBaseUrl.includes('\\') || hasControlCharacter(config.apiBaseUrl)) {
    issues.push('API base URL contains invalid path characters');
  }
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
    issues.push('API timeout is outside the supported range');
  }
  if (config.cacheTtlMs < 0 || config.cacheTtlMs > 600000) {
    issues.push('API cache TTL is outside the supported range');
  }
  if (config.maxRetries < 0 || config.maxRetries > 4) {
    issues.push('API retry count is outside the supported range');
  }
  if (!ALLOWED_BUDGET_PROFILES.has(config.performanceBudgetProfile)) {
    issues.push('Performance budget profile is not supported');
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues)
  });
};

export const assertSafeRuntimeConfig = (config: RuntimeConfig = runtimeConfig): true => {
  const validation = validateRuntimeConfig(config);
  if (!validation.valid) {
    throw new Error(validation.issues[0] || 'Runtime configuration is invalid');
  }
  return true;
};

export const runtimeConfig = createRuntimeConfig();

export const runtimeConfigSnapshot = (config: RuntimeConfig = runtimeConfig) => Object.freeze({
  apiBaseUrl: config.apiBaseUrl,
  requestTimeoutMs: config.requestTimeoutMs,
  cacheTtlMs: config.cacheTtlMs,
  maxRetries: config.maxRetries,
  environment: config.environment,
  release: config.release,
  esriApiVersion: config.esriApiVersion,
  tkgmCityId: config.tkgmCityId,
  diagnosticsEnabled: config.diagnosticsEnabled,
  offlineEnabled: config.offlineEnabled,
  performanceBudgetProfile: config.performanceBudgetProfile
});

export const isProductionRuntime = (config: RuntimeConfig = runtimeConfig): boolean =>
  config.environment.trim().toLowerCase() === 'production';

export const isDevelopmentRuntime = (config: RuntimeConfig = runtimeConfig): boolean =>
  !isProductionRuntime(config);

assertSafeRuntimeConfig();
