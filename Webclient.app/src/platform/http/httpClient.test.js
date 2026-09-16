import { RequestCache } from '../cache/requestCache';
import { AppError } from '../errors/appError';
import { RequestTelemetry } from '../telemetry/requestTelemetry';
import { createApiClient, stableSerialize } from './httpClient';

const success = (data, status = 200, headers = {}) => ({ data, status, headers });

const httpError = (status, data = null, headers = {}) => Object.assign(
  new Error(`HTTP ${status}`),
  {
    name: 'HttpTransportError',
    code: 'HTTP_ERROR',
    status,
    response: { status, data, headers }
  }
);

const createClient = ({ transport, retryWait, telemetry, cache } = {}) => createApiClient({
  transport: transport || jest.fn().mockResolvedValue(success({ ok: true })),
  retryWait: retryWait || jest.fn().mockResolvedValue(undefined),
  telemetry: telemetry === undefined
    ? new RequestTelemetry({ now: () => Date.now(), capacity: 100, windowMs: 60000 })
    : telemetry,
  cache: cache || new RequestCache({ ttlMs: 60000, maxEntries: 20 })
});

describe('stableSerialize', () => {
  test('is stable across object key order', () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
  });

  test('preserves array order', () => {
    expect(stableSerialize([1, 2, 3])).not.toBe(stableSerialize([3, 2, 1]));
  });

  test('normalizes Date values', () => {
    expect(stableSerialize(new Date('2026-09-16T06:00:00Z')))
      .toBe('"2026-09-16T06:00:00.000Z"');
  });

  test('throws for circular request parameters', () => {
    const value = {};
    value.self = value;
    expect(() => stableSerialize(value)).toThrow(/Circular/);
  });
});

describe('createApiClient basic transport contract', () => {
  test('GET returns response data only', async () => {
    const transport = jest.fn().mockResolvedValue(success({ items: [1, 2] }));
    const client = createClient({ transport });

    await expect(client.get('/items')).resolves.toEqual({ items: [1, 2] });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get',
      url: '/items'
    }));
  });

  test('POST forwards body and method', async () => {
    const transport = jest.fn().mockResolvedValue(success({ saved: true }, 201));
    const client = createClient({ transport });

    await expect(client.post('/items', { name: 'Ankara' })).resolves.toEqual({ saved: true });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      method: 'post',
      url: '/items',
      data: { name: 'Ankara' },
      cache: false,
      dedupe: false
    }));
  });

  test.each([
    ['put', 'put'],
    ['patch', 'patch'],
    ['delete', 'delete'],
    ['head', 'head']
  ])('%s helper maps method', async (helper, method) => {
    const transport = jest.fn().mockResolvedValue(success({ ok: true }));
    const client = createClient({ transport });
    if (helper === 'put' || helper === 'patch') {
      await client[helper]('/resource', { value: 1 });
    } else {
      await client[helper]('/resource');
    }
    expect(transport.mock.calls[0][0].method).toBe(method);
  });

  test('blocks cross-origin endpoint before transport', async () => {
    const transport = jest.fn();
    const client = createClient({ transport });
    await expect(client.get('https://evil.example/data')).rejects.toBeInstanceOf(AppError);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('createApiClient retry behavior', () => {
  test('retries transient GET and then returns success', async () => {
    const transport = jest.fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(success({ ok: true }));
    const retryWait = jest.fn().mockResolvedValue(undefined);
    const client = createClient({ transport, retryWait });

    await expect(client.get('/items', {
      maxRetries: 2,
      retryBaseDelayMs: 10,
      retryJitterRatio: 0,
      retryRandom: () => 0.5
    })).resolves.toEqual({ ok: true });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(retryWait).toHaveBeenCalledWith(10, undefined);
  });

  test('honors Retry-After on 429', async () => {
    const headers = { get: (name) => name.toLowerCase() === 'retry-after' ? '2' : null };
    const transport = jest.fn()
      .mockRejectedValueOnce(httpError(429, null, headers))
      .mockResolvedValueOnce(success({ ok: true }));
    const retryWait = jest.fn().mockResolvedValue(undefined);
    const client = createClient({ transport, retryWait });

    await client.get('/search', { maxRetries: 1 });

    expect(retryWait).toHaveBeenCalledWith(2000, undefined);
  });

  test('does not retry non-retryable client error', async () => {
    const transport = jest.fn().mockRejectedValue(httpError(404));
    const retryWait = jest.fn();
    const client = createClient({ transport, retryWait });

    await expect(client.get('/missing', { maxRetries: 4 })).rejects.toMatchObject({
      code: 'NOT_FOUND', status: 404
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(retryWait).not.toHaveBeenCalled();
  });

  test('does not retry POST by default', async () => {
    const transport = jest.fn().mockRejectedValue(httpError(503));
    const client = createClient({ transport });

    await expect(client.post('/items', { value: 1 }, { maxRetries: 4 }))
      .rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('allows explicit retryUnsafe for idempotency-aware mutation', async () => {
    const transport = jest.fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(success({ saved: true }));
    const client = createClient({ transport });

    await expect(client.post('/commands/retryable', { value: 1 }, {
      maxRetries: 1,
      retryUnsafe: true,
      retryBaseDelayMs: 0,
      retryJitterRatio: 0
    })).resolves.toEqual({ saved: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('stops after configured retries and normalizes final error', async () => {
    const transport = jest.fn().mockRejectedValue(httpError(503));
    const client = createClient({ transport });

    await expect(client.get('/unstable', {
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryJitterRatio: 0
    })).rejects.toMatchObject({ code: 'SERVER_ERROR', status: 503 });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  test('abort never retries', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORTED' });
    const transport = jest.fn().mockRejectedValue(abort);
    const client = createClient({ transport });

    await expect(client.get('/slow', { maxRetries: 4 })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('createApiClient cache behavior', () => {
  test('explicit public GET cache prevents repeat transport', async () => {
    const transport = jest.fn().mockResolvedValue(success({ value: 1 }));
    const client = createClient({ transport });

    expect(await client.get('/config', { cache: true })).toEqual({ value: 1 });
    expect(await client.get('/config', { cache: true })).toEqual({ value: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(client.getCacheSize()).toBe(1);
  });

  test('different params do not share cache entry', async () => {
    const transport = jest.fn(({ params }) => Promise.resolve(success({ page: params.page })));
    const client = createClient({ transport });

    expect(await client.get('/items', { cache: true, params: { page: 1 } })).toEqual({ page: 1 });
    expect(await client.get('/items', { cache: true, params: { page: 2 } })).toEqual({ page: 2 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('authorization header disables cache even when requested', async () => {
    const transport = jest.fn().mockResolvedValue(success({ private: true }));
    const client = createClient({ transport });
    const options = { cache: true, headers: { Authorization: 'Bearer token' } };

    await client.get('/profile', options);
    await client.get('/profile', options);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(client.getCacheSize()).toBe(0);
  });

  test('successful mutation clears previous public cache', async () => {
    const transport = jest.fn()
      .mockResolvedValueOnce(success({ value: 1 }))
      .mockResolvedValueOnce(success({ saved: true }))
      .mockResolvedValueOnce(success({ value: 2 }));
    const client = createClient({ transport });

    await client.get('/config', { cache: true });
    expect(client.getCacheSize()).toBe(1);
    await client.post('/config', { value: 2 });
    expect(client.getCacheSize()).toBe(0);
    expect(await client.get('/config', { cache: true })).toEqual({ value: 2 });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  test('failed mutation does not clear valid cache', async () => {
    const transport = jest.fn()
      .mockResolvedValueOnce(success({ value: 1 }))
      .mockRejectedValueOnce(httpError(422));
    const client = createClient({ transport });

    await client.get('/config', { cache: true });
    await expect(client.post('/config', { invalid: true })).rejects.toBeDefined();
    expect(client.getCacheSize()).toBe(1);
    expect(await client.get('/config', { cache: true })).toEqual({ value: 1 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('manual cache invalidation is preserved', async () => {
    const transport = jest.fn(({ url }) => Promise.resolve(success({ url })));
    const client = createClient({ transport });
    await client.get('/config/a', { cache: true });
    await client.get('/config/b', { cache: true });
    expect(client.getCacheSize()).toBe(2);
    expect(client.invalidateCache('get|/config')).toBe(2);
    expect(client.getCacheSize()).toBe(0);
  });
});

describe('createApiClient in-flight deduplication', () => {
  test('shares identical public GET request', async () => {
    let resolveRequest;
    const transport = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const client = createClient({ transport });

    const first = client.get('/config', { dedupe: true });
    const second = client.get('/config', { dedupe: true });
    expect(client.getInFlightCount()).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);

    resolveRequest(success({ ok: true }));
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(client.getInFlightCount()).toBe(0);
  });

  test('signal-bearing request is not deduplicated', async () => {
    const transport = jest.fn().mockResolvedValue(success({ ok: true }));
    const client = createClient({ transport });
    const controller = new AbortController();

    await Promise.all([
      client.get('/config', { dedupe: true, signal: controller.signal }),
      client.get('/config', { dedupe: true, signal: controller.signal })
    ]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('authorization-bearing request is not deduplicated', async () => {
    const transport = jest.fn().mockResolvedValue(success({ ok: true }));
    const client = createClient({ transport });
    const options = { dedupe: true, headers: { authorization: 'Bearer secret' } };
    await Promise.all([client.get('/profile', options), client.get('/profile', options)]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('createApiClient telemetry integration', () => {
  test('exposes bounded telemetry snapshot and summary', async () => {
    let now = 100;
    const telemetry = new RequestTelemetry({ now: () => now, capacity: 100, windowMs: 60000 });
    const transport = jest.fn().mockResolvedValue(success({ ok: true }));
    const client = createClient({ transport, telemetry });
    const pending = client.get('/items/123?q=secret');
    now = 250;
    await pending;

    const snapshot = client.getTelemetrySnapshot();
    expect(snapshot.some((event) => event.path === '/items/{id}')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(client.getTelemetrySummary().completedRequests).toBe(1);
  });

  test('cache hit is reported', async () => {
    const telemetry = new RequestTelemetry();
    const client = createClient({ telemetry });
    await client.get('/config', { cache: true });
    await client.get('/config', { cache: true });
    expect(client.getTelemetrySummary().cacheHits).toBe(1);
  });

  test('clearTelemetry resets local diagnostics only', async () => {
    const telemetry = new RequestTelemetry();
    const client = createClient({ telemetry });
    await client.get('/items');
    expect(client.getTelemetrySnapshot().length).toBeGreaterThan(0);
    client.clearTelemetry();
    expect(client.getTelemetrySnapshot()).toEqual([]);
  });

  test('telemetry can be disabled without changing request behavior', async () => {
    const transport = jest.fn().mockResolvedValue(success({ ok: true }));
    const client = createClient({ transport, telemetry: null });
    await expect(client.get('/items')).resolves.toEqual({ ok: true });
    expect(client.getTelemetrySnapshot()).toEqual([]);
    expect(client.getTelemetrySummary()).toBeNull();
  });
});
