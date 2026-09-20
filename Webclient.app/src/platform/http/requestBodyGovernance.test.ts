import { describe, expect, test, vi } from 'vitest';
import { executeFetch } from './fetchTransport';
import {
  classifyRequestBody,
  normalizeRequestConfig,
  requestBodyByteLength,
  serializeRequestBody,
} from './requestPolicy';

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

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  ok: true,
  headers: headers({
    'content-type': 'application/json',
    'content-length': '11',
  }),
  text: vi.fn(async () => '{"ok":true}'),
});

describe('request body classification and sizing', () => {
  test.each([
    [undefined, 'none'],
    [null, 'none'],
    ['text', 'text'],
    [new URLSearchParams('a=1'), 'url-search-params'],
    [new ArrayBuffer(4), 'array-buffer'],
    [{ value: 1 }, 'json'],
    [[1, 2], 'json'],
    [true, 'json'],
    [42, 'json'],
  ] as const)('classifies request body %#', (value, expected) => {
    expect(classifyRequestBody(value)).toBe(expected);
  });

  test('classifies Blob when supported by the runtime', () => {
    expect(classifyRequestBody(new Blob(['abc']))).toBe('blob');
  });

  test('classifies FormData when supported by the runtime', () => {
    expect(classifyRequestBody(new FormData())).toBe('form-data');
  });

  test('rejects unsupported request body objects', () => {
    expect(classifyRequestBody(new Map())).toBe('unsupported');
  });

  test('reports text body bytes using UTF-8', () => {
    expect(requestBodyByteLength('Çankaya')).toBe(
      new TextEncoder().encode('Çankaya').byteLength,
    );
  });

  test('reports ArrayBuffer bytes exactly', () => {
    expect(requestBodyByteLength(new ArrayBuffer(128))).toBe(128);
  });

  test('reports Blob bytes exactly', () => {
    expect(requestBodyByteLength(new Blob(['x'.repeat(128)]))).toBe(128);
  });

  test('reports URLSearchParams encoded bytes', () => {
    const params = new URLSearchParams({ q: 'Kızılay & Ulus' });
    expect(requestBodyByteLength(params)).toBe(
      new TextEncoder().encode(params.toString()).byteLength,
    );
  });

  test('returns null for structured JSON before serialization', () => {
    expect(requestBodyByteLength({ value: 1 })).toBeNull();
  });

  test('returns null for FormData because multipart framing is transport-defined', () => {
    expect(requestBodyByteLength(new FormData())).toBeNull();
  });
});

describe('bounded text and JSON request serialization', () => {
  test('serializes bounded UTF-8 text', () => {
    const result = serializeRequestBody('post', 'hello', {}, {
      maxBodyBytes: 1024,
    });
    expect(result).toEqual({
      body: 'hello',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  });

  test('rejects text whose UTF-8 bytes exceed the configured budget', () => {
    expect(() => serializeRequestBody(
      'post',
      'ü'.repeat(600),
      {},
      { maxBodyBytes: 1024 },
    )).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
    }));
  });

  test('accepts JSON at the configured byte boundary', () => {
    const body = { value: 'x'.repeat(100) };
    const serialized = JSON.stringify(body);
    const result = serializeRequestBody('post', body, {}, {
      maxBodyBytes: new TextEncoder().encode(serialized).byteLength,
    });
    expect(result.body).toBe(serialized);
  });

  test('rejects oversized JSON without remapping the typed budget error', () => {
    try {
      serializeRequestBody(
        'post',
        { value: 'x'.repeat(2_000) },
        {},
        { maxBodyBytes: 1024 },
      );
      throw new Error('expected request-body rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'REQUEST_BODY_TOO_LARGE',
        retryable: false,
      });
    }
  });

  test('rejects circular JSON with serialization error rather than hanging', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeRequestBody('post', circular))
      .toThrowError(expect.objectContaining({
        code: 'REQUEST_SERIALIZATION_FAILED',
        retryable: false,
      }));
  });

  test('retains caller-provided content-type instead of overriding it', () => {
    const result = serializeRequestBody(
      'post',
      { value: 1 },
      { 'content-type': 'application/problem+json' },
    );
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect(result.headers['Content-Type']).toBeUndefined();
  });
});

describe('bounded URLSearchParams and binary request serialization', () => {
  test('accepts URLSearchParams under budget', () => {
    const data = new URLSearchParams({ q: 'park', page: '2' });
    const result = serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    });
    expect(result.body).toBe(data);
    expect(result.headers['Content-Type'])
      .toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  test('rejects URLSearchParams over budget', () => {
    const data = new URLSearchParams({ q: 'x'.repeat(2_000) });
    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });

  test('accepts Blob under budget without materializing it', () => {
    const data = new Blob(['x'.repeat(100)]);
    const result = serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    });
    expect(result.body).toBe(data);
  });

  test('rejects Blob over budget using declared byte size', () => {
    const data = new Blob(['x'.repeat(2_000)]);
    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });

  test('accepts ArrayBuffer under budget', () => {
    const data = new ArrayBuffer(100);
    expect(serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    }).body).toBe(data);
  });

  test('rejects ArrayBuffer over budget', () => {
    expect(() => serializeRequestBody(
      'post',
      new ArrayBuffer(2048),
      {},
      { maxBodyBytes: 1024 },
    )).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });
});

describe('bounded FormData request serialization', () => {
  test('accepts small string fields without setting multipart content-type manually', () => {
    const data = new FormData();
    data.append('name', 'Ankara');
    data.append('kind', 'district');

    const result = serializeRequestBody('post', data, {}, {
      maxBodyBytes: 4096,
    });
    expect(result.body).toBe(data);
    expect(result.headers['Content-Type']).toBeUndefined();
  });

  test('rejects a large string field using a conservative multipart estimate', () => {
    const data = new FormData();
    data.append('payload', 'x'.repeat(4_000));

    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });

  test('accounts for Blob payload size in multipart estimates', () => {
    const data = new FormData();
    data.append('file', new Blob(['x'.repeat(4_000)]), 'map.txt');

    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 1024,
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });

  test('accepts a small Blob field within multipart budget', () => {
    const data = new FormData();
    data.append('file', new Blob(['map']), 'map.txt');

    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 4096,
    })).not.toThrow();
  });

  test('bounds pathological field cardinality before fetch', () => {
    const data = new FormData();
    for (let index = 0; index < 1025; index += 1) {
      data.append(`f${index}`, '');
    }

    expect(() => serializeRequestBody('post', data, {}, {
      maxBodyBytes: 32 * 1024 * 1024,
    })).toThrowError(expect.objectContaining({
      code: 'REQUEST_BODY_TOO_LARGE',
    }));
  });
});

describe('request method body policy remains fail-closed', () => {
  test.each(['get', 'head'] as const)('%s rejects a request body', (method) => {
    expect(() => serializeRequestBody(method, { value: 1 }))
      .toThrowError(expect.objectContaining({
        code: 'BODY_NOT_ALLOWED',
      }));
  });

  test('bodyless GET still returns undefined body when no data is supplied', () => {
    expect(serializeRequestBody('get', undefined)).toEqual({
      body: undefined,
      headers: {},
    });
  });

  test('unsupported object body remains rejected independently of byte budget', () => {
    expect(() => serializeRequestBody(
      'post',
      new Map([['a', 1]]),
      {},
      { maxBodyBytes: 4096 },
    )).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_REQUEST_BODY',
    }));
  });
});

describe('request-body budget normalization', () => {
  test('uses a 4 MiB default request body budget', () => {
    expect(normalizeRequestConfig({
      method: 'post',
      url: '/items',
    }).maxRequestBodyBytes).toBe(4 * 1024 * 1024);
  });

  test('accepts an explicit request body budget', () => {
    expect(normalizeRequestConfig({
      method: 'post',
      url: '/items',
      maxRequestBodyBytes: 2 * 1024 * 1024,
    }).maxRequestBodyBytes).toBe(2 * 1024 * 1024);
  });

  test('clamps tiny request body budgets to 1 KiB', () => {
    expect(normalizeRequestConfig({
      method: 'post',
      url: '/items',
      maxRequestBodyBytes: 1,
    }).maxRequestBodyBytes).toBe(1024);
  });

  test('clamps huge request body budgets to 32 MiB', () => {
    expect(normalizeRequestConfig({
      method: 'post',
      url: '/items',
      maxRequestBodyBytes: Number.MAX_SAFE_INTEGER,
    }).maxRequestBodyBytes).toBe(32 * 1024 * 1024);
  });

  test('keeps request and response budgets independently configurable', () => {
    const config = normalizeRequestConfig({
      method: 'post',
      url: '/items',
      maxRequestBodyBytes: 2 * 1024 * 1024,
      maxResponseBytes: 8 * 1024 * 1024,
    });
    expect(config.maxRequestBodyBytes).toBe(2 * 1024 * 1024);
    expect(config.maxResponseBytes).toBe(8 * 1024 * 1024);
  });
});

describe('fetch transport request-body budget integration', () => {
  test('rejects an oversized JSON body before invoking fetch', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await expect(executeFetch({
      method: 'post',
      url: '/items',
      data: { payload: 'x'.repeat(2_000) },
      maxRequestBodyBytes: 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sends bounded JSON body with normalized content type', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await expect(executeFetch({
      method: 'post',
      url: '/items',
      data: { value: 1 },
      maxRequestBodyBytes: 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).resolves.toMatchObject({
      data: { ok: true },
      status: 200,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0]!;
    expect(options).toMatchObject({
      method: 'POST',
      body: '{"value":1}',
    });
    expect(options?.headers).toMatchObject({
      'Content-Type': 'application/json;charset=UTF-8',
    });
  });

  test('rejects oversized text before transport hooks start network work', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const onStart = vi.fn();

    await expect(executeFetch({
      method: 'post',
      url: '/items',
      data: 'ü'.repeat(600),
      maxRequestBodyBytes: 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
      onStart,
    })).rejects.toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  test('caller can configure a larger bounded upload budget', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const payload = 'x'.repeat(8_000);

    await expect(executeFetch({
      method: 'post',
      url: '/items',
      data: payload,
      maxRequestBodyBytes: 16 * 1024,
    }, {
      baseUrl: '/api',
      fetchImpl,
    })).resolves.toMatchObject({ status: 200 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
