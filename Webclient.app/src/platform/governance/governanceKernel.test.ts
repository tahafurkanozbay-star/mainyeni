import { describe, expect, test, vi } from 'vitest';
import {
  createPlatformGovernanceKernel,
  governanceBlockingReasons,
  governanceSnapshotSummary,
} from './governanceKernel';

const configuredKernel = () => {
  let now = 1_000;
  const kernel = createPlatformGovernanceKernel({
    clock: { now: () => now },
    telemetryCapacity: 100,
  });
  kernel.config.register({
    key: 'api-path',
    kind: 'string',
    required: true,
    pattern: /^\/(?!\/)/u,
  });
  kernel.config.register({
    key: 'secret',
    kind: 'string',
    secret: true,
  });
  kernel.features.register({
    id: 'endpoint-policy',
    mode: 'on',
  });
  kernel.features.register({
    id: 'typed-bootstrap',
    mode: 'on',
    requires: ['endpoint-policy'],
  });
  kernel.manifest.register({
    id: 'config',
    version: '1',
    domain: 'platform',
    provides: ['runtime-config'],
  });
  kernel.manifest.register({
    id: 'network',
    version: '1',
    domain: 'platform',
    dependsOn: ['config'],
    consumes: ['runtime-config'],
  });
  kernel.readiness.register({
    id: 'platform.config',
    severity: 'critical',
    required: true,
  });
  kernel.readiness.register({
    id: 'platform.manifest',
    severity: 'critical',
    required: true,
  });
  kernel.readiness.register({
    id: 'network-health',
    severity: 'degraded',
    required: false,
    ttlMs: 1_000,
  });
  return {
    kernel,
    advance: (ms: number) => { now += ms; },
  };
};

describe('PlatformGovernanceKernel', () => {
  test('starts ready when config and manifest are valid', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: {
        'api-path': '/api',
        secret: 'do-not-expose',
      },
      rejectInvalidConfig: true,
    });
    expect(snapshot.state.phase).toBe('ready');
    expect(snapshot.readiness.state).toBe('ready');
    expect(snapshot.config.valid).toBe(true);
    expect(snapshot.manifest.valid).toBe(true);
  });

  test('records deterministic startup revisions', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: { 'api-path': '/api' },
    });
    expect(snapshot.state.configRevision).toBe(1);
    expect(snapshot.state.featureRevision).toBe(2);
    expect(snapshot.state.manifestRevision).toBe(2);
  });

  test('stores startup timestamp through injected clock', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: { 'api-path': '/api' },
    });
    expect(snapshot.state.startedAt).toBe(1_000);
    expect(snapshot.state.lastTransitionAt).toBe(1_000);
  });

  test('start is idempotent while already ready', () => {
    const { kernel } = configuredKernel();
    const first = kernel.start({ configSource: { 'api-path': '/api' } });
    const second = kernel.start({ configSource: { 'api-path': '/ignored' } });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(kernel.config.get('api-path')).toBe('/api');
  });

  test('invalid config can block without throwing when soft validation is requested', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: { 'api-path': 'https://external.invalid' },
      rejectInvalidConfig: false,
    });
    expect(snapshot.state.phase).toBe('blocked');
    expect(snapshot.config.valid).toBe(false);
    expect(snapshot.readiness.blockers).toContain('platform.config');
  });

  test('invalid config throws when hard validation is requested', () => {
    const { kernel } = configuredKernel();
    expect(() => kernel.start({
      configSource: { 'api-path': 'https://external.invalid' },
      rejectInvalidConfig: true,
    })).toThrow(/configuration resolution failed/i);
    expect(kernel.state.get().phase).toBe('blocked');
  });

  test('manifest validation blocks startup', () => {
    const kernel = createPlatformGovernanceKernel();
    kernel.config.register({ key: 'api-path', kind: 'string', required: true });
    kernel.manifest.register({
      id: 'network',
      version: '1',
      domain: 'platform',
      dependsOn: ['missing-config'],
    });
    kernel.readiness.register({
      id: 'platform.config',
      severity: 'critical',
      required: true,
    });
    kernel.readiness.register({
      id: 'platform.manifest',
      severity: 'critical',
      required: true,
    });
    const snapshot = kernel.start({ configSource: { 'api-path': '/api' } });
    expect(snapshot.state.phase).toBe('blocked');
    expect(snapshot.manifest.valid).toBe(false);
    expect(snapshot.readiness.blockers).toContain('platform.manifest');
  });

  test('feature evaluation is composed through the kernel', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(kernel.evaluateFeature('typed-bootstrap')).toMatchObject({
      enabled: true,
      reason: 'enabled',
    });
  });

  test('feature dependencies remain authoritative after start', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    kernel.features.replace({ id: 'endpoint-policy', mode: 'off' });
    expect(kernel.evaluateFeature('typed-bootstrap')).toMatchObject({
      enabled: false,
      reason: 'dependency-disabled',
    });
  });

  test('reconfigure updates config revision and generation', () => {
    const { kernel, advance } = configuredKernel();
    const first = kernel.start({ configSource: { 'api-path': '/api' } });
    advance(10);
    const second = kernel.reconfigure({ 'api-path': '/gateway' });
    expect(second.state.configRevision).toBeGreaterThan(first.state.configRevision);
    expect(second.state.generation).toBeGreaterThan(first.state.generation);
    expect(second.state.lastTransitionAt).toBe(1_010);
    expect(kernel.config.get('api-path')).toBe('/gateway');
  });

  test('reconfigure can block a previously ready kernel', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    const snapshot = kernel.reconfigure({
      'api-path': 'https://external.invalid',
    });
    expect(snapshot.state.phase).toBe('blocked');
    expect(snapshot.readiness.state).toBe('blocked');
  });

  test('reconfigure hard rejection preserves a blocked signal', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(() => kernel.reconfigure(
      { 'api-path': 'https://external.invalid' },
      { rejectInvalidConfig: true },
    )).toThrow();
  });

  test('secret config never appears in kernel snapshot JSON', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: {
        'api-path': '/api',
        secret: 'private-value',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-value');
  });

  test('optional readiness evidence can be recorded without blocking', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    const readiness = kernel.recordReadiness('network-health', 'fail', {
      code: 'OFFLINE',
    });
    expect(readiness.state).toBe('ready');
    expect(kernel.snapshot().state.phase).toBe('ready');
  });

  test('required degraded evidence changes phase to degraded', () => {
    const { kernel } = configuredKernel();
    kernel.readiness.register({
      id: 'cache-health',
      severity: 'degraded',
      required: true,
    });
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(kernel.snapshot().state.phase).toBe('degraded');
    kernel.recordReadiness('cache-health', 'pass');
    expect(kernel.snapshot().state.phase).toBe('ready');
  });

  test('critical readiness failure changes ready phase to blocked', () => {
    const { kernel } = configuredKernel();
    kernel.readiness.register({
      id: 'security-gate',
      severity: 'critical',
      required: true,
    });
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(kernel.snapshot().state.phase).toBe('blocked');
    kernel.recordReadiness('security-gate', 'pass');
    expect(kernel.snapshot().state.phase).toBe('ready');
    kernel.recordReadiness('security-gate', 'fail', { code: 'POLICY_FAILURE' });
    expect(kernel.snapshot().state.phase).toBe('blocked');
  });

  test('readiness TTL can degrade a later support snapshot', () => {
    const { kernel, advance } = configuredKernel();
    kernel.readiness.register({
      id: 'cache-health',
      severity: 'degraded',
      required: true,
      ttlMs: 1_000,
    });
    kernel.recordReadiness('cache-health', 'pass');
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(kernel.snapshot().readiness.state).toBe('ready');
    advance(1_001);
    expect(kernel.snapshot().readiness.state).toBe('degraded');
  });

  test('stop transitions to stopped without deleting support state', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    const snapshot = kernel.stop();
    expect(snapshot.state.phase).toBe('stopped');
    expect(snapshot.config.entries).not.toHaveLength(0);
    expect(snapshot.manifest.components).not.toHaveLength(0);
  });

  test('kernel can restart after stop', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    kernel.stop();
    const restarted = kernel.start({ configSource: { 'api-path': '/gateway' } });
    expect(restarted.state.phase).toBe('ready');
    expect(kernel.config.get('api-path')).toBe('/gateway');
  });

  test('snapshot fingerprint changes after config changes', () => {
    const { kernel } = configuredKernel();
    const first = kernel.start({ configSource: { 'api-path': '/api' } });
    const second = kernel.reconfigure({ 'api-path': '/gateway' });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('snapshot fingerprint is stable across repeated reads', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(kernel.snapshot().fingerprint).toBe(kernel.snapshot().fingerprint);
  });

  test('summary exposes counts without raw secret values', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: {
        'api-path': '/api',
        secret: 'sensitive',
      },
    });
    const summary = governanceSnapshotSummary(snapshot);
    expect(summary).toMatchObject({
      phase: 'ready',
      configValid: true,
      manifestValid: true,
      featureCount: 2,
      componentCount: 2,
    });
    expect(JSON.stringify(summary)).not.toContain('sensitive');
  });

  test('blocking reasons include config issues', () => {
    const { kernel } = configuredKernel();
    const snapshot = kernel.start({
      configSource: { 'api-path': 'bad' },
    });
    expect(governanceBlockingReasons(snapshot).some((value) => value.startsWith('config:api-path:')))
      .toBe(true);
  });

  test('blocking reasons include manifest issues', () => {
    const kernel = createPlatformGovernanceKernel();
    kernel.config.register({ key: 'x', kind: 'string' });
    kernel.manifest.register({
      id: 'consumer',
      version: '1',
      domain: 'platform',
      dependsOn: ['missing'],
    });
    kernel.readiness.register({ id: 'platform.config', severity: 'critical' });
    kernel.readiness.register({ id: 'platform.manifest', severity: 'critical' });
    const snapshot = kernel.start({ configSource: { x: 'ok' } });
    expect(governanceBlockingReasons(snapshot).some((value) => value.includes('missing-dependency')))
      .toBe(true);
  });

  test('telemetry accumulates local governance events', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    kernel.evaluateFeature('typed-bootstrap');
    kernel.recordReadiness('network-health', 'pass');
    expect(kernel.snapshot().telemetryEvents).toBeGreaterThan(0);
  });

  test('telemetry never serializes config source values', () => {
    const { kernel } = configuredKernel();
    kernel.start({
      configSource: {
        'api-path': '/api',
        secret: 'do-not-log',
      },
    });
    expect(JSON.stringify(kernel.telemetry.snapshot())).not.toContain('do-not-log');
  });

  test('state history captures lifecycle transitions', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    kernel.stop();
    expect(kernel.state.history().map((item) => item.state.phase))
      .toEqual(expect.arrayContaining(['idle', 'starting', 'ready', 'stopped']));
  });

  test('readiness listener exceptions can be isolated by kernel option', () => {
    const onListenerError = vi.fn();
    const kernel = createPlatformGovernanceKernel({ onListenerError });
    kernel.readiness.register({ id: 'platform.config', severity: 'critical' });
    kernel.readiness.register({ id: 'platform.manifest', severity: 'critical' });
    kernel.readiness.subscribe(() => { throw new Error('observer'); });
    kernel.start();
    expect(onListenerError).toHaveBeenCalled();
  });

  test('dispose closes every child subsystem', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    kernel.dispose();
    expect(() => kernel.snapshot()).toThrow(/disposed/i);
    expect(() => kernel.evaluateFeature('typed-bootstrap')).toThrow(/disposed/i);
    expect(() => kernel.config.resolve({ 'api-path': '/api' })).toThrow(/disposed/i);
    expect(() => kernel.manifest.snapshot()).toThrow(/disposed/i);
    expect(() => kernel.readiness.snapshot()).toThrow(/disposed/i);
  });

  test('dispose is idempotent', () => {
    const { kernel } = configuredKernel();
    kernel.start({ configSource: { 'api-path': '/api' } });
    expect(() => {
      kernel.dispose();
      kernel.dispose();
    }).not.toThrow();
  });
});
