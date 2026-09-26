import { describe, expect, it } from 'vitest';
import type { RuntimeDependencyReadinessDecision } from './runtimeDependencyReadinessCoordinator';
import { RuntimeDependencyFailoverPlanner } from './runtimeDependencyFailoverPlanner';

function readiness(service: string, state: 'ready' | 'degraded' | 'blocked' = 'ready'): RuntimeDependencyReadinessDecision {
  return {
    service,
    state,
    reason: state === 'ready' ? 'healthy' : state === 'degraded' ? 'dependency-degraded' : 'dependency-blocked',
    blockers: [], degradedBy: [], staleDependencies: [], missingDependencies: [], evaluatedAt: 1, revision: 1,
  };
}

const primary = { id: 'primary', priority: 0, state: 'available' as const, capacity: 10, load: 2 };
const fallback = { id: 'fallback', priority: 1, state: 'available' as const, capacity: 8, load: 1 };

function request(overrides: Partial<Parameters<RuntimeDependencyFailoverPlanner['plan']>[0]> = {}) {
  return {
    service: 'search', readiness: readiness('search'), targets: [primary, fallback], requestedUnits: 2, evaluatedAt: 10, ...overrides,
  };
}

describe('RuntimeDependencyFailoverPlanner', () => {
  it('selects the primary target deterministically', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(planner.plan(request())).toMatchObject({ action: 'primary', reason: 'primary-ready', targetId: 'primary', availableUnits: 8 });
  });

  it('selects a fallback when primary is unavailable', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const targets = [{ ...primary, state: 'unavailable' as const }, fallback];
    expect(planner.plan(request({ targets }))).toMatchObject({ action: 'fallback', reason: 'fallback-selected', targetId: 'fallback' });
  });

  it('fails closed when readiness is blocked', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(planner.plan(request({ readiness: readiness('search', 'blocked') }))).toMatchObject({ action: 'block', reason: 'readiness-blocked', targetId: null });
  });

  it('sheds when no target has enough capacity', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const targets = [{ ...primary, load: 9 }, { ...fallback, load: 7 }];
    expect(planner.plan(request({ targets, requestedUnits: 2 }))).toMatchObject({ action: 'shed', reason: 'capacity-exhausted', targetId: null, availableUnits: 1 });
  });

  it('distinguishes no eligible target from exhausted capacity', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const targets = [{ ...primary, state: 'unavailable' as const }, { ...fallback, state: 'unavailable' as const }];
    expect(planner.plan(request({ targets }))).toMatchObject({ action: 'shed', reason: 'no-eligible-target', availableUnits: 0 });
  });

  it('reports degraded primary decisions', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(planner.plan(request({ readiness: readiness('search', 'degraded') }))).toMatchObject({ action: 'primary', reason: 'primary-degraded' });
  });

  it('reports degraded fallback decisions', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const targets = [{ ...primary, state: 'unavailable' as const }, { ...fallback, state: 'degraded' as const }];
    expect(planner.plan(request({ targets }))).toMatchObject({ action: 'fallback', reason: 'fallback-degraded' });
  });

  it('uses priority then id as deterministic ordering', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const targets = [
      { id: 'zeta', priority: 1, state: 'available' as const, capacity: 5, load: 0 },
      { id: 'alpha', priority: 1, state: 'available' as const, capacity: 5, load: 0 },
    ];
    expect(planner.plan(request({ targets }))).toMatchObject({ targetId: 'alpha' });
  });

  it('requires recovery confirmations before returning from fallback to primary', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ recoveryConfirmations: 2 });
    const failed = [{ ...primary, state: 'unavailable' as const }, fallback];
    expect(planner.plan(request({ targets: failed, evaluatedAt: 10 })).targetId).toBe('fallback');
    expect(planner.plan(request({ evaluatedAt: 11 })).targetId).toBe('fallback');
    expect(planner.plan(request({ evaluatedAt: 12 })).targetId).toBe('primary');
  });

  it('immediately fails over when the selected target becomes unavailable', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ recoveryConfirmations: 3 });
    expect(planner.plan(request({ evaluatedAt: 10 })).targetId).toBe('primary');
    const failed = [{ ...primary, state: 'unavailable' as const }, fallback];
    expect(planner.plan(request({ targets: failed, evaluatedAt: 11 })).targetId).toBe('fallback');
  });

  it('rejects duplicate target identities', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(() => planner.plan(request({ targets: [primary, { ...fallback, id: 'primary' }] }))).toThrow(/duplicate failover target/);
  });

  it('rejects target overload evidence', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(() => planner.plan(request({ targets: [{ ...primary, load: 11 }] }))).toThrow(/load exceeds capacity/);
  });

  it('rejects non-monotonic evaluation time', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    planner.plan(request({ evaluatedAt: 10 }));
    expect(() => planner.plan(request({ evaluatedAt: 9 }))).toThrow(/monotonic/);
  });

  it('rejects readiness evidence for a different service', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(() => planner.plan(request({ readiness: readiness('other') }))).toThrow(/does not match/);
  });

  it('enforces target capacity', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ maximumTargetsPerService: 1 });
    expect(() => planner.plan(request())).toThrow(/maximum failover targets/);
  });

  it('enforces bounded service capacity', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ maximumServices: 1 });
    planner.plan(request({ service: 'one', readiness: readiness('one'), evaluatedAt: 10 }));
    expect(() => planner.plan(request({ service: 'two', readiness: readiness('two'), evaluatedAt: 11 }))).toThrow(/maximum failover service capacity/);
  });

  it('bounds transition history', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ maximumHistory: 2, recoveryConfirmations: 1 });
    planner.plan(request({ evaluatedAt: 10 }));
    const failed = [{ ...primary, state: 'unavailable' as const }, fallback];
    planner.plan(request({ targets: failed, evaluatedAt: 11 }));
    planner.plan(request({ evaluatedAt: 12 }));
    expect(planner.transitions()).toHaveLength(2);
    expect(planner.transitions().map((event) => event.toTargetId)).toEqual(['fallback', 'primary']);
  });

  it('returns defensive decision copies', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    const first = planner.plan(request());
    const second = planner.get('search');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('returns sorted service decisions', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    planner.plan(request({ service: 'zeta', readiness: readiness('zeta'), evaluatedAt: 10 }));
    planner.plan(request({ service: 'alpha', readiness: readiness('alpha'), evaluatedAt: 11 }));
    expect(planner.decisions().map((decision) => decision.service)).toEqual(['alpha', 'zeta']);
  });

  it('supports removal and clean reset', () => {
    const planner = new RuntimeDependencyFailoverPlanner();
    planner.plan(request());
    expect(planner.remove('search')).toBe(true);
    expect(planner.get('search')).toBeNull();
    planner.plan(request({ evaluatedAt: 20 }));
    planner.clear();
    expect(planner.decisions()).toEqual([]);
    expect(planner.transitions()).toEqual([]);
    expect(planner.plan(request({ evaluatedAt: 1 })).revision).toBe(1);
  });

  it('rejects invalid policies and requests', () => {
    expect(() => new RuntimeDependencyFailoverPlanner({ maximumServices: 0 })).toThrow(/positive integer/);
    const planner = new RuntimeDependencyFailoverPlanner();
    expect(() => planner.plan(request({ requestedUnits: 0 }))).toThrow(/positive integer/);
    expect(() => planner.plan(request({ service: '   ' }))).toThrow(/must not be empty/);
  });

  it('does not select degraded capacity below the healthy floor', () => {
    const planner = new RuntimeDependencyFailoverPlanner({ minimumHealthyCapacity: 3 });
    const targets = [{ id: 'primary', priority: 0, state: 'degraded' as const, capacity: 5, load: 3 }];
    expect(planner.plan(request({ targets, requestedUnits: 1 }))).toMatchObject({ action: 'shed', reason: 'capacity-exhausted', availableUnits: 2 });
  });
});
