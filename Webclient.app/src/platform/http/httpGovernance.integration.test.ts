import { describe, expect, test, vi } from 'vitest';
import { createFetchTransport } from './fetchTransport';
import { createRequestCoordinator } from './requestCoordinator';
import type { TransportResult } from './contracts';

const createHeaders = (values: Record<string, string> = {}) => {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get: (name: string) => normalized[name.toLowerCase()] ?? null,
    forEach: (callback: (value: string, key: string) => void) => {
      for (const [key, value] of Object.entries(normalized)) callback(value, key);
    },
  };
};

const jsonResponse = (
  body: unknown,
  options: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  } = {},
): Response => {
  const status = options.status ?? 200;
  const text = JSON.stringify(body);
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'ERROR',
    ok: status >= 200 && status < 300,
    headers: createHeaders({
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(text).byteLength),
      ...(options.headers ?? {}),
    }),
    text: vi.fn(async () => text),
  } as unknown as Response;
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

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('HTTP governance end-to-end cache and transport composition', () => {
  test('bounded response can flow through fetch, cache and logical lifecycle ownership', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: 1 }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const first = await coordinator.request<{ version: number }>({
      method: 'get',
      url: '/items',
      cache: true,
      cacheClassification: 'internal',
      cacheTtlMs: 30_000,
      maxResponseBytes: 1024,
    });
    const second = await coordinator.request<{ version: number }>({
      method: 'get',
      url: '/items',
      cache: true,
      cacheClassification: 'internal',
      cacheTtlMs: 30_000,
      maxResponseBytes: 1024,
    });

    expect(first).toMatchObject({ data: { version: 1 }, fromCache: false });
    expect(second).toMatchObject({ data: { version: 1 }, fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(coordinator.getCacheSize()).toBe(1);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      started: 2,
      succeeded: 2,
    });
  });

  test('oversized success response fails and never enters the cache', async () => {
    const text = vi.fn(async () => JSON.stringify({ payload: 'x'.repeat(4_000) }));
    const fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: createHeaders({
        'content-type': 'application/json',
        'content-length': '4096',
      }),
      text,
    } as unknown as Response));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await expect(coordinator.request({
      method: 'get',
      url: '/large',
      cache: true,
      cacheTtlMs: 30_000,
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });

    expect(text).not.toHaveBeenCalled();
    expect(coordinator.getCacheSize()).toBe(0);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      failed: 1,
    });
  });

  test('oversized request body fails before fetch but remains visible as a logical failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await expect(coordinator.request({
      method: 'post',
      url: '/items',
      data: { payload: 'x'.repeat(4_000) },
      maxRequestBodyBytes: 1024,
    })).rejects.toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      failed: 1,
    });
  });

  test('personal classification bypasses retention while preserving transport behavior', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ profile: 'minimal' }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({
      method: 'get',
      url: '/profile',
      cache: true,
      cacheClassification: 'personal',
    });
    await coordinator.request({
      method: 'get',
      url: '/profile',
      cache: true,
      cacheClassification: 'personal',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(coordinator.getCacheSize()).toBe(0);
  });

  test('sensitive request metadata disables both cache retention and shared-flight reuse', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async () => gate.promise);
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const first = coordinator.request({
      method: 'get',
      url: '/search',
      params: { token: 'private', page: 1 },
      cache: true,
      dedupe: true,
    });
    const second = coordinator.request({
      method: 'get',
      url: '/search',
      params: { token: 'private', page: 1 },
      cache: true,
      dedupe: true,
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    gate.resolve(jsonResponse({ ok: true }));
    await Promise.all([first, second]);
    expect(coordinator.getCacheSize()).toBe(0);
  });
});

describe('HTTP governance invalidation and ownership composition', () => {
  test('tag invalidation refreshes only the tagged resource family', async () => {
    let version = 0;
    const fetchMock = vi.fn(async () => jsonResponse({ version: ++version }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({
      method: 'get',
      url: '/districts',
      cache: true,
      cacheTags: ['configuration'],
    });
    await coordinator.request({
      method: 'get',
      url: '/health',
      cache: true,
      cacheTags: ['health'],
    });
    expect(coordinator.getCacheSize()).toBe(2);

    expect(coordinator.invalidateCacheTags(['configuration'])).toBe(1);
    await coordinator.request({
      method: 'get',
      url: '/districts',
      cache: true,
      cacheTags: ['configuration'],
    });
    await coordinator.request({
      method: 'get',
      url: '/health',
      cache: true,
      cacheTags: ['health'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('namespace invalidation isolates cache ownership domains', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({
      method: 'get',
      url: '/config',
      cache: true,
      cacheNamespace: 'bootstrap',
    });
    await coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
      cacheNamespace: 'catalog',
    });

    expect(coordinator.invalidateCacheNamespace('bootstrap')).toBe(1);
    expect(coordinator.getCacheSize()).toBe(1);
  });

  test('legacy prefix invalidation remains compatible with canonical cache identities', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({ method: 'get', url: '/items', cache: true });
    await coordinator.request({ method: 'get', url: '/other', cache: true });

    expect(coordinator.invalidateCache('get|/items')).toBe(1);
    expect(coordinator.getCacheSize()).toBe(1);
  });

  test('global clear is reusable and does not dispose the HTTP client', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({ method: 'get', url: '/items', cache: true });
    expect(coordinator.clearCache()).toBe(1);
    expect(coordinator.getCacheSize()).toBe(0);

    await expect(coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
    })).resolves.toMatchObject({ status: 200 });
    expect(coordinator.getCacheSize()).toBe(1);
  });
});

describe('HTTP governance cancellation and dedupe composition', () => {
  test('two caller signals share one safe transport flight', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async () => gate.promise);
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: firstController.signal,
    });
    const second = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: secondController.signal,
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(coordinator.getInFlightSize()).toBe(1);

    gate.resolve(jsonResponse({ ok: true }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(coordinator.getInFlightSize()).toBe(0);
  });

  test('one cancelled subscriber leaves shared transport work alive for the other', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async () => gate.promise);
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: firstController.signal,
    });
    const second = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: secondController.signal,
    });
    await flush();

    firstController.abort('route-left');
    await expect(first).rejects.toMatchObject({ code: 'subscriber-aborted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    gate.resolve(jsonResponse({ ok: true }));
    await expect(second).resolves.toMatchObject({ data: { ok: true } });
  });

  test('drain waits for cache/dedupe-owned work without admitting new requests', async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async () => gate.promise);
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const running = coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
    });
    await flush();

    const drain = coordinator.drain();
    await expect(coordinator.request({
      method: 'get',
      url: '/late',
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_OPEN' });

    gate.resolve(jsonResponse({ ok: true }));
    await running;
    await expect(drain).resolves.toBeUndefined();
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'closed',
      active: 0,
    });
  });

  test('dispose cancels active fetch ownership and leaves no in-flight registry entries', async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const running = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
    });
    await flush();

    coordinator.dispose(new Error('shutdown'));
    await expect(running).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(coordinator.getInFlightSize()).toBe(0);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'disposed',
      active: 0,
    });
  });
});

describe('HTTP governance privacy and diagnostics composition', () => {
  test('response header snapshots omit credential-bearing headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { ok: true },
      {
        headers: {
          'x-request-id': 'req-1',
          'set-cookie': 'session=secret',
          'x-api-key': 'secret-key',
          etag: '"safe"',
        },
      },
    ));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const result = await coordinator.request<{ ok: boolean }>({
      method: 'get',
      url: '/items',
      includeResponseHeaders: true,
    });
    const metadata = result.metadata as Record<string, unknown>;
    const responseHeaders = metadata.headers as Record<string, string>;

    expect(responseHeaders).toMatchObject({
      'x-request-id': 'req-1',
      etag: '"safe"',
    });
    expect(JSON.stringify(responseHeaders)).not.toContain('secret');
    expect(responseHeaders['set-cookie']).toBeUndefined();
    expect(responseHeaders['x-api-key']).toBeUndefined();
  });

  test('request scope history never retains query parameter values', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({
      method: 'get',
      url: '/search',
      params: { q: 'private-address' },
    });

    const serialized = JSON.stringify(coordinator.getRequestScopeSnapshot());
    expect(serialized).toContain('/search');
    expect(serialized).not.toContain('private-address');
  });

  test('cache runtime snapshot exposes only bounded aggregate state', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
      cacheTags: ['catalog'],
    });

    expect(coordinator.getCacheRuntimeSnapshot()).toMatchObject({
      store: {
        entries: 1,
        namespaces: 1,
      },
      totalFlights: 0,
    });
    expect(JSON.stringify(coordinator.getCacheRuntimeSnapshot())).not.toContain('/items');
  });
});

describe('HTTP governance error semantics remain compatible', () => {
  test('HTTP 429 stays retryable while its body remains bounded', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { message: 'too many' },
      {
        status: 429,
        headers: {
          'retry-after': '1',
          'x-request-id': 'rate-1',
        },
      },
    ));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
      maxRetries: 0,
    });

    await expect(coordinator.request({
      method: 'get',
      url: '/rate-limited',
      maxRetries: 0,
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
      requestId: 'rate-1',
    });
  });

  test('HTTP 400 remains non-retryable and preserves bounded safe message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { message: 'District is required' },
      { status: 400 },
    ));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    await expect(coordinator.request({
      method: 'post',
      url: '/district',
      data: { district: '' },
    })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
      retryable: false,
      message: 'District is required',
    });
  });

  test('network rejection remains retryable without leaking arbitrary response material', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
      maxRetries: 0,
    });

    await expect(coordinator.request({
      method: 'get',
      url: '/offline',
      maxRetries: 0,
    })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  });
});

describe('HTTP governance success envelope compatibility', () => {
  test('transport result remains immutable and cache-compatible', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: 7 }));
    const coordinator = createRequestCoordinator({
      transport: createFetchTransport({
        baseUrl: '/api',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    });

    const result: TransportResult<{ value: number }> = await coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
    });

    expect(result).toMatchObject({
      data: { value: 7 },
      status: 200,
      statusText: 'OK',
      fromCache: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
