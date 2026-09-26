import { describe, expect, it } from 'vitest';
import { RuntimeDependencyReadinessCoordinator } from './runtimeDependencyReadinessCoordinator';
import type { RuntimeDependencyHealthSnapshot } from './runtimeDependencyHealthRegistry';
import type { RuntimeDependencyImpactSnapshot } from './runtimeDependencyTopology';

function topology(overrides: Partial<RuntimeDependencyImpactSnapshot> = {}): RuntimeDependencyImpactSnapshot {
  return {
    node: 'search',
    ownAvailability: 'healthy',
    effectiveImpact: 'none',
    blockedBy: [],
    degradedBy: [],
    revision: 1,
    ...overrides,
  };
}

function health(dependency: string, overrides: Partial<RuntimeDependencyHealthSnapshot> = {}): RuntimeDependencyHealthSnapshot {
  return {
    dependency,
    state: 'healthy',
    sampleCount: 4,
    failureCount: 0,
    consecutiveSuccesses: 4,
    failureRatio: 0,
    averageLatencyMs: 10,
    lastObservedAt: 100,
    stale: false,
    revision: 1,
    ...overrides,
  };
}

describe('RuntimeDependencyReadinessCoordinator', () => {
  it('reports ready when topology has no impacted dependencies', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    expect(coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 })).toMatchObject({
      state: 'ready',
      reason: 'healthy',
      blockers: [],
      degradedBy: [],
    });
  });

  it('fails closed when topology evidence has no corresponding health evidence', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'blocked', blockedBy: ['address-api'] }),
      health: [],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('blocked');
    expect(decision.reason).toBe('missing-health-evidence');
    expect(decision.missingDependencies).toEqual(['address-api']);
    expect(decision.blockers).toEqual(['address-api']);
  });

  it('blocks stale evidence even when the dependency snapshot still says healthy', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ maximumEvidenceAgeMs: 20 });
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { lastObservedAt: 70 })],
      evaluatedAt: 100,
    });
    expect(decision).toMatchObject({ state: 'blocked', reason: 'dependency-stale' });
    expect(decision.staleDependencies).toEqual(['catalog']);
  });

  it('honors an explicit stale marker independent of evidence age', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { stale: true })],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('blocked');
    expect(decision.staleDependencies).toEqual(['catalog']);
  });

  it('requires a minimum sample count before trusting dependency health', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ minimumHealthSamples: 3 });
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { sampleCount: 2 })],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('blocked');
    expect(decision.reason).toBe('insufficient-health-evidence');
  });

  it('propagates unavailable health as a blocking readiness decision', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { state: 'unavailable' })],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('blocked');
    expect(decision.blockers).toEqual(['catalog']);
  });

  it('keeps degraded health degraded when topology impact is degraded', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { state: 'degraded' })],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('degraded');
    expect(decision.reason).toBe('dependency-degraded');
    expect(decision.degradedBy).toEqual(['catalog']);
  });

  it('preserves topology blocking even when supplied health is healthy', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] }),
      health: [health('catalog')],
      evaluatedAt: 100,
    });
    expect(decision.state).toBe('blocked');
    expect(decision.reason).toBe('dependency-blocked');
  });

  it('requires repeated recovery evidence before unblocking', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ recoveryConfirmations: 2 });
    coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] }),
      health: [health('catalog', { state: 'unavailable' })],
      evaluatedAt: 100,
    });
    const firstRecovery = coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 101 });
    expect(firstRecovery.state).toBe('blocked');
    const secondRecovery = coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 102 });
    expect(secondRecovery.state).toBe('ready');
    expect(coordinator.transitions()).toEqual([
      expect.objectContaining({ service: 'search', from: 'blocked', to: 'ready', reason: 'healthy' }),
    ]);
  });

  it('resets recovery confirmation when the candidate state worsens again', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ recoveryConfirmations: 2 });
    const blockedTopology = topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] });
    coordinator.evaluate({ service: 'search', topology: blockedTopology, health: [health('catalog', { state: 'unavailable' })], evaluatedAt: 100 });
    expect(coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 101 }).state).toBe('blocked');
    coordinator.evaluate({ service: 'search', topology: blockedTopology, health: [health('catalog', { state: 'unavailable', lastObservedAt: 102 })], evaluatedAt: 102 });
    expect(coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 103 }).state).toBe('blocked');
  });

  it('does not apply recovery hysteresis to worsening decisions', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ recoveryConfirmations: 4 });
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    const blocked = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] }),
      health: [health('catalog', { state: 'unavailable', lastObservedAt: 101 })],
      evaluatedAt: 101,
    });
    expect(blocked.state).toBe('blocked');
  });

  it('rejects duplicate health evidence to avoid ambiguous authority', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    expect(() => coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog'), health('catalog')],
      evaluatedAt: 100,
    })).toThrow(/duplicate health evidence/);
  });

  it('rejects future health evidence', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    expect(() => coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }),
      health: [health('catalog', { lastObservedAt: 101 })],
      evaluatedAt: 100,
    })).toThrow(/from the future/);
  });

  it('requires topology identity to match the evaluated service', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    expect(() => coordinator.evaluate({ service: 'search', topology: topology({ node: 'map' }), health: [], evaluatedAt: 100 })).toThrow(/does not match/);
  });

  it('requires globally monotonic evaluation time', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    expect(() => coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 99 })).toThrow(/monotonic/);
  });

  it('allows equal timestamps for an atomic evaluation batch', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    const second = coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    expect(second.state).toBe('ready');
  });

  it('enforces bounded service capacity', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ maximumServices: 1 });
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    expect(() => coordinator.evaluate({ service: 'map', topology: topology({ node: 'map' }), health: [], evaluatedAt: 101 })).toThrow(/capacity/);
  });

  it('bounds transition history', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ maximumHistory: 2, recoveryConfirmations: 1 });
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    coordinator.evaluate({ service: 'search', topology: topology({ effectiveImpact: 'degraded', degradedBy: ['catalog'] }), health: [health('catalog', { state: 'degraded', lastObservedAt: 101 })], evaluatedAt: 101 });
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 102 });
    coordinator.evaluate({ service: 'search', topology: topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] }), health: [health('catalog', { state: 'unavailable', lastObservedAt: 103 })], evaluatedAt: 103 });
    expect(coordinator.transitions()).toHaveLength(2);
  });

  it('returns defensive decision copies', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    const blockers = decision.blockers as string[];
    blockers.push('mutated');
    expect(coordinator.get('search')?.blockers).toEqual([]);
  });

  it('returns decisions in deterministic service order', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    coordinator.evaluate({ service: 'zeta', topology: topology({ node: 'zeta' }), health: [], evaluatedAt: 100 });
    coordinator.evaluate({ service: 'alpha', topology: topology({ node: 'alpha' }), health: [], evaluatedAt: 100 });
    expect(coordinator.decisions().map((decision) => decision.service)).toEqual(['alpha', 'zeta']);
  });

  it('removes a service without affecting others', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    coordinator.evaluate({ service: 'map', topology: topology({ node: 'map' }), health: [], evaluatedAt: 100 });
    expect(coordinator.remove('search')).toBe(true);
    expect(coordinator.get('search')).toBeNull();
    expect(coordinator.get('map')?.state).toBe('ready');
  });

  it('clear resets services and history', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator({ recoveryConfirmations: 1 });
    coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 100 });
    coordinator.evaluate({ service: 'search', topology: topology({ effectiveImpact: 'blocked', blockedBy: ['catalog'] }), health: [health('catalog', { state: 'unavailable', lastObservedAt: 101 })], evaluatedAt: 101 });
    coordinator.clear();
    expect(coordinator.decisions()).toEqual([]);
    expect(coordinator.transitions()).toEqual([]);
    expect(coordinator.evaluate({ service: 'search', topology: topology(), health: [], evaluatedAt: 1 }).state).toBe('ready');
  });

  it.each([
    ['maximumServices', 0],
    ['maximumEvidenceAgeMs', 0],
    ['minimumHealthSamples', 0],
    ['recoveryConfirmations', 0],
    ['maximumHistory', 0],
  ] as const)('rejects invalid %s policy', (key, value) => {
    expect(() => new RuntimeDependencyReadinessCoordinator({ [key]: value })).toThrow(RangeError);
  });

  it('normalizes service identity and rejects empty values', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({ service: ' search ', topology: topology(), health: [], evaluatedAt: 100 });
    expect(decision.service).toBe('search');
    expect(() => coordinator.get('   ')).toThrow(TypeError);
  });

  it('sorts and deduplicates dependency evidence in decisions', () => {
    const coordinator = new RuntimeDependencyReadinessCoordinator();
    const decision = coordinator.evaluate({
      service: 'search',
      topology: topology({ effectiveImpact: 'blocked', blockedBy: ['zeta', 'alpha', 'zeta'], degradedBy: ['beta', 'alpha'] }),
      health: [health('alpha'), health('beta'), health('zeta')],
      evaluatedAt: 100,
    });
    expect(decision.blockers).toEqual(['alpha', 'zeta']);
    expect(decision.degradedBy).toEqual(['alpha', 'beta']);
  });
});
