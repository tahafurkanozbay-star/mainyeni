import { vi } from 'vitest';
import { createPerformanceMonitor, rateWebVital } from './performanceMonitor';
import type { PerformanceMonitorDependencies, PerformanceObserverConstructorLike } from './performanceMonitor';

type TestPerformanceEntry = Readonly<{
  name?: string;
  startTime?: number;
  duration?: number;
  responseStart?: number;
  domContentLoadedEventEnd?: number;
  loadEventEnd?: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  hadRecentInput?: boolean;
  value?: number;
  interactionId?: number;
}>;

type TestObserverList = Readonly<{ getEntries: () => readonly TestPerformanceEntry[] }>;
type ObserverCallback = (list: TestObserverList) => void;

const createObserverHarness = () => {
  const instances: FakePerformanceObserver[] = [];

  class FakePerformanceObserver {
    readonly callback: ObserverCallback;
    options: PerformanceObserverInit | null = null;
    readonly disconnect = vi.fn();

    constructor(callback: ObserverCallback) {
      this.callback = callback;
      instances.push(this);
    }

    observe(options: PerformanceObserverInit): void {
      this.options = options;
    }
  }

  const emit = (type: string, entries: readonly TestPerformanceEntry[]): void => {
    const observer = instances.find((item) => item.options?.type === type);
    if (!observer) throw new Error(`No observer for ${type}`);
    observer.callback({ getEntries: () => entries });
  };

  return {
    FakePerformanceObserver: FakePerformanceObserver as unknown as PerformanceObserverConstructorLike,
    instances,
    emit,
  };
};

type TestPerformanceRef = NonNullable<PerformanceMonitorDependencies['performanceRef']> & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
  setNow(value: number): void;
};

const createPerformance = (): TestPerformanceRef => {
  let now = 100;
  const navigation = {
    responseStart: 45,
    domContentLoadedEventEnd: 800,
    loadEventEnd: 1200
  };
  const paint = [{ name: 'first-contentful-paint', startTime: 620 }];
  const resources = [
    { transferSize: 1000, encodedBodySize: 900, decodedBodySize: 2000, duration: 50 },
    { transferSize: 0, encodedBodySize: 500, decodedBodySize: 1200, duration: 10 }
  ];

  return {
    now: () => now,
    setNow: (value: number) => { now = value; },
    getEntriesByType: vi.fn((type: string): readonly TestPerformanceEntry[] => {
      if (type === 'navigation') return [navigation];
      if (type === 'paint') return paint;
      if (type === 'resource') return resources;
      return [];
    }),
    memory: {
      usedJSHeapSize: 25_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 100_000_000
    }
  };
};

describe('rateWebVital', () => {
  test.each([
    ['lcp', 2500, 'good'],
    ['lcp', 2501, 'needs-improvement'],
    ['lcp', 4000, 'needs-improvement'],
    ['lcp', 4001, 'poor'],
    ['cls', 0.1, 'good'],
    ['cls', 0.11, 'needs-improvement'],
    ['cls', 0.25, 'needs-improvement'],
    ['cls', 0.251, 'poor'],
    ['inp', 200, 'good'],
    ['inp', 201, 'needs-improvement'],
    ['inp', 500, 'needs-improvement'],
    ['inp', 501, 'poor']
  ])('%s %p => %s', (name, value, rating) => {
    expect(rateWebVital(name, value)).toBe(rating);
  });

  test.each([
    ['unknown', 1],
    ['lcp', null],
    ['inp', undefined],
    ['cls', Number.NaN]
  ])('returns unknown for unsupported or missing %p %p', (name, value) => {
    expect(rateWebVital(name, value)).toBe('unknown');
  });
});

describe('performance monitor startup and navigation', () => {
  test('collects existing navigation and paint timing', () => {
    const performanceRef = createPerformance();
    const { FakePerformanceObserver } = createObserverHarness();
    const monitor = createPerformanceMonitor({ performanceRef, PerformanceObserverRef: FakePerformanceObserver });

    expect(monitor.start()).toBe(true);
    const snapshot = monitor.snapshot();

    expect(snapshot.startup).toMatchObject({
      firstContentfulPaintMs: 620,
      ttfbMs: 45,
      domContentLoadedMs: 800,
      loadMs: 1200
    });
  });

  test('start is idempotent until stopped', () => {
    const { FakePerformanceObserver, instances } = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: FakePerformanceObserver
    });

    expect(monitor.start()).toBe(true);
    const observerCount = instances.length;
    expect(monitor.start()).toBe(false);
    expect(instances).toHaveLength(observerCount);
    expect(monitor.isStarted()).toBe(true);
  });

  test('markRenderComplete measures from monitor start once', () => {
    const performanceRef = createPerformance();
    const { FakePerformanceObserver } = createObserverHarness();
    const monitor = createPerformanceMonitor({ performanceRef, PerformanceObserverRef: FakePerformanceObserver });
    monitor.start();
    performanceRef.setNow(350);

    expect(monitor.markRenderComplete()).toBe(250);
    performanceRef.setNow(900);
    expect(monitor.markRenderComplete()).toBe(250);
    expect(monitor.snapshot().startup.firstRenderMs).toBe(250);
  });
});

describe('performance monitor Core Web Vitals', () => {
  test('keeps the latest largest contentful paint', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();

    harness.emit('largest-contentful-paint', [
      { startTime: 1200 },
      { startTime: 2300 }
    ]);
    harness.emit('largest-contentful-paint', [{ startTime: 1800 }]);

    expect(monitor.snapshot().coreWebVitals.lcp).toEqual({
      value: 2300,
      rating: 'good'
    });
  });

  test('accumulates layout shift excluding recent input', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();

    harness.emit('layout-shift', [
      { value: 0.05, hadRecentInput: false },
      { value: 0.2, hadRecentInput: true },
      { value: 0.03, hadRecentInput: false }
    ]);

    expect(monitor.snapshot().coreWebVitals.cls).toEqual({
      value: 0.08,
      rating: 'good'
    });
  });

  test('tracks worst interaction duration as INP approximation', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();

    harness.emit('event', [
      { interactionId: 1, duration: 120 },
      { interactionId: 2, duration: 275 },
      { interactionId: 0, duration: 900 }
    ]);

    expect(monitor.snapshot().coreWebVitals.inp).toEqual({
      value: 275,
      rating: 'needs-improvement'
    });
  });

  test('reports missing LCP and INP as unknown', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();
    const vitals = monitor.snapshot().coreWebVitals;
    expect(vitals.lcp).toEqual({ value: null, rating: 'unknown' });
    expect(vitals.inp).toEqual({ value: null, rating: 'unknown' });
  });
});

describe('performance monitor long tasks and resources', () => {
  test('aggregates long task count, total and max duration', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();

    harness.emit('longtask', [{ duration: 60 }, { duration: 140 }, { duration: 50 }]);

    expect(monitor.snapshot().longTasks).toEqual({
      count: 3,
      totalDurationMs: 250,
      maxDurationMs: 140
    });
  });

  test('aggregates transfer, encoded, decoded and zero-transfer resource counts', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();

    harness.emit('resource', [
      { transferSize: 1000, encodedBodySize: 900, decodedBodySize: 2000, duration: 50 },
      { transferSize: 0, encodedBodySize: 500, decodedBodySize: 1200, duration: 10 }
    ]);

    expect(monitor.snapshot().resources).toEqual({
      count: 2,
      transferBytes: 1000,
      encodedBytes: 1400,
      decodedBytes: 3200,
      totalDurationMs: 60,
      zeroTransferCount: 1,
      cacheLikeRatio: 0.5
    });
  });
});

describe('performance monitor memory and network', () => {
  test('captures coarse optional heap and connection information', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver,
      navigatorRef: {
        connection: {
          effectiveType: '4g',
          downlink: 10,
          rtt: 50,
          saveData: false
        }
      }
    });
    monitor.start();

    const snapshot = monitor.snapshot();
    expect(snapshot.memory).toEqual({
      usedBytes: 25_000_000,
      totalBytes: 50_000_000,
      limitBytes: 100_000_000,
      utilization: 0.25
    });
    expect(snapshot.network).toEqual({
      effectiveType: '4g',
      downlinkMbps: 10,
      rttMs: 50,
      saveData: false
    });
  });

  test('returns null for unsupported optional APIs', () => {
    const performanceRef = createPerformance();
    delete performanceRef.memory;
    const monitor = createPerformanceMonitor({
      performanceRef,
      PerformanceObserverRef: null,
      navigatorRef: {}
    });
    monitor.start();
    expect(monitor.snapshot().memory).toBeNull();
    expect(monitor.snapshot().network).toBeNull();
  });
});

describe('performance monitor observer resilience', () => {
  test('unsupported entry types never block startup', () => {
    const instances: PartialObserver[] = [];
    class PartialObserver {
      readonly callback: ObserverCallback;
      readonly disconnect = vi.fn();
      type: string | undefined;

      constructor(callback: ObserverCallback) {
        this.callback = callback;
        instances.push(this);
      }

      observe(options: PerformanceObserverInit): void {
        if (options.type === 'event' || options.type === 'longtask') {
          throw new Error('unsupported');
        }
        this.type = options.type;
      }
    }

    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: PartialObserver as unknown as PerformanceObserverConstructorLike
    });

    expect(() => monitor.start()).not.toThrow();
    expect(monitor.isStarted()).toBe(true);
  });

  test('stop disconnects all supported observers and allows restart', () => {
    const harness = createObserverHarness();
    const monitor = createPerformanceMonitor({
      performanceRef: createPerformance(),
      PerformanceObserverRef: harness.FakePerformanceObserver
    });
    monitor.start();
    const initialObservers = [...harness.instances];

    monitor.stop();
    initialObservers.forEach((observer) => expect(observer.disconnect).toHaveBeenCalledTimes(1));
    expect(monitor.isStarted()).toBe(false);
    expect(monitor.start()).toBe(true);
  });
});
