import type { Metric } from 'web-vitals';

export type SupportedWebVitalName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB';
export interface WebVitalSample {
  readonly name: SupportedWebVitalName;
  readonly value: number;
  readonly delta: number;
  readonly rating: 'good' | 'needs-improvement' | 'poor' | 'unknown';
  readonly navigationType: string | null;
  readonly id: string;
  readonly recordedAt: number;
}
export interface WebVitalsSnapshot {
  readonly capacity: number;
  readonly totalRecorded: number;
  readonly dropped: number;
  readonly samples: readonly WebVitalSample[];
  readonly latestByMetric: Readonly<Partial<Record<SupportedWebVitalName, WebVitalSample>>>;
}
export interface WebVitalsRuntime {
  readonly record: (metric: Metric) => WebVitalSample | null;
  readonly snapshot: () => WebVitalsSnapshot;
  readonly clear: () => void;
}

const SUPPORTED = new Set<SupportedWebVitalName>(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);
const capacityOf = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(500, Math.max(5, Math.trunc(parsed))) : 60;
};
const ratingOf = (value: unknown): WebVitalSample['rating'] =>
  value === 'good' || value === 'needs-improvement' || value === 'poor' ? value : 'unknown';
const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const createWebVitalsRuntime = (
  options: { readonly capacity?: number; readonly now?: () => number } = {},
): WebVitalsRuntime => {
  const capacity = capacityOf(options.capacity);
  const now = options.now ?? (() => Date.now());
  let totalRecorded = 0;
  let samples: WebVitalSample[] = [];

  const record = (metric: Metric): WebVitalSample | null => {
    if (!SUPPORTED.has(metric.name as SupportedWebVitalName)) return null;
    const value = finite(metric.value);
    const delta = finite(metric.delta);
    const recordedAt = finite(now());
    if (value === null || delta === null || recordedAt === null) return null;
    const sample = Object.freeze({
      name: metric.name as SupportedWebVitalName,
      value,
      delta,
      rating: ratingOf(metric.rating),
      navigationType: typeof metric.navigationType === 'string' ? metric.navigationType : null,
      id: typeof metric.id === 'string' ? metric.id : '',
      recordedAt,
    });
    totalRecorded += 1;
    samples = [...samples, sample];
    if (samples.length > capacity) samples = samples.slice(-capacity);
    return sample;
  };

  const snapshot = (): WebVitalsSnapshot => {
    const latest: Partial<Record<SupportedWebVitalName, WebVitalSample>> = {};
    for (const sample of samples) latest[sample.name] = sample;
    return Object.freeze({
      capacity,
      totalRecorded,
      dropped: Math.max(0, totalRecorded - samples.length),
      samples: Object.freeze([...samples]),
      latestByMetric: Object.freeze(latest),
    });
  };

  const clear = (): void => {
    totalRecorded = 0;
    samples = [];
  };

  return Object.freeze({ record, snapshot, clear });
};

export const defaultWebVitalsRuntime = createWebVitalsRuntime();
