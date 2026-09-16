import { createRuntimeConfig } from '../config/runtimeConfig';
import { createRuntimeHealthMonitor } from '../observability/runtimeHealth';
import { createRuntimeKernel } from './runtimeKernel';

const emptyPerformanceSnapshot = () => Object.freeze({
  timestamp: 1000,
  startup: Object.freeze({
    firstRenderMs: 25,
    firstContentfulPaintMs: 100,
    ttfbMs: 50,
    domContentLoadedMs: 200,
    loadMs: 250
  }),
  coreWebVitals: Object.freeze({
    lcp: Object.freeze({ value: 1200, rating: 'good' }),
    cls: Object.freeze({ value: 0.02, rating: 'good' }),
    inp: Object.freeze({ value: 80, rating: 'good' })
  }),
  longTasks: Object.freeze({ count: 0, totalDurationMs: 0, maxDurationMs: 0 }),
  resources: Object.freeze({
    count: 0,
    transferBytes: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    totalDurationMs: 0,
    zeroTransferCount: 0,
    cacheLikeRatio: null
  }),
  memory: null,
  network: null
});

const createFakePerformanceMonitor = (snapshot = emptyPerformanceSnapshot()) => {
  let started = false;
  return {
    start: jest.fn(() => {
      if (started) return false;
      started = true;
      return true;
    }),
    stop: jest.fn(() => { started = false; }),
    markRenderComplete: jest.fn(() => 25),
    snapshot: jest.fn(() => snapshot),
    budget: jest.fn(),
    isStarted: jest.fn(() => started)
  };
};

const createKernel = (overrides = {}) => {
  let now = 1000;
  const clock = () => now;
  const health = createRuntimeHealthMonitor({ clock });
  const performanceMonitor = createFakePerformanceMonitor();
  const config = createRuntimeConfig({
    REACT_APP_API_URL: '/api',
    REACT_APP_API_TIMEOUT_MS: '2000',
    REACT_APP_API_CACHE_TTL_MS: '5000',
    REACT_APP_API_MAX_RETRIES: '2',
    REACT_APP_ENV: 'test',
    REACT_APP_VERSION: 'test-release',
    REACT_APP_PERFORMANCE_BUDGET_PROFILE: 'balanced'
  });
  const kernel = createRuntimeKernel({
    config,
    health,
    performanceMonitor,
    clock,
    ...overrides
  });
  return {
    kernel,
    health,
    performanceMonitor,
    advance: (duration) => { now += duration; }
  };
};

describe('RuntimeKernel lifecycle', () => {
  test('starts once and publishes a bounded local snapshot', () => {
    const { kernel, performanceMonitor } = createKernel();
    expect(kernel.start()).toBe(true);
    expect(kernel.start()).toBe(false);
    expect(performanceMonitor.start).toHaveBeenCalledTimes(1);

    const snapshot = kernel.snapshot();
    expect(snapshot).toMatchObject({
      state: 'running',
      sessions: 0,
      offlineEntries: 0,
      config: {
        environment: 'test',
        release: 'test-release',
        apiBaseUrl: '/api',
        performanceBudgetProfile: 'balanced'
      }
    });
    expect(snapshot.budget.maxConcurrentRequests).toBeGreaterThanOrEqual(2);
    expect(snapshot.health.status).toBe('healthy');
  });

  test('cannot create a session before start', () => {
    const { kernel } = createKernel();
    expect(() => kernel.createSession('query')).toThrow('çalışan kernel');
  });

  test('owns session AbortSignal and disposes registered resources', async () => {
    const { kernel, advance } = createKernel();
    kernel.start();
    const cleanup = jest.fn();
    const session = kernel.createSession('query?token=secret');
    session.register(cleanup, 'watcher');
    expect(session.label).toBe('query');
    expect(session.signal.aborted).toBe(false);
    expect(kernel.snapshot().sessions).toBe(1);

    advance(50);
    await expect(session.dispose()).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(session.signal.aborted).toBe(true);
    expect(session.disposed).toBe(true);
    expect(kernel.snapshot().sessions).toBe(0);
    await expect(session.dispose()).resolves.toBe(false);
  });

  test('kernel stop aborts all sessions and clears bounded stores', async () => {
    const { kernel, performanceMonitor } = createKernel();
    kernel.start();
    const first = kernel.createSession('first');
    const second = kernel.createSession('second');
    kernel.cache.set('public-config', { value: 1 });
    kernel.offlineStore.set('shell', { html: true }, 10000);

    await expect(kernel.stop()).resolves.toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(kernel.snapshot()).toMatchObject({
      state: 'stopped',
      sessions: 0,
      offlineEntries: 0,
      cache: { size: 0 }
    });
    expect(performanceMonitor.stop).toHaveBeenCalledTimes(1);
    await expect(kernel.stop()).resolves.toBe(false);
  });

  test('stopped kernel is fail-closed and cannot be restarted', async () => {
    const { kernel } = createKernel();
    kernel.start();
    await kernel.stop();
    expect(() => kernel.start()).toThrow('yeniden başlatılamaz');
    await expect(kernel.executeResilient('api', () => 'nope')).rejects.toThrow('çalışmıyor');
  });
});

describe('RuntimeKernel resilient execution', () => {
  test('records successful operations without leaking operation URLs', async () => {
    const { kernel, health, advance } = createKernel();
    kernel.start();
    const result = kernel.executeResilient('/api/layers?token=secret', async (signal) => {
      expect(signal.aborted).toBe(false);
      advance(20);
      return { ok: true };
    }, {
      domain: 'http',
      operation: '/api/layers?token=secret'
    });
    await expect(result).resolves.toEqual({ ok: true });
    const snapshot = health.snapshot({ domain: 'http' });
    expect(snapshot.latest[snapshot.latest.length - 1]).toMatchObject({
      code: 'operation-success',
      metadata: { operation: '/api/layers', durationMs: 20 }
    });
  });

  test('feeds retryable failures into named circuit breaker state', async () => {
    const { kernel } = createKernel();
    kernel.start();
    for (let index = 0; index < 5; index += 1) {
      await expect(kernel.executeResilient('service-a', () => Promise.reject(new Error('down'))))
        .rejects.toThrow('down');
    }
    expect(kernel.breakers.snapshot()['service-a']).toMatchObject({ state: 'open' });
    await expect(kernel.executeResilient('service-a', () => Promise.resolve('blocked')))
      .rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });

  test('caller cancellation returns stable ABORTED error and does not poison the circuit', async () => {
    const { kernel } = createKernel();
    kernel.start();
    const controller = new AbortController();
    controller.abort();

    await expect(kernel.executeResilient('service-b', (signal) => {
      if (signal.aborted) return Promise.reject({ name: 'AbortError' });
      return Promise.resolve('unexpected');
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
    expect(kernel.breakers.snapshot()['service-b']).toMatchObject({ state: 'closed', failureCount: 0 });
  });

  test('operation labels are normalized before health storage', async () => {
    const { kernel, health } = createKernel();
    kernel.start();
    await kernel.executeResilient('safe', () => 'ok', {
      domain: 'custom domain',
      operation: 'load config?secret=value#fragment'
    });
    const snapshot = health.snapshot({ domain: 'custom-domain' });
    expect(snapshot.latest[0].metadata.operation).toBe('load-config');
  });

  test('monitoring failures do not replace the business error', async () => {
    const health = createRuntimeHealthMonitor();
    health.warn = jest.fn(() => { throw new Error('monitor failure'); });
    const { kernel } = createKernel({ health });
    kernel.start();
    await expect(kernel.executeResilient('business', () => Promise.reject(new Error('business error'))))
      .rejects.toThrow('business error');
  });
});

describe('RuntimeKernel performance and offline policy', () => {
  test('refreshBudget degrades under explicit constrained sample', () => {
    const { kernel } = createKernel();
    kernel.start();
    const budget = kernel.refreshBudget({
      hardwareConcurrency: 2,
      deviceMemoryGb: 2,
      effectiveType: '2g',
      saveData: true,
      heapUtilization: 0.95,
      longTaskCount: 30,
      longTaskMaxMs: 600
    });
    expect(budget.pressure).toBe('critical');
    expect(budget.prefetchEnabled).toBe(false);
    expect(budget.animationEnabled).toBe(false);
    expect(kernel.snapshot().health.status).toBe('degraded');
  });

  test('keeps authenticated GIS payloads network-only even when cacheable is requested', () => {
    const { kernel } = createKernel();
    kernel.start();
    expect(kernel.offlineDecision({
      method: 'GET',
      url: '/api/features',
      authenticated: true,
      cacheable: true,
      online: true
    })).toMatchObject({
      strategy: 'network-only',
      allowCacheRead: false,
      allowCacheWrite: false,
      allowNetwork: true
    });
  });

  test('denies mutations while offline', () => {
    const { kernel } = createKernel();
    kernel.start();
    expect(kernel.offlineDecision({
      method: 'POST',
      url: '/api/update',
      online: false
    })).toMatchObject({
      strategy: 'deny',
      allowNetwork: false,
      allowCacheRead: false,
      allowCacheWrite: false
    });
  });

  test('permits only bounded explicit nonsensitive GIS cache', () => {
    const { kernel } = createKernel();
    kernel.start();
    const noOptIn = kernel.offlineDecision({
      method: 'GET',
      url: '/api/public-features',
      online: true
    });
    const optIn = kernel.offlineDecision({
      method: 'GET',
      url: '/api/public-features',
      online: true,
      cacheable: true
    });
    expect(noOptIn.strategy).toBe('network-only');
    expect(optIn).toMatchObject({
      strategy: 'stale-while-revalidate',
      allowCacheRead: true,
      allowCacheWrite: true,
      maxAgeMs: 60000
    });
  });
});
