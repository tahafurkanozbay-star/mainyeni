import { describe, expect, it, vi } from 'vitest';
import { createSpatialQueryCacheRuntime, normalizeSpatialQueryCacheRuntimePolicy } from './spatialQueryCacheRuntime';

const key = (where = '1=1') => ({ serviceId: 'parks', layerId: 2, operation: 'query', where });

describe('normalizeSpatialQueryCacheRuntimePolicy', () => {
  it('returns bounded immutable defaults', () => {
    const policy = normalizeSpatialQueryCacheRuntimePolicy();
    expect(policy.cacheMaxEntries).toBeGreaterThan(0);
    expect(policy.requestConcurrency).toBeGreaterThan(0);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('rejects invalid cache and request budgets', () => {
    expect(() => normalizeSpatialQueryCacheRuntimePolicy({ cacheMaxEntries: 0 })).toThrow();
    expect(() => normalizeSpatialQueryCacheRuntimePolicy({ cacheMaxEstimatedBytes: 0 })).toThrow();
    expect(() => normalizeSpatialQueryCacheRuntimePolicy({ cacheDefaultTtlMs: 100, cacheMaxTtlMs: 99 })).toThrow();
    expect(() => normalizeSpatialQueryCacheRuntimePolicy({ coordinatePrecision: 11 })).toThrow();
    expect(() => normalizeSpatialQueryCacheRuntimePolicy({ requestConcurrency: 65 })).toThrow();
  });
});

describe('createSpatialQueryCacheRuntime', () => {
  it('executes once and serves a subsequent equivalent query from cache', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    const operation = vi.fn(async () => ({ features: [1, 2] }));
    const first = await runtime.execute(key('STATUS = 1'), operation, { estimatedBytes: 20 });
    const second = await runtime.execute(key('STATUS = 1'), operation, { estimatedBytes: 20 });
    expect(first.source).toBe('operation');
    expect(second.source).toBe('cache');
    expect(second.value).toEqual({ features: [1, 2] });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({ executions: 2, cacheServed: 1, operationServed: 1 });
  });

  it('deduplicates simultaneous cache misses through the shared request coordinator', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    let resolveOperation: ((value: number) => void) | undefined;
    const operation = vi.fn(() => new Promise<number>((resolve) => { resolveOperation = resolve; }));
    const first = runtime.execute(key(), operation);
    const second = runtime.execute(key(), operation);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    resolveOperation?.(42);
    const [a, b] = await Promise.all([first, second]);
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);
    expect([a.sharedRequest, b.sharedRequest].filter(Boolean)).toHaveLength(1);
  });

  it('keeps materially different query identities separate', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    const operation = vi.fn(async ({ cacheKey }: { cacheKey: string }) => cacheKey);
    const a = await runtime.execute(key('A=1'), operation);
    const b = await runtime.execute(key('A=2'), operation);
    expect(a.cacheKey).not.toBe(b.cacheKey);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('supports explicit refresh without serving the old cache value', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    let value = 1;
    await runtime.execute(key(), async () => value);
    value = 2;
    const refreshed = await runtime.execute(key(), async () => value, { refresh: true });
    const cached = await runtime.execute(key(), async () => 99);
    expect(refreshed.value).toBe(2);
    expect(cached.value).toBe(2);
    expect(runtime.snapshot().refreshes).toBe(1);
  });

  it('supports bypass mode without populating or reading cache', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await runtime.execute(key(), async () => 1);
    const bypassed = await runtime.execute(key(), async () => 2, { bypassCache: true });
    const cached = await runtime.execute(key(), async () => 3);
    expect(bypassed.value).toBe(2);
    expect(cached.value).toBe(1);
    expect(runtime.snapshot().bypasses).toBe(1);
  });

  it('invalidates one normalized key without flushing unrelated entries', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await runtime.execute(key('A=1'), async () => 1);
    await runtime.execute(key('A=2'), async () => 2);
    expect(runtime.invalidate(key('A=1'))).toBe(1);
    expect(runtime.lookup<number>(key('A=1')).status).toBe('miss');
    expect(runtime.lookup<number>(key('A=2')).status).toBe('hit');
  });

  it('invalidates cache entries by domain tag', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await runtime.execute(key('A=1'), async () => 1, { tags: ['layer:2'] });
    await runtime.execute(key('A=2'), async () => 2, { tags: ['layer:3'] });
    expect(runtime.invalidateTag('layer:2')).toBe(1);
    expect(runtime.lookup<number>(key('A=1')).status).toBe('miss');
    expect(runtime.lookup<number>(key('A=2')).status).toBe('hit');
  });

  it('clears all cache entries deterministically', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await runtime.execute(key('A=1'), async () => 1);
    await runtime.execute(key('A=2'), async () => 2);
    expect(runtime.invalidate()).toBe(2);
    expect(runtime.snapshot().cache.entries).toBe(0);
    expect(runtime.snapshot().invalidations).toBe(2);
  });

  it('rejects already-aborted consumers before invoking work', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    const controller = new AbortController();
    controller.abort('gone');
    const operation = vi.fn(async () => 1);
    await expect(runtime.execute(key(), operation, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('propagates active cancellation through the request coordinator', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    const controller = new AbortController();
    const execution = runtime.execute(key(), ({ signal }) => new Promise<number>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { signal: controller.signal });
    await Promise.resolve();
    controller.abort('navigation');
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().cache.entries).toBe(0);
  });

  it('does not cache rejected operations', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await expect(runtime.execute(key(), async () => { throw new Error('service failed'); })).rejects.toThrow('service failed');
    expect(runtime.lookup(key()).status).toBe('miss');
  });

  it('uses coordinate precision consistently across execute and lookup', async () => {
    const runtime = createSpatialQueryCacheRuntime({ coordinatePrecision: 3 });
    const a = { ...key(), envelope: { xmin: 1.12341, ymin: 2, xmax: 3, ymax: 4 } };
    const b = { ...key(), envelope: { xmin: 1.12344, ymin: 2, xmax: 3, ymax: 4 } };
    await runtime.execute(a, async () => 9);
    expect(runtime.lookup<number>(b)).toMatchObject({ status: 'hit', value: 9 });
  });

  it('exposes stale cache only when the caller opts in', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const runtime = createSpatialQueryCacheRuntime({ cacheDefaultTtlMs: 10, cacheMaxTtlMs: 100 });
      await runtime.execute(key(), async () => 7, { ttlMs: 10 });
      vi.setSystemTime(20);
      expect(runtime.lookup<number>(key(), true)).toMatchObject({ status: 'stale', value: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps expired entries and preserves bounded cache accounting', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const runtime = createSpatialQueryCacheRuntime({ cacheDefaultTtlMs: 10, cacheMaxTtlMs: 100 });
      await runtime.execute(key('A=1'), async () => 1, { ttlMs: 10, estimatedBytes: 10 });
      await runtime.execute(key('A=2'), async () => 2, { ttlMs: 20, estimatedBytes: 20 });
      expect(runtime.sweepExpired(10)).toBe(1);
      expect(runtime.snapshot().cache).toMatchObject({ entries: 1, estimatedBytes: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the configured cache byte budget', async () => {
    const runtime = createSpatialQueryCacheRuntime({ cacheMaxEstimatedBytes: 20, cacheMaxEntries: 10 });
    await runtime.execute(key('A=1'), async () => 1, { estimatedBytes: 12 });
    await runtime.execute(key('A=2'), async () => 2, { estimatedBytes: 12 });
    expect(runtime.snapshot().cache).toMatchObject({ entries: 1, estimatedBytes: 12, evictions: 1 });
  });

  it('disposes request and cache resources idempotently', async () => {
    const runtime = createSpatialQueryCacheRuntime();
    await runtime.execute(key(), async () => 1);
    runtime.dispose();
    runtime.dispose();
    expect(runtime.snapshot()).toMatchObject({ disposed: true, cache: { entries: 0 } });
    await expect(runtime.execute(key(), async () => 2)).rejects.toThrow(/disposed/);
  });
});
