import { AppError } from '../errors/appError';
import {
  createHttpResponseError,
  createResponseMetadata,
  getContentType,
  hasNoResponseBody,
  headersToObject,
  isJsonContentType,
  isTextContentType,
  mapHttpStatusToError,
  normalizeFetchFailure,
  parseResponseBody
} from './responseParser';

const createHeaders = (values = {}) => {
  const normalized = Object.keys(values).reduce((accumulator, key) => {
    accumulator[key.toLowerCase()] = String(values[key]);
    return accumulator;
  }, {});

  return {
    get: jest.fn((name) => normalized[String(name).toLowerCase()] ?? null),
    forEach: jest.fn((callback) => {
      Object.keys(normalized).forEach((key) => callback(normalized[key], key));
    })
  };
};

const createResponse = ({
  status = 200,
  ok = status >= 200 && status < 300,
  statusText = 'OK',
  contentType = 'application/json',
  body = '',
  headers = {},
  blob,
  arrayBuffer
} = {}) => ({
  status,
  ok,
  statusText,
  headers: createHeaders({ 'content-type': contentType, ...headers }),
  text: jest.fn().mockResolvedValue(body),
  blob: blob || jest.fn().mockResolvedValue({ blob: true }),
  arrayBuffer: arrayBuffer || jest.fn().mockResolvedValue(new ArrayBuffer(4))
});

describe('responseParser content type detection', () => {
  test.each([
    'application/json',
    'application/json;charset=utf-8',
    'application/problem+json',
    'application/geo+json',
    'application/vnd.api+json'
  ])('recognizes JSON content type %s', (value) => {
    expect(isJsonContentType(value)).toBe(true);
  });

  test.each([
    'text/plain',
    'text/html;charset=utf-8',
    'application/xml',
    'application/xhtml+xml',
    'application/javascript',
    'application/x-www-form-urlencoded'
  ])('recognizes text content type %s', (value) => {
    expect(isTextContentType(value)).toBe(true);
  });

  test.each(['', null, undefined, 'application/octet-stream', 'image/png'])(
    'does not classify %p as JSON',
    (value) => {
      expect(isJsonContentType(value)).toBe(false);
    }
  );

  test('reads content type from Fetch-style headers', () => {
    expect(getContentType(createResponse({
      contentType: 'Application/JSON; Charset=UTF-8'
    }))).toBe('application/json');
  });
});

describe('responseParser header normalization', () => {
  test('normalizes Fetch-style headers to lowercase keys', () => {
    const headers = createHeaders({
      'X-Request-ID': 'abc',
      'Content-Type': 'application/json'
    });
    expect(headersToObject(headers)).toEqual({
      'x-request-id': 'abc',
      'content-type': 'application/json'
    });
  });

  test('normalizes plain object headers', () => {
    expect(headersToObject({
      'X-Request-ID': 'abc',
      ETag: '"123"'
    })).toEqual({
      'x-request-id': 'abc',
      etag: '"123"'
    });
  });

  test('returns immutable empty object for missing headers', () => {
    const result = headersToObject(null);
    expect(result).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('truncates excessive header values', () => {
    const result = headersToObject({
      'x-large': 'x'.repeat(1000)
    });
    expect(result['x-large'].length).toBe(512);
  });
});

describe('responseParser no-body detection', () => {
  test.each([204, 205, 304])('status %s has no body', (status) => {
    expect(hasNoResponseBody(createResponse({ status }), 'get')).toBe(true);
  });

  test('HEAD never parses a body', () => {
    expect(hasNoResponseBody(createResponse({
      status: 200,
      body: '{"value":1}'
    }), 'head')).toBe(true);
  });

  test('content-length zero indicates no body', () => {
    expect(hasNoResponseBody(createResponse({
      status: 200,
      headers: { 'content-length': '0' }
    }), 'get')).toBe(true);
  });

  test('ordinary GET response may contain body', () => {
    expect(hasNoResponseBody(createResponse({
      status: 200,
      headers: { 'content-length': '15' }
    }), 'get')).toBe(false);
  });
});

describe('responseParser successful body parsing', () => {
  test('parses JSON content', async () => {
    const response = createResponse({ body: '{"name":"Ankara","count":25}' });
    await expect(parseResponseBody(response)).resolves.toEqual({ name: 'Ankara', count: 25 });
  });

  test('parses problem+json content', async () => {
    const response = createResponse({
      contentType: 'application/problem+json',
      body: '{"title":"Problem"}'
    });
    await expect(parseResponseBody(response)).resolves.toEqual({ title: 'Problem' });
  });

  test('returns text content verbatim', async () => {
    const response = createResponse({ contentType: 'text/plain', body: 'hello world' });
    await expect(parseResponseBody(response)).resolves.toBe('hello world');
  });

  test('honors explicit text response type even for JSON content', async () => {
    const response = createResponse({ body: '{"value":1}' });
    await expect(parseResponseBody(response, { responseType: 'text' }))
      .resolves.toBe('{"value":1}');
  });

  test('honors explicit JSON response type without JSON content type', async () => {
    const response = createResponse({
      contentType: 'application/octet-stream',
      body: '{"value":1}'
    });
    await expect(parseResponseBody(response, { responseType: 'json' }))
      .resolves.toEqual({ value: 1 });
  });

  test('auto-detects object-looking body without content type', async () => {
    const response = createResponse({ contentType: '', body: '{"value":1}' });
    await expect(parseResponseBody(response)).resolves.toEqual({ value: 1 });
  });

  test('auto-detects array-looking body without content type', async () => {
    const response = createResponse({ contentType: '', body: '[1,2,3]' });
    await expect(parseResponseBody(response)).resolves.toEqual([1, 2, 3]);
  });

  test('returns opaque body as text when type is unknown', async () => {
    const response = createResponse({
      contentType: 'application/octet-stream',
      body: 'opaque-data'
    });
    await expect(parseResponseBody(response)).resolves.toBe('opaque-data');
  });

  test('returns null for empty body', async () => {
    const response = createResponse({ contentType: 'application/octet-stream', body: '   ' });
    await expect(parseResponseBody(response)).resolves.toBeNull();
  });

  test('returns null without calling text for 204', async () => {
    const response = createResponse({ status: 204, ok: true, body: 'ignored' });
    await expect(parseResponseBody(response)).resolves.toBeNull();
    expect(response.text).not.toHaveBeenCalled();
  });

  test('returns null without calling text for HEAD', async () => {
    const response = createResponse({ status: 200, body: 'ignored' });
    await expect(parseResponseBody(response, { method: 'head' })).resolves.toBeNull();
    expect(response.text).not.toHaveBeenCalled();
  });

  test('returns raw response for response mode', async () => {
    const response = createResponse({ body: '{"value":1}' });
    await expect(parseResponseBody(response, { responseType: 'response' })).resolves.toBe(response);
  });

  test('delegates blob mode to response.blob', async () => {
    const response = createResponse();
    await expect(parseResponseBody(response, { responseType: 'blob' }))
      .resolves.toEqual({ blob: true });
    expect(response.blob).toHaveBeenCalledTimes(1);
  });

  test('delegates arraybuffer mode to response.arrayBuffer', async () => {
    const response = createResponse();
    const result = await parseResponseBody(response, { responseType: 'arraybuffer' });
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(response.arrayBuffer).toHaveBeenCalledTimes(1);
  });

  test('rejects blob mode if runtime response has no blob function', async () => {
    const response = createResponse();
    response.blob = undefined;
    await expect(parseResponseBody(response, { responseType: 'blob' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RESPONSE_TYPE' });
  });

  test('rejects arraybuffer mode if runtime response has no arrayBuffer function', async () => {
    const response = createResponse();
    response.arrayBuffer = undefined;
    await expect(parseResponseBody(response, { responseType: 'arraybuffer' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RESPONSE_TYPE' });
  });
});

describe('responseParser malformed JSON behavior', () => {
  test('rejects malformed explicit JSON with typed error', async () => {
    const response = createResponse({ contentType: 'application/json', body: '{"broken":' });
    await expect(parseResponseBody(response)).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
      status: 200,
      retryable: false
    });
  });

  test('can preserve malformed JSON text when explicitly allowed', async () => {
    const response = createResponse({ contentType: 'application/json', body: '{"broken":' });
    await expect(parseResponseBody(response, { allowInvalidJson: true }))
      .resolves.toBe('{"broken":');
  });

  test('auto mode leaves malformed JSON-looking opaque body as text', async () => {
    const response = createResponse({ contentType: 'application/octet-stream', body: '{"broken":' });
    await expect(parseResponseBody(response)).resolves.toBe('{"broken":');
  });
});

describe('responseParser HTTP status mapping', () => {
  test.each([
    [400, 'BAD_REQUEST', false],
    [401, 'UNAUTHORIZED', false],
    [403, 'FORBIDDEN', false],
    [404, 'NOT_FOUND', false],
    [408, 'TIMEOUT', true],
    [409, 'CONFLICT', false],
    [412, 'PRECONDITION_FAILED', false],
    [413, 'PAYLOAD_TOO_LARGE', false],
    [422, 'VALIDATION_FAILED', false],
    [425, 'TOO_EARLY', true],
    [429, 'RATE_LIMITED', true],
    [500, 'SERVER_ERROR', true],
    [503, 'SERVER_ERROR', true]
  ])('maps status %s to %s', (status, code, retryable) => {
    const error = mapHttpStatusToError(status, null);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
  });

  test('uses bounded server message for safe 400 response', () => {
    expect(mapHttpStatusToError(400, { message: 'Validation message' }).message)
      .toBe('Validation message');
  });

  test('uses problem detail for safe 422 response', () => {
    expect(mapHttpStatusToError(422, { detail: 'District is required' }).message)
      .toBe('District is required');
  });

  test('does not expose an excessive server message', () => {
    expect(mapHttpStatusToError(400, { message: 'x'.repeat(1000) }).message)
      .toBe('İstek geçersiz.');
  });

  test('does not expose server message for authentication failures', () => {
    expect(mapHttpStatusToError(401, { message: 'internal auth detail' }).message)
      .toBe('Oturum doğrulaması gerekli.');
  });

  test('carries correlation id into mapped errors', () => {
    expect(mapHttpStatusToError(503, null, { requestId: 'req-123' }).requestId)
      .toBe('req-123');
  });

  test('maps unknown status to generic HTTP error', () => {
    const error = mapHttpStatusToError(418, null);
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.status).toBe(418);
    expect(error.retryable).toBe(false);
  });
});

describe('responseParser HTTP response error construction', () => {
  test('parses error body and exposes Retry-After compatible response metadata', async () => {
    const response = createResponse({
      status: 429,
      ok: false,
      body: '{"message":"too many"}',
      headers: { 'Retry-After': '2', 'X-Request-ID': 'req-429' }
    });
    const error = await createHttpResponseError(response);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.requestId).toBe('req-429');
    expect(error.response.status).toBe(429);
    expect(error.response.data).toEqual({ message: 'too many' });
    expect(error.response.headers).toBe(response.headers);
  });

  test('uses x-correlation-id when x-request-id is absent', async () => {
    const response = createResponse({
      status: 500,
      ok: false,
      headers: { 'X-Correlation-ID': 'corr-1' }
    });
    const error = await createHttpResponseError(response);
    expect(error.requestId).toBe('corr-1');
  });

  test('survives an unreadable error response body', async () => {
    const response = createResponse({ status: 503, ok: false });
    response.text.mockRejectedValue(new Error('stream failed'));
    const error = await createHttpResponseError(response);
    expect(error.code).toBe('SERVER_ERROR');
    expect(error.response.data).toBeNull();
  });
});

describe('responseParser fetch failure normalization', () => {
  test('preserves existing AppError identity', () => {
    const source = new AppError('existing', { code: 'CUSTOM' });
    expect(normalizeFetchFailure(source)).toBe(source);
  });

  test('maps timed out abort to TIMEOUT rather than generic cancellation', () => {
    const source = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = normalizeFetchFailure(source, { timedOut: true, aborted: true });
    expect(error.code).toBe('TIMEOUT');
    expect(error.status).toBe(408);
    expect(error.retryable).toBe(true);
  });

  test('maps caller abort to ABORTED', () => {
    const source = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = normalizeFetchFailure(source, { aborted: true });
    expect(error.code).toBe('ABORTED');
    expect(error.retryable).toBe(false);
  });

  test('maps DOM AbortError to ABORTED without explicit context', () => {
    const error = normalizeFetchFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(error.code).toBe('ABORTED');
  });

  test('maps ordinary fetch rejection to NETWORK_ERROR', () => {
    const error = normalizeFetchFailure(new TypeError('Failed to fetch'));
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
  });
});

describe('responseParser response metadata', () => {
  test('creates immutable compact metadata', () => {
    const response = createResponse({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Request-ID': 'req-1' }
    });
    const metadata = createResponseMetadata(response, {
      url: '/api/items?secret=value',
      method: 'GET'
    });
    expect(metadata).toEqual({
      status: 200,
      ok: true,
      contentType: 'application/json',
      requestId: 'req-1',
      url: '/api/items?secret=value',
      method: 'get',
      headers: undefined
    });
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  test('can include normalized response headers on explicit request', () => {
    const response = createResponse({ headers: { ETag: '"abc"' } });
    const metadata = createResponseMetadata(response, { includeHeaders: true });
    expect(metadata.headers.etag).toBe('"abc"');
    expect(Object.isFrozen(metadata.headers)).toBe(true);
  });
});
