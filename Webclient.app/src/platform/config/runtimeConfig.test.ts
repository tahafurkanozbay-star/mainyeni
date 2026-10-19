import { describe, expect, test } from 'vitest';
import {
  assertSafeRuntimeConfig,
  createRuntimeConfig,
  describeRuntimeConfig,
  normalizeEsriApiVersion,
  runtimeConfigFingerprint,
} from './runtimeConfig';

describe('static-client runtime configuration', () => {
  test('resolves only settings used by the browser runtime', () => {
    const config = createRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '9000',
      VITE_CACHE_TTL_MS: '45000',
      VITE_MAX_RETRIES: '3',
      VITE_ENV: 'staging',
      VITE_RELEASE: '2026.10.19',
      VITE_ESRI_API_VERSION: '5.1.24',
      VITE_TKGM_CITY_ID: '28',
      VITE_ADAPTIVE_RUNTIME: 'true',
      VITE_PRIVACY_TELEMETRY: 'false',
      VITE_API_URL: '/retired-api',
      REACT_APP_API_URL: '/legacy-api',
    });

    expect(config.requestTimeoutMs).toBe(9000);
    expect(config.cacheTtlMs).toBe(45000);
    expect(config.maxRetries).toBe(3);
    expect(config.environment).toBe('staging');
    expect(config.release).toBe('2026.10.19');
    expect(config.esriApiVersion).toBe('5.1.24');
    expect(config.tkgmCityId).toBe('28');
    expect(config.buildMode).toBe('vite-ready');
    expect(config.features.adaptiveRuntime).toBe(true);
    expect(config.features.privacyTelemetry).toBe(false);
    expect(config).not.toHaveProperty('apiBaseUrl');
    expect(assertSafeRuntimeConfig(config)).toBe(true);
  });

  test('ignores retired API URL environment variables', () => {
    const empty = createRuntimeConfig({});
    const withRetiredKeys = createRuntimeConfig({
      VITE_API_URL: 'https://example.invalid/api',
      VITE_API_BASE_URL: '/old-api',
      REACT_APP_API_URL: '/legacy-api',
      REACT_APP_API_BASE_URL: '/legacy-base',
    });

    expect(withRetiredKeys).toEqual(empty);
    expect(withRetiredKeys).not.toHaveProperty('apiBaseUrl');
  });

  test('recognizes Vite built-in environment keys', () => {
    const config = createRuntimeConfig({
      MODE: 'production',
      DEV: false,
      PROD: true,
      BASE_URL: './',
    });

    expect(config.buildMode).toBe('vite-ready');
    expect(config.environment).toBe('production');
  });

  test('keeps generic legacy release metadata readable during migration', () => {
    const config = createRuntimeConfig({
      REACT_APP_VERSION: 'legacy-release',
      REACT_APP_ENV: 'development',
    });

    expect(config.release).toBe('legacy-release');
    expect(config.environment).toBe('development');
    expect(config.buildMode).toBe('legacy-cra');
    expect(config).not.toHaveProperty('apiBaseUrl');
  });

  test('clamps unsafe generic timeout, cache and retry settings', () => {
    const config = createRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '1',
      VITE_CACHE_TTL_MS: '999999999',
      VITE_MAX_RETRIES: '99',
    });

    expect(config.requestTimeoutMs).toBe(1000);
    expect(config.cacheTtlMs).toBe(600000);
    expect(config.maxRetries).toBe(4);
  });

  test('pins ArcGIS versions to the bundled SDK contract', () => {
    expect(normalizeEsriApiVersion('5.1.24')).toBe('5.1.24');
    expect(normalizeEsriApiVersion(' 5.1.24 ')).toBe('5.1.24');
    expect(normalizeEsriApiVersion('next')).toBe('5.1.24');
    expect(normalizeEsriApiVersion('https://example.invalid/sdk')).toBe('5.1.24');

    const config = createRuntimeConfig({});
    expect(() => assertSafeRuntimeConfig({ ...config, esriApiVersion: 'next' }))
      .toThrow(/must match bundled @arcgis\/core 5\.1\.24/i);
  });

  test('uses the bundled SDK version when nothing is configured', () => {
    expect(createRuntimeConfig({}).esriApiVersion).toBe('5.1.24');
  });

  test('creates deterministic fingerprints without exposing configuration values', () => {
    const config = createRuntimeConfig({
      VITE_RELEASE: 'safe-public-release',
      VITE_TKGM_CITY_ID: 'sensitive-city-id',
    });
    const fingerprint = runtimeConfigFingerprint(config);
    const description = describeRuntimeConfig(config);

    expect(fingerprint).toMatch(/^[a-f0-9]{8}$/u);
    expect(runtimeConfigFingerprint(config)).toBe(fingerprint);
    expect(fingerprint).not.toContain('sensitive-city-id');
    expect(JSON.stringify(description)).not.toContain('sensitive-city-id');
    expect(description.tkgmCityIdConfigured).toBe(true);
    expect(description).not.toHaveProperty('apiBaseUrl');
  });
});
