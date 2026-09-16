import { AppError } from '../errors/appError';
import {
  apiClient,
  clearApiClientRuntime,
  createApiClient,
  getApiClientDiagnosticSummary,
  getApiClientDiagnostics
} from './httpClient';

const runtime = Object.freeze({
  apiBaseUrl: '/api',
  requestTimeoutMs: 5000,
  maxRetries: 2,
  cacheTtlMs: 30000
});

const envelope = (data = { ok: true }) => Object.freeze({
  data,
  status: 200,
  statusText: 'OK',
  headers: null,
  metadata: Object.freeze({ status: 200, ok: true, method: 'get', url: '/api/items' }),
  durationMs: 5
});

const transport = (implementation) => ({
  defaults: { baseUrl: '/api', timeoutMs: 5000, maxRetries: 2, cacheTtlMs: 30000 },
  request: jest.fn(implementation || (() => Promise.resolve(envelope())))
});

describe('httpClient public facade', () => {
  test('exports a singleton api client with compatibility methods', () => {
    expect(apiClient).toEqual(expect.objectContaining({
      request: expect.any(Function),
      requestRaw: expect.any(Function),
      get: expect.any(Function),
      head: expect.any(Function),
      post: expect.any(Function),
      put: expect.any(Function),
      patch: expect.any(Function),
      delete: expect.any(Function),
      clearCache: expect.any(Function),
      invalidateCache: expect.any(Function),
      getCacheSize: expect.any(Function),
      getDiagnostics: expect.any(Function),
      getDiagnosticSummary: expect.any(Function)
    }));
  });

  test('singleton maintenance helpers expose safe snapshots', () => {
    clearApiClientRuntime();
    expect(getApiClientDiagnostics()).toEqual([]);
    expect(getApiClientDiagnosticSummary()).toMatchObject({
      retainedEvents: 0,
      totalRecorded: 0,
      droppedEvents: 0
    });
  });
});

describe('createApiClient compatibility', () => {
  test('returns transport data for generic request', async () => {
    const client = createApiClient({
      runtimeConfig: runtime,
      transport: transport(() => Promise.resolve(envelope({ value: 1 })))
    });
    await expect(client.request({ url: '/items' })).resolves.toEqual({ value: 1 });
  });

  test('returns transport envelope through requestRaw', async () => {
    const client = createApiClient({
      runtimeConfig: runtime,
      transport: transport(() => Promise.resolve(envelope({ value: 1 })))
    });
    await expect(client.requestRaw({ url: '/items' })).resolves.toMatchObject({
      data: { value: 1 }, status: 200
    });
  });

  test('GET helper preserves query params and cache flags', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.get('/items', { params: { page: 2 }, cache: true, dedupe: true });
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get', url: '/items', params: { page: 2 }, cache: true, dedupe: true
    }));
  });

  test('HEAD helper preserves request config', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.head('/health', { cache: true });
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'head', url: '/health', cache: true
    }));
  });

  test('POST helper forces cache and dedupe off', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.post('/items', { value: 1 }, { cache: true, dedupe: true });
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'post', url: '/items', data: { value: 1 }, cache: false, dedupe: false
    }));
  });

  test('PUT helper forces cache and dedupe off', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.put('/items/1', { value: 2 });
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'put', url: '/items/1', data: { value: 2 }, cache: false, dedupe: false
    }));
  });

  test('PATCH helper forces cache and dedupe off', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.patch('/items/1', { value: 3 });
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'patch', url: '/items/1', data: { value: 3 }, cache: false, dedupe: false
    }));
  });

  test('DELETE helper forces cache and dedupe off', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.delete('/items/1');
    expect(customTransport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'delete', url: '/items/1', cache: false, dedupe: false
    }));
  });

  test('propagates typed transport errors unchanged', async () => {
    const error = new AppError('not found', { code: 'NOT_FOUND', status: 404 });
    const client = createApiClient({
      runtimeConfig: runtime,
      transport: transport(() => Promise.reject(error))
    });
    await expect(client.get('/missing')).rejects.toBe(error);
  });

  test('honors runtime retry count through coordinator defaults', () => {
    const client = createApiClient({
      runtimeConfig: { ...runtime, maxRetries: 4 },
      transport: transport()
    });
    expect(client.coordinator.defaults.maxRetries).toBe(4);
  });

  test('honors runtime timeout through coordinator defaults', () => {
    const client = createApiClient({
      runtimeConfig: { ...runtime, requestTimeoutMs: 12000 },
      transport: transport()
    });
    expect(client.coordinator.defaults.timeoutMs).toBe(12000);
  });

  test('honors runtime cache TTL through coordinator defaults', () => {
    const client = createApiClient({
      runtimeConfig: { ...runtime, cacheTtlMs: 45000 },
      transport: transport()
    });
    expect(client.coordinator.defaults.cacheTtlMs).toBe(45000);
  });

  test('supports caller signal without dedupe sharing', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    const signal = { aborted: false };
    await Promise.all([
      client.get('/items', { signal, dedupe: true }),
      client.get('/items', { signal, dedupe: true })
    ]);
    expect(customTransport.request).toHaveBeenCalledTimes(2);
  });
});

describe('createApiClient cache behavior', () => {
  test('caches only explicit GET requests', async () => {
    const customTransport = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: customTransport });
    await client.get('/items', { cache: true });
    await client.get('/items', { cache: true });
    expect(customTransport.request).toHaveBeenCalledTimes(1);
    expect(client.getCacheSize()).toBe(1);
  });

  test('clearCache clears all explicit cached reads', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await client.get('/a', { cache: true });
    await client.get('/b', { cache: true });
    expect(client.getCacheSize()).toBe(2);
    expect(client.clearCache()).toBe(2);
    expect(client.getCacheSize()).toBe(0);
  });

  test('invalidateCache removes matching cache key prefix', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await client.get('/items', { cache: true });
    await client.get('/health', { cache: true });
    expect(client.invalidateCache('get|/items')).toBe(1);
    expect(client.getCacheSize()).toBe(1);
  });
});

describe('createApiClient diagnostics behavior', () => {
  test('records request lifecycle with custom transport', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await client.get('/items');
    expect(client.getDiagnosticSummary().counters).toMatchObject({
      'network.request.started': 1,
      'network.request.attempt': 1,
      'network.request.completed': 1
    });
  });

  test('records typed failures without raw error message', async () => {
    const error = new AppError('sensitive upstream raw message', {
      code: 'SERVER_ERROR', status: 503, retryable: true
    });
    const customTransport = transport(() => Promise.reject(error));
    const wait = jest.fn().mockResolvedValue(undefined);
    const client = createApiClient({
      runtimeConfig: { ...runtime, maxRetries: 0 },
      transport: customTransport,
      wait
    });
    await expect(client.get('/items')).rejects.toBe(error);
    const serialized = JSON.stringify(client.getDiagnostics());
    expect(serialized).toContain('SERVER_ERROR');
    expect(serialized).not.toContain('sensitive upstream raw message');
  });

  test('clearDiagnostics resets support state', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await client.get('/items');
    expect(client.getDiagnostics().length).toBeGreaterThan(0);
    client.clearDiagnostics();
    expect(client.getDiagnostics()).toEqual([]);
    expect(client.getDiagnosticSummary().totalRecorded).toBe(0);
  });

  test('supports diagnostic capacity override', async () => {
    const client = createApiClient({
      runtimeConfig: runtime,
      transport: transport(),
      diagnosticCapacity: 10
    });
    for (let index = 0; index < 8; index += 1) {
      await client.get(`/items/${index}`);
    }
    expect(client.getDiagnostics().length).toBeLessThanOrEqual(10);
    expect(client.getDiagnosticSummary().totalRecorded).toBeGreaterThan(10);
  });
});
