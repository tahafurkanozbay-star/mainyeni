import { describe, expect, it } from 'vitest';
import type { PerformanceSnapshot } from '../platform/performance/performanceMonitor';
import { createPerformanceBaseline } from './baseline';
import { createPerformanceHistory } from './history';
import { createOperationProfiler } from './operationProfiler';
import { createPerformanceRuntime } from './runtime';
import { createStartupProfiler } from './startupProfiler';

const healthy = (firstRenderMs: number): PerformanceSnapshot => ({
  timestamp: 1,
  startup: {
    firstRenderMs,
    firstContentfulPaintMs: 400,
    ttfbMs: 80,
    domContentLoadedMs: 600,
    loadMs: 800,
  },
  coreWebVitals: {
    lcp: { value: 1_200, rating: 'good' },
    cls: { value: 0.03, rating: 'good' },
    inp: { value: 90, rating: 'good' },
  },
  longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  resources: {
    count: 0,
    transferBytes: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    totalDurationMs: 0,
    zeroTransferCount: 0,
    cacheLikeRatio: null,
  },
  memory: null,
  network: {
    effectiveType: '4g',
    downlinkMbps: 10,
    rttMs: 50,
    saveData: false,
  },
});

describe('performance governance integration', () => {
  it('tracks a known-good baseline and records later regression history', () => {
    let monitor = healthy(300);
    const runtime = createPerformanceRuntime({
      monitor: {
        start: () => true,
        snapshot: () => monitor,
        reset: () => undefined,
      },
      performanceRef: { getEntriesByType: () => [] },
      now: () => 100,
    });
    const history = createPerformanceHistory(4);

    const first = runtime.capture();
    runtime.setBaseline(createPerformanceBaseline(first.report, 'known-good'));
    history.add(first);

    monitor = healthy(1_600);
    const second = runtime.capture();
    history.add(second);

    expect(second.comparison?.regressions.some(item => item.metric === 'firstRender'))
      .toBe(true);
    expect(history.summary()).toMatchObject({
      size: 2,
      readyCount: 2,
      regressionCount: 1,
    });
  });

  it('profiles startup and async work without creating recurring timers', async () => {
    let clock = 0;
    const startup = createStartupProfiler(8, () => clock);
    const operations = createOperationProfiler({
      warningMs: 50,
      blockMs: 100,
      sampleCapacity: 8,
    });

    startup.begin('bootstrap');
    clock = 40;
    expect(startup.end('bootstrap')?.durationMs).toBe(40);

    clock = 0;
    await operations.measure('hydrate', async () => {
      clock = 60;
    }, { now: () => clock });

    expect(operations.snapshot()[0]).toMatchObject({
      name: 'hydrate',
      level: 'warning',
      failures: 0,
      cancellations: 0,
    });
  });

  it('keeps all runtime collections explicitly bounded', () => {
    const history = createPerformanceHistory(2);
    const operations = createOperationProfiler({ sampleCapacity: 2 });
    const startup = createStartupProfiler(2, () => 1);

    for (let index = 0; index < 10; index += 1) {
      operations.record('loop', index);
      startup.mark(`phase-${index}`, index);
      history.add({
        report: {
          ready: true,
          level: 'pass',
          fingerprint: String(index),
        } as never,
        baseline: null,
        comparison: null,
      });
    }

    expect(operations.snapshot()[0]?.count).toBe(2);
    expect(startup.snapshot()).toHaveLength(2);
    expect(history.values()).toHaveLength(2);
  });
});
