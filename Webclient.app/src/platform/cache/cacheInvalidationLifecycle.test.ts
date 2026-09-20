import { describe, expect, test } from 'vitest';
import { BoundedMemoryCache } from './boundedMemoryCache';
import { CacheCoordinator } from './cacheCoordinator';
import { CacheFlightError } from './cacheFlightContracts';

const clock = () => {
  let value = 1_000;
  return {
    source: Object.freeze({ now: () => value }),
    advance: (milliseconds: number) => {
      value += milliseconds;
      return value;
    },
  };
};

const put = (
  cache: BoundedMemoryCache,
  key: string,
  namespace = 'http',
  value: unknown = { ok: true },
): void => {
  cache.put({
    key,
    namespace,
    value,
    ttlMs: 10_000,
    tags: ['test'],
  });
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

describe('BoundedMemoryCache prefix invalidation', () => {
  test('removes only matching canonical key prefixes', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'http|GET|/items');
    put(cache, 'http|GET|/items/1');
    put(cache, 'http|GET|/health');

    expect(cache.invalidatePrefix('http|GET|/items')).toBe(2);
    expect(cache.get('http|GET|/items').hit).toBe(false);
    expect(cache.get('http|GET|/items/1').hit).toBe(false);
    expect(cache.get('http|GET|/health').hit).toBe(true);
  });

  test('treats a blank prefix as a reusable global clear', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'http|GET|/one');
    put(cache, 'http|GET|/two');

    expect(cache.invalidatePrefix('   ')).toBe(2);
    expect(cache.snapshot().entries).toBe(0);

    put(cache, 'http|GET|/three');
    expect(cache.get('http|GET|/three').hit).toBe(true);
    expect(cache.snapshot().disposed).toBe(false);
  });

  test('rejects oversized arbitrary prefixes before scanning', () => {
    const cache = new BoundedMemoryCache({ maxKeyLength: 64 });
    expect(() => cache.invalidatePrefix('x'.repeat(65))).toThrow(RangeError);
  });

  test('preserves namespace accounting after partial prefix invalidation', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'http|GET|/one', 'http');
    put(cache, 'http|GET|/two', 'http');
    put(cache, 'bootstrap|GET|/map', 'bootstrap');

    expect(cache.invalidatePrefix('http|')).toBe(2);
    expect(() => cache.assertConsistent()).not.toThrow();
    expect(cache.snapshot()).toMatchObject({
      entries: 1,
      namespaces: 1,
    });
  });

  test('updates removal statistics for every removed entry', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'http|GET|/one');
    put(cache, 'http|GET|/two');
    const before = cache.snapshot();

    cache.invalidatePrefix('http|GET|');

    expect(cache.snapshot().removals - before.removals).toBe(2);
  });
});

describe('BoundedMemoryCache clear lifecycle', () => {
  test('returns the number of removed entries', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'one');
    put(cache, 'two');
    put(cache, 'three');

    expect(cache.clear()).toBe(3);
    expect(cache.clear()).toBe(0);
  });

  test('clears reverse tag and namespace indexes', () => {
    const cache = new BoundedMemoryCache();
    cache.put({
      key: 'one',
      namespace: 'catalog',
      value: 1,
      ttlMs: 1_000,
      tags: ['items', 'catalog'],
    });

    cache.clear();

    expect(cache.invalidateTags(['items'])).toBe(0);
    expect(cache.invalidateNamespace('catalog')).toBe(0);
    expect(() => cache.assertConsistent()).not.toThrow();
  });

  test('does not turn clear into permanent disposal', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'before');
    cache.clear();
    put(cache, 'after');

    expect(cache.get('after')).toMatchObject({
      hit: true,
      state: 'fresh',
    });
  });

  test('dispose remains terminal and distinct from clear', () => {
    const cache = new BoundedMemoryCache();
    put(cache, 'before');
    cache.dispose();

    expect(() => cache.clear()).toThrow();
    expect(() => cache.get('before')).toThrow();
    expect(cache.snapshot().disposed).toBe(true);
  });

  test('works with expired entries without corrupting accounting', () => {
    const time = clock();
    const cache = new BoundedMemoryCache({ clock: time.source });
    cache.put({
      key: 'short',
      namespace: 'http',
      value: 1,
      ttlMs: 10,
    });
    cache.put({
      key: 'long',
      namespace: 'http',
      value: 2,
      ttlMs: 1_000,
    });

    time.advance(20);
    expect(cache.get('short').hit).toBe(false);
    expect(cache.clear()).toBe(1);
    expect(() => cache.assertConsistent()).not.toThrow();
  });
});

describe('CacheCoordinator exact invalidation', () => {
  test('removes a completed exact key', async () => {
    const coordinator = new CacheCoordinator();
    const request = {
      key: { namespace: 'http', method: 'GET', url: '/items' },
      policy: {
        method: 'GET',
        classification: 'internal' as const,
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => ({ value: 1 }),
    };

    const resolution = await coordinator.readThrough(request);
    expect(resolution.cached).toBe(true);
    expect(coordinator.storeSnapshot().entries).toBe(1);

    expect(coordinator.invalidateKey(resolution.key)).toBe(true);
    expect(coordinator.storeSnapshot().entries).toBe(0);
  });

  test('cancels an in-flight exact key and prevents stale writeback', async () => {
    const coordinator = new CacheCoordinator();
    const pending = deferred<{ value: number }>();
    const request = {
      key: { namespace: 'http', method: 'GET', url: '/items' },
      policy: {
        method: 'GET',
        classification: 'internal' as const,
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => pending.promise,
    };

    const execution = coordinator.readThrough(request);
    await Promise.resolve();
    const parsedKey = 'http|GET|/items';

    expect(coordinator.invalidateKey(parsedKey)).toBe(false);
    pending.resolve({ value: 1 });

    await expect(execution).rejects.toMatchObject({
      code: 'operation-cancelled',
    });
    expect(coordinator.storeSnapshot().entries).toBe(0);
  });

  test('a subsequent load after exact invalidation may populate a fresh value', async () => {
    const coordinator = new CacheCoordinator();
    let version = 0;
    const request = {
      key: { namespace: 'http', method: 'GET', url: '/items' },
      policy: {
        method: 'GET',
        classification: 'internal' as const,
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => ({ version: ++version }),
    };

    const first = await coordinator.readThrough(request);
    coordinator.invalidateKey(first.key);
    const second = await coordinator.readThrough(request);

    expect(first.value).toEqual({ version: 1 });
    expect(second.value).toEqual({ version: 2 });
    expect(coordinator.storeSnapshot().entries).toBe(1);
  });
});

describe('CacheCoordinator prefix and global invalidation', () => {
  test('prefix invalidation removes matching entries and advances mutation generation', async () => {
    const coordinator = new CacheCoordinator();

    for (const url of ['/items', '/items/1', '/health']) {
      await coordinator.readThrough({
        key: { namespace: 'http', method: 'GET', url },
        policy: {
          method: 'GET',
          classification: 'internal',
          explicitCacheable: true,
          ttlMs: 10_000,
        },
        loader: async () => ({ url }),
      });
    }

    expect(coordinator.invalidatePrefix('http|GET|/items')).toBe(2);
    expect(coordinator.storeSnapshot().entries).toBe(1);
  });

  test('prefix invalidation conservatively cancels all active cache flights', async () => {
    const coordinator = new CacheCoordinator();
    const firstPending = deferred<number>();
    const secondPending = deferred<number>();

    const first = coordinator.readThrough({
      key: { namespace: 'http', method: 'GET', url: '/items' },
      policy: {
        method: 'GET',
        classification: 'internal',
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => firstPending.promise,
    });
    const second = coordinator.readThrough({
      key: { namespace: 'http', method: 'GET', url: '/health' },
      policy: {
        method: 'GET',
        classification: 'internal',
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => secondPending.promise,
    });

    await Promise.resolve();
    coordinator.invalidatePrefix('http|GET|/items');
    firstPending.resolve(1);
    secondPending.resolve(2);

    await expect(first).rejects.toBeInstanceOf(CacheFlightError);
    await expect(second).rejects.toBeInstanceOf(CacheFlightError);
    expect(coordinator.flightSnapshot().flights).toBe(0);
    expect(coordinator.storeSnapshot().entries).toBe(0);
  });

  test('global invalidation clears cache and cancels active loads', async () => {
    const coordinator = new CacheCoordinator();
    await coordinator.readThrough({
      key: { namespace: 'http', method: 'GET', url: '/cached' },
      policy: {
        method: 'GET',
        classification: 'internal',
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => 1,
    });

    const pending = deferred<number>();
    const active = coordinator.readThrough({
      key: { namespace: 'http', method: 'GET', url: '/active' },
      policy: {
        method: 'GET',
        classification: 'internal',
        explicitCacheable: true,
        ttlMs: 10_000,
      },
      loader: async () => pending.promise,
    });

    await Promise.resolve();
    expect(coordinator.invalidateAll()).toBe(1);
    pending.resolve(2);

    await expect(active).rejects.toBeInstanceOf(CacheFlightError);
    expect(coordinator.storeSnapshot().entries).toBe(0);
    expect(coordinator.flightSnapshot().flights).toBe(0);
  });

  test('global invalidation leaves the coordinator reusable', async () => {
    const coordinator = new CacheCoordinator();
    coordinator.invalidateAll();

    await expect(coordinator.readThrough({
      key: { namespace: 'http', method: 'GET', url: '/after-clear' },
      policy: {
        method: 'GET',
        classification: 'public',
        explicitCacheable: true,
        ttlMs: 1_000,
      },
      loader: async () => ({ ok: true }),
    })).resolves.toMatchObject({
      value: { ok: true },
      cached: true,
    });
  });
});
