import { describe, expect, it } from 'vitest';
import type { Metric } from 'web-vitals';
import { createWebVitalsRuntime } from './webVitalsRuntime';

const metric = (overrides: Partial<Metric> = {}): Metric => ({
  name: 'LCP', value: 1200, rating: 'good', delta: 100, id: 'v1',
  navigationType: 'navigate', entries: [], ...overrides,
} as Metric);

describe('createWebVitalsRuntime', () => {
  it('records supported metrics immutably', () => {
    const runtime = createWebVitalsRuntime({ now: () => 10 });
    const sample = runtime.record(metric());
    expect(sample).toMatchObject({ name: 'LCP', value: 1200, delta: 100, recordedAt: 10 });
    expect(Object.isFrozen(sample)).toBe(true);
  });
  it('keeps a bounded FIFO history', () => {
    let now = 0;
    const runtime = createWebVitalsRuntime({ capacity: 5, now: () => ++now });
    for (let index = 0; index < 8; index += 1) runtime.record(metric({ id: String(index), value: index }));
    const snapshot = runtime.snapshot();
    expect(snapshot.samples.map((item) => item.id)).toEqual(['3', '4', '5', '6', '7']);
    expect(snapshot.dropped).toBe(3);
  });
  it('tracks latest metric samples', () => {
    const runtime = createWebVitalsRuntime();
    runtime.record(metric({ name: 'LCP', id: 'one' }));
    runtime.record(metric({ name: 'CLS', id: 'cls', value: 0.1 }));
    runtime.record(metric({ name: 'LCP', id: 'two' }));
    expect(runtime.snapshot().latestByMetric.LCP?.id).toBe('two');
    expect(runtime.snapshot().latestByMetric.CLS?.id).toBe('cls');
  });
  it('rejects non-finite values and unknown metrics', () => {
    const runtime = createWebVitalsRuntime();
    expect(runtime.record(metric({ value: Number.NaN }))).toBeNull();
    expect(runtime.record(metric({ name: 'FID' as Metric['name'] }))).toBeNull();
    expect(runtime.snapshot().totalRecorded).toBe(0);
  });
  it('clears bounded history', () => {
    const runtime = createWebVitalsRuntime();
    runtime.record(metric());
    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({ totalRecorded: 0, dropped: 0, samples: [] });
  });
  it('clamps capacity', () => {
    expect(createWebVitalsRuntime({ capacity: 1 }).snapshot().capacity).toBe(5);
    expect(createWebVitalsRuntime({ capacity: 9999 }).snapshot().capacity).toBe(500);
  });
});
