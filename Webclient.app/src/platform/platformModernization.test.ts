import { AppError, getSafeErrorMessage, isAbortError, isTimeoutError, normalizeAxiosError } from './errors/appError';
import { createRequestCache } from './cache/requestCache';
import { createRuntimeConfig, normalizeApiBaseUrl, validateRuntimeConfig } from './config/runtimeConfig';
import { createRuntimeSupervisor } from './lifecycle/runtimeSupervisor';
import { decideOfflineStrategy, createOfflineMemoryStore } from './offline/offlinePolicy';
import { deriveRuntimeBudget, mergeRuntimeCapabilitySamples, shouldDegradeRuntime } from './performance/runtimeBudget';
import { createRuntimeHealthMonitor, healthStatusFrom } from './observability/runtimeHealth';

describe('Platform strict TypeScript runtime modernization', () => {
  describe('typed AppError contract', () => {
    test('normalizes authentication, timeout and server failures without exposing raw bodies', () => {
      expect(normalizeAxiosError({ response: { status: 401, data: { message: 'raw' } } })).toMatchObject({
        code: 'UNAUTHORIZED',
        retryable: false,
        status: 401
      });
      expect(normalizeAxiosError({ code: 'ECONNABORTED', message: 'timeout' })).toMatchObject({
        code: 'TIMEOUT',
        retryable: true
      });
      expect(normalizeAxiosError({ response: { status: 503, data: { password: 'secret' } } })).toMatchObject({
        code: 'SERVER_ERROR',
        retryable: true,
        status: 503
      });
    });

    test('distinguishes caller cancellation from timeout', () => {
      expect(isAbortError({ name: 'AbortError' })).toBe(true);
      expect(isAbortError({ code: 'ECONNABORTED', message: 'cancelled by caller' })).toBe(true);
      expect(isTimeoutError({ code: 'ECONNABORTED', message: 'timeout' })).toBe(true);
      expect(isTimeoutError({ code: 'ECONNABORTED', message: 'cancelled' })).toBe(false);
    });

    test('returns safe UI messages only for AppError instances', () => {
      expect(getSafeErrorMessage(new AppError('safe'))).toBe('safe');
      expect(getSafeErrorMessage(new Error('internal'), 'fallback')).toBe('fallback');
    });
  });

  describe('runtime configuration', () => {
    test('keeps application API same-origin and rejects protocol-relative input', () => {
      expect(normalizeApiBaseUrl('/api/')).toBe('/api');
      expect(normalizeApiBaseUrl('//evil.example/api')).toBe('/api');
      expect(normalizeApiBaseUrl('javascript:alert(1)')).toBe('/api');
    });

    test('bounds numeric configuration and parses feature switches', () => {
      const config = createRuntimeConfig({
        REACT_APP_API_TIMEOUT_MS: '999999',
        REACT_APP_API_CACHE_TTL_MS: '-50',
        REACT_APP_API_MAX_RETRIES: '12',
        REACT_APP_DIAGNOSTICS_ENABLED: 'false',
        REACT_APP_OFFLINE_ENABLED: 'yes',
        REACT_APP_PERFORMANCE_BUDGET_PROFILE: 'aggressive'
      });
      expect(config.requestTimeoutMs).toBe(60000);
      expect(config.cacheTtlMs).toBe(0);
      expect(config.maxRetries).toBe(4);
      expect(config.diagnosticsEnabled).toBe(false);
      expect(config.offlineEnabled).toBe(true);
      expect(config.performanceBudgetProfile).toBe('aggressive');
      expect(validateRuntimeConfig(config).valid).toBe(true);
    });

    test('falls back on control-character polluted configuration', () => {
      expect(normalizeApiBaseUrl('\n/api')).toBe('/api');
      expect(normalizeApiBaseUrl('/api\rheader')).toBe('/api');
    });
  });

  describe('bounded request cache', () => {
    test('implements TTL and LRU eviction with deterministic statistics', () => {
      let now = 1000;
      const cache = createRequestCache({ ttlMs: 50, maxEntries: 2, clock: () => now });
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      cache.set('c', 3);
      expect(cache.peek('b')).toBeUndefined();
      expect(cache.peek('a')).toBe(1);
      now += 60;
      expect(cache.get('a')).toBeUndefined();
      expect(cache.snapshot()).toMatchObject({ evictions: 1, expirations: 1, size: 0 });
    });

    test('invalidates explicit namespaces without scanning caller data', () => {
      const cache = createRequestCache({ ttlMs: 1000 });
      cache.set('/api/layers:1', { id: 1 });
      cache.set('/api/layers:2', { id: 2 });
      cache.set('/api/config', { id: 3 });
      expect(cache.invalidatePrefix('/api/layers')).toBe(2);
      expect(cache.size()).toBe(1);
    });
  });

  describe('runtime supervisor', () => {
    test('owns resources and disposes in LIFO order', async () => {
      const order = [];
      const supervisor = createRuntimeSupervisor();
      supervisor.register(() => order.push('first'), { label: 'first' });
      supervisor.register(() => order.push('second'), { label: 'second' });
      expect(supervisor.snapshot().active).toBe(2);
      await supervisor.disposeAll();
      expect(order).toEqual(['second', 'first']);
      expect(supervisor.snapshot()).toMatchObject({ active: 0, disposed: 2 });
    });

    test('aborts tracked controllers and prevents new resources after close', async () => {
      const supervisor = createRuntimeSupervisor();
      const tracked = supervisor.trackAbortController(undefined, 'query-session');
      expect(tracked.controller.signal.aborted).toBe(false);
      await supervisor.close();
      expect(tracked.controller.signal.aborted).toBe(true);
      expect(() => supervisor.register(() => undefined)).toThrow('closed');
    });

    test('isolates cleanup failures and records them', async () => {
      const errors = [];
      const supervisor = createRuntimeSupervisor({ onError: (error, context) => errors.push({ error, context }) });
      supervisor.register(() => { throw new Error('dispose failed'); }, { label: 'bad' });
      await supervisor.disposeAll();
      expect(supervisor.snapshot().failedDisposals).toBe(1);
      expect(errors).toHaveLength(1);
    });
  });

  describe('offline policy', () => {
    test('never persists authenticated or sensitive API data', () => {
      expect(decideOfflineStrategy({
        method: 'GET',
        url: '/api/features',
        authenticated: true,
        cacheable: true
      })).toMatchObject({
        strategy: 'network-only',
        allowCacheRead: false,
        allowCacheWrite: false
      });
    });

    test('requires explicit opt-in for nonsensitive GIS payload caching', () => {
      expect(decideOfflineStrategy({ method: 'GET', url: '/api/features' }).strategy).toBe('network-only');
      expect(decideOfflineStrategy({ method: 'GET', url: '/api/features', cacheable: true }).strategy)
        .toBe('stale-while-revalidate');
    });

    test('allows bounded application-shell and public configuration cache behavior', () => {
      expect(decideOfflineStrategy({ method: 'GET', url: '/index.html' }).strategy).toBe('network-first');
      expect(decideOfflineStrategy({ method: 'GET', url: '/assets/app.js' }).strategy).toBe('cache-first');
      expect(decideOfflineStrategy({ method: 'GET', url: '/api/configuration/public' }).strategy).toBe('network-first');
    });

    test('bounded offline memory store expires and evicts entries', () => {
      let now = 10;
      const store = createOfflineMemoryStore({ maxEntries: 2, clock: () => now });
      store.set('a', 1, 100);
      store.set('b', 2, 100);
      store.set('c', 3, 100);
      expect(store.get('a')).toBeUndefined();
      expect(store.size()).toBe(2);
      now = 200;
      expect(store.prune()).toBe(2);
    });
  });

  describe('adaptive runtime budget', () => {
    test('degrades concurrency and render budget under constrained conditions', () => {
      const budget = deriveRuntimeBudget({
        hardwareConcurrency: 2,
        deviceMemoryGb: 2,
        effectiveType: '2g',
        saveData: true,
        heapUtilization: 0.92,
        longTaskCount: 25,
        longTaskMaxMs: 500
      });
      expect(budget.pressure).toBe('critical');
      expect(budget.maxConcurrentRequests).toBeLessThanOrEqual(3);
      expect(budget.prefetchEnabled).toBe(false);
      expect(budget.animationEnabled).toBe(false);
      expect(shouldDegradeRuntime(budget)).toBe(true);
    });

    test('keeps capable devices responsive without unbounded budgets', () => {
      const budget = deriveRuntimeBudget({
        hardwareConcurrency: 16,
        deviceMemoryGb: 16,
        effectiveType: '4g',
        downlinkMbps: 100,
        rttMs: 20
      }, 'aggressive');
      expect(budget.pressure).toBe('low');
      expect(budget.maxConcurrentRequests).toBeLessThanOrEqual(12);
      expect(budget.maxVisibleFeatures).toBeLessThanOrEqual(30000);
      expect(budget.prefetchEnabled).toBe(true);
    });

    test('merges partial capability samples without replacing known values with null', () => {
      expect(mergeRuntimeCapabilitySamples(
        { hardwareConcurrency: 8, effectiveType: '4g' },
        { hardwareConcurrency: null, deviceMemoryGb: 8 }
      )).toEqual({ hardwareConcurrency: 8, effectiveType: '4g', deviceMemoryGb: 8 });
    });
  });

  describe('local health monitor', () => {
    test('redacts sensitive metadata and strips URL query strings', () => {
      const monitor = createRuntimeHealthMonitor();
      const event = monitor.warn('http', 'retry', {
        authorization: 'Bearer secret',
        endpointUrl: '/api/layers?token=secret',
        attempts: 2
      });
      expect(event.metadata.authorization).toBe('[redacted]');
      expect(event.metadata.endpointUrl).toBe('/api/layers');
      expect(event.metadata.attempts).toBe(2);
    });

    test('computes bounded health state and dropped counts', () => {
      const monitor = createRuntimeHealthMonitor({ capacity: 20 });
      for (let index = 0; index < 25; index += 1) {
        monitor.info('bootstrap', 'stage', { index });
      }
      monitor.critical('runtime', 'invariant');
      const snapshot = monitor.snapshot();
      expect(snapshot.status).toBe('unhealthy');
      expect(snapshot.eventCount).toBe(20);
      expect(snapshot.droppedCount).toBe(6);
      expect(snapshot.criticalCount).toBe(1);
    });

    test('maps aggregate state deterministically', () => {
      expect(healthStatusFrom()).toBe('healthy');
      expect(healthStatusFrom({ warnings: 1 })).toBe('degraded');
      expect(healthStatusFrom({ critical: 1 })).toBe('unhealthy');
      expect(healthStatusFrom({ failed: true })).toBe('unhealthy');
    });
  });
});
