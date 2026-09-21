import { vi as jest } from 'vitest';
import { AppError } from '../errors/appError';
import {
  buildFetchOptions,
  createFetchTransport,
  createLinkedAbortScope,
  executeFetch
} from './fetchTransport';
import type { FetchImplementation } from './fetchTransport';
import type { ResponseLike } from './responseParser';

const activeSignal = (): AbortSignal => new AbortController().signal;

const createAbortHarness = () => {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: () => controller.abort('test-aborted'),
  };
};

const response = ({
  status = 200,
  ok = status >= 200 && status < 300,
  body = '{"ok":true}',
  headers = {},
  contentType = 'application/json',
  statusText = 'OK'
}: {
  status?: number;
  ok?: boolean;
  body?: string;
  headers?: Readonly<Record<string, string>>;
  contentType?: string;
  statusText?: string;
} = {}): ResponseLike => ({
  status,
  ok,
  statusText,
  headers: new Headers({ 'content-type': contentType, ...headers }),
  text: jest.fn().mockResolvedValue(body)
});

type FetchMock = ReturnType<typeof jest.fn<FetchImplementation>>;

const fetchResolved = (value: ResponseLike): FetchMock =>
  jest.fn<FetchImplementation>().mockResolvedValue(value);

const firstFetchCall = (fetchImpl: FetchMock) => {
  const call = fetchImpl.mock.calls.at(0);
  if (!call) throw new TypeError('expected one fetch call');
  return call;
};

const firstFetchInit = (fetchImpl: FetchMock): RequestInit => {
  const init = firstFetchCall(fetchImpl)[1];
  if (!init) throw new TypeError('expected fetch RequestInit');
  return init;
};

const defaults = {
  baseUrl: '/api',
  timeoutMs: 5000,
  maxRetries: 2,
  cacheTtlMs: 30000
};

describe('fetchTransport linked abort scope', () => {
  test('creates an active child signal', () => {
    const scope = createLinkedAbortScope({ timeoutMs: 0 });
    expect(scope.signal.aborted).toBe(false);
    expect(scope.isTimedOut()).toBe(false);
    expect(scope.isParentAborted()).toBe(false);
    scope.dispose();
  });

  test('propagates a pre-aborted parent signal', () => {
    const parent = createAbortHarness();
    parent.abort();
    const scope = createLinkedAbortScope({ signal: parent.signal, timeoutMs: 0 });
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isParentAborted()).toBe(true);
    scope.dispose();
  });

  test('propagates parent abort after creation', () => {
    const parent = createAbortHarness();
    const scope = createLinkedAbortScope({ signal: parent.signal, timeoutMs: 0 });
    parent.abort();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isParentAborted()).toBe(true);
    scope.dispose();
  });

  test('marks timeout separately from caller abort', () => {
    const timer: { callback?: TimerHandler } = {};
    const scope = createLinkedAbortScope({
      timeoutMs: 100,
      setTimeout: (callback) => { timer.callback = callback; return 5; },
      clearTimeout: jest.fn()
    });
    if (typeof timer.callback === 'function') timer.callback();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isTimedOut()).toBe(true);
    expect(scope.isParentAborted()).toBe(false);
    scope.dispose();
  });

  test('clears timeout on dispose', () => {
    const clearTimeout = jest.fn();
    const scope = createLinkedAbortScope({
      timeoutMs: 100,
      setTimeout: jest.fn(() => 99),
      clearTimeout
    });
    scope.dispose();
    expect(clearTimeout).toHaveBeenCalledWith(99);
  });

  test('removes parent listener on dispose', () => {
    const parent = createAbortHarness();
    const removeSpy = jest.spyOn(parent.signal, 'removeEventListener');
    const scope = createLinkedAbortScope({ signal: parent.signal, timeoutMs: 0 });
    scope.dispose();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  test('manual abort aborts the child signal', () => {
    const scope = createLinkedAbortScope({ timeoutMs: 0 });
    scope.abort();
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  test('dispose is idempotent', () => {
    const clearTimeout = jest.fn();
    const scope = createLinkedAbortScope({
      timeoutMs: 100,
      setTimeout: jest.fn(() => 5),
      clearTimeout
    });
    scope.dispose();
    scope.dispose();
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('fetchTransport fetch option construction', () => {
  test('creates secure same-origin defaults', () => {
    const signal = activeSignal();
    expect(buildFetchOptions({ method: 'get', signal }, {
      body: undefined,
      headers: { Accept: 'application/json' }
    })).toEqual({
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow'
    });
  });

  test('includes serialized request body', () => {
    const result = buildFetchOptions({ method: 'post', signal: activeSignal() }, {
      body: '{"a":1}', headers: { 'Content-Type': 'application/json' }
    });
    expect(result.body).toBe('{"a":1}');
  });

  test('supports explicit fetch cache mode', () => {
    expect(buildFetchOptions({ method: 'get', signal: activeSignal(), fetchCache: 'reload' }, {
      body: undefined, headers: {}
    }).cache).toBe('reload');
  });

  test('supports explicit credential mode', () => {
    expect(buildFetchOptions({ method: 'get', signal: activeSignal(), credentials: 'omit' }, {
      body: undefined, headers: {}
    }).credentials).toBe('omit');
  });

  test('supports explicit redirect policy', () => {
    expect(buildFetchOptions({ method: 'get', signal: activeSignal(), redirect: 'error' }, {
      body: undefined, headers: {}
    }).redirect).toBe('error');
  });

  test('adds optional integrity only when supplied', () => {
    expect(buildFetchOptions({ method: 'get', signal: activeSignal(), integrity: 'sha256-test' }, {
      body: undefined, headers: {}
    }).integrity).toBe('sha256-test');
  });

  test('adds keepalive only when explicitly enabled', () => {
    expect(buildFetchOptions({ method: 'post', signal: activeSignal(), keepalive: true }, {
      body: 'x', headers: {}
    }).keepalive).toBe(true);
  });
});

describe('fetchTransport executeFetch', () => {
  test('executes same-origin GET and parses JSON response', async () => {
    const fetchImpl = fetchResolved(response({ body: '{"name":"Ankara"}' }));
    const result = await executeFetch({
      method: 'get',
      url: '/items',
      params: { district: 'Çankaya', page: 2 }
    }, {
      defaults,
      baseUrl: '/api',
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(firstFetchCall(fetchImpl)[0]).toBe('/api/items?district=%C3%87ankaya&page=2');
    expect(firstFetchInit(fetchImpl)).toMatchObject({
      method: 'GET', credentials: 'same-origin', cache: 'no-store'
    });
    expect(result.data).toEqual({ name: 'Ankara' });
    expect(result.status).toBe(200);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('serializes POST JSON body', async () => {
    const fetchImpl = fetchResolved(response({ body: '{"saved":true}' }));
    await executeFetch({ method: 'post', url: '/items', data: { name: 'Park' } }, {
      defaults, baseUrl: '/api', fetchImpl
    });
    const init = firstFetchInit(fetchImpl);
    expect(init.body).toBe('{"name":"Park"}');
    expect(new Headers(init.headers).get('Content-Type'))
      .toBe('application/json;charset=UTF-8');
  });

  test('does not double-prefix API base', async () => {
    const fetchImpl = fetchResolved(response());
    await executeFetch({ method: 'get', url: '/api/health' }, {
      defaults, baseUrl: '/api', fetchImpl
    });
    expect(firstFetchCall(fetchImpl)[0]).toBe('/api/health');
  });

  test('blocks absolute application endpoint before fetch', async () => {
    const fetchImpl = jest.fn();
    await expect(executeFetch({ method: 'get', url: 'https://evil.example/items' }, {
      defaults, baseUrl: '/api', fetchImpl
    })).rejects.toMatchObject({ code: 'CROSS_ORIGIN_BLOCKED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('blocks privileged authorization header before fetch', async () => {
    const fetchImpl = jest.fn();
    await expect(executeFetch({
      method: 'get', url: '/items', headers: { Authorization: 'Bearer secret' }
    }, {
      defaults, baseUrl: '/api', fetchImpl
    })).rejects.toMatchObject({ code: 'PRIVILEGED_HEADER_BLOCKED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('maps 404 response to NOT_FOUND', async () => {
    const fetchImpl = fetchResolved(response({
      status: 404, ok: false, body: '{"message":"raw detail"}'
    }));
    await expect(executeFetch({ method: 'get', url: '/missing' }, {
      defaults, fetchImpl
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, retryable: false });
  });

  test('maps 503 response to retryable SERVER_ERROR', async () => {
    const fetchImpl = fetchResolved(response({
      status: 503,
      ok: false,
      body: '{"message":"internal"}',
      headers: { 'Retry-After': '2' }
    }));
    try {
      await executeFetch({ method: 'get', url: '/items' }, { defaults, fetchImpl });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SERVER_ERROR', status: 503, retryable: true });
      if (!(error instanceof AppError)) throw error;
      const responseHeaders = (error as AppError & { response?: { headers?: Headers } }).response?.headers;
      expect(responseHeaders?.get('retry-after')).toBe('2');
    }
  });

  test('maps network TypeError to NETWORK_ERROR', async () => {
    const fetchImpl = jest.fn<FetchImplementation>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(executeFetch({ method: 'get', url: '/items' }, { defaults, fetchImpl }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  test('maps parent cancellation to ABORTED', async () => {
    const parent = createAbortHarness();
    const fetchImpl = jest.fn<FetchImplementation>((_url, options) => new Promise<ResponseLike>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const promise = executeFetch({ method: 'get', url: '/items', signal: parent.signal }, {
      defaults, fetchImpl
    });
    parent.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });

  test('maps transport timeout to TIMEOUT', async () => {
    const timer: { callback?: TimerHandler } = {};
    const fetchImpl = jest.fn<FetchImplementation>((_url, options) => new Promise<ResponseLike>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const promise = executeFetch({ method: 'get', url: '/items', timeout: 100 }, {
      defaults,
      fetchImpl,
      setTimeout: (callback) => { timer.callback = callback; return 1; },
      clearTimeout: jest.fn()
    });
    if (typeof timer.callback === 'function') timer.callback();
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', status: 408, retryable: true });
  });

  test('reports start and completion hooks', async () => {
    const onStart = jest.fn();
    const onSuccess = jest.fn();
    const fetchImpl = fetchResolved(response());
    const clock = jest.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);
    await executeFetch({ method: 'get', url: '/items' }, {
      defaults, fetchImpl, clock, onStart, onSuccess
    });
    expect(onStart).toHaveBeenCalledWith({ method: 'get', url: '/api/items', timeout: 5000 });
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      method: 'get', url: '/api/items', status: 200, durationMs: 25
    }));
  });

  test('reports HTTP failure hook once', async () => {
    const onFailure = jest.fn();
    const fetchImpl = fetchResolved(response({ status: 503, ok: false }));
    await expect(executeFetch({ method: 'get', url: '/items' }, {
      defaults, fetchImpl, onFailure
    })).rejects.toBeInstanceOf(AppError);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
  });

  test('reports network failure hook once', async () => {
    const onFailure = jest.fn();
    const fetchImpl = jest.fn<FetchImplementation>().mockRejectedValue(new TypeError('network'));
    await expect(executeFetch({ method: 'get', url: '/items' }, {
      defaults, fetchImpl, onFailure
    })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls.at(0)?.at(0)).toMatchObject({ error: expect.objectContaining({ code: 'NETWORK_ERROR' }) });
  });

  test('rejects invalid fetch response object', async () => {
    const fetchImpl = jest.fn<FetchImplementation>().mockResolvedValue(null as never);
    await expect(executeFetch({ method: 'get', url: '/items' }, { defaults, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_FETCH_RESPONSE' });
  });

  test('cleans timeout after a successful request', async () => {
    const clearTimeout = jest.fn();
    const fetchImpl = fetchResolved(response());
    await executeFetch({ method: 'get', url: '/items', timeout: 100 }, {
      defaults,
      fetchImpl,
      setTimeout: jest.fn(() => 55),
      clearTimeout
    });
    expect(clearTimeout).toHaveBeenCalledWith(55);
  });

  test('does not create timeout scope when body serialization fails', async () => {
    const setTimeout = jest.fn();
    const fetchImpl = jest.fn();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(executeFetch({ method: 'post', url: '/items', data: circular }, {
      defaults, fetchImpl, setTimeout
    })).rejects.toMatchObject({ code: 'REQUEST_SERIALIZATION_FAILED' });
    expect(setTimeout).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchTransport factory surface', () => {
  test('publishes immutable defaults', () => {
    const transport = createFetchTransport({
      baseUrl: '/api', timeoutMs: 7000, maxRetries: 3, cacheTtlMs: 9000, fetchImpl: jest.fn()
    });
    expect(transport.defaults).toEqual({
      baseUrl: '/api', timeoutMs: 7000, maxRetries: 3, cacheTtlMs: 9000
    });
    expect(Object.isFrozen(transport.defaults)).toBe(true);
    expect(Object.isFrozen(transport)).toBe(true);
  });

  test.each([['get', 'get'], ['head', 'head'], ['delete', 'delete']])(
    '%s helper forwards method',
    async (helper, method) => {
      const fetchImpl = fetchResolved(response({
        status: method === 'head' ? 204 : 200,
        ok: true,
        body: method === 'head' ? '' : '{"ok":true}'
      }));
      const transport = createFetchTransport({ ...defaults, fetchImpl });
      const methodCall = transport[helper as 'get' | 'head' | 'delete'];
      await methodCall('/items');
      expect(firstFetchInit(fetchImpl).method).toBe(method.toUpperCase());
    }
  );

  test.each([['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH']])(
    '%s helper forwards JSON body',
    async (helper, expectedMethod) => {
      const fetchImpl = fetchResolved(response());
      const transport = createFetchTransport({ ...defaults, fetchImpl });
      const methodCall = transport[helper as 'post' | 'put' | 'patch'];
      await methodCall('/items', { value: 1 });
      const init = firstFetchInit(fetchImpl);
      expect(init.method).toBe(expectedMethod);
      expect(init.body).toBe('{"value":1}');
    }
  );
});
