import { describe, expect, test, vi } from 'vitest';
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
  request: vi.fn(implementation ?? (async () => envelope({ ok: true }))) as HttpTransport['request']
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

  test('normalizes endpoint policy failures into AppError', async () => {
    const client = createApiClient({ runtimeConfig: runtime, transport: transport() });
    await expect(client.request({ url: 'https://attacker.invalid/items' })).rejects.toBeInstanceOf(AppError);
  });

  test('forwards caller cancellation to the transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => envelope({ ok: true })) as HttpTransport['request'];
    const client = createApiClient({ runtimeConfig: runtime, transport: transport(request) });

    await expect(client.request({ url: '/items', signal: controller.signal })).rejects.toBeInstanceOf(AppError);
    expect(request).not.toHaveBeenCalled();
  });
});
