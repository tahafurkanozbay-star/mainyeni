import { describe, expect, test, vi } from 'vitest';
import { CacheCoordinator } from '../cache/cacheCoordinator';
import { CacheFlightError } from '../cache/cacheFlightContracts';
import { createCacheKey } from '../cache/cacheKey';
import type { NormalizedRequestConfig, RawRequestConfig, TransportResult } from './contracts';
import {
  HttpCacheRuntime,
  createHttpCacheKeyRequest,
  normalizeHttpCacheInvalidationPrefix,
} from './httpCacheRuntime';
import { normalizeRequestConfig } from './requestPolicy';

const defaults = Object.freeze({
  timeoutMs: 5_000,
  maxRetries: 0,
  cacheTtlMs: 30_000,
});

const normalized = (
  overrides: RawRequestConfig = {},
): NormalizedRequestConfig => normalizeRequestConfig({
  method: 'get',
  url: '/items',
  cache: true,
  dedupe: true,
  cacheClassification: 'internal',
  cacheNamespace: 'http',
  ...overrides,
}, defaults);

const envelope = <T>(data: T, status = 200): TransportResult<T> => Object.freeze({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'ERROR',
  metadata: Object.freeze({
    status,
    method: 'get',
    url: '/items',
  }),
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

describe('createHttpCacheKeyRequest', () => {
  test('creates deterministic canonical cache identities', () => {
    const left = normalized({
      params: { page: 2, category: 'park' },
      cacheVary: { locale: 'tr', compact: true },
    });
    const right = normalized({
      params: { category: 'park', page: 2 },
      cacheVary: { compact: true, locale: 'tr' },
    });

    expect(createCacheKey(createHttpCacheKeyRequest(left)).serialized)
      .toBe(createCacheKey(createHttpCacheKeyRequest(right)).serialized);
  });

  test('keeps HTTP method in the cache identity', () => {
    const getKey = createCacheKey(createHttpCacheKeyRequest(normalized({ method: 'get' })));
    const headKey = createCacheKey(createHttpCacheKeyRequest(normalized({ method: 'head' })));
    expect(getKey.serialized).not.toBe(headKey.serialized);
  });

  test('keeps explicit namespace in the cache identity', () => {
    const first = createCacheKey(createHttpCacheKeyRequest(normalized({ cacheNamespace: 'catalog' })));
    const second = createCacheKey(createHttpCacheKeyRequest(normalized({ cacheNamespace: 'bootstrap' })));
    expect(first.serialized).not.toBe(second.serialized);
  });
});

describe('normalizeHttpCacheInvalidationPrefix', () => {
  test('translates the legacy request key prefix into canonical cache space', () => {
    expect(normalizeHttpCacheInvalidationPrefix('get|/items'))
      .toBe('http|GET|/items');
  });

  test('preserves a canonical cache prefix', () => {
    expect(normalizeHttpCacheInvalidationPrefix('http|GET|/items'))
      .toBe('http|GET|/items');
  });

  test('translates a legacy key containing serialized query metadata', () => {
    expect(normalizeHttpCacheInvalidationPrefix('get|/items|page=2'))
      .toBe('http|GET|/items?page=2');
  });

  test('uses a caller-supplied namespace for bounded migration helpers', () => {
    expect(normalizeHttpCacheInvalidationPrefix('head|/health', 'bootstrap'))
      .toBe('bootstrap|HEAD|/health');
  });

  test('keeps blank prefix as global invalidation', () => {
    expect(normalizeHttpCacheInvalidationPrefix('')).toBe('');
  });
});

describe('HttpCacheRuntime governed retention', () => {
  test('retains an explicitly cacheable internal GET and marks cache hits', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope({ version: 1 }));

    const first = await runtime.resolve(normalized(), loader);
    const second = await runtime.resolve(normalized(), loader);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.metadata?.cache).toBe('fresh-cache');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.cacheSize()).toBe(1);
  });

  test('retains an explicitly cacheable public HEAD', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope(null));

    await runtime.resolve(normalized({
      method: 'head',
      cacheClassification: 'public',
      url: '/health',
    }), loader);
    const second = await runtime.resolve(normalized({
      method: 'head',
      cacheClassification: 'public',
      url: '/health',
    }), loader);

    expect(second.fromCache).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('does not retain personal responses even when cache is requested', async () => {
    const runtime = new HttpCacheRuntime();
    const config = normalized({ cacheClassification: 'personal' });
    const loader = vi.fn(async () => envelope({ user: 1 }));

    expect(config.cache).toBe(false);
    await runtime.resolve(config, loader);
    await runtime.resolve(config, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(runtime.cacheSize()).toBe(0);
  });

  test('does not retain sensitive responses even when cache is requested', async () => {
    const runtime = new HttpCacheRuntime();
    const config = normalized({ cacheClassification: 'sensitive' });
    const loader = vi.fn(async () => envelope({ secret: 'redacted-at-source' }));

    expect(config.cache).toBe(false);
    await runtime.resolve(config, loader);
    await runtime.resolve(config, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(runtime.cacheSize()).toBe(0);
  });

  test('sensitive query metadata disables both retention and sharing', async () => {
    const runtime = new HttpCacheRuntime();
    const config = normalized({
      params: { token: 'private', page: 1 },
      cache: true,
      dedupe: true,
    });
    const loader = vi.fn(async () => envelope({ value: 1 }));

    expect(config.containsSensitiveMetadata).toBe(true);
    expect(config.cache).toBe(false);
    expect(config.dedupe).toBe(false);
    await Promise.all([
      runtime.resolve(config, loader),
      runtime.resolve(config, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(runtime.cacheSize()).toBe(0);
  });

  test('unsafe methods are never retained by the governed cache', async () => {
    const runtime = new HttpCacheRuntime();
    const config = normalized({ method: 'post', cache: true, dedupe: true });
    const loader = vi.fn(async () => envelope({ written: true }));

    expect(config.cache).toBe(false);
    expect(config.dedupe).toBe(false);
    await runtime.resolve(config, loader);
    await runtime.resolve(config, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('zero TTL degrades to network-only without failing the request', async () => {
    const runtime = new HttpCacheRuntime();
    const config = normalized({ cacheTtlMs: 0 });
    const loader = vi.fn(async () => envelope({ value: 1 }));

    await runtime.resolve(config, loader);
    await runtime.resolve(config, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(runtime.cacheSize()).toBe(0);
  });

  test('a cache write capacity issue does not fail a successful network request', async () => {
    const runtime = new HttpCacheRuntime({
      coordinatorOptions: {
        storeOptions: {
          maxEntries: 4,
          maxEntriesPerNamespace: 4,
          maxBytes: 1024,
          maxBytesPerNamespace: 1024,
          maxEntryBytes: 32,
        },
      },
    });
    const loader = vi.fn(async () => envelope({ text: 'x'.repeat(200) }));

    await expect(runtime.resolve(normalized(), loader))
      .resolves.toMatchObject({ data: { text: 'x'.repeat(200) } });
    expect(runtime.cacheSize()).toBe(0);
    expect(runtime.snapshot().cache.writeIssues).toBe(1);
  });

  test('bounded store evicts older entries instead of growing indefinitely', async () => {
    const runtime = new HttpCacheRuntime({
      coordinatorOptions: {
        storeOptions: {
          maxEntries: 2,
          maxEntriesPerNamespace: 2,
        },
      },
    });
    const loader = vi.fn(async () => envelope({ ok: true }));

    await runtime.resolve(normalized({ url: '/one' }), loader);
    await runtime.resolve(normalized({ url: '/two' }), loader);
    await runtime.resolve(normalized({ url: '/three' }), loader);

    expect(runtime.cacheSize()).toBe(2);
    expect(runtime.snapshot().store.evictions).toBeGreaterThanOrEqual(1);
  });
});

describe('HttpCacheRuntime invalidation', () => {
  test('legacy prefix invalidation removes only matching canonical entries', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope({ value: loader.mock.calls.length }));

    await runtime.resolve(normalized({ url: '/items' }), loader);
    await runtime.resolve(normalized({ url: '/health' }), loader);
    expect(runtime.cacheSize()).toBe(2);

    expect(runtime.invalidatePrefix('get|/items')).toBe(1);
    expect(runtime.cacheSize()).toBe(1);

    await runtime.resolve(normalized({ url: '/items' }), loader);
    await runtime.resolve(normalized({ url: '/health' }), loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  test('tag invalidation targets associated entries', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope({ ok: true }));

    await runtime.resolve(normalized({
      url: '/districts',
      cacheTags: ['configuration', 'districts'],
    }), loader);
    await runtime.resolve(normalized({
      url: '/layers',
      cacheTags: ['configuration', 'layers'],
    }), loader);
    await runtime.resolve(normalized({
      url: '/health',
      cacheTags: ['health'],
    }), loader);

    expect(runtime.invalidateTags(['configuration'])).toBe(2);
    expect(runtime.cacheSize()).toBe(1);
  });

  test('namespace invalidation isolates cache responsibility areas', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope({ ok: true }));

    await runtime.resolve(normalized({
      url: '/map',
      cacheNamespace: 'bootstrap',
    }), loader);
    await runtime.resolve(normalized({
      url: '/items',
      cacheNamespace: 'catalog',
    }), loader);

    expect(runtime.invalidateNamespace('bootstrap')).toBe(1);
    expect(runtime.cacheSize()).toBe(1);
  });

  test('global clear leaves the runtime reusable', async () => {
    const runtime = new HttpCacheRuntime();
    const loader = vi.fn(async () => envelope({ ok: true }));

    await runtime.resolve(normalized(), loader);
    expect(runtime.clear()).toBe(1);
    expect(runtime.cacheSize()).toBe(0);

    await runtime.resolve(normalized(), loader);
    expect(runtime.cacheSize()).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('prefix invalidation prevents an older in-flight load from writing back', async () => {
    const runtime = new HttpCacheRuntime();
    const pending = deferred<TransportResult<{ version: number }>>();
    const config = normalized();
    const first = runtime.resolve(config, async () => pending.promise);

    await Promise.resolve();
    runtime.invalidatePrefix('get|/items');
    pending.resolve(envelope({ version: 1 }));

    await expect(first).rejects.toBeInstanceOf(CacheFlightError);
    expect(runtime.cacheSize()).toBe(0);
  });
});

describe('HttpCacheRuntime subscriber-aware dedupe', () => {
  test('shares safe GET work even when callers own AbortSignals', async () => {
    const runtime = new HttpCacheRuntime();
    const pending = deferred<TransportResult<{ value: number }>>();
    const loader = vi.fn(async () => pending.promise);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = runtime.resolve(normalized({
      cache: false,
      dedupe: true,
      signal: firstController.signal,
    }), loader);
    const second = runtime.resolve(normalized({
      cache: false,
      dedupe: true,
      signal: secondController.signal,
    }), loader);

    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.inFlightSize()).toBe(1);

    pending.resolve(envelope({ value: 42 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ data: { value: 42 } }),
      expect.objectContaining({ data: { value: 42 } }),
    ]);
    expect(runtime.inFlightSize()).toBe(0);
  });

  test('aborting one subscriber does not cancel work needed by another', async () => {
    const runtime = new HttpCacheRuntime();
    const pending = deferred<TransportResult<{ value: number }>>();
    let operationSignal: AbortSignal | undefined;
    const loader = vi.fn(async (signal?: AbortSignal) => {
      operationSignal = signal;
      return pending.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = runtime.resolve(normalized({
      cache: false,
      dedupe: true,
      signal: firstController.signal,
    }), loader);
    const second = runtime.resolve(normalized({
      cache: false,
      dedupe: true,
      signal: secondController.signal,
    }), loader);

    await Promise.resolve();
    firstController.abort('first-left');
    await expect(first).rejects.toMatchObject({ code: 'subscriber-aborted' });
    expect(operationSignal?.aborted).toBe(false);

    pending.resolve(envelope({ value: 2 }));
    await expect(second).resolves.toMatchObject({ data: { value: 2 } });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('cancels the shared operation after the last subscriber leaves', async () => {
    const runtime = new HttpCacheRuntime();
    let operationSignal: AbortSignal | undefined;
    const loader = vi.fn((signal?: AbortSignal) => {
      operationSignal = signal;
      return new Promise<TransportResult<never>>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();

    const request = runtime.resolve(normalized({
      cache: false,
      dedupe: true,
      signal: controller.signal,
    }), loader);

    await Promise.resolve();
    controller.abort('gone');
    await expect(request).rejects.toMatchObject({ code: 'subscriber-aborted' });
    expect(operationSignal?.aborted).toBe(true);
    expect(runtime.inFlightSize()).toBe(0);
  });

  test('does not share non-deduplicated requests', async () => {
    const runtime = new HttpCacheRuntime();
    const pendingOne = deferred<TransportResult<{ id: number }>>();
    const pendingTwo = deferred<TransportResult<{ id: number }>>();
    const loader = vi.fn()
      .mockImplementationOnce(async () => pendingOne.promise)
      .mockImplementationOnce(async () => pendingTwo.promise);
    const config = normalized({ cache: false, dedupe: false });

    const first = runtime.resolve(config, loader);
    const second = runtime.resolve(config, loader);
    expect(loader).toHaveBeenCalledTimes(2);

    pendingOne.resolve(envelope({ id: 1 }));
    pendingTwo.resolve(envelope({ id: 2 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe('HttpCacheRuntime stale-while-revalidate', () => {
  test('serves stale data immediately and refreshes it once in the background', async () => {
    let clock = 1_000;
    const coordinator = new CacheCoordinator({
      storeOptions: {
        clock: { now: () => clock },
      },
    });
    const runtime = new HttpCacheRuntime({ coordinator });
    const loader = vi.fn()
      .mockImplementationOnce(async () => envelope({ version: 1 }))
      .mockImplementationOnce(async () => envelope({ version: 2 }));
    const config = normalized({
      cacheTtlMs: 10,
      cacheStaleWhileRevalidateMs: 100,
    });

    const first = await runtime.resolve(config, loader);
    expect(first.data).toEqual({ version: 1 });

    clock = 1_020;
    const stale = await runtime.resolve(config, loader);
    expect(stale.data).toEqual({ version: 1 });
    expect(stale.fromCache).toBe(true);
    expect(stale.metadata?.cache).toBe('stale-cache');

    await Promise.resolve();
    await Promise.resolve();

    const refreshed = await runtime.resolve(config, loader);
    expect(refreshed.data).toEqual({ version: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('coalesces concurrent cache misses into one governed load', async () => {
    const runtime = new HttpCacheRuntime();
    const pending = deferred<TransportResult<{ value: number }>>();
    const loader = vi.fn(async () => pending.promise);
    const config = normalized();

    const first = runtime.resolve(config, loader);
    const second = runtime.resolve(config, loader);
    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().cacheFlights.flights).toBe(1);

    pending.resolve(envelope({ value: 7 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runtime.snapshot().cache.sharedLoads).toBeGreaterThanOrEqual(1);
  });
});

describe('HttpCacheRuntime observability safety', () => {
  test('emits bounded lifecycle metadata without query-string secrets', async () => {
    const events: Array<{ name: string; metadata: Record<string, unknown> }> = [];
    const runtime = new HttpCacheRuntime({
      onEvent: (name, metadata) => events.push({ name, metadata }),
    });
    const loader = vi.fn(async () => envelope({ ok: true }));
    const config = normalized({
      url: '/items',
      params: { page: 1 },
    });

    await runtime.resolve(config, loader);
    await runtime.resolve(config, loader);

    expect(events.some((event) => event.name === 'network.cache.resolved')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('/items');
    expect(serialized).not.toContain('?');
  });

  test('snapshot reports cache and both flight domains', () => {
    const runtime = new HttpCacheRuntime();
    expect(runtime.snapshot()).toMatchObject({
      cache: {
        reads: 0,
        freshHits: 0,
        staleHits: 0,
        misses: 0,
      },
      store: {
        entries: 0,
      },
      cacheFlights: {
        flights: 0,
      },
      dedupeFlights: {
        flights: 0,
      },
      totalFlights: 0,
    });
  });
});
