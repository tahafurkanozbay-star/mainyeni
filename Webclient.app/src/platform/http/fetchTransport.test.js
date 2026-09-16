import {
  buildQueryString,
  combineApplicationUrl,
  createFetchTransport,
  createHttpTransportError,
  createRequestBody,
  createRequestCancellation,
  parseResponseBody
} from './fetchTransport';

const createHeadersLike = (values = {}) => ({
  get: (name) => {
    const key = Object.keys(values).find((candidate) =>
      candidate.toLowerCase() === String(name).toLowerCase());
    return key ? values[key] : null;
  }
});

const createResponse = ({
  status = 200,
  body = '',
  contentType = 'application/json',
  headers = {}
} = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: createHeadersLike({ 'content-type': contentType, ...headers }),
  text: jest.fn().mockResolvedValue(body),
  arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
  blob: jest.fn().mockResolvedValue({ blob: true })
});

describe('buildQueryString', () => {
  test('sorts keys for deterministic network identity', () => {
    expect(buildQueryString({ z: 2, a: 1 })).toBe('?a=1&z=2');
  });

  test('omits nullish values', () => {
    expect(buildQueryString({ a: null, b: undefined, c: 'ok' })).toBe('?c=ok');
  });

  test('repeats array values', () => {
    expect(buildQueryString({ id: [3, 1, 2] })).toBe('?id=3&id=1&id=2');
  });

  test('serializes nested objects deterministically', () => {
    const first = buildQueryString({ filter: { b: 2, a: 1 } });
    const second = buildQueryString({ filter: { a: 1, b: 2 } });
    expect(first).toBe(second);
  });

  test('serializes date values as ISO strings', () => {
    const date = new Date('2026-09-16T06:00:00.000Z');
    expect(decodeURIComponent(buildQueryString({ at: date })))
      .toBe('?at=2026-09-16T06:00:00.000Z');
  });
});

describe('combineApplicationUrl', () => {
  test('joins API base and endpoint', () => {
    expect(combineApplicationUrl('/api', '/items')).toBe('/api/items');
  });

  test('normalizes trailing base slash', () => {
    expect(combineApplicationUrl('/api/', 'items')).toBe('/api/items');
  });

  test('keeps root base local', () => {
    expect(combineApplicationUrl('/', '/items')).toBe('/items');
  });

  test('adds encoded params', () => {
    expect(combineApplicationUrl('/api', '/search', { q: 'Ankara kent' }))
      .toBe('/api/search?q=Ankara+kent');
  });

  test.each([
    'https://evil.example/api',
    '//evil.example/api',
    'javascript:alert(1)',
    '/api\\escape'
  ])('blocks external or malformed request target %s', (target) => {
    expect(() => combineApplicationUrl('/api', target)).toThrow();
  });
});

describe('createRequestBody', () => {
  test('serializes plain object as JSON and sets content type', () => {
    const headers = new Headers();
    const body = createRequestBody({ name: 'Ankara' }, headers);
    expect(body).toBe('{"name":"Ankara"}');
    expect(headers.get('content-type')).toBe('application/json');
  });

  test('preserves existing content type', () => {
    const headers = new Headers({ 'Content-Type': 'application/custom+json' });
    createRequestBody({ value: 1 }, headers);
    expect(headers.get('content-type')).toBe('application/custom+json');
  });

  test('passes string through without JSON quoting', () => {
    const headers = new Headers();
    expect(createRequestBody('plain text', headers)).toBe('plain text');
  });

  test('returns undefined for nullish body', () => {
    const headers = new Headers();
    expect(createRequestBody(undefined, headers)).toBeUndefined();
    expect(createRequestBody(null, headers)).toBeUndefined();
  });
});

describe('parseResponseBody', () => {
  test('parses JSON response', async () => {
    const response = createResponse({ body: '{"ok":true}' });
    await expect(parseResponseBody(response)).resolves.toEqual({ ok: true });
  });

  test('parses problem+json response', async () => {
    const response = createResponse({
      body: '{"title":"problem"}',
      contentType: 'application/problem+json; charset=utf-8'
    });
    await expect(parseResponseBody(response)).resolves.toEqual({ title: 'problem' });
  });

  test('parses vendor +json response', async () => {
    const response = createResponse({
      body: '{"value":1}',
      contentType: 'application/vnd.kentrehberi+json'
    });
    await expect(parseResponseBody(response)).resolves.toEqual({ value: 1 });
  });

  test('returns text for non-json content', async () => {
    const response = createResponse({ body: 'hello', contentType: 'text/plain' });
    await expect(parseResponseBody(response)).resolves.toBe('hello');
  });

  test('returns null for no-content response', async () => {
    const response = createResponse({ status: 204, body: '' });
    await expect(parseResponseBody(response)).resolves.toBeNull();
    expect(response.text).not.toHaveBeenCalled();
  });

  test('supports explicit text response type', async () => {
    const response = createResponse({ body: '{not-json}', contentType: 'application/json' });
    await expect(parseResponseBody(response, 'text')).resolves.toBe('{not-json}');
  });

  test('wraps invalid JSON with bounded transport error', async () => {
    const response = createResponse({ status: 200, body: '{broken' });
    await expect(parseResponseBody(response)).rejects.toMatchObject({
      name: 'HttpTransportError',
      code: 'INVALID_JSON_RESPONSE',
      status: 200
    });
  });
});

describe('createHttpTransportError', () => {
  test('creates axios-compatible response metadata for compatibility layer', () => {
    const error = createHttpTransportError({
      message: 'failed',
      code: 'HTTP_ERROR',
      status: 503,
      data: { unavailable: true },
      headers: { value: 1 }
    });
    expect(error.name).toBe('HttpTransportError');
    expect(error.status).toBe(503);
    expect(error.response.status).toBe(503);
    expect(error.response.data).toEqual({ unavailable: true });
  });

  test('network error has no fake response', () => {
    const error = createHttpTransportError({ code: 'NETWORK_ERROR' });
    expect(error.status).toBeNull();
    expect(error.response).toBeNull();
  });
});

describe('createFetchTransport', () => {
  test('performs same-origin GET with credentials and query', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({
      body: '{"items":[1,2]}'
    }));
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl });

    const response = await transport({
      method: 'get',
      url: '/items',
      params: { page: 2 }
    });

    expect(response.data).toEqual({ items: [1, 2] });
    expect(response.status).toBe(200);
    expect(response.url).toBe('/api/items?page=2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/items?page=2');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
    expect(options.cache).toBe('no-store');
    expect(options.body).toBeUndefined();
  });

  test('serializes POST JSON body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({
      body: '{"saved":true}'
    }));
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl });

    await transport({ method: 'post', url: '/items', data: { name: 'Ada' } });

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"name":"Ada"}');
    expect(options.headers.get('content-type')).toBe('application/json');
  });

  test('merges default and request headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({ body: '{}' }));
    const transport = createFetchTransport({
      baseUrl: '/api',
      fetchImpl,
      defaultHeaders: { Accept: 'application/json', 'X-Default': 'yes' }
    });

    await transport({
      url: '/items',
      headers: { 'X-Default': 'override', 'X-Request': 'yes' }
    });

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.headers.get('accept')).toBe('application/json');
    expect(options.headers.get('x-default')).toBe('override');
    expect(options.headers.get('x-request')).toBe('yes');
  });

  test('turns non-success response into transport error with parsed problem body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({
      status: 429,
      contentType: 'application/problem+json',
      body: '{"title":"Too many requests"}',
      headers: { 'retry-after': '2' }
    }));
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl });

    await expect(transport({ url: '/search' })).rejects.toMatchObject({
      name: 'HttpTransportError',
      code: 'HTTP_ERROR',
      status: 429,
      response: {
        status: 429,
        data: { title: 'Too many requests' }
      }
    });
  });

  test('wraps network failure without exposing arbitrary message contract', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('socket internals'));
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl });

    await expect(transport({ url: '/items' })).rejects.toMatchObject({
      name: 'HttpTransportError',
      code: 'NETWORK_ERROR',
      response: null
    });
  });

  test('honors external abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl, defaultTimeoutMs: 0 });
    const pending = transport({ url: '/slow', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORTED' });
  });

  test('maps timeout abort to timeout transport error', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }));
      const transport = createFetchTransport({ baseUrl: '/api', fetchImpl, defaultTimeoutMs: 50 });
      const pending = transport({ url: '/slow' });
      jest.advanceTimersByTime(50);

      await expect(pending).rejects.toMatchObject({
        name: 'HttpTransportError',
        code: 'ETIMEDOUT',
        status: 408
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('blocks external endpoint before fetch executes', async () => {
    const fetchImpl = jest.fn();
    const transport = createFetchTransport({ baseUrl: '/api', fetchImpl });

    await expect(transport({ url: 'https://evil.example/data' })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createRequestCancellation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('marks timeout separately from caller cancellation', () => {
    const cancellation = createRequestCancellation({ timeoutMs: 10 });
    expect(cancellation.didTimeout()).toBe(false);
    jest.advanceTimersByTime(10);
    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.didTimeout()).toBe(true);
    cancellation.cleanup();
  });

  test('propagates caller cancellation without marking timeout', () => {
    const controller = new AbortController();
    const cancellation = createRequestCancellation({ signal: controller.signal, timeoutMs: 100 });
    controller.abort();
    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.didTimeout()).toBe(false);
    cancellation.cleanup();
  });
});
