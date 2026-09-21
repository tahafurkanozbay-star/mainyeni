import { normalizeApplicationPath } from '../network/endpointPolicy';

const DEFAULT_API_BASE_URL = '/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_RELEASE = 'local';
const DEFAULT_ESRI_API_VERSION = '5.1.24';
const DEFAULT_TKGM_CITY_ID = '';

export const RUNTIME_CONFIG_DEFAULTS = Object.freeze({
  apiBaseUrl: DEFAULT_API_BASE_URL,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  environment: DEFAULT_ENVIRONMENT,
  release: DEFAULT_RELEASE,
  esriApiVersion: DEFAULT_ESRI_API_VERSION,
  tkgmCityId: DEFAULT_TKGM_CITY_ID,
  features: Object.freeze({
    adaptiveRuntime: true,
    debugLogging: false,
    privacyTelemetry: true,
    typedBootstrap: true,
    strictEndpointPolicy: true,
  }),
});

export interface RuntimeEnvironmentSource {
  readonly [key: string]: unknown;
}

export interface RuntimeFeatureFlags {
  readonly adaptiveRuntime: boolean;
  readonly debugLogging: boolean;
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

export type RuntimeConfigFieldId =
  | 'apiBaseUrl'
  | 'requestTimeoutMs'
  | 'cacheTtlMs'
  | 'maxRetries'
  | 'environment'
  | 'release'
  | 'esriApiVersion'
  | 'tkgmCityId'
  | 'features.adaptiveRuntime'
  | 'features.debugLogging'
  | 'features.privacyTelemetry'
  | 'features.typedBootstrap'
  | 'features.strictEndpointPolicy'
  | 'buildMode';

export type RuntimeConfigSourceKind =
  | 'vite'
  | 'vite-builtin'
  | 'legacy-cra'
  | 'default'
  | 'derived';

export type RuntimeConfigResolutionDisposition =
  | 'accepted'
  | 'normalized'
  | 'clamped'
  | 'defaulted'
  | 'invalid-fallback'
  | 'policy-pinned';

export interface RuntimeConfigFieldEvidence {
  readonly fieldId: RuntimeConfigFieldId;
  readonly sourceKey?: string;
  readonly sourceKind: RuntimeConfigSourceKind;
  readonly disposition: RuntimeConfigResolutionDisposition;
  readonly configured: boolean;
  readonly sensitive: boolean;
  readonly shadowedSourceCount: number;
}

export interface RuntimeConfigResolutionSummary {
  readonly configuredFields: number;
  readonly defaultedFields: number;
  readonly normalizedFields: number;
  readonly clampedFields: number;
  readonly rejectedFields: number;
  readonly pinnedFields: number;
  readonly legacySourceFields: number;
  readonly shadowedSourceCount: number;
}

export interface RuntimeConfigResolution {
  readonly config: RuntimeConfig;
  readonly evidence: readonly RuntimeConfigFieldEvidence[];
  readonly summary: RuntimeConfigResolutionSummary;
  readonly configFingerprint: string;
  readonly evidenceFingerprint: string;
}

interface SelectedSource {
  readonly key?: string;
  readonly value?: unknown;
  readonly kind: RuntimeConfigSourceKind;
  readonly configured: boolean;
  readonly shadowedSourceCount: number;
}

interface ResolvedValue<T> {
  readonly value: T;
  readonly evidence: RuntimeConfigFieldEvidence;
}

const API_KEYS = Object.freeze([
  'VITE_API_URL',
  'VITE_API_BASE_URL',
  'REACT_APP_API_URL',
  'REACT_APP_API_BASE_URL',
] as const);

const TIMEOUT_KEYS = Object.freeze([
  'VITE_API_TIMEOUT_MS',
  'REACT_APP_API_TIMEOUT_MS',
] as const);

const CACHE_TTL_KEYS = Object.freeze([
  'VITE_API_CACHE_TTL_MS',
  'REACT_APP_API_CACHE_TTL_MS',
] as const);

const RETRY_KEYS = Object.freeze([
  'VITE_API_MAX_RETRIES',
  'REACT_APP_API_MAX_RETRIES',
] as const);

const ENVIRONMENT_KEYS = Object.freeze([
  'VITE_ENV',
  'MODE',
  'REACT_APP_ENV',
] as const);

const RELEASE_KEYS = Object.freeze([
  'VITE_VERSION',
  'VITE_RELEASE',
  'REACT_APP_VERSION',
  'REACT_APP_RELEASE',
] as const);

const ESRI_KEYS = Object.freeze([
  'VITE_ESRI_API_VERSION',
  'REACT_APP_ESRI_API_VERSION',
] as const);

const TKGM_KEYS = Object.freeze([
  'VITE_TKGM_CITY_ID',
  'REACT_APP_TKGM_CITY_ID',
] as const);

const ADAPTIVE_KEYS = Object.freeze([
  'VITE_ADAPTIVE_RUNTIME',
  'REACT_APP_ADAPTIVE_RUNTIME',
] as const);

const DEBUG_KEYS = Object.freeze([
  'VITE_ENV_DEBUG',
  'REACT_APP_ENV_DEBUG',
] as const);

const PRIVACY_KEYS = Object.freeze([
  'VITE_PRIVACY_TELEMETRY',
  'REACT_APP_PRIVACY_TELEMETRY',
] as const);

const TYPED_BOOTSTRAP_KEYS = Object.freeze([
  'VITE_TYPED_BOOTSTRAP',
  'REACT_APP_TYPED_BOOTSTRAP',
] as const);

const STRICT_ENDPOINT_KEYS = Object.freeze([
  'VITE_STRICT_ENDPOINT_POLICY',
  'REACT_APP_STRICT_ENDPOINT_POLICY',
] as const);

export const RUNTIME_CONFIG_SOURCE_KEYS = Object.freeze({
  apiBaseUrl: API_KEYS,
  requestTimeoutMs: TIMEOUT_KEYS,
  cacheTtlMs: CACHE_TTL_KEYS,
  maxRetries: RETRY_KEYS,
  environment: ENVIRONMENT_KEYS,
  release: RELEASE_KEYS,
  esriApiVersion: ESRI_KEYS,
  tkgmCityId: TKGM_KEYS,
  'features.adaptiveRuntime': ADAPTIVE_KEYS,
  'features.debugLogging': DEBUG_KEYS,
  'features.privacyTelemetry': PRIVACY_KEYS,
  'features.typedBootstrap': TYPED_BOOTSTRAP_KEYS,
  'features.strictEndpointPolicy': STRICT_ENDPOINT_KEYS,
});

const VITE_BUILTIN_KEYS = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);

const getProcessEnv = (): RuntimeEnvironmentSource => {
  const candidate = globalThis as typeof globalThis & {
    readonly process?: { readonly env?: RuntimeEnvironmentSource };
  };
  return candidate.process?.env ?? {};
};

const getViteEnv = (): RuntimeEnvironmentSource => {
  const meta = import.meta as ImportMeta & {
    readonly env?: RuntimeEnvironmentSource;
  };
  return meta.env ?? {};
};

const getDefaultEnvironmentSource = (): RuntimeEnvironmentSource => Object.freeze({
  ...getProcessEnv(),
  ...getViteEnv(),
});

const isConfigured = (value: unknown): boolean =>
  value !== undefined
  && value !== null
  && String(value).trim() !== '';

export const classifyRuntimeConfigSourceKey = (
  key: string,
): RuntimeConfigSourceKind => {
  if (VITE_BUILTIN_KEYS.has(key)) return 'vite-builtin';
  if (key.startsWith('VITE_')) return 'vite';
  if (key.startsWith('REACT_APP_')) return 'legacy-cra';
  return 'derived';
};

const selectSource = (
  source: RuntimeEnvironmentSource,
  keys: readonly string[],
): SelectedSource => {
  const configured = keys.filter((key) => isConfigured(source[key]));
  const key = configured[0];
  if (!key) {
    return Object.freeze({
      kind: 'default' as const,
      configured: false,
      shadowedSourceCount: 0,
    });
  }
  return Object.freeze({
    key,
    value: source[key],
    kind: classifyRuntimeConfigSourceKey(key),
    configured: true,
    shadowedSourceCount: Math.max(0, configured.length - 1),
  });
};

const evidence = (
  fieldId: RuntimeConfigFieldId,
  selected: SelectedSource,
  disposition: RuntimeConfigResolutionDisposition,
  sensitive = false,
): RuntimeConfigFieldEvidence => Object.freeze({
  fieldId,
  ...(selected.key === undefined ? {} : { sourceKey: selected.key }),
  sourceKind: selected.kind,
  disposition,
  configured: selected.configured,
  sensitive,
  shadowedSourceCount: selected.shadowedSourceCount,
});

const parseInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
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
    const normalized = normalizeApplicationPath(value, {
      allowQuery: false,
      allowHash: false,
    });
    return normalized.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
};

export const normalizeApiBaseUrl = (value: unknown): string => {
  const raw = String(value || RUNTIME_CONFIG_DEFAULTS.apiBaseUrl);
  if (containsControlCharacter(raw)) return RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;
  const candidate = raw.trim();

  const relative = normalizeRelativeApiPath(candidate);
  if (relative) return relative;
  if (candidate.startsWith('/')) return RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;

  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : null;
    if (!origin) return RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;
    const parsed = new URL(candidate, origin);
    if (
      parsed.origin !== origin
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.search
    ) {
      return RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;
    }
    return normalizeRelativeApiPath(parsed.pathname)
      ?? RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;
  } catch {
    return RUNTIME_CONFIG_DEFAULTS.apiBaseUrl;
  }
};

/**
 * @arcgis/core is bundled at build time, so runtime configuration must never
 * claim a different SDK version than the package pinned in the lockfile.
 */
export const normalizeEsriApiVersion = (value: unknown): string => {
  const normalized = safeText(value, RUNTIME_CONFIG_DEFAULTS.esriApiVersion, 16);
  return normalized === RUNTIME_CONFIG_DEFAULTS.esriApiVersion
    ? normalized
    : RUNTIME_CONFIG_DEFAULTS.esriApiVersion;
};

const detectBuildMode = (
  source: RuntimeEnvironmentSource,
): RuntimeConfig['buildMode'] => {
  const keys = Object.keys(source);
  const hasVite = keys.some((key) => key.startsWith('VITE_'))
    || ['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'].some((key) => key in source);
  if (hasVite) return 'vite-ready';
  const hasCra = keys.some((key) => key.startsWith('REACT_APP_'));
  if (hasCra) return 'legacy-cra';
  return 'unknown';
};

const buildModeEvidence = (
  source: RuntimeEnvironmentSource,
  mode: RuntimeConfig['buildMode'],
): RuntimeConfigFieldEvidence => {
  if (mode === 'vite-ready') {
    const key = Object.keys(source)
      .filter(
        (candidate) => candidate.startsWith('VITE_') || VITE_BUILTIN_KEYS.has(candidate),
      )
      .sort()[0];
    return evidence(
      'buildMode',
      Object.freeze({
        ...(key ? { key, value: source[key] } : {}),
        kind: key ? classifyRuntimeConfigSourceKey(key) : 'derived',
        configured: Boolean(key),
        shadowedSourceCount: 0,
      }),
      'accepted',
    );
  }
  if (mode === 'legacy-cra') {
    const key = Object.keys(source)
      .filter((candidate) => candidate.startsWith('REACT_APP_'))
      .sort()[0];
    return evidence(
      'buildMode',
      Object.freeze({
        ...(key ? { key, value: source[key] } : {}),
        kind: 'legacy-cra',
        configured: Boolean(key),
        shadowedSourceCount: 0,
      }),
      'accepted',
    );
  }
  return evidence(
    'buildMode',
    Object.freeze({
      kind: 'derived',
      configured: false,
      shadowedSourceCount: 0,
    }),
    'defaulted',
  );
};

const resolveInteger = (
  fieldId: RuntimeConfigFieldId,
  source: RuntimeEnvironmentSource,
  keys: readonly string[],
  fallback: number,
  min: number,
  max: number,
): ResolvedValue<number> => {
  const selected = selectSource(source, keys);
  if (!selected.configured) {
    return Object.freeze({
      value: fallback,
      evidence: evidence(fieldId, selected, 'defaulted'),
    });
  }

  const parsed = Number.parseInt(String(selected.value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return Object.freeze({
      value: fallback,
      evidence: evidence(fieldId, selected, 'invalid-fallback'),
    });
  }
  const value = parseInteger(selected.value, fallback, min, max);
  return Object.freeze({
    value,
    evidence: evidence(
      fieldId,
      selected,
      value === parsed ? 'accepted' : 'clamped',
    ),
  });
};

const resolveBoolean = (
  fieldId: RuntimeConfigFieldId,
  source: RuntimeEnvironmentSource,
  keys: readonly string[],
  fallback: boolean,
): ResolvedValue<boolean> => {
  const selected = selectSource(source, keys);
  if (!selected.configured) {
    return Object.freeze({
      value: fallback,
      evidence: evidence(fieldId, selected, 'defaulted'),
    });
  }
  const value = parseBoolean(selected.value, fallback);
  const normalized = String(selected.value ?? '').trim().toLowerCase();
  const recognized = typeof selected.value === 'boolean'
    || [
      '1',
      'true',
      'yes',
      'on',
      'enabled',
      '0',
      'false',
      'no',
      'off',
      'disabled',
    ].includes(normalized);

  return Object.freeze({
    value,
    evidence: evidence(
      fieldId,
      selected,
      recognized ? 'accepted' : 'invalid-fallback',
    ),
  });
};

const resolveText = (
  fieldId: RuntimeConfigFieldId,
  source: RuntimeEnvironmentSource,
  keys: readonly string[],
  fallback: string,
  maxLength: number,
  sensitive = false,
): ResolvedValue<string> => {
  const selected = selectSource(source, keys);
  if (!selected.configured) {
    return Object.freeze({
      value: fallback,
      evidence: evidence(fieldId, selected, 'defaulted', sensitive),
    });
  }
  const raw = String(selected.value ?? '');
  const value = safeText(selected.value, fallback, maxLength);
  const canonicalRaw = raw.replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLength);
  return Object.freeze({
    value,
    evidence: evidence(
      fieldId,
      selected,
      value === canonicalRaw && raw === canonicalRaw ? 'accepted' : 'normalized',
      sensitive,
    ),
  });
};

const resolveApiBase = (
  source: RuntimeEnvironmentSource,
): ResolvedValue<string> => {
  const selected = selectSource(source, API_KEYS);
  if (!selected.configured) {
    return Object.freeze({
      value: RUNTIME_CONFIG_DEFAULTS.apiBaseUrl,
      evidence: evidence('apiBaseUrl', selected, 'defaulted'),
    });
  }

  const raw = String(selected.value ?? '');
  const value = normalizeApiBaseUrl(selected.value);
  const trimmed = raw.trim();
  const safeCandidate = normalizeRelativeApiPath(trimmed);
  const disposition: RuntimeConfigResolutionDisposition = safeCandidate === value
    ? (trimmed === value ? 'accepted' : 'normalized')
    : value === RUNTIME_CONFIG_DEFAULTS.apiBaseUrl
      ? 'invalid-fallback'
      : 'normalized';

  return Object.freeze({
    value,
    evidence: evidence('apiBaseUrl', selected, disposition),
  });
};

const resolveEsriVersion = (
  source: RuntimeEnvironmentSource,
): ResolvedValue<string> => {
  const selected = selectSource(source, ESRI_KEYS);
  if (!selected.configured) {
    return Object.freeze({
      value: RUNTIME_CONFIG_DEFAULTS.esriApiVersion,
      evidence: evidence('esriApiVersion', selected, 'defaulted'),
    });
  }
  const raw = safeText(selected.value, RUNTIME_CONFIG_DEFAULTS.esriApiVersion, 16);
  const value = normalizeEsriApiVersion(selected.value);
  return Object.freeze({
    value,
    evidence: evidence(
      'esriApiVersion',
      selected,
      raw === value ? 'accepted' : 'policy-pinned',
    ),
  });
};

const summarizeEvidence = (
  values: readonly RuntimeConfigFieldEvidence[],
): RuntimeConfigResolutionSummary => {
  const count = (
    predicate: (item: RuntimeConfigFieldEvidence) => boolean,
  ): number => values.reduce(
    (total, item) => total + (predicate(item) ? 1 : 0),
    0,
  );

  return Object.freeze({
    configuredFields: count((item) => item.configured),
    defaultedFields: count((item) => item.disposition === 'defaulted'),
    normalizedFields: count((item) => item.disposition === 'normalized'),
    clampedFields: count((item) => item.disposition === 'clamped'),
    rejectedFields: count((item) => item.disposition === 'invalid-fallback'),
    pinnedFields: count((item) => item.disposition === 'policy-pinned'),
    legacySourceFields: count((item) => item.sourceKind === 'legacy-cra'),
    shadowedSourceCount: values.reduce(
      (total, item) => total + item.shadowedSourceCount,
      0,
    ),
  });
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const runtimeConfigFingerprint = (
  config: RuntimeConfig = runtimeConfig,
): string => fnv1a([
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
  Number(config.features.debugLogging),
  Number(config.features.privacyTelemetry),
  Number(config.features.typedBootstrap),
  Number(config.features.strictEndpointPolicy),
].join('|'));

export const runtimeConfigEvidenceFingerprint = (
  evidenceValues: readonly RuntimeConfigFieldEvidence[],
): string => fnv1a(
  evidenceValues
    .map((item) => [
      item.fieldId,
      item.sourceKey ?? '',
      item.sourceKind,
      item.disposition,
      Number(item.configured),
      Number(item.sensitive),
      item.shadowedSourceCount,
    ].join(':'))
    .join('|'),
);

export const resolveRuntimeConfig = (
  source: RuntimeEnvironmentSource = getDefaultEnvironmentSource(),
): RuntimeConfigResolution => {
  const env = source || {};
  const apiBaseUrl = resolveApiBase(env);
  const requestTimeoutMs = resolveInteger(
    'requestTimeoutMs',
    env,
    TIMEOUT_KEYS,
    RUNTIME_CONFIG_DEFAULTS.requestTimeoutMs,
    1_000,
    60_000,
  );
  const cacheTtlMs = resolveInteger(
    'cacheTtlMs',
    env,
    CACHE_TTL_KEYS,
    RUNTIME_CONFIG_DEFAULTS.cacheTtlMs,
    0,
    600_000,
  );
  const maxRetries = resolveInteger(
    'maxRetries',
    env,
    RETRY_KEYS,
    RUNTIME_CONFIG_DEFAULTS.maxRetries,
    0,
    4,
  );
  const environment = resolveText(
    'environment',
    env,
    ENVIRONMENT_KEYS,
    RUNTIME_CONFIG_DEFAULTS.environment,
    40,
  );
  const release = resolveText(
    'release',
    env,
    RELEASE_KEYS,
    RUNTIME_CONFIG_DEFAULTS.release,
    120,
  );
  const esriApiVersion = resolveEsriVersion(env);
  const tkgmCityId = resolveText(
    'tkgmCityId',
    env,
    TKGM_KEYS,
    RUNTIME_CONFIG_DEFAULTS.tkgmCityId,
    40,
    true,
  );
  const adaptiveRuntime = resolveBoolean(
    'features.adaptiveRuntime',
    env,
    ADAPTIVE_KEYS,
    RUNTIME_CONFIG_DEFAULTS.features.adaptiveRuntime,
  );
  const debugLogging = resolveBoolean(
    'features.debugLogging',
    env,
    DEBUG_KEYS,
    RUNTIME_CONFIG_DEFAULTS.features.debugLogging,
  );
  const privacyTelemetry = resolveBoolean(
    'features.privacyTelemetry',
    env,
    PRIVACY_KEYS,
    RUNTIME_CONFIG_DEFAULTS.features.privacyTelemetry,
  );
  const typedBootstrap = resolveBoolean(
    'features.typedBootstrap',
    env,
    TYPED_BOOTSTRAP_KEYS,
    RUNTIME_CONFIG_DEFAULTS.features.typedBootstrap,
  );
  const strictEndpointPolicy = resolveBoolean(
    'features.strictEndpointPolicy',
    env,
    STRICT_ENDPOINT_KEYS,
    RUNTIME_CONFIG_DEFAULTS.features.strictEndpointPolicy,
  );
  const buildMode = detectBuildMode(env);

  const config: RuntimeConfig = Object.freeze({
    apiBaseUrl: apiBaseUrl.value,
    requestTimeoutMs: requestTimeoutMs.value,
    cacheTtlMs: cacheTtlMs.value,
    maxRetries: maxRetries.value,
    environment: environment.value,
    release: release.value,
    esriApiVersion: esriApiVersion.value,
    tkgmCityId: tkgmCityId.value,
    buildMode,
    features: Object.freeze({
      adaptiveRuntime: adaptiveRuntime.value,
      debugLogging: debugLogging.value,
      privacyTelemetry: privacyTelemetry.value,
      typedBootstrap: typedBootstrap.value,
      strictEndpointPolicy: strictEndpointPolicy.value,
    }),
  });

  const evidenceValues = Object.freeze([
    apiBaseUrl.evidence,
    requestTimeoutMs.evidence,
    cacheTtlMs.evidence,
    maxRetries.evidence,
    environment.evidence,
    release.evidence,
    esriApiVersion.evidence,
    tkgmCityId.evidence,
    adaptiveRuntime.evidence,
    debugLogging.evidence,
    privacyTelemetry.evidence,
    typedBootstrap.evidence,
    strictEndpointPolicy.evidence,
    buildModeEvidence(env, buildMode),
  ]);

  return Object.freeze({
    config,
    evidence: evidenceValues,
    summary: summarizeEvidence(evidenceValues),
    configFingerprint: runtimeConfigFingerprint(config),
    evidenceFingerprint: runtimeConfigEvidenceFingerprint(evidenceValues),
  });
};

export const createRuntimeConfig = (
  source: RuntimeEnvironmentSource = getDefaultEnvironmentSource(),
): RuntimeConfig => resolveRuntimeConfig(source).config;

export const assertSafeRuntimeConfig = (config: RuntimeConfig): true => {
  const normalizedApi = normalizeApiBaseUrl(config.apiBaseUrl);
  if (normalizedApi !== config.apiBaseUrl) {
    throw new Error('API base URL must be a canonical same-origin relative path');
  }
  if (config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 60_000) {
    throw new Error('API timeout is outside the supported range');
  }
  if (config.cacheTtlMs < 0 || config.cacheTtlMs > 600_000) {
    throw new Error('API cache TTL is outside the supported range');
  }
  if (config.maxRetries < 0 || config.maxRetries > 4) {
    throw new Error('API retry count is outside the supported range');
  }
  if (config.esriApiVersion !== RUNTIME_CONFIG_DEFAULTS.esriApiVersion) {
    throw new Error(
      'ArcGIS Maps SDK version must match bundled @arcgis/core '
      + RUNTIME_CONFIG_DEFAULTS.esriApiVersion,
    );
  }
  return true;
};

export const runtimeConfigResolution = resolveRuntimeConfig();
export const runtimeConfig = runtimeConfigResolution.config;
assertSafeRuntimeConfig(runtimeConfig);

export const describeRuntimeConfig = (
  config: RuntimeConfig = runtimeConfig,
): Readonly<Record<string, unknown>> => Object.freeze({
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

export const describeRuntimeConfigResolution = (
  resolution: RuntimeConfigResolution = runtimeConfigResolution,
): Readonly<Record<string, unknown>> => Object.freeze({
  config: describeRuntimeConfig(resolution.config),
  summary: resolution.summary,
  evidence: Object.freeze(resolution.evidence.map((item) => Object.freeze({
    fieldId: item.fieldId,
    sourceKey: item.sourceKey ?? null,
    sourceKind: item.sourceKind,
    disposition: item.disposition,
    configured: item.configured,
    sensitive: item.sensitive,
    shadowedSourceCount: item.shadowedSourceCount,
  }))),
  configFingerprint: resolution.configFingerprint,
  evidenceFingerprint: resolution.evidenceFingerprint,
});
