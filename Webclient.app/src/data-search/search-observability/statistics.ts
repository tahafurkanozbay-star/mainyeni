import {
  normalizeFiniteNumber,
  normalizeInteger,
} from '../../Toolbox/DataIntegrityHelper';
import type {
  NumericSampleSummary,
  RollingSampleWindow,
} from './contracts';

export const DEFAULT_SAMPLE_WINDOW = 200;
export const MAX_SAMPLE_WINDOW = 5_000;

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const safeRatio = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

export const normalizeMetricValue = (value: unknown): number | null =>
  normalizeFiniteNumber(value, null);

export const percentile = (
  values: unknown,
  percentileValue: unknown,
): number | null => {
  const sorted = asArray(values)
    .map(normalizeMetricValue)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (!sorted.length) return null;

  const p = clamp(normalizeFiniteNumber(percentileValue, 0) ?? 0, 0, 1);
  if (sorted.length === 1) return sorted[0] ?? null;

  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  if (lower === upper) return lowerValue;
  const weight = position - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
};

export const summarizeNumericSamples = (
  values: unknown,
): NumericSampleSummary => {
  const samples = asArray(values)
    .map(normalizeMetricValue)
    .filter((value): value is number => value !== null);

  if (!samples.length) {
    return {
      count: 0,
      min: null,
      max: null,
      sum: 0,
      average: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      latest: null,
    };
  }

  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    sum,
    average: sum / samples.length,
    p50: percentile(samples, 0.5),
    p90: percentile(samples, 0.9),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    latest: samples[samples.length - 1] ?? null,
  };
};

export const createRollingSampleWindow = (
  options: { maxSamples?: unknown } = {},
): RollingSampleWindow => {
  const maxSamples = normalizeInteger(options.maxSamples, {
    min: 1,
    max: MAX_SAMPLE_WINDOW,
    fallback: DEFAULT_SAMPLE_WINDOW,
  }) ?? DEFAULT_SAMPLE_WINDOW;
  const samples: number[] = [];

  const window: RollingSampleWindow = {
    add(value) {
      const normalized = normalizeMetricValue(value);
      if (normalized === null) return false;
      samples.push(normalized);
      while (samples.length > maxSamples) samples.shift();
      return true;
    },

    addMany(values) {
      return asArray(values).reduce<number>(
        (count, value) => count + (window.add(value) ? 1 : 0),
        0,
      );
    },

    values() {
      return samples.slice();
    },

    summary() {
      return summarizeNumericSamples(samples);
    },

    clear() {
      const count = samples.length;
      samples.length = 0;
      return count;
    },

    size() {
      return samples.length;
    },

    maxSamples,
  };

  return window;
};
