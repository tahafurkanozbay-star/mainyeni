import { describe, expect, it, vi } from 'vitest';
import type { PerformanceSnapshot } from '../platform/performance/performanceMonitor';
import { createPerformanceBaseline } from './baseline';
import { createPerformanceRuntime, installPerformanceLifecycleCapture } from './runtime';
import { normalizeWebVitalMetric } from './vitals';

const monitorSnapshot = (): PerformanceSnapshot => ({
  timestamp: 1,
  startup: {
    firstRenderMs: 100,
    firstContentfulPaintMs: 200,
    ttfbMs: 50,
    domContentLoadedMs: 300,
    loadMs: 500,
  },
  coreWebVitals: {
    lcp: { value: 1_000, rating: 'good' },
    cls: { value: 0.02, rating: 'good' },
    inp: { value: 80, rating: 'good' },
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
  network: null,
});

describe('performance runtime', () => {
  it('captures monitor/resource/task/vital evidence without network side effects', () => {
    const start = vi.fn(() => true);
    const runtime = createPerformanceRuntime({
      monitor: {
        start,
        snapshot: monitorSnapshot,
        reset: vi.fn(),
      },
      performanceRef: {
        getEntriesByType: () => [],
      },
      now: () => 1234,
    });

    const vital = normalizeWebVitalMetric({
      name: 'LCP',
      value: 900,
      delta: 20,
      id: 'v1',
      rating: 'good',
      navigationType: 'navigate',
      entries: [],
    }, 100);
    expect(vital).not.toBeNull();
    if (vital) runtime.recordVital(vital);

    const snapshot = runtime.capture();
    expect(start).toHaveBeenCalledOnce();
    expect(snapshot.report.generatedAt).toBe(1234);
    expect(snapshot.report.evidence.vitals.LCP?.value).toBe(900);
    expect(snapshot.report.ready).toBe(true);
  });

  it('compares later captures against an injected baseline', () => {
    let snapshot = monitorSnapshot();
    const runtime = createPerformanceRuntime({
      monitor: {
        start: () => true,
        snapshot: () => snapshot,
        reset: vi.fn(),
      },
      performanceRef: { getEntriesByType: () => [] },
    });

    const first = runtime.capture();
    runtime.setBaseline(createPerformanceBaseline(first.report, 'first'));
    snapshot = {
      ...snapshot,
      startup: {
        ...snapshot.startup,
        firstRenderMs: 1_000,
      },
    };

    const second = runtime.capture();
    expect(second.comparison?.baselineLabel).toBe('first');
    expect(second.comparison?.regressions.some(item => item.metric === 'firstRender')).toBe(true);
  });

  it('resets local evidence and baseline without resetting the shared monitor', () => {
    const monitorReset = vi.fn();
    const runtime = createPerformanceRuntime({
      monitor: {
        start: () => true,
        snapshot: monitorSnapshot,
        reset: monitorReset,
      },
      performanceRef: { getEntriesByType: () => [] },
    });
    runtime.capture();
    runtime.setBaseline(createPerformanceBaseline(runtime.capture().report));
    runtime.reset();
    expect(runtime.getBaseline()).toBeNull();
    expect(runtime.getLastSnapshot()).toBeNull();
    expect(monitorReset).not.toHaveBeenCalled();
  });
});

describe('performance lifecycle capture', () => {
  it('captures on hidden visibility and pagehide and removes listeners on dispose', () => {
    const runtime = {
      recordVital: vi.fn(),
      capture: vi.fn(() => ({ report: {} as never, baseline: null, comparison: null })),
      setBaseline: vi.fn(),
      getBaseline: vi.fn(() => null),
      getLastSnapshot: vi.fn(() => null),
      reset: vi.fn(),
    };
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();

    const documentRef = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: vi.fn((name: string, listener: EventListenerOrEventListenerObject) => {
        documentListeners.set(name, listener as EventListener);
      }),
      removeEventListener: vi.fn((name: string) => {
        documentListeners.delete(name);
      }),
    };
    const windowRef = {
      addEventListener: vi.fn((name: string, listener: EventListenerOrEventListenerObject) => {
        windowListeners.set(name, listener as EventListener);
      }),
      removeEventListener: vi.fn((name: string) => {
        windowListeners.delete(name);
      }),
    };

    const handle = installPerformanceLifecycleCapture(runtime, {
      documentRef,
      windowRef,
    });

    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    windowListeners.get('pagehide')?.(new Event('pagehide'));
    expect(runtime.capture).toHaveBeenCalledTimes(2);

    handle.dispose();
    expect(documentListeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
  });
  it('routes capture observer failures through the explicit lifecycle error boundary', () => {
    const observerError = new Error('observer failed');
    const onCaptureError = vi.fn();
    const runtime = {
      recordVital: vi.fn(),
      capture: vi.fn(() => ({ report: {} as never, baseline: null, comparison: null })),
      setBaseline: vi.fn(),
      getBaseline: vi.fn(() => null),
      getLastSnapshot: vi.fn(() => null),
      reset: vi.fn(),
    };

    const handle = installPerformanceLifecycleCapture(runtime, {
      documentRef: null,
      windowRef: null,
      onCapture() {
        throw observerError;
      },
      onCaptureError,
    });

    expect(() => handle.capture()).not.toThrow();
    expect(onCaptureError).toHaveBeenCalledWith(observerError);
  });

  it('rethrows capture observer failures when no error boundary is configured', () => {
    const runtime = {
      recordVital: vi.fn(),
      capture: vi.fn(() => ({ report: {} as never, baseline: null, comparison: null })),
      setBaseline: vi.fn(),
      getBaseline: vi.fn(() => null),
      getLastSnapshot: vi.fn(() => null),
      reset: vi.fn(),
    };

    const handle = installPerformanceLifecycleCapture(runtime, {
      documentRef: null,
      windowRef: null,
      onCapture() {
        throw new Error('unhandled observer');
      },
    });

    expect(() => handle.capture()).toThrow('unhandled observer');
  });

});
