import { describe, expect, test } from 'vitest';
import { createRuntimeConfig } from '../config/runtimeConfig';
import {
  createDefaultPlatformGovernance,
  refreshDefaultPlatformGovernance,
} from './defaultPlatformGovernance';

describe('default Platform governance composition', () => {
  test('starts ready with the canonical runtime config', () => {
    const runtimeConfig = createRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_RELEASE: '2026.09.21',
      VITE_ENV: 'production',
    });
    const kernel = createDefaultPlatformGovernance({ runtimeConfig });
    expect(kernel.snapshot()).toMatchObject({
      state: { phase: 'ready' },
      config: { valid: true },
      manifest: { valid: true },
      readiness: { state: 'ready' },
    });
  });

  test('registers canonical config schema keys', () => {
    const runtimeConfig = createRuntimeConfig({});
    const kernel = createDefaultPlatformGovernance({ runtimeConfig });
    expect(kernel.config.keys()).toEqual([
      'api-base-url',
      'build-mode',
      'cache-ttl-ms',
      'environment',
      'esri-api-version',
      'max-retries',
      'release',
      'request-timeout-ms',
      'tkgm-city-id',
    ]);
  });

  test('keeps raw TKGM identifier out of support snapshots', () => {
    const runtimeConfig = createRuntimeConfig({
      VITE_TKGM_CITY_ID: 'very-sensitive-city-id',
    });
    const kernel = createDefaultPlatformGovernance({ runtimeConfig });
    expect(JSON.stringify(kernel.snapshot())).not.toContain('very-sensitive-city-id');
    expect(kernel.config.publicValues()['tkgm-city-id']).toBe('[configured]');
  });

  test('maps adaptive runtime flag into feature policy', () => {
    const enabled = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({ VITE_ADAPTIVE_RUNTIME: 'true' }),
    });
    const disabled = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({ VITE_ADAPTIVE_RUNTIME: 'false' }),
    });
    expect(enabled.evaluateFeature('adaptive-runtime').enabled).toBe(true);
    expect(disabled.evaluateFeature('adaptive-runtime').enabled).toBe(false);
  });

  test('typed bootstrap depends on strict endpoint policy', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_TYPED_BOOTSTRAP: 'true',
        VITE_STRICT_ENDPOINT_POLICY: 'false',
      }),
    });
    expect(kernel.evaluateFeature('typed-bootstrap')).toMatchObject({
      enabled: false,
      reason: 'dependency-disabled',
    });
  });

  test('debug logging remains excluded from production', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_ENV: 'production',
        VITE_ENV_DEBUG: 'true',
      }),
    });
    expect(kernel.evaluateFeature('debug-logging', { environment: 'production' })).toMatchObject({
      enabled: false,
      reason: 'environment-excluded',
    });
  });

  test('debug logging can be enabled in development when configured', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_ENV: 'development',
        VITE_ENV_DEBUG: 'true',
      }),
    });
    expect(kernel.evaluateFeature('debug-logging', { environment: 'development' }).enabled)
      .toBe(true);
  });

  test('manifest captures Platform/GIS/Experience dependency direction', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const snapshot = kernel.manifest.snapshot();
    expect(snapshot.startupOrder.indexOf('platform-config'))
      .toBeLessThan(snapshot.startupOrder.indexOf('platform-network'));
    expect(snapshot.startupOrder.indexOf('platform-runtime'))
      .toBeLessThan(snapshot.startupOrder.indexOf('gis-runtime'));
    expect(snapshot.startupOrder.indexOf('gis-runtime'))
      .toBeLessThan(snapshot.startupOrder.indexOf('experience-runtime'));
  });

  test('manifest exposes no WMS/WFS capability contract', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const serialized = JSON.stringify(kernel.manifest.snapshot()).toLowerCase();
    expect(serialized).not.toContain('wms');
    expect(serialized).not.toContain('wfs');
  });

  test('offline runtime remains lazy and optional in manifest', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    expect(kernel.manifest.component('platform-offline')).toMatchObject({
      required: false,
      startup: 'lazy',
    });
  });

  test('built-in readiness only requires config and manifest', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const readiness = kernel.readiness.snapshot();
    expect(readiness.blockers).toEqual([]);
    expect(readiness.requirements.map((item) => item.requirement.id)).toEqual([
      'platform.config',
      'platform.manifest',
      'platform.network-health',
      'platform.runtime-health',
    ]);
  });

  test('optional runtime health can fail without blocking', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    kernel.recordReadiness('platform.runtime-health', 'fail', {
      code: 'PRESSURE',
    });
    expect(kernel.snapshot().state.phase).toBe('ready');
  });

  test('refresh applies a new safe config snapshot', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({ VITE_API_URL: '/api' }),
    });
    const next = createRuntimeConfig({
      VITE_API_URL: '/gateway',
      VITE_RELEASE: 'r2',
    });
    refreshDefaultPlatformGovernance(kernel, next);
    expect(kernel.config.get('api-base-url')).toBe('/gateway');
    expect(kernel.config.get('release')).toBe('r2');
  });

  test('refresh does not recreate feature rules', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const featureRevision = kernel.features.snapshot().revision;
    refreshDefaultPlatformGovernance(kernel, createRuntimeConfig({
      VITE_API_URL: '/gateway',
    }));
    expect(kernel.features.snapshot().revision).toBe(featureRevision);
  });

  test('runtime config normalization prevents external API origins before governance', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_API_URL: 'https://external.invalid/api',
      }),
    });
    expect(kernel.config.get('api-base-url')).toBe('/api');
    expect(kernel.snapshot().config.valid).toBe(true);
  });

  test('ArcGIS SDK version remains pinned to bundled package contract', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_ESRI_API_VERSION: 'next',
      }),
    });
    expect(kernel.config.get('esri-api-version')).toBe('5.1.24');
  });

  test('default governance snapshot has a deterministic support fingerprint', () => {
    const config = createRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_RELEASE: 'same-release',
    });
    const first = createDefaultPlatformGovernance({ runtimeConfig: config });
    const second = createDefaultPlatformGovernance({ runtimeConfig: config });
    expect(first.snapshot().config.fingerprint).toBe(second.snapshot().config.fingerprint);
    expect(first.snapshot().manifest.fingerprint).toBe(second.snapshot().manifest.fingerprint);
    expect(first.snapshot().features.fingerprint).toBe(second.snapshot().features.fingerprint);
  });

  test('configuration support output never leaks secret-shaped source values', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_TKGM_CITY_ID: 'credential-like-value',
      }),
    });
    const support = {
      config: kernel.config.snapshot(),
      publicConfig: kernel.config.publicValues(),
      readiness: kernel.readiness.snapshot(),
      manifest: kernel.manifest.snapshot(),
    };
    expect(JSON.stringify(support)).not.toContain('credential-like-value');
  });
});
