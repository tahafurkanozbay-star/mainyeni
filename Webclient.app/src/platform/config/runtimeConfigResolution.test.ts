import { describe, expect, test } from 'vitest';
import {
  RUNTIME_CONFIG_DEFAULTS,
  RUNTIME_CONFIG_SOURCE_KEYS,
  classifyRuntimeConfigSourceKey,
  createRuntimeConfig,
  describeRuntimeConfigResolution,
  resolveRuntimeConfig,
  runtimeConfigEvidenceFingerprint,
  runtimeConfigFingerprint,
  type RuntimeConfigFieldEvidence,
} from './runtimeConfig';

const evidenceFor = (
  values: readonly RuntimeConfigFieldEvidence[],
  fieldId: RuntimeConfigFieldEvidence['fieldId'],
): RuntimeConfigFieldEvidence => {
  const found = values.find((item) => item.fieldId === fieldId);
  if (!found) throw new Error('missing evidence for ' + fieldId);
  return found;
};

describe('runtime config source classification', () => {
  test.each([
    ['VITE_API_URL', 'vite'],
    ['VITE_FEATURE_X', 'vite'],
    ['MODE', 'vite-builtin'],
    ['DEV', 'vite-builtin'],
    ['PROD', 'vite-builtin'],
    ['SSR', 'vite-builtin'],
    ['BASE_URL', 'vite-builtin'],
    ['REACT_APP_API_URL', 'legacy-cra'],
    ['CUSTOM_VALUE', 'derived'],
  ] as const)('classifies %s as %s', (key, expected) => {
    expect(classifyRuntimeConfigSourceKey(key)).toBe(expected);
  });

  test('publishes deterministic source-key precedence', () => {
    expect(RUNTIME_CONFIG_SOURCE_KEYS.apiBaseUrl).toEqual([
      'VITE_API_URL',
      'VITE_API_BASE_URL',
      'REACT_APP_API_URL',
      'REACT_APP_API_BASE_URL',
    ]);
    expect(RUNTIME_CONFIG_SOURCE_KEYS.environment).toEqual([
      'VITE_ENV',
      'MODE',
      'REACT_APP_ENV',
    ]);
  });

  test('freezes default feature policy', () => {
    expect(Object.isFrozen(RUNTIME_CONFIG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(RUNTIME_CONFIG_DEFAULTS.features)).toBe(true);
  });
});

describe('runtime config provenance defaults', () => {
  test('resolves canonical defaults from an empty source', () => {
    const resolution = resolveRuntimeConfig({});
    expect(resolution.config).toEqual({
      apiBaseUrl: '/api',
      requestTimeoutMs: 15_000,
      cacheTtlMs: 30_000,
      maxRetries: 2,
      environment: 'production',
      release: 'local',
      esriApiVersion: '5.1.24',
      tkgmCityId: '',
      buildMode: 'unknown',
      features: {
        adaptiveRuntime: true,
        debugLogging: false,
        privacyTelemetry: true,
        typedBootstrap: true,
        strictEndpointPolicy: true,
      },
    });
  });

  test('marks every direct config field as defaulted when source is empty', () => {
    const resolution = resolveRuntimeConfig({});
    for (const item of resolution.evidence) {
      expect(item.configured).toBe(false);
      expect(item.sourceKey).toBeUndefined();
      expect(item.shadowedSourceCount).toBe(0);
    }
    expect(resolution.summary.configuredFields).toBe(0);
    expect(resolution.summary.defaultedFields).toBe(14);
  });

  test('uses derived evidence for unknown build mode', () => {
    const item = evidenceFor(resolveRuntimeConfig({}).evidence, 'buildMode');
    expect(item).toMatchObject({
      sourceKind: 'derived',
      disposition: 'defaulted',
      configured: false,
    });
  });

  test('returns immutable top-level resolution objects', () => {
    const resolution = resolveRuntimeConfig({});
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.config)).toBe(true);
    expect(Object.isFrozen(resolution.config.features)).toBe(true);
    expect(Object.isFrozen(resolution.evidence)).toBe(true);
    expect(Object.isFrozen(resolution.summary)).toBe(true);
  });

  test('preserves createRuntimeConfig compatibility with resolution config', () => {
    const source = {
      VITE_API_URL: '/api/v2',
      VITE_API_TIMEOUT_MS: '2000',
      VITE_RELEASE: 'r2',
    };
    expect(createRuntimeConfig(source)).toEqual(resolveRuntimeConfig(source).config);
  });
});

describe('runtime config source precedence and shadowing', () => {
  test('prefers Vite API key and records shadowed legacy source', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '/api/v2',
      REACT_APP_API_URL: '/legacy',
    });
    const item = evidenceFor(resolution.evidence, 'apiBaseUrl');
    expect(resolution.config.apiBaseUrl).toBe('/api/v2');
    expect(item).toMatchObject({
      sourceKey: 'VITE_API_URL',
      sourceKind: 'vite',
      configured: true,
      shadowedSourceCount: 1,
    });
    expect(resolution.summary.shadowedSourceCount).toBe(1);
  });

  test('records every lower-precedence configured alias as shadowed', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '/api/v4',
      VITE_API_BASE_URL: '/api/v3',
      REACT_APP_API_URL: '/api/v2',
      REACT_APP_API_BASE_URL: '/api/v1',
    });
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl').shadowedSourceCount).toBe(3);
    expect(resolution.summary.shadowedSourceCount).toBe(3);
  });

  test('uses VITE_API_BASE_URL when primary Vite key is blank', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '   ',
      VITE_API_BASE_URL: '/gateway',
    });
    expect(resolution.config.apiBaseUrl).toBe('/gateway');
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl')).toMatchObject({
      sourceKey: 'VITE_API_BASE_URL',
      sourceKind: 'vite',
      shadowedSourceCount: 0,
    });
  });

  test('uses legacy API key only when modern aliases are absent', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_API_URL: '/legacy-api',
    });
    expect(resolution.config.apiBaseUrl).toBe('/legacy-api');
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl')).toMatchObject({
      sourceKey: 'REACT_APP_API_URL',
      sourceKind: 'legacy-cra',
    });
    expect(resolution.summary.legacySourceFields).toBeGreaterThan(0);
  });

  test('prefers explicit VITE_ENV over MODE and legacy environment', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      MODE: 'production',
      REACT_APP_ENV: 'legacy',
    });
    expect(resolution.config.environment).toBe('staging');
    expect(evidenceFor(resolution.evidence, 'environment')).toMatchObject({
      sourceKey: 'VITE_ENV',
      sourceKind: 'vite',
      shadowedSourceCount: 2,
    });
  });

  test('classifies MODE as Vite built-in source', () => {
    const resolution = resolveRuntimeConfig({ MODE: 'test' });
    expect(resolution.config.environment).toBe('test');
    expect(evidenceFor(resolution.evidence, 'environment')).toMatchObject({
      sourceKey: 'MODE',
      sourceKind: 'vite-builtin',
    });
    expect(resolution.config.buildMode).toBe('vite-ready');
  });
});

describe('runtime config integer evidence', () => {
  test('accepts a valid timeout unchanged', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_TIMEOUT_MS: '9000' });
    expect(resolution.config.requestTimeoutMs).toBe(9000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition)
      .toBe('accepted');
  });

  test('clamps timeout below minimum', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_TIMEOUT_MS: '1' });
    expect(resolution.config.requestTimeoutMs).toBe(1000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition)
      .toBe('clamped');
    expect(resolution.summary.clampedFields).toBe(1);
  });

  test('clamps timeout above maximum', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_TIMEOUT_MS: '999999' });
    expect(resolution.config.requestTimeoutMs).toBe(60_000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition)
      .toBe('clamped');
  });

  test('falls back for non-numeric timeout', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_TIMEOUT_MS: 'never' });
    expect(resolution.config.requestTimeoutMs).toBe(15_000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition)
      .toBe('invalid-fallback');
    expect(resolution.summary.rejectedFields).toBe(1);
  });

  test('clamps cache ttl to zero', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_CACHE_TTL_MS: '-1' });
    expect(resolution.config.cacheTtlMs).toBe(0);
    expect(evidenceFor(resolution.evidence, 'cacheTtlMs').disposition)
      .toBe('clamped');
  });

  test('clamps cache ttl to configured upper bound', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_CACHE_TTL_MS: '999999999',
    });
    expect(resolution.config.cacheTtlMs).toBe(600_000);
  });

  test('accepts zero retries', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '0' });
    expect(resolution.config.maxRetries).toBe(0);
    expect(evidenceFor(resolution.evidence, 'maxRetries').disposition)
      .toBe('accepted');
  });

  test('clamps retries above four', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '9' });
    expect(resolution.config.maxRetries).toBe(4);
    expect(evidenceFor(resolution.evidence, 'maxRetries').disposition)
      .toBe('clamped');
  });

  test('retains legacy parseInt compatibility for numeric prefix', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '3attempts' });
    expect(resolution.config.maxRetries).toBe(3);
    expect(evidenceFor(resolution.evidence, 'maxRetries').disposition)
      .toBe('accepted');
  });
});

describe('runtime config boolean evidence', () => {
  test.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['enabled', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['disabled', false],
  ])('accepts adaptive runtime boolean token %s', (value, expected) => {
    const resolution = resolveRuntimeConfig({ VITE_ADAPTIVE_RUNTIME: value });
    expect(resolution.config.features.adaptiveRuntime).toBe(expected);
    expect(evidenceFor(
      resolution.evidence,
      'features.adaptiveRuntime',
    ).disposition).toBe('accepted');
  });

  test('accepts native boolean input', () => {
    const resolution = resolveRuntimeConfig({ VITE_ENV_DEBUG: true });
    expect(resolution.config.features.debugLogging).toBe(true);
    expect(evidenceFor(
      resolution.evidence,
      'features.debugLogging',
    ).disposition).toBe('accepted');
  });

  test('falls back for unknown boolean token', () => {
    const resolution = resolveRuntimeConfig({ VITE_ENV_DEBUG: 'perhaps' });
    expect(resolution.config.features.debugLogging).toBe(false);
    expect(evidenceFor(
      resolution.evidence,
      'features.debugLogging',
    ).disposition).toBe('invalid-fallback');
  });

  test('keeps privacy telemetry enabled by default', () => {
    const resolution = resolveRuntimeConfig({});
    expect(resolution.config.features.privacyTelemetry).toBe(true);
    expect(evidenceFor(
      resolution.evidence,
      'features.privacyTelemetry',
    ).disposition).toBe('defaulted');
  });

  test('records shadowed feature aliases', () => {
    const resolution = resolveRuntimeConfig({
      VITE_TYPED_BOOTSTRAP: 'true',
      REACT_APP_TYPED_BOOTSTRAP: 'false',
    });
    expect(resolution.config.features.typedBootstrap).toBe(true);
    expect(evidenceFor(
      resolution.evidence,
      'features.typedBootstrap',
    ).shadowedSourceCount).toBe(1);
  });
});

describe('runtime config text evidence', () => {
  test('accepts canonical environment text', () => {
    const resolution = resolveRuntimeConfig({ VITE_ENV: 'staging' });
    expect(resolution.config.environment).toBe('staging');
    expect(evidenceFor(resolution.evidence, 'environment').disposition)
      .toBe('accepted');
  });

  test('normalizes environment boundary whitespace', () => {
    const resolution = resolveRuntimeConfig({ VITE_ENV: ' staging ' });
    expect(resolution.config.environment).toBe('staging');
    expect(evidenceFor(resolution.evidence, 'environment').disposition)
      .toBe('normalized');
  });

  test('normalizes release line breaks without retaining raw text in evidence', () => {
    const resolution = resolveRuntimeConfig({
      VITE_RELEASE: 'release-1\nprivate-tail',
    });
    expect(resolution.config.release).toBe('release-1 private-tail');
    const item = evidenceFor(resolution.evidence, 'release');
    expect(item.disposition).toBe('normalized');
    expect(JSON.stringify(item)).not.toContain('private-tail');
  });

  test('bounds long release text', () => {
    const resolution = resolveRuntimeConfig({ VITE_RELEASE: 'x'.repeat(300) });
    expect(resolution.config.release).toHaveLength(120);
    expect(evidenceFor(resolution.evidence, 'release').disposition)
      .toBe('normalized');
  });

  test('marks TKGM evidence sensitive without exposing the identifier', () => {
    const secret = 'private-city-id';
    const resolution = resolveRuntimeConfig({ VITE_TKGM_CITY_ID: secret });
    const item = evidenceFor(resolution.evidence, 'tkgmCityId');
    expect(item.sensitive).toBe(true);
    expect(item.sourceKey).toBe('VITE_TKGM_CITY_ID');
    expect(JSON.stringify(item)).not.toContain(secret);
    expect(resolution.config.tkgmCityId).toBe(secret);
  });
});

describe('runtime config API boundary evidence', () => {
  test('accepts canonical same-origin relative path', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_URL: '/gateway/api' });
    expect(resolution.config.apiBaseUrl).toBe('/gateway/api');
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl').disposition)
      .toBe('accepted');
  });

  test('normalizes trailing slash on safe API path', () => {
    const resolution = resolveRuntimeConfig({ VITE_API_URL: '/gateway/api/' });
    expect(resolution.config.apiBaseUrl).toBe('/gateway/api');
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl').disposition)
      .toBe('normalized');
  });

  test.each([
    'https://evil.example/api',
    '//evil.example/api',
    '/api\\admin',
    '/api/%2e%2e/admin',
    '/api/%252e%252e/admin',
    '/api?token=private',
    '/api#fragment',
  ])('fails closed and records rejected API input %s', (value) => {
    const resolution = resolveRuntimeConfig({ VITE_API_URL: value });
    expect(resolution.config.apiBaseUrl).toBe('/api');
    expect(evidenceFor(resolution.evidence, 'apiBaseUrl').disposition)
      .toBe('invalid-fallback');
  });

  test('does not place rejected API input in evidence', () => {
    const privateUrl = 'https://private.example/internal';
    const resolution = resolveRuntimeConfig({ VITE_API_URL: privateUrl });
    expect(JSON.stringify(resolution.evidence)).not.toContain(privateUrl);
  });
});

describe('runtime config ArcGIS evidence', () => {
  test('accepts bundled ArcGIS version', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ESRI_API_VERSION: '5.1.24',
    });
    expect(resolution.config.esriApiVersion).toBe('5.1.24');
    expect(evidenceFor(resolution.evidence, 'esriApiVersion').disposition)
      .toBe('accepted');
  });

  test('normalizes benign ArcGIS version whitespace', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ESRI_API_VERSION: ' 5.1.24 ',
    });
    expect(resolution.config.esriApiVersion).toBe('5.1.24');
    expect(evidenceFor(resolution.evidence, 'esriApiVersion').disposition)
      .toBe('accepted');
  });

  test.each([
    'next',
    '5.2.0',
    'https://evil.example/sdk',
    '5.1.24\nhttps://evil.example',
  ])('pins unsupported ArcGIS value %s to bundled version', (value) => {
    const resolution = resolveRuntimeConfig({ VITE_ESRI_API_VERSION: value });
    expect(resolution.config.esriApiVersion).toBe('5.1.24');
    expect(evidenceFor(resolution.evidence, 'esriApiVersion').disposition)
      .toBe('policy-pinned');
    expect(resolution.summary.pinnedFields).toBe(1);
  });
});

describe('runtime config build-mode evidence', () => {
  test('detects Vite mode from custom VITE key', () => {
    const resolution = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    expect(resolution.config.buildMode).toBe('vite-ready');
    expect(evidenceFor(resolution.evidence, 'buildMode').sourceKind)
      .toBe('vite');
  });

  test('detects Vite mode from built-in key', () => {
    const resolution = resolveRuntimeConfig({ PROD: true });
    expect(resolution.config.buildMode).toBe('vite-ready');
    expect(evidenceFor(resolution.evidence, 'buildMode').sourceKind)
      .toBe('vite-builtin');
  });

  test('detects legacy CRA mode when only legacy keys exist', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_RELEASE: 'legacy',
    });
    expect(resolution.config.buildMode).toBe('legacy-cra');
    expect(evidenceFor(resolution.evidence, 'buildMode')).toMatchObject({
      sourceKind: 'legacy-cra',
      disposition: 'accepted',
    });
  });

  test('Vite markers win build-mode detection when legacy aliases coexist', () => {
    const resolution = resolveRuntimeConfig({
      VITE_RELEASE: 'modern',
      REACT_APP_RELEASE: 'legacy',
    });
    expect(resolution.config.buildMode).toBe('vite-ready');
  });
});

describe('runtime config deterministic evidence fingerprints', () => {
  test('config fingerprint is stable for equal normalized values', () => {
    const first = resolveRuntimeConfig({ VITE_API_URL: '/api/' });
    const second = resolveRuntimeConfig({ VITE_API_URL: '/api' });
    expect(first.configFingerprint).toBe(second.configFingerprint);
  });

  test('evidence fingerprint distinguishes normalized from accepted source', () => {
    const first = resolveRuntimeConfig({ VITE_API_URL: '/api/' });
    const second = resolveRuntimeConfig({ VITE_API_URL: '/api' });
    expect(first.evidenceFingerprint).not.toBe(second.evidenceFingerprint);
  });

  test('evidence fingerprint changes when source family changes', () => {
    const modern = resolveRuntimeConfig({ VITE_API_URL: '/api' });
    const legacy = resolveRuntimeConfig({ REACT_APP_API_URL: '/api' });
    expect(modern.configFingerprint).toBe(legacy.configFingerprint);
    expect(modern.evidenceFingerprint).not.toBe(legacy.evidenceFingerprint);
  });

  test('fingerprints are independent of source object insertion order', () => {
    const first = resolveRuntimeConfig({
      VITE_API_URL: '/api/v2',
      VITE_RELEASE: 'r1',
      VITE_ENV: 'staging',
    });
    const second = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_API_URL: '/api/v2',
    });
    expect(second.configFingerprint).toBe(first.configFingerprint);
    expect(second.evidenceFingerprint).toBe(first.evidenceFingerprint);
  });

  test('standalone evidence fingerprint matches resolution fingerprint', () => {
    const resolution = resolveRuntimeConfig({
      VITE_RELEASE: 'r5',
      VITE_API_MAX_RETRIES: '4',
    });
    expect(runtimeConfigEvidenceFingerprint(resolution.evidence))
      .toBe(resolution.evidenceFingerprint);
  });

  test('config fingerprint changes when a non-sensitive field changes', () => {
    const first = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    const second = resolveRuntimeConfig({ VITE_RELEASE: 'r2' });
    expect(second.configFingerprint).not.toBe(first.configFingerprint);
  });

  test('config fingerprint changes when sensitive identifier changes without revealing it', () => {
    const first = resolveRuntimeConfig({ VITE_TKGM_CITY_ID: 'city-a' });
    const second = resolveRuntimeConfig({ VITE_TKGM_CITY_ID: 'city-b' });
    expect(second.configFingerprint).not.toBe(first.configFingerprint);
    expect(first.configFingerprint).not.toContain('city-a');
    expect(second.configFingerprint).not.toContain('city-b');
  });

  test('legacy runtimeConfigFingerprint call remains deterministic', () => {
    const config = createRuntimeConfig({ VITE_RELEASE: 'compat' });
    expect(runtimeConfigFingerprint(config)).toMatch(/^[0-9a-f]{8}$/u);
    expect(runtimeConfigFingerprint(config)).toBe(runtimeConfigFingerprint(config));
  });
});

describe('runtime config privacy-safe support description', () => {
  test('describes source metadata without raw source values', () => {
    const secret = 'sensitive-city-identifier';
    const resolution = resolveRuntimeConfig({
      VITE_TKGM_CITY_ID: secret,
      VITE_RELEASE: 'release-public',
    });
    const description = describeRuntimeConfigResolution(resolution);
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('VITE_TKGM_CITY_ID');
    expect(serialized).toContain('tkgmCityId');
  });

  test('does not retain invalid raw API value in support description', () => {
    const raw = 'https://secret-host.example/api';
    const description = describeRuntimeConfigResolution(resolveRuntimeConfig({
      VITE_API_URL: raw,
    }));
    expect(JSON.stringify(description)).not.toContain(raw);
  });

  test('includes bounded summary counts and fingerprints', () => {
    const description = describeRuntimeConfigResolution(resolveRuntimeConfig({
      VITE_API_TIMEOUT_MS: '1',
      VITE_ENV_DEBUG: 'perhaps',
    }));
    expect(description).toMatchObject({
      summary: {
        clampedFields: 1,
        rejectedFields: 1,
      },
    });
    expect(String(description.configFingerprint)).toMatch(/^[0-9a-f]{8}$/u);
    expect(String(description.evidenceFingerprint)).toMatch(/^[0-9a-f]{8}$/u);
  });

  test('freezes support description collections', () => {
    const description = describeRuntimeConfigResolution(resolveRuntimeConfig({}));
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description.evidence)).toBe(true);
  });
});
