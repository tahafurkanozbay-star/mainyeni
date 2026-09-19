import { createOfflineCacheStore } from './cacheStore';
import type { OfflineCacheLimits } from './contracts';

const limits: OfflineCacheLimits = Object.freeze({
  maxEntries: 2,
  maxBytes: 100,
  maxEntryBytes: 80,
  maxAgeMs: 60_000,
});

class MemoryCache {
  readonly values = new Map<string, Response>();

  async match(request: Request | string): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request.url;
    return this.values.get(key)?.clone();
  }

  async put(request: Request | string, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : request.url;
    this.values.set(key, response.clone());
  }

  async delete(request: Request | string): Promise<boolean> {
    const key = typeof request === 'string' ? request : request.url;
    return this.values.delete(key);
  }

  async keys(): Promise<readonly Request[]> {
    return [...this.values.keys()].map((key) => new Request(key));
  }
}

class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

const req = (name: string): Request => new Request('https://example.test/' + name);

describe('offline cache store', () => {
  test('stores measured response bytes and serves clone', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    const response = new Response('hello');
    const result = await store.put(req('a'), response, 'static');
    expect(result.stored).toBe(true);
    expect(result.bytes).toBe(5);
    expect(await (await store.match(req('a')))?.text()).toBe('hello');
    expect(store.ledger.snapshot().hits).toBe(1);
  });

  test('uses content-length without consuming body measurement', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    const response = new Response('hello', {
      headers: { 'content-length': '5' },
    });
    const result = await store.put(req('a'), response, 'static');
    expect(result.bytes).toBe(5);
  });

  test('rejects response larger than per-entry budget', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    const result = await store.put(req('huge'), new Response('x'.repeat(81)), 'static');
    expect(result).toMatchObject({
      stored: false,
      reason: 'entry-too-large',
      bytes: 0,
    });
    expect(await store.match(req('huge'))).toBeNull();
  });

  test('rejects declared content-length above budget', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    const response = new Response('tiny', {
      headers: { 'content-length': '999' },
    });
    const result = await store.put(req('huge'), response, 'static');
    expect(result.stored).toBe(false);
  });

  test('evicts oldest cache entry when max entries exceeded', async () => {
    let now = 0;
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
      now: () => ++now,
    });
    await store.put(req('a'), new Response('a'), 'static');
    await store.put(req('b'), new Response('b'), 'static');
    const third = await store.put(req('c'), new Response('c'), 'static');
    expect(third.evicted).toEqual(['https://example.test/a']);
    expect(await store.match(req('a'))).toBeNull();
    expect(await store.match(req('b'))).not.toBeNull();
    expect(await store.match(req('c'))).not.toBeNull();
  });

  test('evicts by aggregate byte budget', async () => {
    const storage = new MemoryCacheStorage();
    const byteLimits = { ...limits, maxEntries: 10, maxBytes: 10 };
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits: byteLimits,
    });
    await store.put(req('a'), new Response('123456'), 'static');
    const result = await store.put(req('b'), new Response('abcdef'), 'static');
    expect(result.evicted).toContain('https://example.test/a');
    expect(store.ledger.snapshot().bytes).toBeLessThanOrEqual(10);
  });

  test('delete removes ledger and cache atomically enough for retries', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    await store.put(req('a'), new Response('a'), 'static');
    expect(await store.delete(req('a'))).toBe(true);
    expect(store.ledger.get('https://example.test/a')).toBeNull();
    expect(await store.delete(req('a'))).toBe(false);
  });

  test('clear deletes named cache and returns tracked entry count', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    await store.put(req('a'), new Response('a'), 'static');
    await store.put(req('b'), new Response('b'), 'static');
    expect(await store.clear()).toBe(2);
    expect(storage.caches.has('test')).toBe(false);
  });

  test('hydrate reconstructs unmeasured records for existing cache entries', async () => {
    const storage = new MemoryCacheStorage();
    const cache = await storage.open('test');
    await cache.put(req('a'), new Response('a'));
    await cache.put(req('b'), new Response('bb', { headers: { 'content-length': '2' } }));
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    expect(await store.hydrate()).toBe(2);
    const snapshot = store.ledger.snapshot();
    expect(snapshot.entries).toBe(2);
    expect(snapshot.measuredEntries).toBe(1);
    expect(snapshot.unmeasuredEntries).toBe(1);
  });

  test('hydrate is idempotent for known keys', async () => {
    const storage = new MemoryCacheStorage();
    const cache = await storage.open('test');
    await cache.put(req('a'), new Response('a'));
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    expect(await store.hydrate()).toBe(1);
    expect(await store.hydrate()).toBe(0);
  });

  test('cache miss removes stale ledger metadata', async () => {
    const storage = new MemoryCacheStorage();
    const store = createOfflineCacheStore({
      cacheStorage: storage as unknown as CacheStorage,
      cacheName: 'test',
      limits,
    });
    store.ledger.record('https://example.test/a', { kind: 'static', bytes: 1 });
    expect(store.ledger.size()).toBe(1);
    expect(await store.match(req('a'))).toBeNull();
    expect(store.ledger.size()).toBe(0);
  });
});
