import { describe, expect, it } from 'vitest';
import { RuntimeDependencyHealthRegistry } from './runtimeDependencyHealthRegistry';

const policy = {
  windowSize: 4,
  minimumSamples: 2,
  degradedFailureRatio: 0.25,
  unavailableFailureRatio: 0.75,
  recoverySuccesses: 2,
  staleAfterMs: 100,
  maximumDependencies: 2,
  maximumHistory: 3,
} as const;

describe('RuntimeDependencyHealthRegistry', () => {
  it('starts healthy and degrades from bounded failure ratio evidence', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'search', outcome: 'success', observedAt: 1, latencyMs: 10 });
    const snapshot = registry.observe({ dependency: 'search', outcome: 'failure', observedAt: 2, latencyMs: 20 });
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.sampleCount).toBe(2);
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.failureRatio).toBe(0.5);
    expect(snapshot.averageLatencyMs).toBe(15);
  });

  it('marks a dependency unavailable at the configured failure ratio', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'gis', outcome: 'failure', observedAt: 1 });
    const snapshot = registry.observe({ dependency: 'gis', outcome: 'timeout', observedAt: 2 });
    expect(snapshot.state).toBe('unavailable');
    expect(registry.transitions()).toMatchObject([{ dependency: 'gis', from: 'healthy', to: 'unavailable', reason: 'failure-ratio' }]);
  });

  it('requires consecutive recovery evidence before returning healthy', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 1 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 2 });
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 3 });
    expect(registry.snapshot('api', 3)?.state).toBe('unavailable');
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 4 });
    expect(registry.snapshot('api', 4)?.state).toBe('degraded');
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 5 });
    expect(registry.snapshot('api', 5)?.state).toBe('healthy');
  });

  it('bounds the observation window', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    for (let index = 1; index <= 8; index += 1) {
      registry.observe({ dependency: 'api', outcome: 'success', observedAt: index });
    }
    expect(registry.observations('api')).toHaveLength(4);
    expect(registry.observations('api').map((entry) => entry.observedAt)).toEqual([5, 6, 7, 8]);
  });

  it('fails closed when dependency capacity is exhausted', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'one', outcome: 'success', observedAt: 1 });
    registry.observe({ dependency: 'two', outcome: 'success', observedAt: 1 });
    expect(() => registry.observe({ dependency: 'three', outcome: 'success', observedAt: 1 })).toThrow(/capacity/);
  });

  it('allows capacity to be reclaimed by explicit removal', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'one', outcome: 'success', observedAt: 1 });
    registry.observe({ dependency: 'two', outcome: 'success', observedAt: 1 });
    expect(registry.remove('one')).toBe(true);
    expect(registry.observe({ dependency: 'three', outcome: 'success', observedAt: 2 }).dependency).toBe('three');
  });

  it('rejects non-monotonic observations per dependency', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 10 });
    expect(() => registry.observe({ dependency: 'api', outcome: 'success', observedAt: 9 })).toThrow(/monotonic/);
  });

  it('allows independent dependency clocks', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'a', outcome: 'success', observedAt: 100 });
    expect(() => registry.observe({ dependency: 'b', outcome: 'success', observedAt: 1 })).not.toThrow();
  });

  it('marks stale dependencies unavailable during reads', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 });
    expect(registry.snapshot('api', 102)?.state).toBe('unavailable');
    expect(registry.snapshot('api', 102)?.stale).toBe(true);
    expect(registry.transitions().at(-1)?.reason).toBe('stale');
  });

  it('does not duplicate stale transitions on repeated reads', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 });
    registry.snapshot('api', 102);
    registry.snapshot('api', 200);
    expect(registry.transitions().filter((entry) => entry.reason === 'stale')).toHaveLength(1);
  });

  it('sorts aggregate snapshots by dependency name', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'zeta', outcome: 'success', observedAt: 1 });
    registry.observe({ dependency: 'alpha', outcome: 'success', observedAt: 1 });
    expect(registry.snapshots(1).map((entry) => entry.dependency)).toEqual(['alpha', 'zeta']);
  });

  it('bounds transition history', () => {
    const registry = new RuntimeDependencyHealthRegistry({ ...policy, minimumSamples: 1, degradedFailureRatio: 0.2, unavailableFailureRatio: 0.5, recoverySuccesses: 1 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 1 });
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 2 });
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 3 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 4 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 5 });
    expect(registry.transitions().length).toBeLessThanOrEqual(3);
  });

  it('returns defensive copies of observation history', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1, latencyMs: 2 });
    const observations = registry.observations('api');
    expect(observations).toEqual([{ dependency: 'api', outcome: 'success', observedAt: 1, latencyMs: 2 }]);
    expect(Object.is(observations[0], registry.observations('api')[0])).toBe(false);
  });

  it('resets health evidence without removing dependency ownership', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 1 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 2 });
    expect(registry.reset('api', 3)).toBe(true);
    const snapshot = registry.snapshot('api', 3);
    expect(snapshot).toMatchObject({ state: 'healthy', sampleCount: 0, failureCount: 0, lastObservedAt: null });
  });

  it('returns false when resetting an unknown dependency', () => {
    expect(new RuntimeDependencyHealthRegistry(policy).reset('missing', 1)).toBe(false);
  });

  it('clears all bounded state', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 1 });
    registry.observe({ dependency: 'api', outcome: 'failure', observedAt: 2 });
    registry.clear();
    expect(registry.snapshots(2)).toEqual([]);
    expect(registry.transitions()).toEqual([]);
  });

  it.each([
    [{ windowSize: 0 }, 'windowSize'],
    [{ minimumSamples: 0 }, 'minimumSamples'],
    [{ recoverySuccesses: 0 }, 'recoverySuccesses'],
    [{ staleAfterMs: 0 }, 'staleAfterMs'],
    [{ maximumDependencies: 0 }, 'maximumDependencies'],
    [{ maximumHistory: 0 }, 'maximumHistory'],
  ])('rejects invalid positive integer policy %o', (override, expected) => {
    expect(() => new RuntimeDependencyHealthRegistry({ ...policy, ...override })).toThrow(expected);
  });

  it('rejects a minimum sample count larger than the window', () => {
    expect(() => new RuntimeDependencyHealthRegistry({ ...policy, windowSize: 2, minimumSamples: 3 })).toThrow(/minimumSamples/);
  });

  it('rejects inverted failure thresholds', () => {
    expect(() => new RuntimeDependencyHealthRegistry({ ...policy, degradedFailureRatio: 0.8, unavailableFailureRatio: 0.5 })).toThrow(/degradedFailureRatio/);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid degraded ratios: %s', (value) => {
    expect(() => new RuntimeDependencyHealthRegistry({ ...policy, degradedFailureRatio: value })).toThrow(/degradedFailureRatio/);
  });

  it('normalizes dependency whitespace', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(registry.observe({ dependency: ' api ', outcome: 'success', observedAt: 1 }).dependency).toBe('api');
  });

  it.each(['', '   '])('rejects empty dependency identity %j', (dependency) => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(() => registry.observe({ dependency, outcome: 'success', observedAt: 1 })).toThrow(/empty/);
  });

  it('rejects excessively long dependency identity', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(() => registry.observe({ dependency: 'x'.repeat(161), outcome: 'success', observedAt: 1 })).toThrow(/160/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid observation time %s', (observedAt) => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(() => registry.observe({ dependency: 'api', outcome: 'success', observedAt })).toThrow(/observedAt/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid latency %s', (latencyMs) => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(() => registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1, latencyMs })).toThrow(/latencyMs/);
  });

  it('tracks rejected observations as failures', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 });
    expect(registry.observe({ dependency: 'api', outcome: 'rejected', observedAt: 2 }).failureCount).toBe(1);
  });

  it('tracks timeout observations as failures', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 });
    expect(registry.observe({ dependency: 'api', outcome: 'timeout', observedAt: 2 }).failureCount).toBe(1);
  });

  it('reports null average latency without latency evidence', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    expect(registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 }).averageLatencyMs).toBeNull();
  });

  it('preserves exact stale boundary as non-stale', () => {
    const registry = new RuntimeDependencyHealthRegistry(policy);
    registry.observe({ dependency: 'api', outcome: 'success', observedAt: 1 });
    expect(registry.snapshot('api', 101)?.stale).toBe(false);
  });
});
