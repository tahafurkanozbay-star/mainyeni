import type { Metric } from 'web-vitals';
import type {
  CoreVitalName,
  WebVitalMeasurement,
} from './contracts';
import {
  finiteNumber,
  normalizeNavigationType,
  normalizeVitalName,
  normalizeVitalRating,
  safeText,
} from './normalization';

export type VitalListener = (measurement: WebVitalMeasurement) => void;

export const normalizeWebVitalMetric = (
  metric: Partial<Metric> | null | undefined,
  recordedAt = Date.now(),
): WebVitalMeasurement | null => {
  if (!metric) return null;
  const name = normalizeVitalName(metric.name);
  const value = finiteNumber(metric.value, null);
  if (!name || value === null) return null;

  return Object.freeze({
    name,
    value,
    delta: finiteNumber(metric.delta, 0) ?? 0,
    id: safeText(metric.id, 120),
    rating: normalizeVitalRating(metric.rating),
    navigationType: normalizeNavigationType(metric.navigationType),
    recordedAt,
  });
};

export interface WebVitalsRegistration {
  readonly stop: () => void;
  readonly active: () => boolean;
}

export const registerWebVitals = (
  listener: VitalListener,
  now: () => number = Date.now,
): WebVitalsRegistration => {
  let enabled = typeof listener === 'function';

  if (enabled) {
    void import('web-vitals')
      .then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
        if (!enabled) return;
        const forward = (metric: Metric): void => {
          if (!enabled) return;
          const normalized = normalizeWebVitalMetric(metric, now());
          if (normalized) listener(normalized);
        };
        onCLS(forward);
        onFCP(forward);
        onINP(forward);
        onLCP(forward);
        onTTFB(forward);
      })
      .catch(() => {
        // Optional runtime metrics must never prevent application startup.
      });
  }

  return Object.freeze({
    stop() {
      enabled = false;
    },
    active: () => enabled,
  });
};

export const latestVitalMap = (
  measurements: readonly WebVitalMeasurement[],
): Readonly<Partial<Record<CoreVitalName, WebVitalMeasurement>>> => {
  const result: Partial<Record<CoreVitalName, WebVitalMeasurement>> = {};
  for (const measurement of measurements) {
    const existing = result[measurement.name];
    if (!existing || measurement.recordedAt >= existing.recordedAt) {
      result[measurement.name] = measurement;
    }
  }
  return Object.freeze(result);
};
