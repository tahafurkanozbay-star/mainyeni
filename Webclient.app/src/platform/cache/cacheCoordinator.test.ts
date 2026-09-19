import { describe, expect, it, vi } from 'vitest';
import { BoundedMemoryCache } from './boundedMemoryCache';
import { CacheCoordinator } from './cacheCoordinator';
import { CacheMutationGuard } from './cacheMutationGuard';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const publicRequest = <T>(
  loader: () => Promise<T>,
  overrides: Partial<Parameters<CacheCoordinator['readThrough']>[0]> = {},
) => ({
  key: { namespace: 'catalog', url: '/places' },
  policy: {
    classification: 'public' as const,
    explicitCacheable: true,
    ttlMs: 1000,
    staleWhileRevalidateMs: 500,
  },
  loader: async () => loader(),
  ...overrides,
});

describe('CacheCoordinator', () => {
  it('loads once and serves the next read from fresh cache', async () => {
    const loader = vi.fn(async () => ({ version: 1 }));
    const coordinator = new CacheCoordinator();

    const first = await coordinator.readThrough(publicRequest(loader));
    const second = await coordinator.readThrough(publicRequest(loader));

    expect(first).toMatchObject({
      value: { version: 1 },
      source: 'shared-loader',
      cached: true,
    });
    expect(second).toMatchObject({
      value: { version: 1 },
      source: 'fresh-cache',
      cached: true,
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      reads: 2,
      freshHits: 1,
      misses: 1,
      loads: 1,
      writes: 1,
    });
  });

  it('deduplicates concurrent misses', async () => {
    const gate = deferred<number>();
    const loader = vi.fn(() => gate.promise);
    const coordinator = new CacheCoordinator();

    const first = coordinator.readThrough(publicRequest(loader));
    const second = coordinator.readThrough(publicRequest(loader));

    expect(coordinator.flightSnapshot()).toMatchObject({
      flights: 1,
      subscribers: 2,
      started: 1,
      joined: 1,
    });
    gate.resolve(7);

    await expect(first).resolves.toMatchObject({ value: 7 });
    await expect(second).resolves.toMatchObject({ value: 7 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      loads: 1,
      sharedLoads: 1,
    });
  });

  it('does not cache requests rejected by cache policy', async () => {
    const loader = vi.fn(async () => 1);
    const coordinator = new CacheCoordinator();
    const request = {
      key: { namespace: 'profile', url: '/me' },
      policy: {
        classification: 'personal' as const,
        explicitCacheable: true,
        ttlMs: 1000,
      },
      loader: async () => loader(),
    };

    const first = await coordinator.readThrough(request);
    const second = await coordinator.readThrough(request);

    expect(first.source).toBe('network-only');
    expect(second.source).toBe('network-only');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(coordinator.storeSnapshot().entries).toBe(0);
    expect(coordinator.snapshot()).toMatchObject({
      networkOnly: 2,
      loads: 2,
    });
  });

  it('preserves caller cancellation for network-only requests', async () => {
    const controller = new AbortController();
    const coordinator = new CacheCoordinator();
    const started = deferred<void>();
    const request = {
      key: { namespace: 'profile', url: '/me' },
      policy: {
        classification: 'personal' as const,
        explicitCacheable: true,
      },
      signal: controller.signal,
      loader: async ({ signal }: { signal: AbortSignal }) => {
        started.resolve();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return 1;
      },
    };

    const result = coordinator.readThrough(request);
    await started.promise;
    controller.abort(new Error('cancelled'));

    await expect(result).rejects.toThrow('cancelled');
  });

  it('returns data even when a cache write exceeds entry capacity', async () => {
    const coordinator = new CacheCoordinator({
      storeOptions: {
        maxBytes: 1024,
        maxBytesPerNamespace: 1024,
        maxEntryBytes: 16,
      },
    });
    const result = await coordinator.readThrough({
      key: { namespace: 'catalog', url: '/places' },
      policy: {
        classification: 'public',
        explicitCacheable: true,
        ttlMs: 1000,
      },
      byteSize: 17,
      loader: async () => 'payload',
    });

    expect(result).toMatchObject({
      value: 'payload',
      source: 'shared-loader',
      cached: false,
    });
    expect(result.cacheWriteIssue).toContain('entry-too-large');
    expect(coordinator.snapshot()).toMatchObject({
      writes: 0,
      writeIssues: 1,
    });
  });

  it('rejects stale write-back after an external mutation generation changes', async () => {
    const gate = deferred<number>();
    const mutations = new CacheMutationGuard();
    const coordinator = new CacheCoordinator({ mutations });
    const result = coordinator.readThrough({
      key: { namespace: 'catalog', url: '/places' },
      policy: {
        classification: 'public',
        explicitCacheable: true,
        ttlMs: 1000,
      },
      tags: ['places'],
      loader: async () => gate.promise,
    });

    mutations.invalidateTags(['places']);
    gate.resolve(8);

    await expect(result).resolves.toMatchObject({
      value: 8,
      cached: false,
      cacheWriteIssue: 'invalidated-during-load',
    });
    expect(coordinator.storeSnapshot().entries).toBe(0);
    expect(coordinator.snapshot()).toMatchObject({
      invalidatedWrites: 1,
      writeIssues: 1,
    });
  });

  it('cancels active flights during tag invalidation', async () => {
    const gate = deferred<number>();
    const coordinator = new CacheCoordinator();
    const result = coordinator.readThrough({
      key: { namespace: 'catalog', url: '/places' },
      policy: {
        classification: 'public',
        explicitCacheable: true,
        ttlMs: 1000,
      },
      tags: ['places'],
      loader: async () => gate.promise,
    });

    expect(coordinator.invalidateTags(['places'])).toBe(0);
    await expect(result).rejects.toMatchObject({ code: 'operation-cancelled' });
    expect(coordinator.flightSnapshot().flights).toBe(0);
    gate.resolve(1);
  });

  it('cancels active flights during namespace invalidation', async () => {
    const gate = deferred<number>();
    const coordinator = new CacheCoordinator();
    const result = coordinator.readThrough(publicRequest(() => gate.promise));

    expect(coordinator.invalidateNamespace('catalog')).toBe(0);
    await expect(result).rejects.toMatchObject({ code: 'operation-cancelled' });
    gate.resolve(1);
  });

  it('serves stale data immediately and refreshes it in the background', async () => {
    let now = 0;
    const store = new BoundedMemoryCache({ clock: { now: () => now } });
    const coordinator = new CacheCoordinator({ store });
    let version = 1;
    const loader = vi.fn(async () => version);

    const first = await coordinator.readThrough(publicRequest(loader));
    expect(first.value).toBe(1);

    now = 1200;
    version = 2;
    const stale = await coordinator.readThrough(publicRequest(loader));
    expect(stale).toMatchObject({
      value: 1,
      source: 'stale-cache',
      cached: true,
    });
    await expect(stale.revalidation).resolves.toEqual({
      status: 'updated',
      cached: true,
    });

    const refreshed = await coordinator.readThrough(publicRequest(loader));
    expect(refreshed).toMatchObject({
      value: 2,
      source: 'fresh-cache',
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('reports failed stale revalidation without discarding stale data', async () => {
    let now = 0;
    const store = new BoundedMemoryCache({ clock: { now: () => now } });
    const coordinator = new CacheCoordinator({ store });

    await coordinator.readThrough(publicRequest(async () => 1));
    now = 1200;
    const stale = await coordinator.readThrough(publicRequest(async () => {
      throw new TypeError('upstream');
    }));

    expect(stale.value).toBe(1);
    await expect(stale.revalidation).resolves.toEqual({
      status: 'failed',
      errorName: 'TypeError',
    });
    expect(coordinator.snapshot().revalidationFailures).toBe(1);
  });

  it('reports cancelled stale revalidation as cancelled', async () => {
    let now = 0;
    const store = new BoundedMemoryCache({ clock: { now: () => now } });
    const coordinator = new CacheCoordinator({ store });
    await coordinator.readThrough(publicRequest(async () => 1));

    now = 1200;
    const gate = deferred<number>();
    const stale = await coordinator.readThrough(publicRequest(() => gate.promise));
    coordinator.invalidateNamespace('catalog');

    await expect(stale.revalidation).resolves.toEqual({ status: 'cancelled' });
    gate.resolve(2);
  });

  it('prunes expired entries through the coordinator boundary', async () => {
    let now = 0;
    const store = new BoundedMemoryCache({ clock: { now: () => now } });
    const coordinator = new CacheCoordinator({ store });
    await coordinator.readThrough({
      key: { namespace: 'catalog', url: '/places' },
      policy: {
        classification: 'public',
        explicitCacheable: true,
        ttlMs: 10,
      },
      loader: async () => 1,
    });

    now = 11;
    expect(coordinator.pruneExpired()).toBe(1);
    expect(coordinator.storeSnapshot().entries).toBe(0);
  });

  it('disposes store and flights idempotently', async () => {
    const coordinator = new CacheCoordinator();
    await coordinator.readThrough(publicRequest(async () => 1));
    coordinator.dispose();
    coordinator.dispose();

    expect(coordinator.storeSnapshot()).toMatchObject({
      disposed: true,
      entries: 0,
    });
    await expect(coordinator.readThrough(publicRequest(async () => 2)))
      .rejects.toMatchObject({ code: 'disposed' });
  });
});
