import { AppError } from '../errors/appError';
import {
  buildFetchOptions,
  createFetchTransport,
  createLinkedAbortScope,
  executeFetch
} from './fetchTransport';

class TestAbortSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  addEventListener(name, callback) {
    if (name === 'abort') this.listeners.add(callback);
  }

  removeEventListener(name, callback) {
    if (name === 'abort') this.listeners.delete(callback);
  }

  dispatchAbort() {
    if (this.aborted) return;
    this.aborted = true;
    [...this.listeners].forEach((listener) => listener());
  }
}

class TestAbortController {
  constructor() {
    this.signal = new TestAbortSignal();
  }

  abort() {
    this.signal.dispatchAbort();
  }
}

const createHeaders = (values = {}) => {
  const normalized = Object.keys(values).reduce((result, key) => {
    result[key.toLowerCase()] = String(values[key]);
    return result;
  }, {});
  return {
    get: (name) => normalized[String(name).toLowerCase()] ?? null,
    forEach: (callback) => Object.keys(normalized)
      .forEach((key) => callback(normalized[key], key))
  };
};

const response = ({
  status = 200,
  ok = status >= 200 && status < 300,
  body = '{"ok":true}',
  headers = {},
  contentType = 'application/json',
  statusText = 'OK'
} = {}) => ({
  status,
  ok,
  statusText,
  headers: createHeaders({ 'content-type': contentType, ...headers }),
  text: jest.fn().mockResolvedValue(body)
});

const defaults = {
  baseUrl: '/api',
  timeoutMs: 5000,
  maxRetries: 2,
  cacheTtlMs: 30000
};

describe('fetchTransport linked abort scope', () => {
  const OriginalAbortController = global.AbortController;

  beforeAll(() => {
    global.AbortController = TestAbortController;
  });

  afterAll(() => {
    global.AbortController = OriginalAbortController;
  });

  test('creates an active child signal', () => {
    const scope = createLinkedAbortScope({ timeoutMs: 0 });
    expect(scope.signal.aborted).toBe(false);
    expect(scope.isTimedOut()).toBe(false);
    expect(scope.isParentAborted()).toBe(false);
    scope.dispose();
  });

  test('propagates a pre-aborted parent signal', () => {
    const parent = new TestAbortSignal();
    parent.dispatchAbort();
    const scope = createLinkedAbortScope({ signal: parent, timeoutMs: 0 });
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isParentAborted()).toBe(true);
    scope.dispose();
  });

  test('propagates parent abort after creation', () => {
    const parent = new TestAbortSignal();
    const scope = createLinkedAbortScope({ signal: parent, timeoutMs: 0 });
    parent.dispatchAbort();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isParentAborted()).toBe(true);
    scope.dispose();
  });

  test('marks timeout separately from caller abort', () => {
    let timeoutCallback;
    const scope = createLinkedAbortScope({
      timeoutMs: 100,
      setTimeout: (callback) => { timeoutCallback = callback; return 5; },
      clearTimeout: jest.fn()
    });
    timeoutCallback();
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
    const parent = new TestAbortSignal();
    const removeSpy = jest.spyOn(parent, 'removeEventListener');
    const scope = createLinkedAbortScope({ signal: parent, timeoutMs: 0 });
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
    const signal = {};
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
    const result = buildFetchOptions({ method: 'post', signal: {} }, {
      body: '{"a":1}', headers: { 'Content-Type': 'application/json' }
    });
    expect(result.body).toBe('{"a":1}');
  });

  test('supports explicit fetch cache mode', () => {
    expect(buildFetchOptions({ method: 'get', signal: {}, fetchCache: 'reload' }, {
      body: undefined, headers: {}
    }).cache).toBe('reload');
  });

  test('supports explicit credential mode', () => {
    expect(buildFetchOptions({ method: 'get', signal: {}, credentials: 'omit' }, {
      body: undefined, headers: {}
    }).credentials).toBe('omit');
  });

  test('supports explicit redirect policy', () => {
    expect(buildFetchOptions({ method: 'get', signal: {}, redirect: 'error' }, {
      body: undefined, headers: {}
    }).redirect).toBe('error');
  });

  test('adds optional integrity only when supplied', () => {
    expect(buildFetchOptions({ method: 'get', signal: {}, integrity: 'sha256-test' }, {
      body: undefined, headers: {}
    }).integrity).toBe('sha256-test');
  });

  test('adds keepalive only when explicitly enabled', () => {
    expect(buildFetchOptions({ method: 'post', signal: {}, keepalive: true }, {
      body: 'x', headers: {}
    }).keepalive).toBe(true);
  });
});

describe('fetchTransport executeFetch', () => {
  const OriginalAbortController = global.AbortController;

  beforeAll(() => {
    global.AbortController = TestAbortController;
  });

  afterAll(() => {
    global.AbortController = OriginalAbortController;
  });

  test('executes same-origin GET and parses JSON response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ body: '{"name":"Ankara"}' }));
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
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/items?district=%C3%87ankaya&page=2');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'GET', credentials: 'same-origin', cache: 'no-store'
    });
    expect(result.data).toEqual({ name: 'Ankara' });
    expect(result.status).toBe(200);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('serializes POST JSON body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ body: '{"saved":true}' }));
    await executeFetch({ method: 'post', url: '/items', data: { name: 'Park' } }, {
      defaults, baseUrl: '/api', fetchImpl
    });
    expect(fetchImpl.mock.calls[0][1].body).toBe('{"name":"Park"}');
    expect(fetchImpl.mock.calls[0][1].headers['Content-Type'])
      .toBe('application/json;charset=UTF-8');
  });

  test('does not double-prefix API base', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response());
    await executeFetch({ method: 'get', url: '/api/health' }, {
      defaults, baseUrl: '/api', fetchImpl
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/health');
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
    const fetchImpl = jest.fn().mockResolvedValue(response({
      status: 404, ok: false, body: '{"message":"raw detail"}'
    }));
    await expect(executeFetch({ method: 'get', url: '/missing' }, {
      defaults, fetchImpl
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, retryable: false });
  });

  test('maps 503 response to retryable SERVER_ERROR', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({
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
      expect(error.response.headers.get('retry-after')).toBe('2');
    }
  });

  test('maps network TypeError to NETWORK_ERROR', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(executeFetch({ method: 'get', url: '/items' }, { defaults, fetchImpl }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  test('maps parent cancellation to ABORTED', async () => {
    const parent = new TestAbortSignal();
    const fetchImpl = jest.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const promise = executeFetch({ method: 'get', url: '/items', signal: parent }, {
      defaults, fetchImpl
    });
    parent.dispatchAbort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });

  test('maps transport timeout to TIMEOUT', async () => {
    let timeoutCallback;
    const fetchImpl = jest.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const promise = executeFetch({ method: 'get', url: '/items', timeout: 100 }, {
      defaults,
      fetchImpl,
      setTimeout: (callback) => { timeoutCallback = callback; return 1; },
      clearTimeout: jest.fn()
    });
    timeoutCallback();
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', status: 408, retryable: true });
  });

  test('reports start and completion hooks', async () => {
    const onStart = jest.fn();
    const onSuccess = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(response());
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
    const fetchImpl = jest.fn().mockResolvedValue(response({ status: 503, ok: false }));
    await expect(executeFetch({ method: 'get', url: '/items' }, {
      defaults, fetchImpl, onFailure
    })).rejects.toBeInstanceOf(AppError);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
  });

  test('reports network failure hook once', async () => {
    const onFailure = jest.fn();
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('network'));
    await expect(executeFetch({ method: 'get', url: '/items' }, {
      defaults, fetchImpl, onFailure
    })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].error.code).toBe('NETWORK_ERROR');
  });

  test('rejects invalid fetch response object', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(null);
    await expect(executeFetch({ method: 'get', url: '/items' }, { defaults, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_FETCH_RESPONSE' });
  });

  test('cleans timeout after a successful request', async () => {
    const clearTimeout = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(response());
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
    const circular = {};
    circular.self = circular;
    await expect(executeFetch({ method: 'post', url: '/items', data: circular }, {
      defaults, fetchImpl, setTimeout
    })).rejects.toMatchObject({ code: 'REQUEST_SERIALIZATION_FAILED' });
    expect(setTimeout).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchTransport factory surface', () => {
  const OriginalAbortController = global.AbortController;

  beforeAll(() => {
    global.AbortController = TestAbortController;
  });

  afterAll(() => {
    global.AbortController = OriginalAbortController;
  });

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
      const fetchImpl = jest.fn().mockResolvedValue(response({
        status: method === 'head' ? 204 : 200,
        ok: true,
        body: method === 'head' ? '' : '{"ok":true}'
      }));
      const transport = createFetchTransport({ ...defaults, fetchImpl });
      await transport[helper]('/items');
      expect(fetchImpl.mock.calls[0][1].method).toBe(method.toUpperCase());
    }
  );

  test.each([['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH']])(
    '%s helper forwards JSON body',
    async (helper, expectedMethod) => {
      const fetchImpl = jest.fn().mockResolvedValue(response());
      const transport = createFetchTransport({ ...defaults, fetchImpl });
      await transport[helper]('/items', { value: 1 });
      expect(fetchImpl.mock.calls[0][1].method).toBe(expectedMethod);
      expect(fetchImpl.mock.calls[0][1].body).toBe('{"value":1}');
    }
  );
});
