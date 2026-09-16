import {
  assertSafeRuntimeConfig,
  createRuntimeConfig,
  normalizeApiBaseUrl,
  runtimeConfigFingerprint,
} from './runtimeConfig';

describe('Vite-first runtime configuration', () => {
  test('prefers VITE variables while retaining explicit legacy-source compatibility', () => {
    const config = createRuntimeConfig({
      VITE_API_URL: '/api/v2',
      REACT_APP_API_URL: '/api/legacy',
      VITE_API_TIMEOUT_MS: '9000',
      VITE_API_CACHE_TTL_MS: '45000',
      VITE_API_MAX_RETRIES: '3',
      VITE_ENV: 'staging',
      VITE_RELEASE: '2026.09.16',
      VITE_ESRI_API_VERSION: '4.34',
      VITE_TKGM_CITY_ID: '28',
      VITE_ADAPTIVE_RUNTIME: 'true',
      VITE_PRIVACY_TELEMETRY: 'false',
    });

    expect(config.apiBaseUrl).toBe('/api/v2');
    expect(config.requestTimeoutMs).toBe(9000);
    expect(config.cacheTtlMs).toBe(45000);
    expect(config.maxRetries).toBe(3);
    expect(config.environment).toBe('staging');
    expect(config.release).toBe('2026.09.16');
    expect(config.esriApiVersion).toBe('4.34');
    expect(config.tkgmCityId).toBe('28');
    expect(config.buildMode).toBe('vite-ready');
    expect(config.features.adaptiveRuntime).toBe(true);
    expect(config.features.privacyTelemetry).toBe(false);
    expect(assertSafeRuntimeConfig(config)).toBe(true);
  });

  test('still understands an explicitly supplied legacy CRA source during staged migration', () => {
    const config = createRuntimeConfig({
      REACT_APP_API_URL: '/legacy-api',
      REACT_APP_VERSION: 'legacy',
    });

    expect(config.apiBaseUrl).toBe('/legacy-api');
    expect(config.release).toBe('legacy');
    expect(config.buildMode).toBe('legacy-cra');
  });

  test.each([
    ['https://evil.example/api', '/api'],
    ['//evil.example/api', '/api'],
    ['/api\\admin', '/api'],
    ['/api/%2e%2e/admin', '/api'],
    ['/api/%252e%252e/admin', '/api'],
    ['/api?token=leak', '/api'],
    ['/api#fragment', '/api'],
  ])('fails closed for unsafe API base %s', (candidate, expected) => {
    expect(normalizeApiBaseUrl(candidate)).toBe(expected);
  });

  test('canonicalizes a safe relative API path', () => {
    expect(normalizeApiBaseUrl('/api/')).toBe('/api');
    expect(normalizeApiBaseUrl('/gateway/services')).toBe('/gateway/services');
  });

  test('clamps unsafe numeric runtime settings', () => {
    const config = createRuntimeConfig({
      VITE_API_TIMEOUT_MS: '1',
      VITE_API_CACHE_TTL_MS: '999999999',
      VITE_API_MAX_RETRIES: '99',
    });
    expect(config.requestTimeoutMs).toBe(1000);
    expect(config.cacheTtlMs).toBe(600000);
    expect(config.maxRetries).toBe(4);
  });

  test('produces deterministic fingerprints without exposing raw configuration fields', () => {
    const config = createRuntimeConfig({ VITE_API_URL: '/api', VITE_RELEASE: 'r1' });
    const first = runtimeConfigFingerprint(config);
    const second = runtimeConfigFingerprint(config);
    expect(first).toMatch(/^[a-f0-9]{8}$/);
    expect(second).toBe(first);
    expect(first).not.toContain('/api');
  });
});
