import { describe, expect, it } from 'vitest';
import type { WebVitalSample } from '../observability/webVitalsRuntime';
import { createPerformanceBudgetRuntime } from './performanceBudgetRuntime';

const sample = (overrides: Partial<WebVitalSample> = {}): WebVitalSample => ({
  name: 'LCP',
  value: 1_000,
  delta: 10,
  rating: 'good',
  navigationType: 'navigate',
  id: 'sample-1',
  recordedAt: 100,
  ...overrides,
});

const budgets = {
  LCP: { warning: 2_500, critical: 4_000 },
  INP: { warning: 200, critical: 500 },
  CLS: { warning: 0.1, critical: 0.25 },
} as const;

describe('createPerformanceBudgetRuntime', () => {
  it('classifies values below warning as good', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ value: 2_499 })).status).toBe('good');
  });

  it('classifies warning threshold inclusively', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ value: 2_500 })).status).toBe('warning');
  });

  it('classifies critical threshold inclusively', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ value: 4_000 })).status).toBe('critical');
  });

  it('classifies values above critical as critical', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ value: 10_000 })).status).toBe('critical');
  });

  it('marks metrics without configured budget as unbudgeted', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ name: 'FCP' })).status).toBe('unbudgeted');
  });

  it('copies threshold evidence into evaluation', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample())).toMatchObject({
      metric: 'LCP',
      warningThreshold: 2500,
      criticalThreshold: 4000,
      sampleId: 'sample-1',
      recordedAt: 100,
    });
  });

  it('keeps evaluations immutable', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(Object.isFrozen(runtime.evaluate(sample()))).toBe(true);
  });

  it('tracks latest evaluation by metric', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ name: 'LCP', id: 'l1', value: 1000 }));
    runtime.evaluate(sample({ name: 'INP', id: 'i1', value: 100 }));
    runtime.evaluate(sample({ name: 'LCP', id: 'l2', value: 5000 }));
    const snapshot = runtime.snapshot();
    expect(snapshot.latestByMetric.LCP?.sampleId).toBe('l2');
    expect(snapshot.latestByMetric.INP?.sampleId).toBe('i1');
  });

  it('tracks critical and warning counts in the current window', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ value: 1000 }));
    runtime.evaluate(sample({ value: 3000 }));
    runtime.evaluate(sample({ value: 5000 }));
    expect(runtime.snapshot()).toMatchObject({
      criticalCount: 1,
      warningCount: 1,
      healthy: false,
    });
  });

  it('healthy ignores warnings but not criticals', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ value: 3000 }));
    expect(runtime.snapshot().healthy).toBe(true);
    runtime.evaluate(sample({ value: 5000 }));
    expect(runtime.snapshot().healthy).toBe(false);
  });

  it('tracks unbudgeted samples separately', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ name: 'TTFB' }));
    expect(runtime.snapshot().unbudgetedCount).toBe(1);
  });

  it('enforces a bounded rolling evaluation window', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets, windowSize: 5 });
    for (let index = 0; index < 8; index += 1) {
      runtime.evaluate(sample({ id: String(index), value: index }));
    }
    const snapshot = runtime.snapshot();
    expect(snapshot.evaluations).toHaveLength(5);
    expect(snapshot.evaluations.map((item) => item.sampleId)).toEqual(['3', '4', '5', '6', '7']);
    expect(snapshot.totalEvaluated).toBe(8);
  });

  it('clamps tiny windows to five', () => {
    expect(createPerformanceBudgetRuntime({ budgets, windowSize: 1 }).snapshot().windowSize).toBe(5);
  });

  it('clamps huge windows to five hundred', () => {
    expect(createPerformanceBudgetRuntime({ budgets, windowSize: 99_999 }).snapshot().windowSize).toBe(500);
  });

  it('uses a safe default window for invalid values', () => {
    expect(createPerformanceBudgetRuntime({ budgets, windowSize: Number.NaN }).snapshot().windowSize).toBe(60);
  });

  it('rejects negative thresholds', () => {
    expect(() => createPerformanceBudgetRuntime({
      budgets: { LCP: { warning: -1, critical: 4_000 } },
    })).toThrow(/non-negative/i);
  });

  it('rejects non-finite thresholds', () => {
    expect(() => createPerformanceBudgetRuntime({
      budgets: { LCP: { warning: Number.NaN, critical: 4_000 } },
    })).toThrow(/finite/i);
  });

  it('rejects critical thresholds below warning thresholds', () => {
    expect(() => createPerformanceBudgetRuntime({
      budgets: { LCP: { warning: 4_000, critical: 2_500 } },
    })).toThrow(/cannot be lower/i);
  });

  it('rejects non-finite samples', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(() => runtime.evaluate(sample({ value: Number.NaN }))).toThrow(/finite/i);
  });

  it('rejects missing samples', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(() => runtime.evaluate(null as never)).toThrow(/sample/i);
  });

  it('clear resets rolling state and counters', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ value: 5000 }));
    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({
      totalEvaluated: 0,
      evaluations: [],
      criticalCount: 0,
      warningCount: 0,
      healthy: true,
    });
  });

  it('snapshots remain detached from future evaluations', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    runtime.evaluate(sample({ id: 'one' }));
    const first = runtime.snapshot();
    runtime.evaluate(sample({ id: 'two' }));
    expect(first.evaluations.map((item) => item.sampleId)).toEqual(['one']);
    expect(runtime.snapshot().evaluations.map((item) => item.sampleId)).toEqual(['one', 'two']);
  });

  it('supports fractional CLS thresholds exactly', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ name: 'CLS', value: 0.099 })).status).toBe('good');
    expect(runtime.evaluate(sample({ name: 'CLS', value: 0.1 })).status).toBe('warning');
    expect(runtime.evaluate(sample({ name: 'CLS', value: 0.25 })).status).toBe('critical');
  });

  it('supports INP thresholds independently from LCP', () => {
    const runtime = createPerformanceBudgetRuntime({ budgets });
    expect(runtime.evaluate(sample({ name: 'INP', value: 199 })).status).toBe('good');
    expect(runtime.evaluate(sample({ name: 'INP', value: 200 })).status).toBe('warning');
    expect(runtime.evaluate(sample({ name: 'INP', value: 500 })).status).toBe('critical');
  });
});
