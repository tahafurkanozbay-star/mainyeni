import { describe, expect, test } from 'vitest';
import {
  RUNTIME_CONFIG_DEFAULTS,
  RUNTIME_CONFIG_SOURCE_KEYS,
  classifyRuntimeConfigSourceKey,
  createRuntimeConfig,
  describeRuntimeConfigResolution,
  resolveRuntimeConfig,
  runtimeConfigEvidenceFingerprint,
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
    ['VITE_RELEASE', 'vite'],
    ['VITE_FEATURE_X', 'vite'],
    ['MODE', 'vite-builtin'],
    ['DEV', 'vite-builtin'],
    ['PROD', 'vite-builtin'],
    ['SSR', 'vite-builtin'],
    ['BASE_URL', 'vite-builtin'],
    ['REACT_APP_RELEASE', 'legacy-cra'],
    ['VITE_API_URL', 'derived'],
    ['REACT_APP_API_URL', 'derived'],
    ['CUSTOM_VALUE', 'derived'],
  ] as const)('classifies %s as %s', (key, expected) => {
    expect(classifyRuntimeConfigSourceKey(key)).toBe(expected);
  });

  test('publishes only supported runtime configuration source keys', () => {
    expect(RUNTIME_CONFIG_SOURCE_KEYS.requestTimeoutMs).toEqual([
      'VITE_REQUEST_TIMEOUT_MS',
      'REACT_APP_REQUEST_TIMEOUT_MS',
    ]);
    expect(RUNTIME_CONFIG_SOURCE_KEYS.cacheTtlMs).toEqual([
      'VITE_CACHE_TTL_MS',
      'REACT_APP_CACHE_TTL_MS',
    ]);
    expect(RUNTIME_CONFIG_SOURCE_KEYS.maxRetries).toEqual([
      'VITE_MAX_RETRIES',
      'REACT_APP_MAX_RETRIES',
    ]);
    expect(RUNTIME_CONFIG_SOURCE_KEYS.environment).toEqual([
      'VITE_ENV',
      'MODE',
      'REACT_APP_ENV',
    ]);
    expect(RUNTIME_CONFIG_SOURCE_KEYS).not.toHaveProperty('apiBaseUrl');
  });

  test('freezes default feature policy', () => {
    expect(Object.isFrozen(RUNTIME_CONFIG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(RUNTIME_CONFIG_DEFAULTS.features)).toBe(true);
  });
});

describe('runtime config provenance defaults', () => {
  test('resolves canonical defaults without any application API field', () => {
    const resolution = resolveRuntimeConfig({});
    expect(resolution.config).toEqual({
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
    expect(resolution.config).not.toHaveProperty('apiBaseUrl');
  });

  test('marks every direct config field as defaulted when source is empty', () => {
    const resolution = resolveRuntimeConfig({});
    for (const item of resolution.evidence) {
      expect(item.configured).toBe(false);
      expect(item.sourceKey).toBeUndefined();
      expect(item.shadowedSourceCount).toBe(0);
    }
    expect(resolution.summary.configuredFields).toBe(0);
    expect(resolution.summary.defaultedFields).toBe(13);
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
      VITE_REQUEST_TIMEOUT_MS: '2000',
      VITE_RELEASE: 'r2',
    };
    expect(createRuntimeConfig(source)).toEqual(resolveRuntimeConfig(source).config);
  });

  test('ignores retired API URL keys instead of treating them as runtime configuration', () => {
    const empty = resolveRuntimeConfig({});
    const retiredOnly = resolveRuntimeConfig({
      VITE_API_URL: 'https://private.example/api',
      VITE_API_BASE_URL: '/old-api',
      REACT_APP_API_URL: '/legacy-api',
      REACT_APP_API_BASE_URL: '/legacy-base',
    });
    expect(retiredOnly.config).toEqual(empty.config);
    expect(retiredOnly.config).not.toHaveProperty('apiBaseUrl');
    expect(retiredOnly.evidence).toEqual(empty.evidence);
    expect(retiredOnly.config.buildMode).toBe('unknown');
  });
});

describe('runtime config source precedence and shadowing', () => {
  test('prefers a Vite timeout and records a shadowed legacy alias', () => {
    const resolution = resolveRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '9000',
      REACT_APP_REQUEST_TIMEOUT_MS: '5000',
    });
    const item = evidenceFor(resolution.evidence, 'requestTimeoutMs');
    expect(resolution.config.requestTimeoutMs).toBe(9000);
    expect(item).toMatchObject({
      sourceKey: 'VITE_REQUEST_TIMEOUT_MS',
      sourceKind: 'vite',
      configured: true,
      shadowedSourceCount: 1,
    });
    expect(resolution.summary.shadowedSourceCount).toBe(1);
  });

  test('uses a legacy generic timeout only when the Vite alias is absent', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_REQUEST_TIMEOUT_MS: '7000',
    });
    expect(resolution.config.requestTimeoutMs).toBe(7000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs')).toMatchObject({
      sourceKey: 'REACT_APP_REQUEST_TIMEOUT_MS',
      sourceKind: 'legacy-cra',
      shadowedSourceCount: 0,
    });
  });

  test('prefers VITE_ENV and records lower-precedence environment aliases', () => {
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

  test('selects and clamps generic timeout, cache and retry controls', () => {
    const resolution = resolveRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '1',
      VITE_CACHE_TTL_MS: '999999999',
      VITE_MAX_RETRIES: '99',
    });
    expect(resolution.config.requestTimeoutMs).toBe(1000);
    expect(resolution.config.cacheTtlMs).toBe(600_000);
    expect(resolution.config.maxRetries).toBe(4);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition).toBe('clamped');
    expect(evidenceFor(resolution.evidence, 'cacheTtlMs').disposition).toBe('clamped');
    expect(evidenceFor(resolution.evidence, 'maxRetries').disposition).toBe('clamped');
  });

  test('marks malformed numeric settings as rejected without retaining raw values', () => {
    const raw = 'not-a-timeout-secret';
    const resolution = resolveRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: raw,
    });
    expect(resolution.config.requestTimeoutMs).toBe(15_000);
    expect(evidenceFor(resolution.evidence, 'requestTimeoutMs').disposition).toBe('invalid-fallback');
    expect(JSON.stringify(resolution.evidence)).not.toContain(raw);
  });

  test('uses only recognized environment keys for build-mode provenance', () => {
    const releaseOnly = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    expect(releaseOnly.config.buildMode).toBe('vite-ready');
    expect(resolveRuntimeConfig({ VITE_API_URL: '/retired-api' }).config.buildMode).toBe('unknown');

    const mixed = resolveRuntimeConfig({
      VITE_API_URL: '/retired-api',
      VITE_RELEASE: 'r1',
    });
    expect(evidenceFor(mixed.evidence, 'buildMode').sourceKey).toBe('VITE_RELEASE');
  });
});

describe('runtime config value normalization', () => {
  test('normalizes environment and release text', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: ' staging ',
      VITE_RELEASE: ' release-1 ',
    });
    expect(resolution.config.environment).toBe('staging');
    expect(resolution.config.release).toBe('release-1');
    expect(evidenceFor(resolution.evidence, 'environment').disposition).toBe('normalized');
    expect(evidenceFor(resolution.evidence, 'release').disposition).toBe('normalized');
  });

  test('bounds oversized release text', () => {
    const resolution = resolveRuntimeConfig({ VITE_RELEASE: 'x'.repeat(300) });
    expect(resolution.config.release).toHaveLength(120);
    expect(evidenceFor(resolution.evidence, 'release').disposition).toBe('normalized');
  });

  test('pins ArcGIS version to the bundled package contract', () => {
    const resolution = resolveRuntimeConfig({ VITE_ESRI_API_VERSION: 'next' });
    expect(resolution.config.esriApiVersion).toBe('5.1.24');
    expect(evidenceFor(resolution.evidence, 'esriApiVersion').disposition).toBe('policy-pinned');
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

  test('normalizes equivalent setting values to a stable config fingerprint', () => {
    const first = resolveRuntimeConfig({ VITE_REQUEST_TIMEOUT_MS: '15000' });
    const second = resolveRuntimeConfig({ VITE_REQUEST_TIMEOUT_MS: '15000 ' });
    expect(first.configFingerprint).toBe(second.configFingerprint);
  });

  test('evidence fingerprint distinguishes source normalization from accepted input', () => {
    const first = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    const second = resolveRuntimeConfig({ VITE_RELEASE: ' r1 ' });
    expect(first.configFingerprint).toBe(second.configFingerprint);
    expect(first.evidenceFingerprint).not.toBe(second.evidenceFingerprint);
  });

  test('fingerprints are independent of source insertion order', () => {
    const first = resolveRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '8000',
      VITE_RELEASE: 'r1',
      VITE_ENV: 'staging',
    });
    const second = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_REQUEST_TIMEOUT_MS: '8000',
    });
    expect(second.configFingerprint).toBe(first.configFingerprint);
    expect(second.evidenceFingerprint).toBe(first.evidenceFingerprint);
  });

  test('standalone evidence fingerprint matches the resolution fingerprint', () => {
    const resolution = resolveRuntimeConfig({
      VITE_RELEASE: 'r5',
      VITE_MAX_RETRIES: '4',
    });
    expect(runtimeConfigEvidenceFingerprint(resolution.evidence)).toBe(resolution.evidenceFingerprint);
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
    expect(serialized).not.toContain('apiBaseUrl');
  });

  test('includes bounded summary counts and fingerprints', () => {
    const description = describeRuntimeConfigResolution(resolveRuntimeConfig({
      VITE_REQUEST_TIMEOUT_MS: '1',
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
