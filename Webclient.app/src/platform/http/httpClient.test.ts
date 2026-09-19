import { describe, expect, jest, test } from '@jest/globals';
import { AppError } from '../errors/appError';
import { apiClient, clearApiClientRuntime, createApiClient, getApiClientDiagnosticSummary, getApiClientDiagnostics } from './httpClient';
import type { RuntimeConfig } from '../config/runtimeConfig';
import type { HttpResponseEnvelope, HttpTransport } from './contracts';

const runtime: RuntimeConfig = Object.freeze({ apiBaseUrl: '/api', requestTimeoutMs: 5000, maxRetries: 2, cacheTtlMs: 30000 });

const envelope = <T>(data: T): HttpResponseEnvelope<T> => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: null,
  metadata: { status: 200, ok: true, method: 'get', url: '/api/items' },
  durationMs: 5
});

const transport = (implementation?: HttpTransport['request']): HttpTransport => ({
  defaults: { baseUrl: '/api', timeoutMs: 5000, maxRetries: 2, cacheTtlMs: 30000 },
  request: jest.fn(implementation ?? (async () => envelope({ ok: true }))) as HttpTransport['request']
});

describe('httpClient public facade', () => {
  test('exports compatibility methods', () => {
    expect(apiClient).toEqual(expect.objectContaining({ request: expect.any(Function), requestRaw: expect.any(Function), get: expect.any(Function), head: expect.any(Function), post: expect.any(Function), put: expect.any(Function), patch: expect.any(Function), delete: expect.any(Function), clearCache: expect.any(Function), invalidateCache: expect.any(Function), getCacheSize: expect.any(Function), getDiagnostics: expect.any(Function), getDiagnosticSummary: expect.any(Function) }));
  });

  test('singleton maintenance helpers expose safe snapshots', () => {
    clearApiClientRuntime();
    expect(getApiClientDiagnostics()).toEqual([]);
    expect(getApiClientDiagnosticSummary()).toMatchObject({ retainedEvents: 0, totalRecorded: 0, droppedEvents: 0 });
  });
});

describe('createApiClient compatibility', () => {
  test('returns data and raw envelopes', async () => {
    const custom = transport(async () => envelope({ value: 1 }));
    const client = createApiClient({ runtimeConfig: runtime, transport: custom });
    await expect(client.request<{ value: number }>({ url: '/items' })).resolves.toEqual({ value: 1 });
    await expect(client.requestRaw<{ value: number }>({ url: '/items' })).resolves.toMatchObject({ data: { value: 1 }, status: 200 });
  });

  test('preserves GET and HEAD config while writes disable cache/dedupe', async () => {
    const custom = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: custom });
    await client.get('/items', { params: { page: 2 }, cache: true, dedupe: true });
    await client.head('/health', { cache: true });
    await client.post('/items', { value: 1 }, { cache: true, dedupe: true });
    await client.put('/items/1', { value: 2 });
    await client.patch('/items/1', { value: 3 });
    await client.delete('/items/1');
    expect(custom.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'get', url: '/items', params: { page: 2 }, cache: true, dedupe: true }));
    expect(custom.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'head', url: '/health', cache: true }));
    for (let call = 3; call <= 6; call += 1) expect(custom.request).toHaveBeenNthCalledWith(call, expect.objectContaining({ cache: false, dedupe: false }));
  });

  test('propagates typed transport errors unchanged', async () => {
    const error = new AppError('not found', { code: 'NOT_FOUND', status: 404 });
    const client = createApiClient({ runtimeConfig: runtime, transport: transport(async () => { throw error; }) });
    await expect(client.get('/missing')).rejects.toBe(error);
  });

  test('honors runtime coordinator defaults', () => {
    const client = createApiClient({ runtimeConfig: { ...runtime, maxRetries: 4, requestTimeoutMs: 12000, cacheTtlMs: 45000 }, transport: transport() });
    expect(client.coordinator.defaults).toMatchObject({ maxRetries: 4, timeoutMs: 12000, cacheTtlMs: 45000 });
  });

  test('caller signals prevent dedupe sharing', async () => {
    const custom = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: custom });
    const controller = new AbortController();
    await Promise.all([client.get('/items', { signal: controller.signal, dedupe: true }), client.get('/items', { signal: controller.signal, dedupe: true })]);
    expect(custom.request).toHaveBeenCalledTimes(2);
  });
});

describe('cache and diagnostics', () => {
  test('explicit GET cache is bounded and invalidatable', async () => {
    const custom = transport();
    const client = createApiClient({ runtimeConfig: runtime, transport: custom });
    await client.get('/items', { cache: true });
    await client.get('/items', { cache: true });
    await client.get('/health', { cache: true });
    expect(custom.request).toHaveBeenCalledTimes(2);
    expect(client.invalidateCache('get|/items')).toBe(1);
    expect(client.clearCache()).toBe(1);
    expect(client.getCacheSize()).toBe(0);
  });

  test('records lifecycle without leaking raw errors', async () => {
    const ok = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await ok.get('/items');
    expect(ok.getDiagnosticSummary().counters).toMatchObject({ 'network.request.started': 1, 'network.request.attempt': 1, 'network.request.completed': 1 });

    const error = new AppError('sensitive upstream raw message', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const failing = createApiClient({ runtimeConfig: { ...runtime, maxRetries: 0 }, transport: transport(async () => { throw error; }), wait: async () => undefined });
    await expect(failing.get('/items')).rejects.toBe(error);
    const serialized = JSON.stringify(failing.getDiagnostics());
    expect(serialized).toContain('SERVER_ERROR');
    expect(serialized).not.toContain('sensitive upstream raw message');
  });

  test('diagnostic retention honors capacity and can be cleared', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport(), diagnosticCapacity: 10 });
    for (let index = 0; index < 8; index += 1) await client.get(`/items/${index}`);
    expect(client.getDiagnostics().length).toBeLessThanOrEqual(10);
    expect(client.getDiagnosticSummary().totalRecorded).toBeGreaterThan(10);
    client.clearDiagnostics();
    expect(client.getDiagnostics()).toEqual([]);
    expect(client.getDiagnosticSummary().totalRecorded).toBe(0);
  });
});
