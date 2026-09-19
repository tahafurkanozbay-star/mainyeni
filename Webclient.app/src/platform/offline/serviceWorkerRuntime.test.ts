import { vi } from 'vitest';
import { createServiceWorkerRuntime, type FetchEventLike, type MessageEventLike, type ServiceWorkerScopeLike, type WaitUntilEventLike } from './serviceWorkerRuntime';
import { createOfflinePolicy } from './offlinePolicy';

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

  async keys(): Promise<readonly string[]> {
    return [...this.caches.keys()];
  }
}

interface ScopeFixture {
  readonly scope: ServiceWorkerScopeLike;
  readonly cacheStorage: MemoryCacheStorage;
  readonly fetchMock: ReturnType<typeof vi.fn>;
  readonly claim: ReturnType<typeof vi.fn>;
  readonly skipWaiting: ReturnType<typeof vi.fn>;
  readonly listeners: Map<string, (event: never) => void>;
}

const createScope = (): ScopeFixture => {
  const cacheStorage = new MemoryCacheStorage();
  const listeners = new Map<string, (event: never) => void>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const response = new Response('network:' + new URL(request.url).pathname, {
      status: 200,
      headers: { 'cache-control': 'public, max-age=60' },
    });
    Object.defineProperty(response, 'url', { value: request.url });
    return response;
  });
  const claim = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);

  const scope = {
    caches: cacheStorage as unknown as CacheStorage,
    clients: {
      claim,
      matchAll: vi.fn(async () => [{ id: 'client-1' }, { id: 'client-2' }]),
    },
    registration: {
      scope: 'https://example.test/',
      waiting: null,
    },
    location: new URL('https://example.test/service-worker.js') as unknown as Location,
    navigator: { onLine: true },
    fetch: fetchMock,
    skipWaiting,
    addEventListener: (type: string, listener: (event: never) => void): void => {
      listeners.set(type, listener);
    },
  } as unknown as ServiceWorkerScopeLike;

  return { scope, cacheStorage, fetchMock, claim, skipWaiting, listeners };
};

const fetchEvent = (request: Request): FetchEventLike & { waits: Promise<unknown>[] } => {
  const waits: Promise<unknown>[] = [];
  return {
    request,
    waits,
    waitUntil: (promise) => waits.push(promise),
    respondWith: vi.fn(),
  };
};

describe('service worker runtime lifecycle', () => {
  test('install seeds root navigation shell when network is available', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    await runtime.install();
    const cache = fixture.cacheStorage.caches.get('kent-rehberi-test-static');
    expect(cache).toBeDefined();
    expect(cache?.values.has('https://example.test/')).toBe(true);
  });

  test('install tolerates first-run network failure', async () => {
    const fixture = createScope();
    fixture.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    await expect(runtime.install()).resolves.toBeUndefined();
  });

  test('activate deletes only stale caches with owned prefix', async () => {
    const fixture = createScope();
    fixture.cacheStorage.caches.set('kent-rehberi-old-static', new MemoryCache());
    fixture.cacheStorage.caches.set('unrelated-cache', new MemoryCache());
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'current' }),
    });
    await runtime.activate();
    expect(fixture.cacheStorage.caches.has('kent-rehberi-old-static')).toBe(false);
    expect(fixture.cacheStorage.caches.has('unrelated-cache')).toBe(true);
    expect(fixture.claim).toHaveBeenCalledTimes(1);
  });

  test('attach registers install activate fetch and message listeners exactly once', () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    runtime.attach();
    expect([...fixture.listeners.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'message']);
    const size = fixture.listeners.size;
    runtime.attach();
    expect(fixture.listeners.size).toBe(size);
  });
});

describe('service worker fetch strategies', () => {
  test('static cache miss uses network and stores response', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    const request = new Request('https://example.test/assets/app.js');
    Object.defineProperty(request, 'destination', { value: 'script' });
    const event = fetchEvent(request);
    const response = await runtime.handleFetch(event);
    expect(await response.text()).toContain('network:/assets/app.js');
    await Promise.all(event.waits);
    const cache = fixture.cacheStorage.caches.get('kent-rehberi-test-static');
    expect(cache?.values.has(request.url)).toBe(true);
  });

  test('static cache hit returns stale response and refreshes in background', async () => {
    const fixture = createScope();
    const cache = new MemoryCache();
    await cache.put('https://example.test/assets/app.js', new Response('cached'));
    fixture.cacheStorage.caches.set('kent-rehberi-test-static', cache);
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    await runtime.activate();

    const request = new Request('https://example.test/assets/app.js');
    Object.defineProperty(request, 'destination', { value: 'script' });
    const event = fetchEvent(request);
    const response = await runtime.handleFetch(event);
    expect(await response.text()).toBe('cached');
    expect(response.headers.get('x-kent-rehberi-offline')).toBe('stale');
    expect(event.waits).toHaveLength(1);
    await Promise.all(event.waits);
    expect(fixture.fetchMock).toHaveBeenCalled();
  });

  test('navigation network failure falls back to cached shell', async () => {
    const fixture = createScope();
    const cache = new MemoryCache();
    await cache.put('https://example.test/', new Response('<html>shell</html>', {
      headers: { 'content-type': 'text/html' },
    }));
    fixture.cacheStorage.caches.set('kent-rehberi-test-static', cache);
    fixture.fetchMock.mockRejectedValue(new TypeError('offline'));
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    await runtime.activate();

    const request = new Request('https://example.test/map');
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    Object.defineProperty(request, 'destination', { value: 'document' });
    const response = await runtime.handleFetch(fetchEvent(request));
    expect(await response.text()).toContain('shell');
    expect(response.headers.get('x-kent-rehberi-offline')).toBe('shell-fallback');
  });

  test('uncached navigation failure returns bounded offline document', async () => {
    const fixture = createScope();
    fixture.fetchMock.mockRejectedValue(new TypeError('offline'));
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    const request = new Request('https://example.test/map');
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    Object.defineProperty(request, 'destination', { value: 'document' });
    const response = await runtime.handleFetch(fetchEvent(request));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Çevrimdışı');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('API response without public opt-in is not cached', async () => {
    const fixture = createScope();
    fixture.fetchMock.mockImplementationOnce(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const response = new Response('{"ok":true}', { status: 200 });
      Object.defineProperty(response, 'url', { value: request.url });
      return response;
    });
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    const request = new Request('https://example.test/api/items', {
      headers: { accept: 'application/json' },
    });
    const event = fetchEvent(request);
    await runtime.handleFetch(event);
    await Promise.all(event.waits);
    const cache = fixture.cacheStorage.caches.get('kent-rehberi-test-api');
    expect(cache?.values.has(request.url) ?? false).toBe(false);
  });

  test('API response with explicit public opt-in is cached for offline fallback', async () => {
    const fixture = createScope();
    fixture.fetchMock.mockImplementationOnce(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const response = new Response('{"ok":true}', {
        status: 200,
        headers: { 'x-kent-rehberi-offline': 'public' },
      });
      Object.defineProperty(response, 'url', { value: request.url });
      return response;
    });
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    const request = new Request('https://example.test/api/items', {
      headers: { accept: 'application/json' },
    });
    const event = fetchEvent(request);
    await runtime.handleFetch(event);
    await Promise.all(event.waits);
    expect(fixture.cacheStorage.caches.get('kent-rehberi-test-api')?.values.has(request.url)).toBe(true);

    fixture.fetchMock.mockRejectedValue(new TypeError('offline'));
    const fallback = await runtime.handleFetch(fetchEvent(request));
    expect(await fallback.text()).toBe('{"ok":true}');
    expect(fallback.headers.get('x-kent-rehberi-offline')).toBe('cache-fallback');
  });

  test('cross-origin and write requests bypass owned caches', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    const cross = await runtime.handleFetch(fetchEvent(new Request('https://cdn.example/app.js')));
    expect(await cross.text()).toContain('network:/app.js');

    const post = new Request('https://example.test/api/items', { method: 'POST', body: '{}' });
    const write = await runtime.handleFetch(fetchEvent(post));
    expect(await write.text()).toContain('network:/api/items');
    expect(fixture.cacheStorage.caches.size).toBe(0);
  });
});

describe('service worker messages and status', () => {
  test('status reports bounded cache and client counts', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    await runtime.install();
    const status = await runtime.status();
    expect(status.protocolVersion).toBe(1);
    expect(status.cacheVersion).toBe('test');
    expect(status.scope).toBe('https://example.test/');
    expect(status.controlledClients).toBe(2);
    expect(status.cacheNames).toContain('kent-rehberi-test-static');
  });

  test('ping replies through MessagePort when present', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      now: () => 123,
    });
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const event: MessageEventLike = {
      data: { protocolVersion: 1, id: 'ping-1', type: 'ping' },
      ports: [port],
      waitUntil: vi.fn(),
    };
    await runtime.handleMessage(event);
    expect(port.postMessage).toHaveBeenCalledWith({
      protocolVersion: 1,
      id: 'ping-1',
      ok: true,
      type: 'pong',
      timestamp: 123,
    });
  });

  test('skip waiting is explicit message only', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    expect(fixture.skipWaiting).not.toHaveBeenCalled();
    const source = { postMessage: vi.fn() };
    const event: MessageEventLike = {
      data: { protocolVersion: 1, id: 'skip-1', type: 'skip-waiting' },
      source,
      waitUntil: vi.fn(),
    };
    await runtime.handleMessage(event);
    expect(fixture.skipWaiting).toHaveBeenCalledTimes(1);
    expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'skip-1',
      ok: true,
      type: 'skip-waiting',
    }));
  });

  test('clear-cache deletes only requested owned cache', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({
      scope: fixture.scope,
      policy: createOfflinePolicy({ cacheVersion: 'test' }),
    });
    const staticCache = await fixture.cacheStorage.open('kent-rehberi-test-static');
    const apiCache = await fixture.cacheStorage.open('kent-rehberi-test-api');
    await staticCache.put(new Request('https://example.test/assets/a.js'), new Response('a'));
    await apiCache.put(new Request('https://example.test/api/a'), new Response('a'));

    const source = { postMessage: vi.fn() };
    await runtime.handleMessage({
      data: { protocolVersion: 1, id: 'clear-1', type: 'clear-cache', cache: 'static' },
      source,
      waitUntil: vi.fn(),
    });
    expect(fixture.cacheStorage.caches.has('kent-rehberi-test-static')).toBe(false);
    expect(fixture.cacheStorage.caches.has('kent-rehberi-test-api')).toBe(true);
  });

  test('invalid protocol message is ignored without side effects', async () => {
    const fixture = createScope();
    const runtime = createServiceWorkerRuntime({ scope: fixture.scope });
    const source = { postMessage: vi.fn() };
    await runtime.handleMessage({
      data: { protocolVersion: 99, id: 'x', type: 'clear-cache' },
      source,
      waitUntil: vi.fn(),
    });
    expect(source.postMessage).not.toHaveBeenCalled();
  });
});
