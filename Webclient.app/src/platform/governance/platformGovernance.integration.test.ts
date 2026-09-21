import { describe, expect, test } from 'vitest';
import { createRuntimeConfig } from '../config/runtimeConfig';
import { createDefaultPlatformGovernance } from './defaultPlatformGovernance';
import { governanceBlockingReasons, governanceSnapshotSummary } from './governanceKernel';

describe('Platform governance integration', () => {
  test('composes current runtime configuration without creating a transport stack', () => {
    const config = createRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_API_TIMEOUT_MS: '15000',
      VITE_API_CACHE_TTL_MS: '30000',
      VITE_API_MAX_RETRIES: '2',
      VITE_RELEASE: 'integration',
    });
    const kernel = createDefaultPlatformGovernance({ runtimeConfig: config });
    expect(kernel.config.publicValues()).toMatchObject({
      'api-base-url': '/api',
      'request-timeout-ms': 15000,
      'cache-ttl-ms': 30000,
      'max-retries': 2,
      release: 'integration',
    });
    const serialized = JSON.stringify(kernel.snapshot()).toLowerCase();
    expect(serialized).not.toContain('fetch(');
    expect(serialized).not.toContain('axios');
    expect(serialized).not.toContain('xmlhttprequest');
  });

  test('uses existing runtime domains as manifest capabilities, not duplicate implementations', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    expect(kernel.manifest.snapshot().capabilities).toMatchObject({
      'runtime-config': ['platform-config'],
      'governed-http': ['platform-network'],
      'endpoint-policy': ['platform-network'],
      'runtime-supervision': ['platform-runtime'],
      'resource-budget': ['platform-runtime'],
      'offline-persistence': ['platform-offline'],
      'offline-replay': ['platform-offline'],
      'spatial-runtime': ['gis-runtime'],
      'adaptive-shell': ['experience-runtime'],
    });
  });

  test('produces a compact support summary', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    expect(governanceSnapshotSummary(kernel.snapshot())).toMatchObject({
      phase: 'ready',
      configValid: true,
      configIssueCount: 0,
      manifestValid: true,
      blockerCount: 0,
      featureCount: 5,
    });
  });

  test('blocking reasons remain empty for canonical defaults', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    expect(governanceBlockingReasons(kernel.snapshot())).toEqual([]);
  });

  test('feature decisions use config flags without exposing raw environment source', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({
        VITE_ADAPTIVE_RUNTIME: 'false',
        VITE_PRIVACY_TELEMETRY: 'true',
      }),
    });
    expect(kernel.evaluateFeature('adaptive-runtime').enabled).toBe(false);
    expect(kernel.evaluateFeature('privacy-telemetry').enabled).toBe(true);
    expect(JSON.stringify(kernel.features.snapshot())).not.toContain('VITE_');
  });

  test('kill-switch replacement can immediately close a feature', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({ VITE_ADAPTIVE_RUNTIME: 'true' }),
    });
    expect(kernel.evaluateFeature('adaptive-runtime').enabled).toBe(true);
    kernel.features.replace({
      id: 'adaptive-runtime',
      mode: 'on',
      killSwitch: true,
    });
    expect(kernel.evaluateFeature('adaptive-runtime')).toMatchObject({
      enabled: false,
      reason: 'kill-switch',
    });
  });

  test('manifest invalidation is visible in a fresh kernel before startup', () => {
    const config = createRuntimeConfig({});
    const kernel = createDefaultPlatformGovernance({ runtimeConfig: config });
    kernel.manifest.remove('platform-network');
    expect(kernel.manifest.snapshot().valid).toBe(false);
    expect(kernel.manifest.snapshot().issues.some((item) =>
      item.code === 'missing-dependency' || item.code === 'missing-capability')).toBe(true);
  });

  test('readiness support details redact URLs and credentials', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    kernel.recordReadiness('platform.network-health', 'fail', {
      code: 'UNAVAILABLE',
      detail: 'token=abc https://internal.invalid/private',
    });
    const serialized = JSON.stringify(kernel.readiness.snapshot());
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('internal.invalid');
  });

  test('stopping governance is a local lifecycle action only', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const before = kernel.telemetry.summary().totalEvents;
    const stopped = kernel.stop();
    expect(stopped.state.phase).toBe('stopped');
    expect(kernel.telemetry.summary().totalEvents).toBeGreaterThan(before);
  });

  test('governance can be recreated cleanly after disposal', () => {
    const config = createRuntimeConfig({});
    const first = createDefaultPlatformGovernance({ runtimeConfig: config });
    first.dispose();
    const second = createDefaultPlatformGovernance({ runtimeConfig: config });
    expect(second.snapshot().state.phase).toBe('ready');
  });

  test('support fingerprints never include API paths verbatim', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({ VITE_API_URL: '/very-specific-api-path' }),
    });
    expect(kernel.snapshot().fingerprint).not.toContain('/very-specific-api-path');
    expect(kernel.config.snapshot().fingerprint).not.toContain('/very-specific-api-path');
  });

  test('governance stays fully synchronous and deterministic at decision boundaries', () => {
    const kernel = createDefaultPlatformGovernance({
      runtimeConfig: createRuntimeConfig({}),
    });
    const feature = kernel.evaluateFeature('typed-bootstrap');
    const readiness = kernel.readiness.snapshot();
    const manifest = kernel.manifest.snapshot();
    expect(feature.enabled).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(manifest.valid).toBe(true);
  });
});
