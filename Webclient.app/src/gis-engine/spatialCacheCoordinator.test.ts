import { describe, expect, it, vi } from 'vitest';
import {
  SpatialCacheCapacityError,
  createSpatialCacheCoordinator,
} from './spatialCacheCoordinator';

const deferred = <TValue>() => {
  let resolve!: (value: TValue) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('createSpatialCacheCoordinator budgets', () => {
  it('stores and reads bounded values while tracking hits and misses', () => {
    const cache = createSpatialCacheCoordinator({ maxEntries: 4, maxBytes: 10_000 });
    cache.put('roads', { count: 3 }, { estimatedBytes: 120 });

    expect(cache.get<{ count: number }>('roads')).toEqual({ count: 3 });
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.getSnapshot()).toMatchObject({
      size: 1,
      estimatedBytes: 120,
      hits: 1,
      misses: 1,
    });
  });

  it('preserves cached undefined values for request dedupe semantics', async () => {
    const cache = createSpatialCacheCoordinator();
    const loader = vi.fn(async () => undefined);
    cache.put('empty', undefined, { estimatedBytes: 0 });

    await expect(cache.request('empty', loader)).resolves.toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    expect(cache.getSnapshot().hits).toBe(1);
  });

  it('evicts the lowest-priority entry before higher-priority entries', () => {
    const cache = createSpatialCacheCoordinator({ maxEntries: 2 });
    cache.put('critical', 1, { priority: 'critical' });
    cache.put('low', 2, { priority: 'low' });
    cache.put('high', 3, { priority: 'high' });

    expect(cache.has('critical')).toBe(true);
    expect(cache.has('high')).toBe(true);
    expect(cache.has('low')).toBe(false);
  });

  it('uses hit count and recency to select deterministic same-priority victims', () => {
    let now = 10;
    const cache = createSpatialCacheCoordinator({ maxEntries: 2, now: () => now });
    cache.put('old', 1);
    now += 1;
    cache.put('hot', 2);
    cache.get('hot');
    now += 1;
    cache.put('new', 3);

    expect(cache.has('old')).toBe(false);
    expect(cache.has('hot')).toBe(true);
    expect(cache.has('new')).toBe(true);
  });

  it('never leaves the cache above its byte budget even for critical entries', () => {
    const cache = createSpatialCacheCoordinator({ maxEntries: 4, maxBytes: 100 });
    cache.put('critical-a', 'a', { priority: 'critical', estimatedBytes: 70 });
    cache.put('critical-b', 'b', { priority: 'critical', estimatedBytes: 70 });

    const snapshot = cache.getSnapshot();
    expect(snapshot.estimatedBytes).toBeLessThanOrEqual(100);
    expect(snapshot.size).toBe(1);
  });

  it('does not retain an individually oversized entry', () => {
    const cache = createSpatialCacheCoordinator({ maxBytes: 128 });
    cache.put('oversized', 'payload', { estimatedBytes: 256 });

    expect(cache.has('oversized')).toBe(false);
    expect(cache.getSnapshot().estimatedBytes).toBe(0);
  });

  it('expires entries using the injected deterministic clock', () => {
    let now = 1_000;
    const cache = createSpatialCacheCoordinator({
      defaultTtlMs: 100,
      maxTtlMs: 1_000,
      now: () => now,
    });
    cache.put('parcel', 1);
    now = 1_099;
    expect(cache.has('parcel')).toBe(true);
    now = 1_100;
    expect(cache.has('parcel')).toBe(false);
    expect(cache.getSnapshot().evictions).toBe(1);
  });

  it('caps ttl at the configured maximum', () => {
    let now = 0;
    const cache = createSpatialCacheCoordinator({
      defaultTtlMs: 100,
      maxTtlMs: 200,
      now: () => now,
    });
    const entry = cache.put('bounded-ttl', 1, { ttlMs: 50_000 });
    expect(entry.expiresAt).toBe(200);
    now = 200;
    expect(cache.has('bounded-ttl')).toBe(false);
  });

  it('normalizes tags and invalidates matching entries', () => {
    const cache = createSpatialCacheCoordinator();
    cache.put('a', 1, { tags: ['Layer:Roads', 'layer:roads', ' active '] });
    cache.put('b', 2, { tags: ['layer:buildings'] });

    expect(cache.invalidateTags([' LAYER:ROADS '])).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('enforces key, tag count, and tag length metadata budgets', () => {
    const cache = createSpatialCacheCoordinator({
      maxKeyLength: 5,
      maxTagsPerEntry: 2,
      maxTagLength: 4,
    });

    expect(() => cache.put('123456', 1)).toThrow(RangeError);
    expect(() => cache.put('ok', 1, { tags: ['a', 'b', 'c'] })).toThrow(RangeError);
    expect(() => cache.put('ok', 1, { tags: ['abcde'] })).toThrow(RangeError);
  });

  it('accepts explicit zero byte estimates', () => {
    const cache = createSpatialCacheCoordinator({
      estimateBytes: () => 999,
    });
    const entry = cache.put('zero', null, { estimatedBytes: 0 });
    expect(entry.estimatedBytes).toBe(0);
    expect(cache.getSnapshot().estimatedBytes).toBe(0);
  });

  it('falls back safely when the custom byte estimator throws', () => {
    const cache = createSpatialCacheCoordinator({
      estimateBytes: () => {
        throw new Error('estimator failed');
      },
    });
    const entry = cache.put('safe', { value: 1 });
    expect(entry.estimatedBytes).toBe(1_024);
  });

  it('rejects invalid configuration instead of silently coercing it', () => {
    expect(() => createSpatialCacheCoordinator({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => createSpatialCacheCoordinator({ maxInFlight: Number.NaN })).toThrow(RangeError);
    expect(() => createSpatialCacheCoordinator({ maxTagLength: -1 })).toThrow(RangeError);
  });

  it('rejects an invalid injected clock before corrupting cache timestamps', () => {
    const cache = createSpatialCacheCoordinator({ now: () => Number.NaN });
    expect(() => cache.put('x', 1)).toThrow(RangeError);
  });
});

describe('createSpatialCacheCoordinator observers', () => {
  it('reports eviction without allowing observer failures to break cache state', () => {
    const onObserverError = vi.fn();
    const cache = createSpatialCacheCoordinator({
      maxEntries: 1,
      onEvict: () => {
        throw new Error('observer failed');
      },
      onObserverError,
    });

    cache.put('one', 1);
    expect(() => cache.put('two', 2)).not.toThrow();
    expect(cache.getSnapshot().size).toBe(1);
    expect(onObserverError).toHaveBeenCalledTimes(1);
  });

  it('reports failures from the observer-error observer through the host error channel', () => {
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    try {
      const cache = createSpatialCacheCoordinator({
        maxEntries: 1,
        onEvict: () => {
          throw new Error('eviction observer failed');
        },
        onObserverError: () => {
          throw new Error('secondary observer failed');
        },
      });

      cache.put('one', 1);
      expect(() => cache.put('two', 2)).not.toThrow();
      expect(cache.getSnapshot().size).toBe(1);
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
        message: 'secondary observer failed',
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('emits explicit reasons for manual and budget removals', () => {
    const onEvict = vi.fn();
    const cache = createSpatialCacheCoordinator({ maxEntries: 1, onEvict });
    cache.put('one', 1);
    cache.put('two', 2);
    cache.delete('two', 'test-delete');

    expect(onEvict).toHaveBeenCalledWith('one', 'entry-budget');
    expect(onEvict).toHaveBeenCalledWith('two', 'test-delete');
  });
});

describe('createSpatialCacheCoordinator request governance', () => {
  it('deduplicates concurrent loaders by normalized key', async () => {
    const pending = deferred<number>();
    const loader = vi.fn(async () => pending.promise);
    const cache = createSpatialCacheCoordinator();

    const first = cache.request(' roads ', loader);
    const second = cache.request('roads', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot()).toMatchObject({
      activeRequests: 1,
      activeSubscribers: 2,
      dedupeHits: 1,
    });

    pending.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(cache.getSnapshot()).toMatchObject({
      activeRequests: 0,
      activeSubscribers: 0,
    });
  });

  it('aborting one deduplicated subscriber does not cancel surviving consumers', async () => {
    const pending = deferred<string>();
    let transportSignal: AbortSignal | null = null;
    const loader = vi.fn(async (signal: AbortSignal) => {
      transportSignal = signal;
      return pending.promise;
    });
    const cache = createSpatialCacheCoordinator();
    const controller = new AbortController();

    const cancellable = cache.request('shared', loader, { signal: controller.signal });
    const survivor = cache.request('shared', loader);
    controller.abort(new Error('view changed'));

    await expect(cancellable).rejects.toThrow('view changed');
    expect(transportSignal?.aborted).toBe(false);

    pending.resolve('ok');
    await expect(survivor).resolves.toBe('ok');
    expect(cache.getSnapshot().abortedSubscribers).toBe(1);
  });

  it('aborts underlying transport when the final subscriber leaves', async () => {
    let transportSignal: AbortSignal | null = null;
    const loader = vi.fn((signal: AbortSignal) => {
      transportSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const cache = createSpatialCacheCoordinator();
    const controller = new AbortController();

    const request = cache.request('cancel-all', loader, { signal: controller.signal });
    controller.abort(new Error('navigation'));

    await expect(request).rejects.toThrow('navigation');
    expect(transportSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cache.getSnapshot().activeRequests).toBe(0));
  });

  it('rejects the first subscriber even when an abort-insensitive loader eventually resolves', async () => {
    const pending = deferred<string>();
    const cache = createSpatialCacheCoordinator();
    const controller = new AbortController();
    const request = cache.request('insensitive', async () => pending.promise, {
      signal: controller.signal,
    });

    controller.abort(new Error('cancelled'));
    await expect(request).rejects.toThrow('cancelled');

    pending.resolve('late-value');
    await vi.waitFor(() => expect(cache.getSnapshot().activeRequests).toBe(0));
    expect(cache.has('insensitive')).toBe(false);
  });

  it('fails fast for a pre-aborted signal without invoking the loader', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    const loader = vi.fn(async () => 1);
    const cache = createSpatialCacheCoordinator();

    await expect(cache.request('pre-aborted', loader, { signal: controller.signal }))
      .rejects.toThrow('already gone');
    expect(loader).not.toHaveBeenCalled();
  });

  it('does not cache a failed request and allows a later retry', async () => {
    const cache = createSpatialCacheCoordinator();
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(7);

    await expect(cache.request('retryable', loader)).rejects.toThrow('temporary');
    await expect(cache.request('retryable', loader)).resolves.toBe(7);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.get<number>('retryable')).toBe(7);
  });

  it('enforces the global in-flight request budget', async () => {
    const first = deferred<number>();
    const cache = createSpatialCacheCoordinator({ maxInFlight: 1 });
    const loader = vi.fn(async () => first.promise);

    const active = cache.request('one', loader);
    await expect(cache.request('two', async () => 2)).rejects.toBeInstanceOf(SpatialCacheCapacityError);
    expect(cache.getSnapshot().rejectedRequests).toBe(1);

    first.resolve(1);
    await expect(active).resolves.toBe(1);
  });

  it('can bypass a cached value while still refreshing the cache', async () => {
    const cache = createSpatialCacheCoordinator();
    cache.put('refresh', 1);

    await expect(cache.request('refresh', async () => 2, { bypassCache: true })).resolves.toBe(2);
    expect(cache.get<number>('refresh')).toBe(2);
  });

  it('uses the first in-flight request cache policy for all deduplicated consumers', async () => {
    const pending = deferred<number>();
    const cache = createSpatialCacheCoordinator();
    const first = cache.request('policy', async () => pending.promise, {
      tags: ['first'],
      priority: 'high',
      estimatedBytes: 24,
    });
    const second = cache.request('policy', async () => 99, {
      tags: ['second'],
      priority: 'low',
    });

    pending.resolve(5);
    await Promise.all([first, second]);

    expect(cache.invalidateTags(['second'])).toBe(0);
    expect(cache.invalidateTags(['first'])).toBe(1);
  });

  it('tracks request misses without counting a dedupe hit as a cache hit', async () => {
    const pending = deferred<number>();
    const cache = createSpatialCacheCoordinator();
    const first = cache.request('metrics', async () => pending.promise);
    const second = cache.request('metrics', async () => 2);

    pending.resolve(1);
    await Promise.all([first, second]);

    const snapshot = cache.getSnapshot();
    expect(snapshot.hits).toBe(0);
    expect(snapshot.misses).toBe(2);
    expect(snapshot.dedupeHits).toBe(1);
  });
});
