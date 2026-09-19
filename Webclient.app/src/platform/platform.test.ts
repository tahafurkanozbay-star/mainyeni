import { vi } from 'vitest';
import { RequestCache } from './cache/requestCache';
import { createRuntimeConfig } from './config/runtimeConfig';
import { AppError, getSafeErrorMessage } from './errors/appError';
import { assertApplicationEndpoint, isSameOriginPath, normalizeApplicationPath } from './network/endpointPolicy';
import { stableSerialize } from './http/httpClient';

vi.mock('axios', () => {
  const request = vi.fn();
  return {
    create: vi.fn(() => ({ request })),
    CancelToken: {
      source: vi.fn(() => ({ token: {}, cancel: vi.fn() }))
    }
  };
});

describe('platform runtime configuration', () => {
  test('defaults to a same-origin API boundary', () => {
    const config = createRuntimeConfig({});
    expect(config.apiBaseUrl).toBe('/api');
    expect(config.requestTimeoutMs).toBe(15000);
    expect(config.maxRetries).toBe(2);
  });

  test('accepts normalized relative API paths', () => {
    const config = createRuntimeConfig({
      REACT_APP_API_URL: '/gateway/',
      REACT_APP_API_TIMEOUT_MS: '5000',
      REACT_APP_API_MAX_RETRIES: '3'
    });
    expect(config.apiBaseUrl).toBe('/gateway');
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.maxRetries).toBe(3);
  });

  test('rejects an external build-time API origin by falling back', () => {
    const config = createRuntimeConfig({ REACT_APP_API_URL: 'https://attacker.invalid/api' });
    expect(config.apiBaseUrl).toBe('/api');
  });

  test('clamps unsafe timeout and retry values', () => {
    const config = createRuntimeConfig({
      REACT_APP_API_TIMEOUT_MS: '999999',
      REACT_APP_API_MAX_RETRIES: '99'
    });
    expect(config.requestTimeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(4);
  });
});

describe('endpoint policy', () => {
  test.each(['/api', '/api/items', '/'])('allows same-origin path %s', (path) => {
    expect(isSameOriginPath(path)).toBe(true);
    expect(assertApplicationEndpoint(path)).toBe(path);
  });

  test.each([
    'https://example.com/api',
    'http://example.com/api',
    '//example.com/api',
    'javascript:alert(1)',
    '/api\\escape'
  ])('blocks non-application endpoint %s', (path) => {
    expect(() => normalizeApplicationPath(path)).toThrow(AppError);
  });

  test('normalizes duplicate slashes without changing origin', () => {
    expect(normalizeApplicationPath('api//items')).toBe('/api/items');
  });
});

describe('RequestCache', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test('expires values at the configured TTL', () => {
    const cache = new RequestCache({ ttlMs: 100, maxEntries: 5 });
    cache.set('a', { value: 1 });
    expect(cache.get('a')).toEqual({ value: 1 });

    nowSpy.mockReturnValue(1101);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test('evicts the least recently used entry when bounded capacity is exceeded', () => {
    const cache = new RequestCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  test('invalidates key prefixes without clearing unrelated entries', () => {
    const cache = new RequestCache({ ttlMs: 1000, maxEntries: 5 });
    cache.set('GET|/config|a', 1);
    cache.set('GET|/config|b', 2);
    cache.set('GET|/health|', 3);

    expect(cache.invalidatePrefix('GET|/config')).toBe(2);
    expect(cache.get('GET|/health|')).toBe(3);
  });
});

describe('stable request identity', () => {
  test('serializes object keys deterministically', () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
  });

  test('preserves array ordering', () => {
    expect(stableSerialize([1, 2])).not.toBe(stableSerialize([2, 1]));
  });
});

describe('safe errors', () => {
  test('returns the controlled AppError message', () => {
    expect(getSafeErrorMessage(new AppError('Kontrollü hata'))).toBe('Kontrollü hata');
  });

  test('does not echo arbitrary raw exception messages', () => {
    expect(getSafeErrorMessage(new Error('database password leaked'))).toBe('Beklenmeyen bir hata oluştu.');
  });
});
