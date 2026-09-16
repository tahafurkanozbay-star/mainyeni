import { AppError } from '../errors/appError';
import { createNetworkDiagnostics } from './networkDiagnostics';
import {
  RequestCoordinator,
  createCoordinatedClient,
  createRequestCoordinator
} from './requestCoordinator';

const success = (data = { ok: true }, status = 200) => Object.freeze({
  data,
  status,
  statusText: 'OK',
  headers: null,
  metadata: Object.freeze({ status, ok: true, method: 'get', url: '/api/items' }),
  durationMs: 5
});

const defaults = { timeoutMs: 5000, maxRetries: 2, cacheTtlMs: 30000 };

const createTransport = (implementation) => ({
  defaults,
  request: jest.fn(implementation || (() => Promise.resolve(success())))
});

describe('RequestCoordinator construction', () => {
  test('requires a transport request function', () => {
    expect(() => new RequestCoordinator()).toThrow(TypeError);
    expect(() => new RequestCoordinator({ transport: {} })).toThrow(TypeError);
  });

  test('inherits transport defaults', () => {
    const coordinator = new RequestCoordinator({ transport: createTransport() });
    expect(coordinator.defaults).toEqual(defaults);
    expect(Object.isFrozen(coordinator.defaults)).toBe(true);
  });

  test('allows explicit coordinator defaults to override transport', () => {
    const coordinator = new RequestCoordinator({
      transport: createTransport(), timeoutMs: 9000, maxRetries: 1, cacheTtlMs: 8000
    });
    expect(coordinator.defaults).toEqual({ timeoutMs: 9000, maxRetries: 1, cacheTtlMs: 8000 });
  });

  test('publishes factory helper', () => {
    expect(createRequestCoordinator({ transport: createTransport() })).toBeInstanceOf(RequestCoordinator);
  });
});

describe('RequestCoordinator request normalization', () => {
  test('normalizes GET defaults before transport', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await coordinator.request({ url: '/items' });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get', url: '/items', timeout: 5000, maxRetries: 2,
      retryAllowed: true, safeMethod: true
    }));
  });

  test('blocks cross-origin request before transport', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await expect(coordinator.request({ url: 'https://evil.example/items' }))
      .rejects.toMatchObject({ code: 'CROSS_ORIGIN_BLOCKED' });
    expect(transport.request).not.toHaveBeenCalled();
  });

  test('blocks privileged headers before transport', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await expect(coordinator.request({
      url: '/items', headers: { Authorization: 'Bearer secret' }
    })).rejects.toMatchObject({ code: 'PRIVILEGED_HEADER_BLOCKED' });
    expect(transport.request).not.toHaveBeenCalled();
  });
});

describe('RequestCoordinator cache behavior', () => {
  test('does not cache unless explicitly enabled', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await coordinator.request({ url: '/items' });
    await coordinator.request({ url: '/items' });
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(coordinator.getCacheSize()).toBe(0);
  });

  test('caches explicitly cacheable GET responses', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    const first = await coordinator.request({ url: '/items', cache: true, cacheTtlMs: 30000 });
    const second = await coordinator.request({ url: '/items', cache: true, cacheTtlMs: 30000 });
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(second.metadata.cache).toBe('hit');
    expect(coordinator.getCacheSize()).toBe(1);
  });

  test('keeps parameter variants in distinct cache entries', async () => {
    const transport = createTransport(({ params }) => Promise.resolve(success({ page: params.page })));
    const coordinator = createRequestCoordinator({ transport });
    await coordinator.request({ url: '/items', params: { page: 1 }, cache: true });
    await coordinator.request({ url: '/items', params: { page: 2 }, cache: true });
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(coordinator.getCacheSize()).toBe(2);
  });

  test('does not cache POST even when requested', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ method: 'post', url: '/items', data: { value: 1 }, cache: true });
    expect(coordinator.getCacheSize()).toBe(0);
  });

  test('does not cache sensitive query metadata', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ url: '/items', params: { token: 'secret' }, cache: true });
    expect(coordinator.getCacheSize()).toBe(0);
  });

  test('clearCache returns removed entry count', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ url: '/a', cache: true });
    await coordinator.request({ url: '/b', cache: true });
    expect(coordinator.clearCache()).toBe(2);
    expect(coordinator.getCacheSize()).toBe(0);
  });

  test('invalidateCache removes matching key prefix only', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ url: '/items', cache: true });
    await coordinator.request({ url: '/health', cache: true });
    expect(coordinator.invalidateCache('get|/items')).toBe(1);
    expect(coordinator.getCacheSize()).toBe(1);
  });

  test('empty invalidate prefix clears all cache', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ url: '/items', cache: true });
    expect(coordinator.invalidateCache('')).toBe(1);
    expect(coordinator.getCacheSize()).toBe(0);
  });
});

describe('RequestCoordinator in-flight dedupe', () => {
  test('joins identical safe requests when dedupe is enabled', async () => {
    let resolveTransport;
    const transport = createTransport(() => new Promise((resolve) => { resolveTransport = resolve; }));
    const coordinator = createRequestCoordinator({ transport });
    const first = coordinator.request({ url: '/items', dedupe: true });
    const second = coordinator.request({ url: '/items', dedupe: true });
    expect(first).toBe(second);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(coordinator.getInFlightSize()).toBe(1);
    resolveTransport(success({ joined: true }));
    await expect(first).resolves.toMatchObject({ data: { joined: true } });
    await expect(second).resolves.toMatchObject({ data: { joined: true } });
    expect(coordinator.getInFlightSize()).toBe(0);
  });

  test('does not dedupe requests with different params', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await Promise.all([
      coordinator.request({ url: '/items', params: { page: 1 }, dedupe: true }),
      coordinator.request({ url: '/items', params: { page: 2 }, dedupe: true })
    ]);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('does not dedupe caller-owned cancellation signals', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    const signal = { aborted: false };
    await Promise.all([
      coordinator.request({ url: '/items', dedupe: true, signal }),
      coordinator.request({ url: '/items', dedupe: true, signal })
    ]);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('releases failed dedupe entry', async () => {
    const error = new AppError('bad', { code: 'BAD_REQUEST', status: 400 });
    const coordinator = createRequestCoordinator({
      transport: createTransport(() => Promise.reject(error))
    });
    await expect(coordinator.request({ url: '/items', dedupe: true })).rejects.toBe(error);
    expect(coordinator.getInFlightSize()).toBe(0);
  });

  test('does not dedupe unsafe POST', async () => {
    const transport = createTransport();
    const coordinator = createRequestCoordinator({ transport });
    await Promise.all([
      coordinator.request({ method: 'post', url: '/items', data: { value: 1 }, dedupe: true }),
      coordinator.request({ method: 'post', url: '/items', data: { value: 1 }, dedupe: true })
    ]);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });
});

describe('RequestCoordinator retry integration', () => {
  test('retries retryable GET failures', async () => {
    const temporary = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const transport = createTransport();
    transport.request.mockRejectedValueOnce(temporary).mockResolvedValueOnce(success({ recovered: true }));
    const wait = jest.fn().mockResolvedValue(undefined);
    const coordinator = createRequestCoordinator({ transport, wait, retryOptions: { random: () => 0 } });
    await expect(coordinator.request({ url: '/items' })).resolves.toMatchObject({ data: { recovered: true } });
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  test('stops at retry budget', async () => {
    const temporary = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const transport = createTransport(() => Promise.reject(temporary));
    const coordinator = createRequestCoordinator({
      transport, maxRetries: 1, wait: jest.fn().mockResolvedValue(undefined), retryOptions: { random: () => 0 }
    });
    await expect(coordinator.request({ url: '/items' })).rejects.toBe(temporary);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('does not retry ordinary POST', async () => {
    const temporary = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const transport = createTransport(() => Promise.reject(temporary));
    const coordinator = createRequestCoordinator({ transport, wait: jest.fn().mockResolvedValue(undefined) });
    await expect(coordinator.request({ method: 'post', url: '/items', data: { value: 1 } }))
      .rejects.toBe(temporary);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  test('retries POST only with explicit retryUnsafe opt-in', async () => {
    const temporary = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const transport = createTransport();
    transport.request.mockRejectedValueOnce(temporary).mockResolvedValueOnce(success({ saved: true }));
    const coordinator = createRequestCoordinator({
      transport, maxRetries: 1, wait: jest.fn().mockResolvedValue(undefined), retryOptions: { random: () => 0 }
    });
    await expect(coordinator.request({
      method: 'post', url: '/items', data: { value: 1 }, retryUnsafe: true
    })).resolves.toMatchObject({ data: { saved: true } });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('does not retry non-retryable failure', async () => {
    const badRequest = new AppError('bad', { code: 'BAD_REQUEST', status: 400, retryable: false });
    const transport = createTransport(() => Promise.reject(badRequest));
    const coordinator = createRequestCoordinator({ transport, wait: jest.fn() });
    await expect(coordinator.request({ url: '/items' })).rejects.toBe(badRequest);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
});

describe('RequestCoordinator diagnostics', () => {
  test('records request lifecycle', async () => {
    const diagnostics = createNetworkDiagnostics();
    const coordinator = createRequestCoordinator({ transport: createTransport(), diagnostics });
    await coordinator.request({ url: '/items' });
    expect(diagnostics.count('network.request.started')).toBe(1);
    expect(diagnostics.count('network.request.attempt')).toBe(1);
    expect(diagnostics.count('network.request.completed')).toBe(1);
  });

  test('records failure lifecycle', async () => {
    const diagnostics = createNetworkDiagnostics();
    const error = new AppError('bad', { code: 'BAD_REQUEST', status: 400 });
    const coordinator = createRequestCoordinator({
      transport: createTransport(() => Promise.reject(error)), diagnostics
    });
    await expect(coordinator.request({ url: '/items' })).rejects.toBe(error);
    expect(diagnostics.count('network.request.failed')).toBe(1);
  });

  test('records retry lifecycle', async () => {
    const diagnostics = createNetworkDiagnostics();
    const temporary = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    const transport = createTransport();
    transport.request.mockRejectedValueOnce(temporary).mockResolvedValueOnce(success());
    const coordinator = createRequestCoordinator({
      transport, diagnostics, wait: jest.fn().mockResolvedValue(undefined), retryOptions: { random: () => 0 }
    });
    await coordinator.request({ url: '/items' });
    expect(diagnostics.count('network.request.retry')).toBe(1);
  });

  test('records cache hit and miss', async () => {
    const diagnostics = createNetworkDiagnostics();
    const coordinator = createRequestCoordinator({ transport: createTransport(), diagnostics });
    await coordinator.request({ url: '/items', cache: true });
    await coordinator.request({ url: '/items', cache: true });
    expect(diagnostics.count('network.cache.miss')).toBe(1);
    expect(diagnostics.count('network.cache.write')).toBe(1);
    expect(diagnostics.count('network.cache.hit')).toBe(1);
  });

  test('records dedupe join and release', async () => {
    const diagnostics = createNetworkDiagnostics();
    let resolveTransport;
    const coordinator = createRequestCoordinator({
      transport: createTransport(() => new Promise((resolve) => { resolveTransport = resolve; })),
      diagnostics
    });
    const first = coordinator.request({ url: '/items', dedupe: true });
    const second = coordinator.request({ url: '/items', dedupe: true });
    resolveTransport(success());
    await Promise.all([first, second]);
    expect(diagnostics.count('network.dedupe.start')).toBe(1);
    expect(diagnostics.count('network.dedupe.join')).toBe(1);
    expect(diagnostics.count('network.dedupe.release')).toBe(1);
  });

  test('never retains URL query strings in diagnostics', async () => {
    const diagnostics = createNetworkDiagnostics();
    const coordinator = createRequestCoordinator({ transport: createTransport(), diagnostics });
    await coordinator.request({ url: '/items?public=1' });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('public=1');
  });

  test('exposes and clears diagnostics', async () => {
    const coordinator = createRequestCoordinator({ transport: createTransport() });
    await coordinator.request({ url: '/items' });
    expect(coordinator.getDiagnostics().length).toBeGreaterThan(0);
    expect(coordinator.getDiagnosticSummary().totalRecorded).toBeGreaterThan(0);
    coordinator.clearDiagnostics();
    expect(coordinator.getDiagnostics()).toEqual([]);
    expect(coordinator.getDiagnosticSummary().totalRecorded).toBe(0);
  });
});

describe('createCoordinatedClient compatibility surface', () => {
  test('request returns data rather than transport envelope', async () => {
    const client = createCoordinatedClient({
      transport: createTransport(() => Promise.resolve(success({ value: 1 })))
    });
    await expect(client.request({ url: '/items' })).resolves.toEqual({ value: 1 });
  });

  test('requestRaw returns transport envelope', async () => {
    const client = createCoordinatedClient({
      transport: createTransport(() => Promise.resolve(success({ value: 1 })))
    });
    await expect(client.requestRaw({ url: '/items' })).resolves.toMatchObject({
      data: { value: 1 }, status: 200
    });
  });

  test.each([['get', 'get'], ['head', 'head'], ['delete', 'delete']])(
    '%s helper forwards method',
    async (helper, expectedMethod) => {
      const transport = createTransport();
      const client = createCoordinatedClient({ transport });
      await client[helper]('/items');
      expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
        method: expectedMethod, url: '/items'
      }));
    }
  );

  test.each([['post', 'post'], ['put', 'put'], ['patch', 'patch']])(
    '%s helper forwards method and data',
    async (helper, expectedMethod) => {
      const transport = createTransport();
      const client = createCoordinatedClient({ transport });
      await client[helper]('/items', { value: 1 });
      expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
        method: expectedMethod,
        url: '/items',
        data: { value: 1 },
        cache: false,
        dedupe: false
      }));
    }
  );

  test('exposes cache and diagnostics maintenance helpers', async () => {
    const client = createCoordinatedClient({ transport: createTransport() });
    await client.get('/items', { cache: true });
    expect(client.getCacheSize()).toBe(1);
    expect(client.getDiagnosticSummary().totalRecorded).toBeGreaterThan(0);
    client.clearCache();
    client.clearDiagnostics();
    expect(client.getCacheSize()).toBe(0);
    expect(client.getDiagnosticSummary().totalRecorded).toBe(0);
  });
});
