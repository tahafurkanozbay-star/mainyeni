import type { NumericDistribution } from './contracts';
import { boundedInteger, finiteNumber, roundMetric } from './normalization';

const cleanNumbers = (values: readonly unknown[]): number[] =>
  values
    .map(value => finiteNumber(value, null))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

export const percentile = (values: readonly unknown[], percentileValue: number): number | null => {
  const sorted = cleanNumbers(values);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;

  const p = Math.min(1, Math.max(0, percentileValue));
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

export const summarizeNumbers = (values: readonly unknown[]): NumericDistribution => {
  const samples = cleanNumbers(values);
  if (samples.length === 0) {
    return {
      count: 0,
      minimum: null,
      maximum: null,
      sum: 0,
      average: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
      latest: null,
    };
  }

  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    count: samples.length,
    minimum: roundMetric(samples[0]),
    maximum: roundMetric(samples.at(-1)),
    sum: roundMetric(sum) ?? 0,
    average: roundMetric(sum / samples.length),
    p50: roundMetric(percentile(samples, 0.5)),
    p75: roundMetric(percentile(samples, 0.75)),
    p90: roundMetric(percentile(samples, 0.9)),
    p95: roundMetric(percentile(samples, 0.95)),
    p99: roundMetric(percentile(samples, 0.99)),
    latest: roundMetric(samples.at(-1)),
  };
};

export interface BoundedSampleWindow {
  readonly add: (value: unknown) => boolean;
  readonly addMany: (values: readonly unknown[]) => number;
  readonly values: () => number[];
  readonly summary: () => NumericDistribution;
  readonly clear: () => number;
  readonly size: () => number;
  readonly capacity: number;
}

export const createBoundedSampleWindow = (capacityValue: unknown = 256): BoundedSampleWindow => {
  const capacity = boundedInteger(capacityValue, 1, 4_096, 256);
  const samples: number[] = [];

  const add = (value: unknown): boolean => {
    const normalized = finiteNumber(value, null);
    if (normalized === null) return false;
    samples.push(normalized);
    if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    return true;
  };

  return {
    add,
    addMany(values) {
      let added = 0;
      for (const value of values) added += add(value) ? 1 : 0;
      return added;
    },
    values: () => samples.slice(),
    summary: () => summarizeNumbers(samples),
    clear() {
      const size = samples.length;
      samples.length = 0;
      return size;
    },
    size: () => samples.length,
    capacity,
  };
};
