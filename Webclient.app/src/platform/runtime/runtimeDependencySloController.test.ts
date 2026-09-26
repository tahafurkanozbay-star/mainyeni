import { describe, expect, it } from 'vitest';
import { RuntimeDependencySloController } from './runtimeDependencySloController';

const sample = (dependency: string, observedAt: number, outcome: 'success' | 'failure' | 'timeout' | 'rejected' = 'success', latencyMs = 10) => ({ dependency, observedAt, outcome, latencyMs });

describe('RuntimeDependencySloController', () => {
  it('keeps insufficient evidence healthy', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 3 });
    expect(controller.record(sample('search', 1, 'failure')).state).toBe('healthy');
    expect(controller.record(sample('search', 2, 'failure')).state).toBe('healthy');
  });

  it('degrades on bounded failure ratio', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 4, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.75 });
    controller.record(sample('search', 1));
    controller.record(sample('search', 2));
    controller.record(sample('search', 3));
    expect(controller.record(sample('search', 4, 'failure')).state).toBe('degraded');
  });

  it('exhausts on failure ratio', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 4, exhaustedFailureRatio: 0.5 });
    controller.record(sample('search', 1, 'failure'));
    controller.record(sample('search', 2, 'failure'));
    controller.record(sample('search', 3));
    expect(controller.record(sample('search', 4)).state).toBe('exhausted');
  });

  it('degrades on average latency', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 2, degradedLatencyMs: 100, exhaustedLatencyMs: 500 });
    controller.record(sample('search', 1, 'success', 120));
    expect(controller.record(sample('search', 2, 'success', 120)).state).toBe('degraded');
  });

  it('exhausts on extreme latency evidence', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 2, degradedLatencyMs: 100, exhaustedLatencyMs: 500 });
    controller.record(sample('search', 1, 'success', 10));
    expect(controller.record(sample('search', 2, 'success', 1_100)).state).toBe('exhausted');
  });

  it('requires confirmations before recovery', () => {
    const controller = new RuntimeDependencySloController({ windowSize: 2, minimumSamples: 2, degradedFailureRatio: 0.5, exhaustedFailureRatio: 1, recoveryConfirmations: 2 });
    controller.record(sample('search', 1, 'failure'));
    expect(controller.record(sample('search', 2, 'failure')).state).toBe('exhausted');
    expect(controller.record(sample('search', 3)).state).toBe('exhausted');
    expect(controller.record(sample('search', 4)).state).toBe('healthy');
  });

  it('resets recovery confirmations after unhealthy evidence', () => {
    const controller = new RuntimeDependencySloController({ windowSize: 2, minimumSamples: 2, degradedFailureRatio: 0.5, exhaustedFailureRatio: 1, recoveryConfirmations: 2 });
    controller.record(sample('search', 1, 'failure'));
    controller.record(sample('search', 2, 'failure'));
    controller.record(sample('search', 3));
    const reset = controller.record(sample('search', 4, 'failure'));
    expect(reset.state).not.toBe('healthy');
  });

  it('bounds rolling samples', () => {
    const controller = new RuntimeDependencySloController({ windowSize: 2, minimumSamples: 2 });
    controller.record(sample('search', 1, 'failure'));
    controller.record(sample('search', 2));
    const snapshot = controller.record(sample('search', 3));
    expect(snapshot.sampleCount).toBe(2);
    expect(snapshot.failureCount).toBe(0);
  });

  it('rejects non-monotonic global evidence', () => {
    const controller = new RuntimeDependencySloController();
    controller.record(sample('search', 10));
    expect(() => controller.record(sample('address', 9))).toThrow(/monotonic/);
  });

  it('enforces dependency capacity', () => {
    const controller = new RuntimeDependencySloController({ maximumDependencies: 1 });
    controller.record(sample('search', 1));
    expect(() => controller.record(sample('address', 2))).toThrow(/capacity/);
  });

  it('bounds transition history', () => {
    const controller = new RuntimeDependencySloController({ windowSize: 1, minimumSamples: 1, degradedFailureRatio: 0.5, exhaustedFailureRatio: 1, recoveryConfirmations: 1, maximumHistory: 2 });
    controller.record(sample('search', 1, 'failure'));
    controller.record(sample('search', 2));
    controller.record(sample('search', 3, 'failure'));
    expect(controller.transitions()).toHaveLength(2);
  });

  it('returns defensive snapshots and transition copies', () => {
    const controller = new RuntimeDependencySloController({ minimumSamples: 1, exhaustedFailureRatio: 1 });
    const first = controller.record(sample('search', 1, 'failure'));
    const fetched = controller.get('search');
    expect(fetched).toEqual(first);
    expect(fetched).not.toBe(first);
    const transitions = controller.transitions();
    expect(transitions).toHaveLength(1);
    expect(controller.transitions()).not.toBe(transitions);
  });

  it('sorts snapshots by dependency identity', () => {
    const controller = new RuntimeDependencySloController();
    controller.record(sample('zeta', 1));
    controller.record(sample('alpha', 2));
    expect(controller.snapshots().map((entry) => entry.dependency)).toEqual(['alpha', 'zeta']);
  });

  it('supports removal and full reset', () => {
    const controller = new RuntimeDependencySloController();
    controller.record(sample('search', 10));
    expect(controller.remove('search')).toBe(true);
    expect(controller.get('search')).toBeNull();
    controller.record(sample('search', 11));
    controller.clear();
    expect(controller.snapshots()).toEqual([]);
    expect(controller.transitions()).toEqual([]);
    expect(controller.record(sample('search', 1)).revision).toBe(1);
  });

  it('validates identifiers and numeric evidence', () => {
    const controller = new RuntimeDependencySloController();
    expect(() => controller.record(sample(' ', 1))).toThrow(/blank/);
    expect(() => controller.record(sample('search', 1, 'success', -1))).toThrow(/latencyMs/);
    expect(() => controller.record(sample('search', -1))).toThrow(/observedAt/);
  });

  it('validates policy ordering and bounds', () => {
    expect(() => new RuntimeDependencySloController({ windowSize: 0 })).toThrow(/positive integer/);
    expect(() => new RuntimeDependencySloController({ windowSize: 2, minimumSamples: 3 })).toThrow(/cannot exceed/);
    expect(() => new RuntimeDependencySloController({ degradedFailureRatio: 0.8, exhaustedFailureRatio: 0.5 })).toThrow(/cannot exceed/);
    expect(() => new RuntimeDependencySloController({ degradedLatencyMs: 200, exhaustedLatencyMs: 100 })).toThrow(/cannot exceed/);
    expect(() => new RuntimeDependencySloController({ degradedFailureRatio: 2 })).toThrow(/between 0 and 1/);
  });
});
