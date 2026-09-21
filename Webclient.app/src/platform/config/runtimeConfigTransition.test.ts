import { describe, expect, test } from 'vitest';
import { resolveRuntimeConfig } from './runtimeConfig';
import {
  RuntimeConfigTransitionError,
  assessRuntimeConfigTransition,
  assertRuntimeConfigTransitionSafe,
  runtimeConfigTransitionPolicyDefaults,
} from './runtimeConfigTransition';

const modern = (
  overrides: Record<string, unknown> = {},
) => resolveRuntimeConfig({
  VITE_API_URL: '/api',
  VITE_ENV: 'staging',
  VITE_RELEASE: 'r1',
  VITE_TYPED_BOOTSTRAP: 'true',
  VITE_STRICT_ENDPOINT_POLICY: 'true',
  VITE_ENV_DEBUG: 'false',
  ...overrides,
});

describe('runtime config transition no-op behavior', () => {
  test('allows identical resolution', () => {
    const before = modern();
    const after = modern();
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.allowed).toBe(true);
    expect(assessment.changes.changed).toBe(false);
    expect(assessment.violations).toEqual([]);
  });

  test('allows provenance-only change with identical canonical config', () => {
    const before = resolveRuntimeConfig({
      VITE_API_URL: '/api',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const after = resolveRuntimeConfig({
      VITE_API_URL: '/api/',
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
    });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.allowed).toBe(true);
    expect(assessment.changes.count).toBe(0);
    expect(assessment.beforeEvidenceFingerprint)
      .not.toBe(assessment.afterEvidenceFingerprint);
  });

  test('assessment is immutable', () => {
    const assessment = assessRuntimeConfigTransition(modern(), modern());
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.violations)).toBe(true);
    expect(Object.isFrozen(assessment.changes)).toBe(true);
  });

  test('fingerprint is deterministic', () => {
    const first = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
    );
    const second = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
    );
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('fingerprint changes when violations change', () => {
    const release = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
    );
    const network = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_API_URL: '/gateway' }),
    );
    expect(network.fingerprint).not.toBe(release.fingerprint);
  });
});

describe('runtime config transition change budget', () => {
  test('allows one benign release change within default budget', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
    );
    expect(assessment.allowed).toBe(true);
    expect(assessment.changes.changes).toContainEqual({
      fieldId: 'release',
      changeClass: 'release',
      sensitive: false,
    });
  });

  test('rejects when changed field count exceeds budget', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({
        VITE_RELEASE: 'r2',
        VITE_API_TIMEOUT_MS: '5000',
        VITE_API_CACHE_TTL_MS: '1000',
        VITE_API_MAX_RETRIES: '4',
      }),
      { maxChangedFields: 2 },
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: 'change-budget-exceeded',
      actualCount: 4,
      threshold: 2,
    }));
  });

  test('zero change budget still allows no-op transition', () => {
    expect(assessRuntimeConfigTransition(modern(), modern(), {
      maxChangedFields: 0,
    }).allowed).toBe(true);
  });

  test('zero change budget rejects any canonical change', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
      { maxChangedFields: 0 },
    );
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: 'change-budget-exceeded',
      actualCount: 1,
      threshold: 0,
    }));
  });
});

describe('runtime config network boundary transition', () => {
  test('rejects API base change by default', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_API_URL: '/gateway' }),
    );
    expect(assessment.allowed).toBe(false);
    expect(assessment.violations).toContainEqual({
      code: 'network-boundary-change',
      affectedFields: ['apiBaseUrl'],
    });
  });

  test('allows API base change only with explicit override', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_API_URL: '/gateway' }),
      { allowNetworkBoundaryChange: true },
    );
    expect(assessment.allowed).toBe(true);
  });

  test('does not leak API paths into assessment', () => {
    const before = modern({ VITE_API_URL: '/private-before' });
    const after = modern({ VITE_API_URL: '/private-after' });
    const assessment = assessRuntimeConfigTransition(before, after);
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toContain('/private-before');
    expect(serialized).not.toContain('/private-after');
  });

  test('normalized equivalent API path does not count as network change', () => {
    const before = modern({ VITE_API_URL: '/api/' });
    const after = modern({ VITE_API_URL: '/api' });
    expect(assessRuntimeConfigTransition(before, after).allowed).toBe(true);
  });
});

describe('runtime config security boundary transition', () => {
  test('rejects strict endpoint disablement', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_STRICT_ENDPOINT_POLICY: 'false' }),
    );
    expect(assessment.violations).toContainEqual({
      code: 'security-boundary-change',
      affectedFields: ['features.strictEndpointPolicy'],
    });
  });

  test('rejects typed bootstrap disablement', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_TYPED_BOOTSTRAP: 'false' }),
    );
    expect(assessment.violations).toContainEqual({
      code: 'security-boundary-change',
      affectedFields: ['features.typedBootstrap'],
    });
  });

  test('rejects debug logging enablement as security change', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_ENV_DEBUG: 'true' }),
    );
    expect(assessment.violations).toContainEqual({
      code: 'security-boundary-change',
      affectedFields: ['features.debugLogging'],
    });
  });

  test('allows security boundary change only explicitly', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_ENV_DEBUG: 'true' }),
      { allowSecurityBoundaryChange: true },
    );
    expect(assessment.allowed).toBe(true);
  });

  test('ordinary feature toggle is not a security boundary change', () => {
    const assessment = assessRuntimeConfigTransition(
      modern(),
      modern({ VITE_ADAPTIVE_RUNTIME: 'false' }),
    );
    expect(assessment.allowed).toBe(true);
    expect(assessment.changes.changes).toContainEqual({
      fieldId: 'features.adaptiveRuntime',
      changeClass: 'feature',
      sensitive: false,
    });
  });
});

describe('runtime config sensitive identity transition', () => {
  test('sensitive TKGM change is allowed by default but remains classified', () => {
    const before = modern({ VITE_TKGM_CITY_ID: 'city-a' });
    const after = modern({ VITE_TKGM_CITY_ID: 'city-b' });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.allowed).toBe(true);
    expect(assessment.changes.changes).toContainEqual({
      fieldId: 'tkgmCityId',
      changeClass: 'identity',
      sensitive: true,
    });
  });

  test('can reject sensitive identity changes explicitly', () => {
    const assessment = assessRuntimeConfigTransition(
      modern({ VITE_TKGM_CITY_ID: 'city-a' }),
      modern({ VITE_TKGM_CITY_ID: 'city-b' }),
      { allowSensitiveIdentityChange: false },
    );
    expect(assessment.violations).toContainEqual({
      code: 'sensitive-identity-change',
      affectedFields: ['tkgmCityId'],
    });
  });

  test('sensitive raw values never appear in violation', () => {
    const assessment = assessRuntimeConfigTransition(
      modern({ VITE_TKGM_CITY_ID: 'secret-a' }),
      modern({ VITE_TKGM_CITY_ID: 'secret-b' }),
      { allowSensitiveIdentityChange: false },
    );
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toContain('secret-a');
    expect(serialized).not.toContain('secret-b');
  });
});

describe('runtime config environment transition', () => {
  test('rejects staging to production environment change by default', () => {
    const assessment = assessRuntimeConfigTransition(
      modern({ VITE_ENV: 'staging' }),
      modern({ VITE_ENV: 'production' }),
    );
    expect(assessment.violations).toContainEqual({
      code: 'environment-change',
      affectedFields: ['environment'],
    });
  });

  test('allows environment change only explicitly', () => {
    const assessment = assessRuntimeConfigTransition(
      modern({ VITE_ENV: 'staging' }),
      modern({ VITE_ENV: 'production' }),
      { allowEnvironmentChange: true },
    );
    expect(assessment.allowed).toBe(true);
  });

  test('release change inside same environment remains allowed', () => {
    const assessment = assessRuntimeConfigTransition(
      modern({ VITE_RELEASE: 'r1' }),
      modern({ VITE_RELEASE: 'r2' }),
    );
    expect(assessment.allowed).toBe(true);
  });
});

describe('runtime config SDK version transition', () => {
  test('policy-pinned unsupported versions do not create canonical SDK change', () => {
    const before = modern({ VITE_ESRI_API_VERSION: '5.1.24' });
    const after = modern({ VITE_ESRI_API_VERSION: 'next' });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.changes.changes.some((change) =>
      change.fieldId === 'esriApiVersion')).toBe(false);
  });

  test('SDK transition policy defaults to closed', () => {
    expect(runtimeConfigTransitionPolicyDefaults().allowSdkVersionChange)
      .toBe(false);
  });
});

describe('runtime config build mode regression', () => {
  test('rejects Vite to legacy build mode regression', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      allowNetworkBoundaryChange: true,
      allowEnvironmentChange: true,
      maxLegacySourceIncrease: 20,
    });
    expect(assessment.violations).toContainEqual({
      code: 'build-mode-regression',
      affectedFields: ['buildMode'],
    });
  });

  test('allows build mode regression only explicitly', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      allowBuildModeRegression: true,
      maxLegacySourceIncrease: 20,
      maxChangedFields: 20,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'build-mode-regression')).toBe(false);
  });

  test('legacy to Vite migration is not a regression', () => {
    const before = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    });
    const after = modern();
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 20,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'build-mode-regression')).toBe(false);
  });

  test('unknown to Vite is not a regression', () => {
    const before = resolveRuntimeConfig({});
    const after = modern();
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 20,
      allowEnvironmentChange: true,
      allowNetworkBoundaryChange: true,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'build-mode-regression')).toBe(false);
  });
});

describe('runtime config legacy-source regression budget', () => {
  test('rejects any legacy-source increase by default', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      REACT_APP_API_URL: '/api',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 20,
    });
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: 'legacy-source-regression',
      actualCount: 1,
      threshold: 0,
    }));
  });

  test('can budget one additional legacy field temporarily', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      VITE_ENV: 'staging',
      VITE_RELEASE: 'r1',
      REACT_APP_API_URL: '/api',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxLegacySourceIncrease: 1,
      maxChangedFields: 20,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'legacy-source-regression')).toBe(false);
  });

  test('reducing legacy source usage is allowed', () => {
    const before = resolveRuntimeConfig({
      REACT_APP_API_URL: '/api',
      REACT_APP_ENV: 'staging',
      REACT_APP_RELEASE: 'r1',
    });
    const after = modern();
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 20,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'legacy-source-regression')).toBe(false);
  });
});

describe('runtime config rejected-field regression budget', () => {
  test('rejects new invalid fallback by default', () => {
    const before = modern();
    const after = modern({ VITE_API_TIMEOUT_MS: 'bad' });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: 'rejected-field-regression',
      affectedFields: ['requestTimeoutMs'],
      actualCount: 1,
      threshold: 0,
    }));
  });

  test('can budget one rejected field explicitly', () => {
    const before = modern();
    const after = modern({ VITE_API_TIMEOUT_MS: 'bad' });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxRejectedFieldIncrease: 1,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'rejected-field-regression')).toBe(false);
  });

  test('fixing rejected parser input is allowed', () => {
    const before = modern({ VITE_API_TIMEOUT_MS: 'bad' });
    const after = modern({ VITE_API_TIMEOUT_MS: '5000' });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.violations.some((item) =>
      item.code === 'rejected-field-regression')).toBe(false);
  });
});

describe('runtime config shadowed-source regression budget', () => {
  test('rejects new shadowed alias by default', () => {
    const before = modern();
    const after = modern({ REACT_APP_API_URL: '/legacy' });
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: 'shadowed-source-regression',
      affectedFields: ['apiBaseUrl'],
      actualCount: 1,
      threshold: 0,
    }));
  });

  test('can budget one shadowed alias explicitly', () => {
    const before = modern();
    const after = modern({ REACT_APP_API_URL: '/legacy' });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxShadowedSourceIncrease: 1,
    });
    expect(assessment.violations.some((item) =>
      item.code === 'shadowed-source-regression')).toBe(false);
  });

  test('removing shadowed alias is allowed', () => {
    const before = modern({ REACT_APP_API_URL: '/legacy' });
    const after = modern();
    const assessment = assessRuntimeConfigTransition(before, after);
    expect(assessment.violations.some((item) =>
      item.code === 'shadowed-source-regression')).toBe(false);
  });
});

describe('runtime config transition mixed changes', () => {
  test('returns multiple independent violations for unsafe deployment', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      REACT_APP_API_URL: '/gateway',
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'r2',
      REACT_APP_ENV_DEBUG: 'true',
      REACT_APP_STRICT_ENDPOINT_POLICY: 'false',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 20,
    });
    const codes = assessment.violations.map((item) => item.code);
    expect(codes).toContain('network-boundary-change');
    expect(codes).toContain('security-boundary-change');
    expect(codes).toContain('environment-change');
    expect(codes).toContain('build-mode-regression');
    expect(codes).toContain('legacy-source-regression');
  });

  test('bounds mixed transition violations', () => {
    const before = modern();
    const after = resolveRuntimeConfig({
      REACT_APP_API_URL: '/gateway',
      REACT_APP_ENV: 'production',
      REACT_APP_RELEASE: 'r2',
      REACT_APP_ENV_DEBUG: 'true',
      REACT_APP_STRICT_ENDPOINT_POLICY: 'false',
      REACT_APP_API_TIMEOUT_MS: 'bad',
    });
    const assessment = assessRuntimeConfigTransition(before, after, {
      maxChangedFields: 1,
      maxViolations: 3,
    });
    expect(assessment.violations).toHaveLength(3);
  });

  test('violation records expose field ids but not config values', () => {
    const before = modern({ VITE_API_URL: '/private-a' });
    const after = modern({ VITE_API_URL: '/private-b' });
    const assessment = assessRuntimeConfigTransition(before, after);
    const serialized = JSON.stringify(assessment.violations);
    expect(serialized).toContain('apiBaseUrl');
    expect(serialized).not.toContain('/private-a');
    expect(serialized).not.toContain('/private-b');
  });
});

describe('runtime config transition policy validation', () => {
  test.each([
    ['maxChangedFields', -1],
    ['maxLegacySourceIncrease', -1],
    ['maxRejectedFieldIncrease', -1],
    ['maxShadowedSourceIncrease', -1],
    ['maxViolations', 0],
  ] as const)('rejects invalid transition policy %s', (key, value) => {
    expect(() => assessRuntimeConfigTransition(modern(), modern(), {
      [key]: value,
    })).toThrow(RangeError);
  });

  test('returns frozen default policy copy', () => {
    const policy = runtimeConfigTransitionPolicyDefaults();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy).toMatchObject({
      maxChangedFields: 6,
      allowNetworkBoundaryChange: false,
      allowSecurityBoundaryChange: false,
      allowSensitiveIdentityChange: true,
      allowEnvironmentChange: false,
      allowSdkVersionChange: false,
      allowBuildModeRegression: false,
      maxLegacySourceIncrease: 0,
      maxRejectedFieldIncrease: 0,
      maxShadowedSourceIncrease: 0,
    });
  });
});

describe('assertRuntimeConfigTransitionSafe', () => {
  test('returns true for safe release-only transition', () => {
    expect(assertRuntimeConfigTransitionSafe(
      modern(),
      modern({ VITE_RELEASE: 'r2' }),
    )).toBe(true);
  });

  test('throws typed error for unsafe network transition', () => {
    try {
      assertRuntimeConfigTransitionSafe(
        modern(),
        modern({ VITE_API_URL: '/gateway' }),
      );
      throw new Error('expected transition rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigTransitionError);
      const typed = error as RuntimeConfigTransitionError;
      expect(typed.code).toBe('RUNTIME_CONFIG_TRANSITION_REJECTED');
      expect(typed.assessment.allowed).toBe(false);
      expect(typed.assessment.violations).toContainEqual({
        code: 'network-boundary-change',
        affectedFields: ['apiBaseUrl'],
      });
      expect(typed.message).not.toContain('/gateway');
    }
  });

  test('supports explicit deployment authorization override', () => {
    expect(assertRuntimeConfigTransitionSafe(
      modern(),
      modern({
        VITE_API_URL: '/gateway',
        VITE_ENV: 'production',
        VITE_ENV_DEBUG: 'true',
      }),
      {
        allowNetworkBoundaryChange: true,
        allowEnvironmentChange: true,
        allowSecurityBoundaryChange: true,
        maxChangedFields: 20,
      },
    )).toBe(true);
  });
});
