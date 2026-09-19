import type {
  ApiRequestControl,
  BusinessRuntimePolicy,
  NormalizedApiRequestControl,
} from './contracts';

export const DEFAULT_BUSINESS_RUNTIME_POLICY: Readonly<BusinessRuntimePolicy> = Object.freeze({
  maxTextLength: 160,
  maxIdentifierLength: 96,
  maxIdentifierCount: 250,
  maxWhereLength: 4096,
  maxDiagnosticEntries: 256,
  defaultCacheTtlMs: 30_000,
  maxCacheTtlMs: 300_000,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 120_000,
  minNearbyDistance: 0,
  maxNearbyDistance: 100,
});

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const boundedFinite = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

export const normalizeBusinessRuntimePolicy = (
  input: Partial<BusinessRuntimePolicy> | null | undefined = {},
): BusinessRuntimePolicy => {
  const value = input ?? {};
  const defaults = DEFAULT_BUSINESS_RUNTIME_POLICY;

  return Object.freeze({
    maxTextLength: boundedInteger(value.maxTextLength, defaults.maxTextLength, 1, 2_048),
    maxIdentifierLength: boundedInteger(
      value.maxIdentifierLength,
      defaults.maxIdentifierLength,
      1,
      512,
    ),
    maxIdentifierCount: boundedInteger(
      value.maxIdentifierCount,
      defaults.maxIdentifierCount,
      1,
      10_000,
    ),
    maxWhereLength: boundedInteger(
      value.maxWhereLength,
      defaults.maxWhereLength,
      64,
      65_536,
    ),
    maxDiagnosticEntries: boundedInteger(
      value.maxDiagnosticEntries,
      defaults.maxDiagnosticEntries,
      1,
      4_096,
    ),
    defaultCacheTtlMs: boundedInteger(
      value.defaultCacheTtlMs,
      defaults.defaultCacheTtlMs,
      0,
      defaults.maxCacheTtlMs,
    ),
    maxCacheTtlMs: boundedInteger(
      value.maxCacheTtlMs,
      defaults.maxCacheTtlMs,
      1_000,
      3_600_000,
    ),
    defaultTimeoutMs: boundedInteger(
      value.defaultTimeoutMs,
      defaults.defaultTimeoutMs,
      1,
      defaults.maxTimeoutMs,
    ),
    maxTimeoutMs: boundedInteger(
      value.maxTimeoutMs,
      defaults.maxTimeoutMs,
      1_000,
      600_000,
    ),
    minNearbyDistance: boundedFinite(
      value.minNearbyDistance,
      defaults.minNearbyDistance,
      0,
      defaults.maxNearbyDistance,
    ),
    maxNearbyDistance: boundedFinite(
      value.maxNearbyDistance,
      defaults.maxNearbyDistance,
      1,
      5_000,
    ),
  });
};

export const normalizeApiRequestControl = (
  control: ApiRequestControl = {},
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): NormalizedApiRequestControl => {
  const timeoutMs = boundedInteger(
    control.timeoutMs,
    policy.defaultTimeoutMs,
    1,
    policy.maxTimeoutMs,
  );
  const cacheTtlMs = boundedInteger(
    control.cacheTtlMs,
    policy.defaultCacheTtlMs,
    0,
    policy.maxCacheTtlMs,
  );
  const normalized: NormalizedApiRequestControl = {
    timeoutMs,
    cacheTtlMs,
    cache: control.cache !== false,
    dedupe: control.signal ? false : control.dedupe !== false,
    ...(control.signal ? { signal: control.signal } : {}),
  };
  return Object.freeze(normalized);
};

export const normalizeNearbyDistance = (
  value: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return policy.minNearbyDistance;
  return Math.min(
    policy.maxNearbyDistance,
    Math.max(policy.minNearbyDistance, numeric),
  );
};
