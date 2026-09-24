import { describe, expect, it } from 'vitest';
import { RuntimeLoadWindow, type RuntimeLoadWindowPolicy } from './runtimeLoadWindow';

const policy: RuntimeLoadWindowPolicy = {
  sampleLimit: 4,
  minimumSamples: 2,
  pressureFailureRatio: 0.25,
  criticalFailureRatio: 0.5,
  pressureRejectionRatio: 0.25,
  criticalRejectionRatio: 0.5,
  recoverySuccesses: 2,
};

const sample = (outcome: 'success' | 'failure' | 'cancelled' | 'rejected', observedAt: number, lane: 'interactive' | 'background' | 'maintenance' = 'interactive') => ({
  lane, outcome, observedAt, durationMs: 10,
});

describe('RuntimeLoadWindow', () => {
  it('stays idle until evidence is mature and then reports healthy', () => {
    const window = new RuntimeLoadWindow(policy);
    expect(window.record(sample('success', 1)).state).toBe('idle');
    const snapshot = window.record(sample('success', 2));
    expect(snapshot.state).toBe('healthy');
    expect(snapshot.lanes.interactive.successes).toBe(2);
  });

  it('classifies failure and rejection pressure independently', () => {
    const failures = new RuntimeLoadWindow(policy);
    failures.record(sample('failure', 1));
    expect(failures.record(sample('success', 2)).state).toBe('critical');

    const rejections = new RuntimeLoadWindow(policy);
    rejections.record(sample('rejected', 1));
    expect(rejections.record(sample('success', 2)).state).toBe('critical');
  });

  it('requires a stable success run before recovering from critical state', () => {
    const window = new RuntimeLoadWindow(policy);
    window.record(sample('failure', 1));
    window.record(sample('failure', 2));
    window.record(sample('success', 3));
    expect(window.snapshot().state).toBe('critical');
    window.record(sample('success', 4));
    expect(window.snapshot().state).toBe('critical');
    window.record(sample('success', 5));
    expect(window.snapshot().state).toBe('pressured');
  });

  it('keeps each lane bounded and aggregates the worst lane', () => {
    const window = new RuntimeLoadWindow(policy);
    for (let index = 1; index <= 8; index += 1) window.record(sample('success', index, 'background'));
    window.record(sample('rejected', 9, 'interactive'));
    const snapshot = window.record(sample('rejected', 10, 'interactive'));
    expect(snapshot.lanes.background.samples).toBe(4);
    expect(snapshot.lanes.interactive.state).toBe('critical');
    expect(snapshot.state).toBe('critical');
    expect(snapshot.totalSamples).toBe(6);
  });

  it('tracks duration evidence without allowing cancellation to count as failure', () => {
    const window = new RuntimeLoadWindow(policy);
    window.record({ ...sample('cancelled', 1), durationMs: 20 });
    const snapshot = window.record({ ...sample('success', 2), durationMs: 40 });
    expect(snapshot.lanes.interactive.cancelled).toBe(1);
    expect(snapshot.lanes.interactive.failureRatio).toBe(0);
    expect(snapshot.lanes.interactive.averageDurationMs).toBe(30);
    expect(snapshot.lanes.interactive.maximumDurationMs).toBe(40);
  });

  it('rejects non-monotonic caller time and hostile sample values', () => {
    const window = new RuntimeLoadWindow(policy);
    window.record(sample('success', 5));
    expect(() => window.record(sample('success', 4))).toThrow(/monotonic/);
    expect(() => window.record({ ...sample('success', 6), durationMs: Number.POSITIVE_INFINITY })).toThrow(/durationMs/);
    expect(() => window.record({ ...sample('success', 6), lane: 'unknown' as 'interactive' })).toThrow(/unsupported runtime lane/);
  });

  it('validates policy ordering and bounds', () => {
    expect(() => new RuntimeLoadWindow({ ...policy, sampleLimit: 0 })).toThrow(/sampleLimit/);
    expect(() => new RuntimeLoadWindow({ ...policy, minimumSamples: 5 })).toThrow(/minimumSamples/);
    expect(() => new RuntimeLoadWindow({ ...policy, criticalFailureRatio: 0.1 })).toThrow(/criticalFailureRatio/);
    expect(() => new RuntimeLoadWindow({ ...policy, criticalRejectionRatio: 0.1 })).toThrow(/criticalRejectionRatio/);
  });

  it('supports scoped and global reset', () => {
    const window = new RuntimeLoadWindow(policy);
    window.record(sample('success', 1, 'interactive'));
    window.record(sample('success', 2, 'background'));
    window.reset('interactive');
    expect(window.snapshot().lanes.interactive.samples).toBe(0);
    expect(window.snapshot().lanes.background.samples).toBe(1);
    window.reset();
    expect(window.snapshot().totalSamples).toBe(0);
    expect(window.snapshot().lastObservedAt).toBeNull();
  });

  it('returns immutable snapshots and policy', () => {
    const window = new RuntimeLoadWindow(policy);
    const snapshot = window.record(sample('success', 1));
    expect(Object.isFrozen(window.policy)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.interactive)).toBe(true);
  });
});
