import type { PerformanceBaseline } from './contracts';
import { finiteNumber, safeText } from './normalization';

export interface BaselineDecodeResult {
  readonly ok: boolean;
  readonly baseline: PerformanceBaseline | null;
  readonly errors: readonly string[];
}

export interface BaselineCodecOptions {
  readonly maxMetrics?: number;
  readonly maxInputBytes?: number;
}

const DEFAULT_MAX_METRICS = 64;
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024;
const METRIC_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/u;
const FINGERPRINT_PATTERN = /^[a-zA-Z0-9._:-]{1,160}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedPositiveInteger = (
  value: unknown,
  fallback: number,
  maximum: number,
): number => {
  const parsed = finiteNumber(value, fallback) ?? fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)));
};

const normalizeOptions = (
  options: BaselineCodecOptions = {},
): Required<BaselineCodecOptions> => ({
  maxMetrics: boundedPositiveInteger(options.maxMetrics, DEFAULT_MAX_METRICS, 512),
  maxInputBytes: boundedPositiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 1024 * 1024),
});

const decodeInput = (
  input: unknown,
  maxInputBytes: number,
  errors: string[],
): unknown => {
  if (typeof input !== 'string') return input;
  if (new TextEncoder().encode(input).byteLength > maxInputBytes) {
    errors.push('baseline-input-too-large');
    return null;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    errors.push('baseline-json-invalid');
    return null;
  }
};

const normalizeMetrics = (
  raw: unknown,
  maxMetrics: number,
  errors: string[],
): Readonly<Record<string, number | null>> => {
  if (!isRecord(raw)) {
    errors.push('baseline-metrics-invalid');
    return Object.freeze({});
  }

  const entries = Object.entries(raw);
  if (entries.length > maxMetrics) {
    errors.push('baseline-metrics-too-many');
  }

  const output: Record<string, number | null> = {};
  for (const [rawKey, rawValue] of entries.slice(0, maxMetrics)) {
    const key = safeText(rawKey, 80);
    if (!METRIC_KEY_PATTERN.test(key)) {
      errors.push('baseline-metric-key-invalid');
      continue;
    }
    if (rawValue === null) {
      output[key] = null;
      continue;
    }
    const value = finiteNumber(rawValue, null);
    if (value === null) {
      errors.push('baseline-metric-value-invalid');
      continue;
    }
    output[key] = value;
  }

  return Object.freeze(output);
};

export const decodePerformanceBaseline = (
  input: unknown,
  options: BaselineCodecOptions = {},
): BaselineDecodeResult => {
  const normalizedOptions = normalizeOptions(options);
  const errors: string[] = [];
  const parsed = decodeInput(input, normalizedOptions.maxInputBytes, errors);

  if (!isRecord(parsed)) {
    if (!errors.length) errors.push('baseline-object-invalid');
    return Object.freeze({ ok: false, baseline: null, errors: Object.freeze(errors) });
  }

  if (parsed.schemaVersion !== 1) errors.push('baseline-schema-unsupported');

  const label = safeText(parsed.label, 120);
  if (!label) errors.push('baseline-label-invalid');

  const fingerprint = safeText(parsed.fingerprint, 160);
  if (!FINGERPRINT_PATTERN.test(fingerprint)) errors.push('baseline-fingerprint-invalid');

  const capturedAt = finiteNumber(parsed.capturedAt, null);
  if (capturedAt === null || capturedAt < 0) errors.push('baseline-captured-at-invalid');

  const metrics = normalizeMetrics(
    parsed.metrics,
    normalizedOptions.maxMetrics,
    errors,
  );

  if (errors.length > 0 || capturedAt === null) {
    return Object.freeze({
      ok: false,
      baseline: null,
      errors: Object.freeze(Array.from(new Set(errors))),
    });
  }

  return Object.freeze({
    ok: true,
    baseline: Object.freeze({
      schemaVersion: 1,
      label,
      fingerprint,
      capturedAt,
      metrics,
    }),
    errors: Object.freeze([]),
  });
};

export const encodePerformanceBaseline = (
  baseline: PerformanceBaseline,
  options: BaselineCodecOptions = {},
): string => {
  const decoded = decodePerformanceBaseline(baseline, options);
  if (!decoded.ok || !decoded.baseline) {
    throw new TypeError(`Invalid performance baseline: ${decoded.errors.join(', ')}`);
  }

  const orderedMetrics = Object.fromEntries(
    Object.entries(decoded.baseline.metrics)
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  );

  return JSON.stringify({
    schemaVersion: 1,
    label: decoded.baseline.label,
    fingerprint: decoded.baseline.fingerprint,
    capturedAt: decoded.baseline.capturedAt,
    metrics: orderedMetrics,
  });
};
