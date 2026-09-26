import { describe, expect, it } from 'vitest';
import { RuntimeDependencyChangeGuard } from './runtimeDependencyChangeGuard';

const request = (overrides: Partial<Parameters<RuntimeDependencyChangeGuard['evaluate']>[0]> = {}) => ({
  service: 'search', dependency: 'address', changeId: 'change-1', changeUnits: 10,
  dependencyHealthy: true, dependencyStale: false, required: true, evaluatedAt: 1, ...overrides,
});

describe('RuntimeDependencyChangeGuard', () => {
  it('allows a bounded healthy low-risk change', () => {
    const guard = new RuntimeDependencyChangeGuard({ recoveryConfirmations: 1 });
    expect(guard.evaluate(request()).decision).toBe('allow');
    expect(guard.snapshot('search')?.activeChanges).toEqual(['change-1']);
  });

  it('fails closed for stale evidence', () => {
    const guard = new RuntimeDependencyChangeGuard();
    const result = guard.evaluate(request({ dependencyStale: true }));
    expect(result).toMatchObject({ decision: 'block', risk: 'critical' });
    expect(result.reasons).toContain('dependency-evidence-stale');
  });

  it('blocks unhealthy required dependencies', () => {
    const guard = new RuntimeDependencyChangeGuard();
    expect(guard.evaluate(request({ dependencyHealthy: false })).decision).toBe('block');
  });

  it('stages unhealthy optional dependencies', () => {
    const guard = new RuntimeDependencyChangeGuard();
    const result = guard.evaluate(request({ dependencyHealthy: false, required: false }));
    expect(result.decision).toBe('stage');
    expect(result.risk).toBe('elevated');
  });

  it('requires recovery evidence before a high-risk change', () => {
    const guard = new RuntimeDependencyChangeGuard({ recoveryConfirmations: 2 });
    const first = guard.evaluate(request({ changeUnits: 55 }));
    const second = guard.evaluate(request({ changeId: 'change-2', changeUnits: 55, evaluatedAt: 2 }));
    expect(first.reasons).toContain('recovery-confirmation-pending');
    expect(first.decision).toBe('stage');
    expect(second.decision).toBe('allow');
  });

  it('always stages critical healthy changes', () => {
    const guard = new RuntimeDependencyChangeGuard({ recoveryConfirmations: 1 });
    const result = guard.evaluate(request({ changeUnits: 90 }));
    expect(result.decision).toBe('stage');
    expect(result.reasons).toContain('critical-change-requires-staging');
  });

  it('bounds concurrent active changes', () => {
    const guard = new RuntimeDependencyChangeGuard({ maxConcurrentChanges: 1, recoveryConfirmations: 1 });
    expect(guard.evaluate(request()).decision).toBe('allow');
    const blocked = guard.evaluate(request({ changeId: 'change-2', evaluatedAt: 2 }));
    expect(blocked.decision).toBe('block');
    expect(blocked.reasons).toContain('concurrent-change-capacity-exceeded');
    expect(guard.complete('search', 'change-1')).toBe(true);
    expect(guard.evaluate(request({ changeId: 'change-2', evaluatedAt: 3 })).decision).toBe('allow');
  });

  it('does not double-count a repeated active change id', () => {
    const guard = new RuntimeDependencyChangeGuard({ maxConcurrentChanges: 1, recoveryConfirmations: 1 });
    guard.evaluate(request());
    expect(guard.evaluate(request({ evaluatedAt: 2 })).decision).toBe('allow');
    expect(guard.snapshot('search')?.activeChanges).toHaveLength(1);
  });

  it('rejects non-monotonic evidence', () => {
    const guard = new RuntimeDependencyChangeGuard();
    guard.evaluate(request({ evaluatedAt: 10 }));
    expect(() => guard.evaluate(request({ evaluatedAt: 9 }))).toThrow(/monotonic/);
  });

  it('bounds service capacity', () => {
    const guard = new RuntimeDependencyChangeGuard({ maxServices: 1 });
    guard.evaluate(request());
    expect(() => guard.evaluate(request({ service: 'map', evaluatedAt: 2 }))).toThrow(/service capacity/);
  });

  it('bounds dependency capacity per service', () => {
    const guard = new RuntimeDependencyChangeGuard({ maxDependenciesPerService: 1 });
    guard.evaluate(request());
    expect(() => guard.evaluate(request({ dependency: 'places', evaluatedAt: 2 }))).toThrow(/dependency capacity/);
  });

  it('bounds and defensively copies history', () => {
    const guard = new RuntimeDependencyChangeGuard({ maxHistoryEntries: 2, recoveryConfirmations: 1 });
    guard.evaluate(request({ changeId: 'a', evaluatedAt: 1 }));
    guard.evaluate(request({ changeId: 'b', evaluatedAt: 2 }));
    guard.evaluate(request({ changeId: 'c', evaluatedAt: 3 }));
    const history = guard.history();
    expect(history.map((entry) => entry.changeId)).toEqual(['b', 'c']);
    const mutable = [...history];
    mutable.pop();
    expect(guard.history()).toHaveLength(2);
  });

  it('returns deterministic defensive snapshots', () => {
    const guard = new RuntimeDependencyChangeGuard({ recoveryConfirmations: 1 });
    guard.evaluate(request({ dependency: 'zeta', changeId: 'z', evaluatedAt: 1 }));
    guard.evaluate(request({ dependency: 'alpha', changeId: 'a', evaluatedAt: 2 }));
    const snapshot = guard.snapshot('search');
    expect(snapshot?.dependencies).toEqual(['alpha', 'zeta']);
    expect(snapshot?.activeChanges).toEqual(['a', 'z']);
  });

  it('removes service state explicitly', () => {
    const guard = new RuntimeDependencyChangeGuard();
    guard.evaluate(request());
    expect(guard.removeService('search')).toBe(true);
    expect(guard.snapshot('search')).toBeUndefined();
  });

  it('validates policy thresholds and request bounds', () => {
    expect(() => new RuntimeDependencyChangeGuard({ highRiskUnits: 20, elevatedRiskUnits: 30 })).toThrow(/monotonic/);
    const guard = new RuntimeDependencyChangeGuard();
    expect(() => guard.evaluate(request({ changeUnits: 101 }))).toThrow(/capacity/);
    expect(() => guard.evaluate(request({ service: ' ' }))).toThrow(/blank/);
  });
});
