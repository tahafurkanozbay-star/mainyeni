import { describe, expect, test, vi } from 'vitest';
import { executeFetch } from './fetchTransport';
import {
  assertResponseBodyBudget,
  createHttpResponseError,
  headersToObject,
  parseResponseBody,
  responseBodyByteLength,
  type ResponseLike,
} from './responseParser';
import { normalizeRequestConfig } from './requestPolicy';

const headers = (values: Record<string, string> = {}) => {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get: (name: string) => normalized[name.toLowerCase()] ?? null,
    forEach: (callback: (value: string, key: string) => void) => {
      for (const [key, value] of Object.entries(normalized)) callback(value, key);
    },
  };
};

const response = (
  body: string,
  options: {
    status?: number;
    contentType?: string;
    contentLength?: number;
  } = {},
): ResponseLike => ({
  status: options.status ?? 200,
  ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
  statusText: 'OK',
  headers: headers({
    'content-type': options.contentType ?? 'application/json',
    ...(options.contentLength === undefined
      ? {}
      : { 'content-length': String(options.contentLength) }),
  }) as unknown as Headers,
  text: vi.fn(async () => body),
  blob: vi.fn(async () => new Blob([body])),
  arrayBuffer: vi.fn(async () => new TextEncoder().encode(body).buffer),
});

describe('response byte accounting', () => {
  test('counts ASCII bytes exactly', () => {
    expect(responseBodyByteLength('abc')).toBe(3);
  });

  test('counts UTF-8 Turkish text correctly', () => {
    expect(responseBodyByteLength('Çankaya')).toBe(new TextEncoder().encode('Çankaya').byteLength);
  });

  test('counts astral emoji as four UTF-8 bytes', () => {
    expect(responseBodyByteLength('🗺️')).toBe(new TextEncoder().encode('🗺️').byteLength);
  });

  test('accepts content length at the exact configured boundary', () => {
    const target = response('', { contentLength: 1024 });
    expect(assertResponseBodyBudget(target, 1024)).toBe(1024);
  });

  test('rejects advertised body length above the configured boundary', () => {
    const target = response('', { contentLength: 1025 });
    expect(() => assertResponseBodyBudget(target, 1024)).toThrowError(
      expect.objectContaining({
        code: 'RESPONSE_TOO_LARGE',
        retryable: false,
      }),
    );
  });

  test('ignores malformed content-length instead of trusting it', () => {
    const target: ResponseLike = {
      status: 200,
      headers: headers({ 'content-length': 'not-a-number' }) as unknown as Headers,
      text: vi.fn(async () => 'ok'),
    };
    expect(assertResponseBodyBudget(target, 1024)).toBe(1024);
  });

  test('clamps caller body budget to the safe lower bound', () => {
    expect(assertResponseBodyBudget(response(''), 1)).toBe(1024);
  });

  test('clamps caller body budget to the safe upper bound', () => {
    expect(assertResponseBodyBudget(response(''), Number.MAX_SAFE_INTEGER))
      .toBe(64 * 1024 * 1024);
  });
});

describe('bounded text and JSON materialization', () => {
  test('parses JSON below the configured byte budget', async () => {
    const target = response('{"name":"Ankara"}');
    await expect(parseResponseBody(target, {
      responseType: 'json',
      maxBodyBytes: 1024,
    })).resolves.toEqual({ name: 'Ankara' });
  });

  test('rejects text whose actual UTF-8 size exceeds the budget', async () => {
    const target = response('ü'.repeat(600), {
      contentType: 'text/plain',
    });

    await expect(parseResponseBody(target, {
      responseType: 'text',
      maxBodyBytes: 1024,
    })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
  });

  test('preflight rejection avoids reading a body advertised as too large', async () => {
    const target = response('never-read', {
      contentLength: 2048,
    });

    await expect(parseResponseBody(target, {
      maxBodyBytes: 1024,
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(target.text).not.toHaveBeenCalled();
  });

  test('empty no-body response bypasses materialization', async () => {
    const target = response('ignored', {
      status: 204,
      contentLength: 10_000,
    });

    await expect(parseResponseBody(target, {
      maxBodyBytes: 1024,
    })).resolves.toBeNull();
    expect(target.text).not.toHaveBeenCalled();
  });

  test('HEAD response bypasses materialization regardless of advertised size', async () => {
    const target = response('ignored', {
      contentLength: 10_000,
    });

    await expect(parseResponseBody(target, {
      method: 'head',
      maxBodyBytes: 1024,
    })).resolves.toBeNull();
    expect(target.text).not.toHaveBeenCalled();
  });

  test('raw response mode preserves streaming ownership for explicit callers', async () => {
    const target = response('not-materialized', {
      contentLength: 50_000,
    });

    await expect(parseResponseBody(target, {
      responseType: 'response',
      maxBodyBytes: 1024,
    })).resolves.toBe(target);
    expect(target.text).not.toHaveBeenCalled();
  });
});

describe('bounded binary materialization', () => {
  test('accepts a blob below the configured byte budget', async () => {
    const target = response('x'.repeat(100), {
      contentType: 'application/octet-stream',
    });

    const value = await parseResponseBody(target, {
      responseType: 'blob',
      maxBodyBytes: 1024,
    });
    expect(value).toBeInstanceOf(Blob);
    expect((value as Blob).size).toBe(100);
  });

  test('rejects a blob whose materialized size exceeds the budget', async () => {
    const target = response('x'.repeat(2048), {
      contentType: 'application/octet-stream',
    });

    await expect(parseResponseBody(target, {
      responseType: 'blob',
      maxBodyBytes: 1024,
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  test('accepts an ArrayBuffer below the configured byte budget', async () => {
    const target = response('x'.repeat(100), {
      contentType: 'application/octet-stream',
    });

    const value = await parseResponseBody(target, {
      responseType: 'arraybuffer',
      maxBodyBytes: 1024,
    });
    expect(value).toBeInstanceOf(ArrayBuffer);
    expect((value as ArrayBuffer).byteLength).toBe(100);
  });

  test('rejects an ArrayBuffer whose materialized size exceeds the budget', async () => {
    const target = response('x'.repeat(2048), {
      contentType: 'application/octet-stream',
    });

    await expect(parseResponseBody(target, {
      responseType: 'arraybuffer',
      maxBodyBytes: 1024,
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('error response governance', () => {
  test('maps an oversized error response without materializing its body', async () => {
    const target = response('{"message":"never-read"}', {
      status: 503,
      contentLength: 128 * 1024,
    });

    const error = await createHttpResponseError(target, {
      maxBodyBytes: 16 * 1024 * 1024,
    });

    expect(error).toMatchObject({
      code: 'SERVER_ERROR',
      status: 503,
      retryable: true,
    });
    expect(error.response?.data).toBeNull();
    expect(target.text).not.toHaveBeenCalled();
  });

  test('allows a small bounded problem response to supply a safe validation message', async () => {
    const target = response('{"message":"District is required"}', {
      status: 400,
      contentLength: 34,
    });

    const error = await createHttpResponseError(target);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('District is required');
  });
});

describe('response header privacy', () => {
  test('drops credential-bearing plain-object response headers', () => {
    expect(headersToObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
      'Set-Cookie': 'session=secret',
      'X-Api-Key': 'secret-key',
      ETag: '"safe"',
    })).toEqual({
      'content-type': 'application/json',
      etag: '"safe"',
    });
  });

  test('drops credential-bearing Fetch-style response headers', () => {
    const snapshot = headersToObject(headers({
      'content-type': 'application/json',
      'set-cookie': 'session=secret',
      'x-auth-token': 'secret',
      'x-request-id': 'req-1',
    }) as unknown as Headers);

    expect(snapshot).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  test('retains bounded ordinary response headers', () => {
    const snapshot = headersToObject({
      'X-Large': 'x'.repeat(1000),
    });
    expect(snapshot['x-large']).toHaveLength(512);
  });
});

describe('request policy response budget normalization', () => {
  test('uses a bounded 16 MiB default', () => {
    expect(normalizeRequestConfig({
      method: 'get',
      url: '/items',
    }).maxResponseBytes).toBe(16 * 1024 * 1024);
  });

  test('accepts an explicit response budget', () => {
    expect(normalizeRequestConfig({
      method: 'get',
      url: '/items',
      maxResponseBytes: 2 * 1024 * 1024,
    }).maxResponseBytes).toBe(2 * 1024 * 1024);
  });

  test('clamps excessively small response budgets', () => {
    expect(normalizeRequestConfig({
      method: 'get',
      url: '/items',
      maxResponseBytes: 1,
    }).maxResponseBytes).toBe(1024);
  });

  test('clamps excessively large response budgets', () => {
    expect(normalizeRequestConfig({
      method: 'get',
      url: '/items',
      maxResponseBytes: Number.MAX_SAFE_INTEGER,
    }).maxResponseBytes).toBe(64 * 1024 * 1024);
  });
});

describe('fetch transport response budget integration', () => {
  test('rejects oversized advertised success responses before text materialization', async () => {
    const text = vi.fn(async () => '{"value":1}');
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: headers({
        'content-type': 'application/json',
        'content-length': '2048',
      }),
      text,
    })) as unknown as typeof fetch;

    await expect(executeFetch({
      method: 'get',
      url: '/items',
      maxResponseBytes: 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
    expect(text).not.toHaveBeenCalled();
  });

  test('accepts a response within the configured budget', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: headers({
        'content-type': 'application/json',
        'content-length': '11',
      }),
      text: vi.fn(async () => '{"ok":true}'),
    })) as unknown as typeof fetch;

    await expect(executeFetch<{ ok: boolean }>({
      method: 'get',
      url: '/items',
      maxResponseBytes: 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).resolves.toMatchObject({
      data: { ok: true },
      status: 200,
    });
  });

  test('still maps oversized error responses by HTTP status', async () => {
    const text = vi.fn(async () => '{"message":"hidden"}');
    const fetchImpl = vi.fn(async () => ({
      status: 503,
      statusText: 'Unavailable',
      ok: false,
      headers: headers({
        'content-type': 'application/json',
        'content-length': String(128 * 1024),
      }),
      text,
    })) as unknown as typeof fetch;

    await expect(executeFetch({
      method: 'get',
      url: '/items',
      maxResponseBytes: 16 * 1024 * 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 503,
    });
    expect(text).not.toHaveBeenCalled();
  });
});
