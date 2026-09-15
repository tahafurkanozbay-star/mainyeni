import { RequestCache } from './cache/requestCache';
import { AppError, ERROR_CODES, normalizeError } from './errors/appError';
import { assertEndpointAllowed, classifyEndpoint } from './network/endpointPolicy';

jest.useFakeTimers();

afterEach(() => {
  jest.clearAllTimers();
  jest.clearAllMocks();
});

describe('RequestCache', () => {
  test('deduplicates concurrent requests and caches the resolved value', async () => {
    const cache = new RequestCache({ ttlMs: 1000, maxEntries: 2 });
    const factory = jest.fn(() => Promise.resolve({ value: 7 }));
    const first = cache.getOrCreate('same', factory);
    const second = cache.getOrCreate('same', factory);

    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 7 }, { value: 7 }]);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(cache.getOrCreate('same', factory)).resolves.toEqual({ value: 7 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('evicts the oldest entry when the bound is exceeded', async () => {
    const cache = new RequestCache({ ttlMs: 1000, maxEntries: 2 });
    await cache.getOrCreate('a', () => Promise.resolve(1));
    await cache.getOrCreate('b', () => Promise.resolve(2));
    await cache.getOrCreate('c', () => Promise.resolve(3));
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });
});

describe('Error normalization', () => {
  test('maps aborts to a non-retryable public error', () => {
    const error = normalizeError(Object.assign(new Error('aborted'), { name: 'AbortError' }), { endpoint: '/api/test' });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(ERROR_CODES.ABORTED);
    expect(error.retryable).toBe(false);
  });

  test('maps server responses to retryable errors', () => {
    const error = normalizeError({ response: { status: 503 } }, { endpoint: '/api/test' });
    expect(error.code).toBe(ERROR_CODES.SERVER);
    expect(error.retryable).toBe(true);
  });
});

describe('Network endpoint policy', () => {
  test('accepts same-origin routes', () => {
    expect(classifyEndpoint('/api/layers').allowed).toBe(true);
  });

  test('blocks arbitrary cross-origin endpoints', () => {
    expect(classifyEndpoint('https://example.com/data').allowed).toBe(false);
  });

  test('rejects WMS/WFS policy violations', () => {
    expect(() => assertEndpointAllowed('/api/gis', { serviceType: 'WMS' })).toThrow('not allowed');
    expect(() => assertEndpointAllowed('/api/gis', { serviceType: 'WFS' })).toThrow('not allowed');
  });
});
