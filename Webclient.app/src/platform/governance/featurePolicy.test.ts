import { describe, expect, test } from 'vitest';
import { createFeaturePolicy } from './featurePolicy';

describe('FeaturePolicy', () => {
  test('enables an on rule', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'typed-bootstrap', mode: 'on' });
    expect(policy.evaluate('typed-bootstrap')).toMatchObject({
      enabled: true,
      reason: 'enabled',
    });
  });

  test('disables an off rule', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'typed-bootstrap', mode: 'off' });
    expect(policy.evaluate('typed-bootstrap')).toMatchObject({
      enabled: false,
      reason: 'disabled',
    });
  });

  test('kill switch always wins', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'adaptive-runtime',
      mode: 'on',
      killSwitch: true,
    });
    expect(policy.evaluate('adaptive-runtime')).toMatchObject({
      enabled: false,
      reason: 'kill-switch',
    });
  });

  test('targets explicit environments', () => {
    const policy = createFeaturePolicy({ defaultEnvironment: 'production' });
    policy.register({
      id: 'preview-tool',
      mode: 'on',
      environments: ['staging'],
    });
    expect(policy.evaluate('preview-tool')).toMatchObject({
      enabled: false,
      reason: 'environment-not-targeted',
    });
    expect(policy.evaluate('preview-tool', { environment: 'staging' }).enabled)
      .toBe(true);
  });

  test('excludes explicit environments', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'debug-logging',
      mode: 'on',
      excludeEnvironments: ['production'],
    });
    expect(policy.evaluate('debug-logging', { environment: 'production' })).toMatchObject({
      enabled: false,
      reason: 'environment-excluded',
    });
    expect(policy.evaluate('debug-logging', { environment: 'development' }).enabled)
      .toBe(true);
  });

  test('allowlist requires a matching subject', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'beta-layer',
      mode: 'allowlist',
      allowSubjects: ['user-a', 'user-b'],
    });
    expect(policy.evaluate('beta-layer', { subject: 'user-a' }).enabled).toBe(true);
    expect(policy.evaluate('beta-layer', { subject: 'user-c' })).toMatchObject({
      enabled: false,
      reason: 'subject-not-allowed',
    });
  });

  test('allowlist comparison is normalized', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'beta-layer',
      mode: 'allowlist',
      allowSubjects: ['User-A'],
    });
    expect(policy.evaluate('beta-layer', { subject: 'USER-A' }).enabled).toBe(true);
  });

  test('denylist defaults to enabled outside denied subjects', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'new-search',
      mode: 'denylist',
      denySubjects: ['blocked'],
    });
    expect(policy.evaluate('new-search', { subject: 'allowed' }).enabled).toBe(true);
    expect(policy.evaluate('new-search', { subject: 'blocked' })).toMatchObject({
      enabled: false,
      reason: 'subject-denied',
    });
  });

  test('percentage rollout is deterministic for the same context', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'map-renderer-v2',
      mode: 'percentage',
      percentage: 50,
    });
    const first = policy.evaluate('map-renderer-v2', {
      subject: 'stable-subject',
      environment: 'production',
    });
    const second = policy.evaluate('map-renderer-v2', {
      subject: 'stable-subject',
      environment: 'production',
    });
    expect(second).toEqual(first);
    expect(first.bucket).toBeGreaterThanOrEqual(0);
    expect(first.bucket).toBeLessThan(10_000);
  });

  test('zero-percent rollout never enables a subject', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'map-renderer-v2',
      mode: 'percentage',
      percentage: 0,
    });
    expect(policy.evaluate('map-renderer-v2', { subject: 'a' }).enabled).toBe(false);
  });

  test('hundred-percent rollout enables every non-empty subject', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'map-renderer-v2',
      mode: 'percentage',
      percentage: 100,
    });
    expect(policy.evaluate('map-renderer-v2', { subject: 'a' }).enabled).toBe(true);
    expect(policy.evaluate('map-renderer-v2', { subject: 'b' }).enabled).toBe(true);
  });

  test('percentage rollout requires a subject key', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'map-renderer-v2',
      mode: 'percentage',
      percentage: 100,
    });
    expect(policy.evaluate('map-renderer-v2')).toMatchObject({
      enabled: false,
      reason: 'subject-not-allowed',
    });
  });

  test('required dependencies must be enabled', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'endpoint-policy', mode: 'on' });
    policy.register({
      id: 'typed-bootstrap',
      mode: 'on',
      requires: ['endpoint-policy'],
    });
    expect(policy.evaluate('typed-bootstrap').enabled).toBe(true);

    policy.replace({ id: 'endpoint-policy', mode: 'off' });
    expect(policy.evaluate('typed-bootstrap')).toMatchObject({
      enabled: false,
      reason: 'dependency-disabled',
    });
  });

  test('missing dependencies fail closed', () => {
    const policy = createFeaturePolicy();
    policy.register({
      id: 'typed-bootstrap',
      mode: 'on',
      requires: ['missing-policy'],
    });
    expect(policy.evaluate('typed-bootstrap')).toMatchObject({
      enabled: false,
      reason: 'missing-dependency',
    });
  });

  test('disabledWhen blocks when the referenced feature is enabled', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'maintenance-mode', mode: 'on' });
    policy.register({
      id: 'map-edit',
      mode: 'on',
      disabledWhen: ['maintenance-mode'],
    });
    expect(policy.evaluate('map-edit')).toMatchObject({
      enabled: false,
      reason: 'disabled-by-rule',
    });
  });

  test('disabledWhen does not block when the referenced feature is off', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'maintenance-mode', mode: 'off' });
    policy.register({
      id: 'map-edit',
      mode: 'on',
      disabledWhen: ['maintenance-mode'],
    });
    expect(policy.evaluate('map-edit').enabled).toBe(true);
  });

  test('dependency cycles fail closed instead of recursing forever', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'a', mode: 'on', requires: ['b'] });
    policy.register({ id: 'b', mode: 'on', requires: ['a'] });
    const result = policy.evaluate('a');
    expect(result.enabled).toBe(false);
    expect(['cycle', 'dependency-disabled']).toContain(result.reason);
  });

  test('self dependency is rejected during registration', () => {
    const policy = createFeaturePolicy();
    expect(() => policy.register({
      id: 'a',
      mode: 'on',
      requires: ['a'],
    })).toThrow(/cannot reference itself/i);
  });

  test('unknown feature evaluation returns a closed result', () => {
    const policy = createFeaturePolicy();
    expect(policy.evaluate('missing')).toMatchObject({
      enabled: false,
      reason: 'missing-dependency',
    });
  });

  test('register returns an unregister function', () => {
    const policy = createFeaturePolicy();
    const unregister = policy.register({ id: 'flag', mode: 'on' });
    expect(policy.evaluate('flag').enabled).toBe(true);
    unregister();
    expect(policy.evaluate('flag').enabled).toBe(false);
  });

  test('replace creates a previously absent rule', () => {
    const policy = createFeaturePolicy();
    policy.replace({ id: 'flag', mode: 'on' });
    expect(policy.evaluate('flag').enabled).toBe(true);
  });

  test('remove reports whether a rule existed', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'flag', mode: 'on' });
    expect(policy.remove('flag')).toBe(true);
    expect(policy.remove('flag')).toBe(false);
  });

  test('evaluateAll is stable and sorted by id', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'zeta', mode: 'off' });
    policy.register({ id: 'alpha', mode: 'on' });
    expect(policy.evaluateAll().map((item) => item.id)).toEqual(['alpha', 'zeta']);
  });

  test('snapshot counts enabled defaults and kill switches', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'one', mode: 'on' });
    policy.register({ id: 'two', mode: 'off' });
    policy.register({ id: 'three', mode: 'on', killSwitch: true });
    expect(policy.snapshot()).toMatchObject({
      ruleCount: 3,
      enabledByDefault: 1,
      killSwitches: ['three'],
    });
  });

  test('snapshot fingerprint changes when policy changes', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'one', mode: 'on' });
    const first = policy.snapshot().fingerprint;
    policy.replace({ id: 'one', mode: 'off' });
    expect(policy.snapshot().fingerprint).not.toBe(first);
  });

  test('snapshot revision changes on mutations', () => {
    const policy = createFeaturePolicy();
    expect(policy.snapshot().revision).toBe(0);
    policy.register({ id: 'one', mode: 'on' });
    expect(policy.snapshot().revision).toBe(1);
    policy.replace({ id: 'one', mode: 'off' });
    expect(policy.snapshot().revision).toBe(2);
    policy.remove('one');
    expect(policy.snapshot().revision).toBe(3);
  });

  test('enforces rule capacity', () => {
    const policy = createFeaturePolicy({ maxRules: 1 });
    policy.register({ id: 'one', mode: 'on' });
    expect(() => policy.register({ id: 'two', mode: 'on' }))
      .toThrow(/capacity/i);
  });

  test('enforces dependency capacity', () => {
    const policy = createFeaturePolicy({ maxDependencies: 1 });
    expect(() => policy.register({
      id: 'main',
      mode: 'on',
      requires: ['a', 'b'],
    })).toThrow(/capacity/i);
  });

  test('clear removes every rule', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'one', mode: 'on' });
    policy.register({ id: 'two', mode: 'on' });
    policy.clear();
    expect(policy.ids()).toEqual([]);
    expect(policy.snapshot().ruleCount).toBe(0);
  });

  test('dispose rejects subsequent mutations and evaluation', () => {
    const policy = createFeaturePolicy();
    policy.register({ id: 'one', mode: 'on' });
    policy.dispose();
    expect(() => policy.register({ id: 'two', mode: 'on' })).toThrow(/disposed/i);
    expect(() => policy.evaluate('one')).toThrow(/disposed/i);
  });
});
