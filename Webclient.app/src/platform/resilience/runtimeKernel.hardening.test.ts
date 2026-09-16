import { createRuntimeConfig } from '../config/runtimeConfig';
import { createRuntimeHealthMonitor } from '../observability/runtimeHealth';
import { createRuntimeKernel } from './runtimeKernel';

const createPerformanceStub = () => {
  let started = false;
  const snapshot = Object.freeze({
    timestamp: 1,
    startup: Object.freeze({
      firstRenderMs: null,
      firstContentfulPaintMs: null,
      ttfbMs: null,
      domContentLoadedMs: null,
      loadMs: null
    }),
    coreWebVitals: Object.freeze({
      lcp: Object.freeze({ value: null, rating: 'unknown' }),
      cls: Object.freeze({ value: 0, rating: 'good' }),
      inp: Object.freeze({ value: null, rating: 'unknown' })
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

  return {
    start: jest.fn(() => {
      if (started) return false;
      started = true;
      return true;
    }),
    stop: jest.fn(() => { started = false; }),
    markRenderComplete: jest.fn(() => 0),
    snapshot: jest.fn(() => snapshot),
    budget: jest.fn(),
    isStarted: jest.fn(() => started)
  };
};

const config = () => createRuntimeConfig({
  REACT_APP_API_URL: '/api',
  REACT_APP_API_TIMEOUT_MS: '1000',
  REACT_APP_API_CACHE_TTL_MS: '5000',
  REACT_APP_API_MAX_RETRIES: '2',
  REACT_APP_ENV: 'test',
  REACT_APP_VERSION: 'hardening-test'
});

const kernelFactory = (overrides = {}) => createRuntimeKernel({
  config: config(),
  performanceMonitor: createPerformanceStub(),
  ...overrides
});

describe('RuntimeKernel hardening contracts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('enforces timeout even when an operation ignores AbortSignal', async () => {
    jest.useFakeTimers();
    const kernel = kernelFactory();
    kernel.start();

    const operation = jest.fn(() => new Promise(() => undefined));
    const pending = kernel.executeResilient('slow-service', operation, {
      domain: 'http',
      operation: 'load-slow-data',
      timeoutMs: 100
    });

    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(100);
    await expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 408,
      retryable: true
    });
    expect(kernel.breakers.snapshot()['slow-service']).toMatchObject({
      failureCount: 1,
      state: 'closed'
    });

    await kernel.stop();
  });

  test('caller abort is distinguishable from timeout and does not count as failure', async () => {
    const kernel = kernelFactory();
    kernel.start();
    const caller = new AbortController();

    const pending = kernel.executeResilient('abortable-service', () => new Promise(() => undefined), {
      signal: caller.signal,
      operation: 'caller-owned-operation'
    });
    caller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false
    });
    expect(kernel.breakers.snapshot()['abortable-service']).toMatchObject({
      failureCount: 0,
      state: 'closed'
    });
    await kernel.stop();
  });

  test('disposing a session also removes its parent ownership lease', async () => {
    const kernel = kernelFactory();
    kernel.start();
    const session = kernel.createSession('temporary-query');
    const cleanup = jest.fn();
    session.register(cleanup, 'watch-handle');

    expect(kernel.snapshot().resources.active).toBe(1);
    expect(session.supervisor.snapshot().active).toBe(1);
    await session.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(kernel.snapshot().resources.active).toBe(0);
    expect(session.supervisor.snapshot().active).toBe(0);
    await kernel.stop();
  });

  test('health monitor exceptions never replace a successful business result', async () => {
    const health = createRuntimeHealthMonitor();
    health.record = jest.fn(() => {
      throw new Error('health sink unavailable');
    });
    const kernel = kernelFactory({ health });
    expect(() => kernel.start()).not.toThrow();

    await expect(kernel.executeResilient('healthy-operation', () => Promise.resolve({ ok: true }), {
      domain: 'runtime',
      operation: 'safe-result'
    })).resolves.toEqual({ ok: true });

    await kernel.stop();
  });

  test('health monitor exceptions never replace the original business failure', async () => {
    const health = createRuntimeHealthMonitor();
    health.record = jest.fn(() => {
      throw new Error('health sink unavailable');
    });
    const kernel = kernelFactory({ health });
    kernel.start();
    const businessError = new Error('domain failure');

    await expect(kernel.executeResilient('failing-operation', () => Promise.reject(businessError), {
      domain: 'runtime',
      operation: 'failing-result'
    })).rejects.toBe(businessError);

    await kernel.stop();
  });

  test('session labels and operation metadata remove query and fragment material', async () => {
    const health = createRuntimeHealthMonitor();
    const kernel = kernelFactory({ health });
    kernel.start();
    const session = kernel.createSession('/api/query?token=private#fragment');
    expect(session.label).toBe('/api/query');

    await kernel.executeResilient('/api/query?tenant=1', () => 'done', {
      domain: 'query runtime',
      operation: '/api/query?token=private#fragment'
    });

    const event = health.snapshot({ domain: 'query-runtime' }).latest.at(-1);
    expect(event?.metadata.operation).toBe('/api/query');
    expect(Object.keys(kernel.breakers.snapshot())).toEqual(['/api/query']);

    await session.dispose();
    await kernel.stop();
  });
});
