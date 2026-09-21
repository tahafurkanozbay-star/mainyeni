import { describe, expect, test, vi } from 'vitest';
import { resolveRuntimeConfig } from './runtimeConfig';
import {
  RuntimeConfigAdmissionError,
  assessRuntimeConfigAdmission,
  assertRuntimeConfigAdmissible,
  compareRuntimeConfigResolutions,
  createRuntimeConfigGovernanceJournal,
  createRuntimeConfigMigrationPlan,
  evaluateRuntimeConfigGovernance,
  runtimeConfigSecurityFields,
} from './runtimeConfigGovernance';

describe('runtime config governance healthy baseline', () => {
  test('modern Vite production config can be healthy', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_ENV: 'production',
      VITE_RELEASE: '2026.09.21',
      VITE_TYPED_BOOTSTRAP: 'true',
      VITE_STRICT_ENDPOINT_POLICY: 'true',
      VITE_ENV_DEBUG: 'false',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.production).toBe(true);
    expect(health.status).toBe('healthy');
    expect(health.risks).toEqual([]);
  });

  test('staging config is not classified as production', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    expect(evaluateRuntimeConfigGovernance(resolution).production).toBe(false);
  });

  test('prod alias is classified as production', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'prod',
      VITE_RELEASE: 'r1',
    });
    expect(evaluateRuntimeConfigGovernance(resolution).production).toBe(true);
  });

  test('governance summary preserves config and evidence fingerprints', () => {
    const resolution = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    const summary = evaluateRuntimeConfigGovernance(resolution);
    expect(summary.configFingerprint).toBe(resolution.configFingerprint);
    expect(summary.evidenceFingerprint).toBe(resolution.evidenceFingerprint);
  });

  test('governance output is immutable', () => {
    const health = evaluateRuntimeConfigGovernance(resolveRuntimeConfig({
      VITE_RELEASE: 'r1',
    }));
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.risks)).toBe(true);
  });
});

describe('runtime config governance source migration risks', () => {
  test('single legacy field degrades by default', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.legacySourceFields).toBe(1);
    expect(health.status).toBe('degraded');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'legacy-source',
      status: 'degraded',
      count: 1,
    }));
  });

  test('many legacy fields become critical', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_API_TIMEOUT_MS: '5000',
      REACT_APP_API_CACHE_TTL_MS: '1000',
      REACT_APP_API_MAX_RETRIES: '2',
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'r1',
      REACT_APP_ADAPTIVE_RUNTIME: 'true',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'legacy-source',
      status: 'critical',
    }));
  });

  test('shadowed alias degrades', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '/api',
      REACT_APP_API_URL: '/legacy',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.shadowedSourceCount).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'shadowed-source',
      status: 'degraded',
      affectedFields: ['apiBaseUrl'],
    }));
  });

  test('multiple shadowed aliases can become critical', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_API_BASE_URL: '/api2',
      REACT_APP_API_URL: '/legacy',
      REACT_APP_API_BASE_URL: '/legacy2',
      VITE_RELEASE: 'r1',
      REACT_APP_RELEASE: 'legacy-r1',
      VITE_ENV: 'staging',
      REACT_APP_ENV: 'legacy',
    });
    const health = evaluateRuntimeConfigGovernance(resolution, {
      shadowedSourceCriticalCount: 4,
    });
    expect(health.shadowedSourceCount).toBeGreaterThanOrEqual(4);
    expect(health.status).toBe('critical');
  });

  test('legacy build mode is critical in production', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'legacy-build-mode',
      status: 'critical',
      affectedFields: ['buildMode'],
    }));
  });

  test('legacy build mode is degraded outside production', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_ENV: 'development',
      REACT_APP_RELEASE: 'local',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'legacy-build-mode',
      status: 'degraded',
    }));
  });

  test('unknown build mode degrades', () => {
    const health = evaluateRuntimeConfigGovernance(resolveRuntimeConfig({}));
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'unknown-build-mode',
      status: 'degraded',
    }));
  });
});

describe('runtime config governance parser risks', () => {
  test('invalid numeric fallback degrades', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_TIMEOUT_MS: 'never',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.rejectedFields).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'invalid-fallback',
      status: 'degraded',
      affectedFields: ['requestTimeoutMs'],
    }));
  });

  test('many invalid fields become critical', () => {
    const resolution = resolveRuntimeConfig({
      VITE_API_TIMEOUT_MS: 'never',
      VITE_API_CACHE_TTL_MS: 'never',
      VITE_API_MAX_RETRIES: 'never',
      VITE_ENV_DEBUG: 'perhaps',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.rejectedFields).toBe(4);
    expect(health.status).toBe('critical');
  });

  test('ArcGIS version policy pinning degrades', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ESRI_API_VERSION: 'next',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.pinnedFields).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'policy-pinned',
      affectedFields: ['esriApiVersion'],
    }));
  });

  test('risk entry count is bounded', () => {
    const resolution = resolveRuntimeConfig({
      REACT_APP_API_URL: 'https://evil.example',
      REACT_APP_API_TIMEOUT_MS: 'bad',
      REACT_APP_API_CACHE_TTL_MS: 'bad',
      REACT_APP_API_MAX_RETRIES: 'bad',
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'local',
      REACT_APP_ENV_DEBUG: 'true',
      REACT_APP_TYPED_BOOTSTRAP: 'false',
      REACT_APP_STRICT_ENDPOINT_POLICY: 'false',
      REACT_APP_ESRI_API_VERSION: 'next',
    });
    const health = evaluateRuntimeConfigGovernance(resolution, {
      maxRiskEntries: 3,
    });
    expect(health.risks).toHaveLength(3);
  });
});

describe('runtime config governance production security', () => {
  test('debug logging in production is critical', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'r1',
      VITE_ENV_DEBUG: 'true',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'debug-logging-production',
      affectedFields: ['features.debugLogging'],
    }));
  });

  test('debug logging in development is not a production risk', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'development',
      VITE_RELEASE: 'local',
      VITE_ENV_DEBUG: 'true',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks.some((risk) =>
      risk.code === 'debug-logging-production')).toBe(false);
  });

  test('strict endpoint policy disabled is always critical', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_STRICT_ENDPOINT_POLICY: 'false',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'strict-endpoint-disabled',
    }));
  });

  test('typed bootstrap disabled is critical', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_TYPED_BOOTSTRAP: 'false',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'typed-bootstrap-disabled',
    }));
  });

  test('local production release degrades', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'local',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'local-release-production',
      status: 'degraded',
    }));
  });

  test('staging local release does not add production release risk', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'local',
    });
    const health = evaluateRuntimeConfigGovernance(resolution);
    expect(health.risks.some((risk) =>
      risk.code === 'local-release-production')).toBe(false);
  });
});

describe('runtime config governance policy validation', () => {
  test.each([
    ['legacySourceWarningCount', 0],
    ['legacySourceCriticalCount', 0],
    ['shadowedSourceWarningCount', 0],
    ['shadowedSourceCriticalCount', 0],
    ['rejectedFieldWarningCount', 0],
    ['rejectedFieldCriticalCount', 0],
    ['pinnedFieldWarningCount', 0],
    ['pinnedFieldCriticalCount', 0],
    ['maxRiskEntries', 0],
  ] as const)('rejects invalid governance threshold %s', (key, value) => {
    expect(() => evaluateRuntimeConfigGovernance(resolveRuntimeConfig({}), {
      [key]: value,
    })).toThrow(RangeError);
  });

  test('rejects critical legacy threshold below warning', () => {
    expect(() => evaluateRuntimeConfigGovernance(resolveRuntimeConfig({}), {
      legacySourceWarningCount: 3,
      legacySourceCriticalCount: 2,
    })).toThrow(RangeError);
  });

  test('rejects critical shadow threshold below warning', () => {
    expect(() => evaluateRuntimeConfigGovernance(resolveRuntimeConfig({}), {
      shadowedSourceWarningCount: 3,
      shadowedSourceCriticalCount: 2,
    })).toThrow(RangeError);
  });

  test('rejects critical parser threshold below warning', () => {
    expect(() => evaluateRuntimeConfigGovernance(resolveRuntimeConfig({}), {
      rejectedFieldWarningCount: 3,
      rejectedFieldCriticalCount: 2,
    })).toThrow(RangeError);
  });
});

describe('runtime config admission defaults', () => {
  test('admits modern staging config', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }));
    expect(result.admitted).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('admits safe modern production config', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'r1',
      VITE_ENV_DEBUG: 'false',
      VITE_TYPED_BOOTSTRAP: 'true',
      VITE_STRICT_ENDPOINT_POLICY: 'true',
    }));
    expect(result.admitted).toBe(true);
    expect(result.production).toBe(true);
  });

  test('allows unknown build mode by default', () => {
    expect(assessRuntimeConfigAdmission(resolveRuntimeConfig({})).admitted)
      .toBe(true);
  });

  test('rejects legacy build mode by default', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    }));
    expect(result.admitted).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'legacy-build-mode',
    }));
  });

  test('can temporarily allow legacy build mode during migration', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    }), {
      allowLegacyBuildMode: true,
      maxLegacySourceFields: 10,
    });
    expect(result.admitted).toBe(true);
  });

  test('can reject unknown build mode explicitly', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({}), {
      allowUnknownBuildMode: false,
    });
    expect(result.admitted).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'unknown-build-mode',
    }));
  });
});

describe('runtime config admission security', () => {
  test('rejects production debug logging', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'r1',
      VITE_ENV_DEBUG: 'true',
    }));
    expect(result.admitted).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'debug-logging-production',
    }));
  });

  test('can allow production debug logging only through explicit override', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'r1',
      VITE_ENV_DEBUG: 'true',
    }), {
      allowDebugLoggingInProduction: true,
    });
    expect(result.admitted).toBe(true);
  });

  test('rejects strict endpoint policy disablement', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_STRICT_ENDPOINT_POLICY: 'false',
    }));
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'strict-endpoint-disabled',
    }));
  });

  test('can relax strict endpoint requirement only explicitly', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_STRICT_ENDPOINT_POLICY: 'false',
    }), {
      requireStrictEndpointPolicy: false,
    });
    expect(result.admitted).toBe(true);
  });

  test('rejects typed bootstrap disablement', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_TYPED_BOOTSTRAP: 'false',
    }));
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'typed-bootstrap-disabled',
    }));
  });
});

describe('runtime config admission quantitative budgets', () => {
  test('rejects any parser fallback by default', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_API_TIMEOUT_MS: 'bad',
    }));
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'too-many-rejected-fields',
      actualCount: 1,
      threshold: 0,
    }));
  });

  test('can admit one parser fallback with explicit budget', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      VITE_API_TIMEOUT_MS: 'bad',
    }), {
      maxRejectedFields: 1,
    });
    expect(result.admitted).toBe(true);
  });

  test('rejects legacy source budget overflow', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_RELEASE: 'r1',
      REACT_APP_API_URL: '/api',
      REACT_APP_API_TIMEOUT_MS: '5000',
      REACT_APP_API_CACHE_TTL_MS: '1000',
      REACT_APP_API_MAX_RETRIES: '2',
      REACT_APP_ADAPTIVE_RUNTIME: 'true',
    }), {
      allowLegacyBuildMode: true,
      maxLegacySourceFields: 2,
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'too-many-legacy-fields',
    }));
  });

  test('rejects shadowed alias budget overflow', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      REACT_APP_ENV: 'legacy',
      VITE_RELEASE: 'r1',
      REACT_APP_RELEASE: 'legacy-r1',
      VITE_API_URL: '/api',
      REACT_APP_API_URL: '/legacy',
    }), {
      maxShadowedSourceCount: 1,
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'too-many-shadowed-sources',
      threshold: 1,
    }));
  });

  test('bounds admission violations', () => {
    const result = assessRuntimeConfigAdmission(resolveRuntimeConfig({
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'r1',
      REACT_APP_ENV_DEBUG: 'true',
      REACT_APP_TYPED_BOOTSTRAP: 'false',
      REACT_APP_STRICT_ENDPOINT_POLICY: 'false',
      REACT_APP_API_TIMEOUT_MS: 'bad',
    }), {
      allowLegacyBuildMode: false,
      maxLegacySourceFields: 0,
      maxRejectedFields: 0,
      maxViolations: 2,
    });
    expect(result.violations).toHaveLength(2);
  });

  test.each([
    ['maxRejectedFields', -1],
    ['maxLegacySourceFields', -1],
    ['maxShadowedSourceCount', -1],
    ['maxViolations', 0],
  ] as const)('rejects invalid admission budget %s', (key, value) => {
    expect(() => assessRuntimeConfigAdmission(resolveRuntimeConfig({}), {
      [key]: value,
    })).toThrow(RangeError);
  });
});

describe('assertRuntimeConfigAdmissible', () => {
  test('returns true for admissible config', () => {
    expect(assertRuntimeConfigAdmissible(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }))).toBe(true);
  });

  test('throws typed admission error on rejected config', () => {
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: 'r1',
      VITE_ENV_DEBUG: 'true',
    });
    try {
      assertRuntimeConfigAdmissible(resolution);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigAdmissionError);
      const typed = error as RuntimeConfigAdmissionError;
      expect(typed.code).toBe('RUNTIME_CONFIG_REJECTED');
      expect(typed.result.admitted).toBe(false);
      expect(typed.message).not.toContain('r1');
    }
  });
});

describe('privacy-safe runtime config change comparison', () => {
  test('reports no change for equal canonical config', () => {
    const before = resolveRuntimeConfig({ VITE_API_URL: '/api/' });
    const after = resolveRuntimeConfig({ VITE_API_URL: '/api' });
    const changes = compareRuntimeConfigResolutions(before, after);
    expect(changes.changed).toBe(false);
    expect(changes.count).toBe(0);
    expect(changes.changes).toEqual([]);
  });

  test('reports network boundary change without exposing values', () => {
    const before = resolveRuntimeConfig({ VITE_API_URL: '/api' });
    const after = resolveRuntimeConfig({ VITE_API_URL: '/gateway' });
    const changes = compareRuntimeConfigResolutions(before, after);
    expect(changes.changes).toEqual([
      {
        fieldId: 'apiBaseUrl',
        changeClass: 'network-boundary',
        sensitive: false,
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain('/gateway');
    expect(JSON.stringify(changes)).not.toContain('/api');
  });

  test('marks TKGM identity change sensitive', () => {
    const before = resolveRuntimeConfig({ VITE_TKGM_CITY_ID: 'city-a' });
    const after = resolveRuntimeConfig({ VITE_TKGM_CITY_ID: 'city-b' });
    const changes = compareRuntimeConfigResolutions(before, after);
    expect(changes.changes).toEqual([
      {
        fieldId: 'tkgmCityId',
        changeClass: 'identity',
        sensitive: true,
      },
    ]);
    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain('city-a');
    expect(serialized).not.toContain('city-b');
  });

  test('classifies security feature change', () => {
    const before = resolveRuntimeConfig({
      VITE_STRICT_ENDPOINT_POLICY: 'true',
    });
    const after = resolveRuntimeConfig({
      VITE_STRICT_ENDPOINT_POLICY: 'false',
    });
    expect(compareRuntimeConfigResolutions(before, after).changes)
      .toContainEqual({
        fieldId: 'features.strictEndpointPolicy',
        changeClass: 'security-boundary',
        sensitive: false,
      });
  });

  test('classifies retry change as resilience', () => {
    const before = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '1' });
    const after = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '2' });
    expect(compareRuntimeConfigResolutions(before, after).changes)
      .toContainEqual({
        fieldId: 'maxRetries',
        changeClass: 'resilience',
        sensitive: false,
      });
  });

  test('change fingerprint is stable for equivalent change sets', () => {
    const beforeA = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '1' });
    const afterA = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '2' });
    const beforeB = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '1' });
    const afterB = resolveRuntimeConfig({ VITE_API_MAX_RETRIES: '2' });
    expect(compareRuntimeConfigResolutions(beforeA, afterA).fingerprint)
      .toBe(compareRuntimeConfigResolutions(beforeB, afterB).fingerprint);
  });
});

describe('runtime config migration plan', () => {
  test('returns empty plan for modern Vite config', () => {
    const plan = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }));
    expect(plan.required).toBe(false);
    expect(plan.stepCount).toBe(0);
    expect(plan.steps).toEqual([]);
  });

  test('maps legacy API key to primary Vite replacement', () => {
    const plan = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
    }));
    expect(plan.steps).toContainEqual({
      fieldId: 'apiBaseUrl',
      legacyKey: 'REACT_APP_API_URL',
      replacementKey: 'VITE_API_URL',
      shadowed: false,
    });
  });

  test('maps legacy release key to Vite replacement', () => {
    const plan = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_RELEASE: 'r1',
    }));
    expect(plan.steps).toContainEqual({
      fieldId: 'release',
      legacyKey: 'REACT_APP_RELEASE',
      replacementKey: 'VITE_VERSION',
      shadowed: false,
    });
  });

  test('does not emit buildMode as a migration step', () => {
    const plan = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_RELEASE: 'r1',
    }));
    expect(plan.steps.some((step) => step.fieldId === 'buildMode')).toBe(false);
  });

  test('sorts migration steps deterministically', () => {
    const plan = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_TYPED_BOOTSTRAP: 'true',
      REACT_APP_API_URL: '/api',
      REACT_APP_RELEASE: 'r1',
    }));
    expect(plan.steps.map((step) => step.fieldId)).toEqual([
      'apiBaseUrl',
      'features.typedBootstrap',
      'release',
    ]);
  });

  test('migration fingerprint is deterministic', () => {
    const first = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_RELEASE: 'r1',
    }));
    const second = createRuntimeConfigMigrationPlan(resolveRuntimeConfig({
      REACT_APP_RELEASE: 'r1',
      REACT_APP_API_URL: '/api',
    }));
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe('runtime config security field catalog', () => {
  test('contains only config field identities', () => {
    const fields = runtimeConfigSecurityFields();
    expect(fields).toEqual([
      'apiBaseUrl',
      'features.debugLogging',
      'features.strictEndpointPolicy',
      'features.typedBootstrap',
    ]);
    expect(Object.isFrozen(fields)).toBe(true);
  });
});

describe('runtime config governance journal', () => {
  test('samples on demand without timers or polling', () => {
    let now = 100;
    const journal = createRuntimeConfigGovernanceJournal({ now: () => now });
    const first = journal.sample(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }));
    now = 120;
    const second = journal.sample(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r2',
    }));
    expect(first.sequence).toBe(1);
    expect(first.sampledAt).toBe(100);
    expect(second.sequence).toBe(2);
    expect(second.sampledAt).toBe(120);
    expect('setInterval' in journal).toBe(false);
    expect('setTimeout' in journal).toBe(false);
  });

  test('retains bounded history', () => {
    let now = 1;
    const journal = createRuntimeConfigGovernanceJournal({
      historyLimit: 2,
      now: () => now,
    });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    now += 1;
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r2' }));
    now += 1;
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r3' }));
    const state = journal.snapshot();
    expect(state.samples).toBe(3);
    expect(state.history.map((item) => item.sequence)).toEqual([2, 3]);
  });

  test('retains bounded events', () => {
    let now = 1;
    const journal = createRuntimeConfigGovernanceJournal({
      eventLimit: 2,
      now: () => now++,
    });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r2' }));
    expect(journal.snapshot().events).toHaveLength(2);
  });

  test('history can be disabled', () => {
    const journal = createRuntimeConfigGovernanceJournal({ historyLimit: 0 });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    expect(journal.snapshot().history).toEqual([]);
    expect(journal.snapshot().current?.sequence).toBe(1);
  });

  test('events can be disabled', () => {
    const journal = createRuntimeConfigGovernanceJournal({ eventLimit: 0 });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    expect(journal.snapshot().events).toEqual([]);
  });

  test('emits change-detected only with baseline changes', () => {
    const observer = vi.fn();
    const journal = createRuntimeConfigGovernanceJournal({ onEvent: observer });
    const baseline = resolveRuntimeConfig({ VITE_RELEASE: 'r1' });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r2' }), baseline);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'change-detected',
      changeCount: 1,
    }));
  });

  test('emits admitted event', () => {
    const journal = createRuntimeConfigGovernanceJournal();
    journal.sample(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }));
    expect(journal.snapshot().events).toContainEqual(expect.objectContaining({
      kind: 'admitted',
      violationCount: 0,
    }));
  });

  test('emits rejected event without raw values', () => {
    const secret = 'secret-release-value';
    const journal = createRuntimeConfigGovernanceJournal();
    journal.sample(resolveRuntimeConfig({
      VITE_ENV: 'production',
      VITE_RELEASE: secret,
      VITE_ENV_DEBUG: 'true',
    }));
    const serialized = JSON.stringify(journal.snapshot());
    expect(serialized).toContain('rejected');
    expect(serialized).not.toContain(secret);
  });

  test('observer failures are isolated', () => {
    const journal = createRuntimeConfigGovernanceJournal({
      onEvent: () => {
        throw new Error('private observer detail');
      },
    });
    expect(() => journal.sample(resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    }))).not.toThrow();
    const state = journal.snapshot();
    expect(state.observerFailures).toBeGreaterThan(0);
    expect(state.events).toContainEqual(expect.objectContaining({
      kind: 'observer-failed',
      errorName: 'Error',
    }));
    expect(JSON.stringify(state)).not.toContain('private observer detail');
  });

  test('rejects invalid clock value', () => {
    const journal = createRuntimeConfigGovernanceJournal({
      now: () => Number.NaN,
    });
    expect(() => journal.sample(resolveRuntimeConfig({}))).toThrow(RangeError);
  });

  test('rejects backwards clock', () => {
    let now = 100;
    const journal = createRuntimeConfigGovernanceJournal({ now: () => now });
    journal.sample(resolveRuntimeConfig({}));
    now = 99;
    expect(() => journal.sample(resolveRuntimeConfig({}))).toThrow(RangeError);
  });

  test('reset clears state and monotonic baseline', () => {
    let now = 100;
    const journal = createRuntimeConfigGovernanceJournal({ now: () => now });
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    journal.reset();
    now = 50;
    const sample = journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r2' }));
    expect(sample.sequence).toBe(1);
    expect(sample.sampledAt).toBe(50);
  });

  test('snapshot collections are immutable', () => {
    const journal = createRuntimeConfigGovernanceJournal();
    journal.sample(resolveRuntimeConfig({ VITE_RELEASE: 'r1' }));
    const state = journal.snapshot();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.history)).toBe(true);
    expect(Object.isFrozen(state.events)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
  });

  test('sample fingerprint excludes raw config values', () => {
    const secret = 'private-city-id';
    const journal = createRuntimeConfigGovernanceJournal();
    const sample = journal.sample(resolveRuntimeConfig({
      VITE_TKGM_CITY_ID: secret,
      VITE_RELEASE: 'r1',
    }));
    expect(sample.fingerprint).toMatch(/^[0-9a-f]{8}$/u);
    expect(JSON.stringify(sample)).not.toContain(secret);
  });

  test('equivalent governance state yields stable sample fingerprint', () => {
    let now = 1;
    const journal = createRuntimeConfigGovernanceJournal({ now: () => now });
    const resolution = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const first = journal.sample(resolution);
    now += 1;
    const second = journal.sample(resolution);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
