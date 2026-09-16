import { AppError } from '../errors/appError';
import {
  BODYLESS_HTTP_METHODS,
  DEFAULT_ACCEPT_HEADER,
  IDEMPOTENT_HTTP_METHODS,
  SAFE_HTTP_METHODS,
  assertSafeHeaderName,
  classifyRequestBody,
  createRequestKey,
  hasSensitiveRequestMetadata,
  isIdempotentMethod,
  isSafeMethod,
  joinApplicationUrl,
  methodAllowsBody,
  normalizeHeaderName,
  normalizeMethod,
  normalizeRequestConfig,
  sanitizeRequestHeaders,
  serializeQueryParams,
  serializeRequestBody,
  stableSerialize
} from './requestPolicy';

describe('requestPolicy method normalization', () => {
  test.each([
    [undefined, 'get'],
    [null, 'get'],
    ['', 'get'],
    ['GET', 'get'],
    [' head ', 'head'],
    ['POST', 'post'],
    ['Delete', 'delete'],
    ['OPTIONS', 'options']
  ])('normalizes %p to %s', (input, expected) => {
    expect(normalizeMethod(input)).toBe(expected);
  });

  test.each(['g et', 'get\npost', '123', 'get/path', 'get?x=1'])(
    'rejects malformed method %p',
    (input) => {
      expect(() => normalizeMethod(input)).toThrow(AppError);
      try {
        normalizeMethod(input);
      } catch (error) {
        expect(error.code).toBe('INVALID_HTTP_METHOD');
        expect(error.retryable).toBe(false);
      }
    }
  );

  test('documents safe methods through an immutable list', () => {
    expect(SAFE_HTTP_METHODS).toEqual(['get', 'head']);
    expect(Object.isFrozen(SAFE_HTTP_METHODS)).toBe(true);
  });

  test('documents idempotent methods through an immutable list', () => {
    expect(IDEMPOTENT_HTTP_METHODS).toEqual(['get', 'head', 'put', 'delete', 'options']);
    expect(Object.isFrozen(IDEMPOTENT_HTTP_METHODS)).toBe(true);
  });

  test('documents bodyless methods', () => {
    expect(BODYLESS_HTTP_METHODS).toEqual(['get', 'head']);
  });

  test.each([
    ['get', true], ['head', true], ['post', false], ['put', false], ['patch', false], ['delete', false]
  ])('classifies %s safe=%p', (method, expected) => {
    expect(isSafeMethod(method)).toBe(expected);
  });

  test.each([
    ['get', true], ['head', true], ['put', true], ['delete', true], ['options', true], ['post', false], ['patch', false]
  ])('classifies %s idempotent=%p', (method, expected) => {
    expect(isIdempotentMethod(method)).toBe(expected);
  });

  test.each([
    ['get', false], ['head', false], ['post', true], ['put', true], ['patch', true], ['delete', true]
  ])('classifies body support for %s', (method, expected) => {
    expect(methodAllowsBody(method)).toBe(expected);
  });
});

describe('requestPolicy header security', () => {
  test.each([
    ['X-Request-ID', 'x-request-id'],
    [' Content-Type ', 'content-type'],
    ['ACCEPT', 'accept']
  ])('normalizes header %p', (input, expected) => {
    expect(normalizeHeaderName(input)).toBe(expected);
  });

  test.each([
    'authorization', 'Authorization', 'COOKIE', 'Proxy-Authorization', 'X-Api-Key',
    'X-Client-Key', 'x-client-secret', 'x-secret', 'x-access-token'
  ])('blocks privileged browser header %s', (name) => {
    expect(() => assertSafeHeaderName(name)).toThrow(AppError);
    try {
      assertSafeHeaderName(name);
    } catch (error) {
      expect(error.code).toBe('PRIVILEGED_HEADER_BLOCKED');
    }
  });

  test.each(['host', 'Content-Length', 'connection', 'Transfer-Encoding', 'Origin', 'Referer'])(
    'blocks browser-managed header %s',
    (name) => {
      try {
        assertSafeHeaderName(name);
        throw new Error('expected header rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error.code).toBe('MANAGED_HEADER_BLOCKED');
      }
    }
  );

  test.each(['', '   ', 'bad header', 'bad:header', 'x-header\nnext', 'x-header/'])(
    'rejects invalid header name %p',
    (name) => {
      try {
        assertSafeHeaderName(name);
        throw new Error('expected header rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error.code).toBe('INVALID_REQUEST_HEADER');
      }
    }
  );

  test('adds the default Accept header', () => {
    expect(sanitizeRequestHeaders({ 'X-Request-ID': 'abc' })).toEqual({
      'X-Request-ID': 'abc',
      Accept: DEFAULT_ACCEPT_HEADER
    });
  });

  test('does not overwrite an explicit Accept header', () => {
    expect(sanitizeRequestHeaders({ Accept: 'text/plain' })).toEqual({ Accept: 'text/plain' });
  });

  test('drops null and blank header values', () => {
    expect(sanitizeRequestHeaders({
      'X-Null': null,
      'X-Undefined': undefined,
      'X-Blank': '   ',
      'X-Good': ' yes '
    })).toEqual({ 'X-Good': 'yes', Accept: DEFAULT_ACCEPT_HEADER });
  });

  test.each(['one\r\ntwo', 'one\ntwo', 'one\rtwo', 'one\0two'])(
    'rejects header value control characters %p',
    (value) => {
      try {
        sanitizeRequestHeaders({ 'X-Test': value });
        throw new Error('expected invalid header');
      } catch (error) {
        expect(error.code).toBe('INVALID_REQUEST_HEADER');
      }
    }
  );

  test('returns only the default header for null input', () => {
    expect(sanitizeRequestHeaders(null)).toEqual({ Accept: DEFAULT_ACCEPT_HEADER });
  });
});

describe('requestPolicy sensitive metadata detection', () => {
  test.each([
    [{ token: 'x' }, true],
    [{ accessToken: 'x' }, true],
    [{ PASSWORD: 'x' }, true],
    [{ nested: { client_key: 'x' } }, true],
    [{ nested: [{ credential: 'x' }] }, true],
    [{ query: 'ankara', page: 2 }, false],
    [null, false],
    ['plain', false]
  ])('detects sensitivity for %p', (value, expected) => {
    expect(hasSensitiveRequestMetadata(value)).toBe(expected);
  });

  test('bounds recursive inspection depth', () => {
    const value = { a: { b: { c: { d: { e: { token: 'deep' } } } } } };
    expect(hasSensitiveRequestMetadata(value)).toBe(false);
  });
});

describe('requestPolicy query serialization', () => {
  test('sorts keys deterministically', () => {
    expect(serializeQueryParams({ z: 1, a: 2, m: 3 })).toBe('a=2&m=3&z=1');
  });

  test('preserves zero false and empty strings', () => {
    expect(serializeQueryParams({ zero: 0, enabled: false, empty: '' }))
      .toBe('empty=&enabled=false&zero=0');
  });

  test('drops null and undefined query values', () => {
    expect(serializeQueryParams({ a: null, b: undefined, c: 'ok' })).toBe('c=ok');
  });

  test('serializes arrays as repeated keys', () => {
    expect(serializeQueryParams({ ids: [3, 2, 1] })).toBe('ids=3&ids=2&ids=1');
  });

  test('drops null entries inside arrays', () => {
    expect(serializeQueryParams({ ids: [1, null, undefined, 2] })).toBe('ids=1&ids=2');
  });

  test('serializes dates using ISO-8601', () => {
    expect(serializeQueryParams({ at: new Date('2026-09-16T05:00:00.000Z') }))
      .toBe('at=2026-09-16T05%3A00%3A00.000Z');
  });

  test('serializes nested objects as compact JSON', () => {
    expect(serializeQueryParams({ filter: { district: 'Çankaya', active: true } }))
      .toBe('filter=%7B%22district%22%3A%22%C3%87ankaya%22%2C%22active%22%3Atrue%7D');
  });

  test('passes URLSearchParams through deterministically', () => {
    const params = new URLSearchParams();
    params.append('a', '1');
    params.append('a', '2');
    expect(serializeQueryParams(params)).toBe('a=1&a=2');
  });

  test.each([['not-object'], [12], [true], [[1, 2]]])('rejects non-object params %p', (value) => {
    try {
      serializeQueryParams(value);
      throw new Error('expected invalid params');
    } catch (error) {
      expect(error.code).toBe('INVALID_QUERY_PARAMS');
    }
  });

  test('joins base and application path once', () => {
    expect(joinApplicationUrl('/api', '/AppSettings/List', { key: 'GisMapConfig' }))
      .toBe('/api/AppSettings/List?key=GisMapConfig');
  });

  test('does not double-prefix an already based path', () => {
    expect(joinApplicationUrl('/api', '/api/health')).toBe('/api/health');
  });

  test('supports root base URL', () => {
    expect(joinApplicationUrl('/', '/health')).toBe('/health');
  });

  test('appends params to an existing query string', () => {
    expect(joinApplicationUrl('/api', '/items?fixed=1', { page: 2 }))
      .toBe('/api/items?fixed=1&page=2');
  });

  test.each(['https://evil.example/path', '//evil.example/path', 'http://localhost/path'])(
    'blocks cross-origin-like application path %p',
    (path) => {
      expect(() => joinApplicationUrl('/api', path)).toThrow(AppError);
    }
  );
});

describe('requestPolicy request body handling', () => {
  test.each([
    [undefined, 'none'],
    [null, 'none'],
    ['text', 'text'],
    [{ a: 1 }, 'json'],
    [[1, 2], 'json'],
    [12, 'json'],
    [false, 'json']
  ])('classifies body %p as %s', (value, expected) => {
    expect(classifyRequestBody(value)).toBe(expected);
  });

  test('classifies URLSearchParams specially', () => {
    expect(classifyRequestBody(new URLSearchParams('a=1'))).toBe('url-search-params');
  });

  test('rejects bodies for GET', () => {
    try {
      serializeRequestBody('get', { a: 1 }, {});
      throw new Error('expected body rejection');
    } catch (error) {
      expect(error.code).toBe('BODY_NOT_ALLOWED');
    }
  });

  test('rejects bodies for HEAD', () => {
    expect(() => serializeRequestBody('head', 'value', {})).toThrow(AppError);
  });

  test('allows empty GET body', () => {
    expect(serializeRequestBody('get', undefined, { Accept: 'application/json' }))
      .toEqual({ body: undefined, headers: { Accept: 'application/json' } });
  });

  test('serializes plain object as JSON and sets content type', () => {
    const result = serializeRequestBody('post', { name: 'Ankara' }, { Accept: 'application/json' });
    expect(result.body).toBe('{"name":"Ankara"}');
    expect(result.headers['Content-Type']).toBe('application/json;charset=UTF-8');
  });

  test('preserves explicit JSON content type', () => {
    const result = serializeRequestBody('post', { a: 1 }, { 'content-type': 'application/problem+json' });
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect(result.headers['Content-Type']).toBeUndefined();
  });

  test('serializes string body as text', () => {
    const result = serializeRequestBody('post', 'hello', {});
    expect(result.body).toBe('hello');
    expect(result.headers['Content-Type']).toBe('text/plain;charset=UTF-8');
  });

  test('keeps URLSearchParams body intact', () => {
    const body = new URLSearchParams('a=1&b=2');
    const result = serializeRequestBody('post', body, {});
    expect(result.body).toBe(body);
    expect(result.headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  test('rejects unsupported body types', () => {
    const value = new Map([['a', 1]]);
    try {
      serializeRequestBody('post', value, {});
      throw new Error('expected unsupported body');
    } catch (error) {
      expect(error.code).toBe('UNSUPPORTED_REQUEST_BODY');
    }
  });

  test('wraps circular JSON serialization failure', () => {
    const value = {};
    value.self = value;
    try {
      serializeRequestBody('post', value, {});
      throw new Error('expected serialization failure');
    } catch (error) {
      expect(error.code).toBe('REQUEST_SERIALIZATION_FAILED');
      expect(error.retryable).toBe(false);
    }
  });
});

describe('requestPolicy stable serialization', () => {
  test('sorts object keys recursively', () => {
    expect(stableSerialize({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  test('preserves array order', () => {
    expect(stableSerialize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('normalizes dates', () => {
    expect(stableSerialize(new Date('2026-01-01T00:00:00.000Z')))
      .toBe('"2026-01-01T00:00:00.000Z"');
  });

  test('normalizes non-finite numbers as strings', () => {
    expect(stableSerialize(Number.NaN)).toBe('"NaN"');
    expect(stableSerialize(Number.POSITIVE_INFINITY)).toBe('"Infinity"');
  });

  test('rejects circular metadata', () => {
    const value = {};
    value.self = value;
    try {
      stableSerialize(value);
      throw new Error('expected circular failure');
    } catch (error) {
      expect(error.code).toBe('CIRCULAR_REQUEST_METADATA');
    }
  });

  test('creates a deterministic request key', () => {
    expect(createRequestKey({ method: 'GET', url: '/items', params: { z: 2, a: 1 } }))
      .toBe('get|/items|a=1&z=2');
  });
});

describe('requestPolicy normalized request config', () => {
  const defaults = { timeoutMs: 5000, maxRetries: 2, cacheTtlMs: 30000 };

  test('normalizes basic request defaults', () => {
    const result = normalizeRequestConfig({ url: '/health' }, defaults);
    expect(result).toMatchObject({
      method: 'get',
      url: '/health',
      timeout: 5000,
      maxRetries: 2,
      cache: false,
      dedupe: false,
      retryAllowed: true,
      safeMethod: true,
      idempotentMethod: true,
      containsSensitiveMetadata: false,
      cacheTtlMs: 30000
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('enables cache and dedupe only when explicitly requested', () => {
    const result = normalizeRequestConfig({ method: 'get', url: '/items', cache: true, dedupe: true }, defaults);
    expect(result.cache).toBe(true);
    expect(result.dedupe).toBe(true);
  });

  test('disables cache and dedupe for unsafe POST requests', () => {
    const result = normalizeRequestConfig({ method: 'post', url: '/items', cache: true, dedupe: true }, defaults);
    expect(result.cache).toBe(false);
    expect(result.dedupe).toBe(false);
    expect(result.retryAllowed).toBe(false);
  });

  test('allows explicit unsafe retry without enabling cache or dedupe', () => {
    const result = normalizeRequestConfig({ method: 'post', url: '/items', retryUnsafe: true, cache: true, dedupe: true }, defaults);
    expect(result.retryAllowed).toBe(true);
    expect(result.cache).toBe(false);
    expect(result.dedupe).toBe(false);
  });

  test('disables cache and dedupe for sensitive query metadata', () => {
    const result = normalizeRequestConfig({
      method: 'get', url: '/items', params: { token: 'secret' }, cache: true, dedupe: true
    }, defaults);
    expect(result.containsSensitiveMetadata).toBe(true);
    expect(result.cache).toBe(false);
    expect(result.dedupe).toBe(false);
  });

  test('disables dedupe when caller owns a cancellation signal', () => {
    const controller = new AbortController();
    const result = normalizeRequestConfig({ method: 'get', url: '/items', dedupe: true, signal: controller.signal }, defaults);
    expect(result.dedupe).toBe(false);
  });

  test('clamps request timeout to one minute', () => {
    expect(normalizeRequestConfig({ url: '/items', timeout: 999999 }, defaults).timeout).toBe(60000);
  });

  test('clamps request timeout to a positive value', () => {
    expect(normalizeRequestConfig({ url: '/items', timeout: -200 }, defaults).timeout).toBe(1);
  });

  test('clamps retry count to four', () => {
    expect(normalizeRequestConfig({ url: '/items', maxRetries: 99 }, defaults).maxRetries).toBe(4);
  });

  test('clamps negative retry count to zero', () => {
    expect(normalizeRequestConfig({ url: '/items', maxRetries: -2 }, defaults).maxRetries).toBe(0);
  });

  test('normalizes negative cache TTL to zero', () => {
    expect(normalizeRequestConfig({ url: '/items', cacheTtlMs: -100 }, defaults).cacheTtlMs).toBe(0);
  });

  test('rejects a non-object configuration', () => {
    try {
      normalizeRequestConfig('invalid', defaults);
      throw new Error('expected invalid config');
    } catch (error) {
      expect(error.code).toBe('INVALID_REQUEST_CONFIG');
    }
  });
});
