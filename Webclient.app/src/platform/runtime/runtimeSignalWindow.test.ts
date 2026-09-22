import { describe, expect, it } from 'vitest';
import { RuntimeSignalWindow } from './runtimeSignalWindow';

describe('RuntimeSignalWindow', () => {
  it('starts with an immutable empty snapshot', () => {
    const window = new RuntimeSignalWindow();
    const snapshot = window.snapshot();
    expect(snapshot).toMatchObject({ count: 0, successRate: 1, errorRate: 0, oldestTimestampMs: null, newestTimestampMs: null });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
  });

  it('rejects unsafe configuration bounds', () => {
    expect(() => new RuntimeSignalWindow({ capacity: 0 })).toThrow(RangeError);
    expect(() => new RuntimeSignalWindow({ capacity: 4_097 })).toThrow(RangeError);
    expect(() => new RuntimeSignalWindow({ maxAgeMs: 0 })).toThrow(RangeError);
    expect(() => new RuntimeSignalWindow({ maxAgeMs: 86_400_001 })).toThrow(RangeError);
    expect(() => new RuntimeSignalWindow({ maxLatencyMs: 600_001 })).toThrow(RangeError);
    expect(() => new RuntimeSignalWindow({ maxWeight: 10_001 })).toThrow(RangeError);
  });

  it('records lane-specific and aggregate outcomes', () => {
    const window = new RuntimeSignalWindow();
    expect(window.record({ lane: 'critical', latencyMs: 20, success: true, timestampMs: 1 })).toBe(true);
    expect(window.record({ lane: 'interactive', latencyMs: 40, success: false, timestampMs: 2 })).toBe(true);
    expect(window.record({ lane: 'background', latencyMs: 60, success: true, timestampMs: 3 })).toBe(true);
    expect(window.snapshot()).toMatchObject({ count: 3, successes: 2, failures: 1, meanLatencyMs: 40, p50LatencyMs: 40, p95LatencyMs: 60 });
    expect(window.snapshot().lanes.critical).toMatchObject({ count: 1, successes: 1, failures: 0 });
    expect(window.snapshot().lanes.interactive).toMatchObject({ count: 1, successes: 0, failures: 1 });
  });

  it('uses bounded weights for rate and mean calculations', () => {
    const window = new RuntimeSignalWindow({ maxWeight: 10 });
    window.record({ lane: 'critical', latencyMs: 10, success: true, timestampMs: 1, weight: 3 });
    window.record({ lane: 'critical', latencyMs: 50, success: false, timestampMs: 2, weight: 1 });
    expect(window.snapshot()).toMatchObject({ weightedCount: 4, successRate: 0.75, errorRate: 0.25, meanLatencyMs: 20 });
  });

  it('caps hostile latency values without rejecting a valid sample', () => {
    const window = new RuntimeSignalWindow({ maxLatencyMs: 100 });
    expect(window.record({ lane: 'background', latencyMs: 1_000_000, success: false, timestampMs: 1 })).toBe(true);
    expect(window.snapshot()).toMatchObject({ meanLatencyMs: 100, maxLatencyMs: 100, p95LatencyMs: 100 });
  });

  it('rejects malformed samples without mutating the active window', () => {
    const window = new RuntimeSignalWindow();
    expect(window.record({ lane: 'critical', latencyMs: -1, success: true, timestampMs: 1 })).toBe(false);
    expect(window.record({ lane: 'critical', latencyMs: Number.NaN, success: true, timestampMs: 1 })).toBe(false);
    expect(window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: -1 })).toBe(false);
    expect(window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 1, weight: 0 })).toBe(false);
    expect(window.snapshot()).toMatchObject({ count: 0, rejected: 4 });
  });

  it('fails closed on clock regression', () => {
    const window = new RuntimeSignalWindow();
    window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 10 });
    expect(window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 9 })).toBe(false);
    expect(window.snapshot()).toMatchObject({ count: 1, rejected: 1, newestTimestampMs: 10 });
  });

  it('evicts oldest samples when capacity is reached', () => {
    const window = new RuntimeSignalWindow({ capacity: 2 });
    window.record({ lane: 'critical', latencyMs: 10, success: true, timestampMs: 1 });
    window.record({ lane: 'interactive', latencyMs: 20, success: true, timestampMs: 2 });
    window.record({ lane: 'background', latencyMs: 30, success: false, timestampMs: 3 });
    expect(window.snapshot()).toMatchObject({ count: 2, evictedByCapacity: 1, oldestTimestampMs: 2, newestTimestampMs: 3 });
  });

  it('evicts expired samples using an explicit caller clock', () => {
    const window = new RuntimeSignalWindow({ maxAgeMs: 10 });
    window.record({ lane: 'critical', latencyMs: 10, success: true, timestampMs: 1 });
    window.record({ lane: 'critical', latencyMs: 20, success: true, timestampMs: 5 });
    expect(window.evictExpired(12)).toBe(1);
    expect(window.snapshot()).toMatchObject({ count: 1, evictedByAge: 1, oldestTimestampMs: 5 });
  });

  it('keeps samples exactly on the age boundary', () => {
    const window = new RuntimeSignalWindow({ maxAgeMs: 10 });
    window.record({ lane: 'critical', latencyMs: 10, success: true, timestampMs: 1 });
    expect(window.evictExpired(11)).toBe(0);
    expect(window.snapshot().count).toBe(1);
  });

  it('rejects backwards explicit eviction clocks', () => {
    const window = new RuntimeSignalWindow();
    window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 10 });
    expect(() => window.evictExpired(9)).toThrow(RangeError);
  });

  it('calculates nearest-rank percentiles deterministically', () => {
    const window = new RuntimeSignalWindow();
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach((latencyMs, index) => {
      window.record({ lane: 'interactive', latencyMs, success: true, timestampMs: index + 1 });
    });
    expect(window.snapshot()).toMatchObject({ p50LatencyMs: 50, p95LatencyMs: 100, maxLatencyMs: 100 });
  });

  it('clear releases samples but preserves lifetime diagnostics', () => {
    const window = new RuntimeSignalWindow({ capacity: 1 });
    window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 1 });
    window.record({ lane: 'critical', latencyMs: 2, success: true, timestampMs: 2 });
    window.clear();
    expect(window.snapshot()).toMatchObject({ count: 0, evictedByCapacity: 1, oldestTimestampMs: null, newestTimestampMs: null });
    expect(window.record({ lane: 'background', latencyMs: 3, success: true, timestampMs: 1 })).toBe(true);
  });

  it('does not own timers, transport, persistence or telemetry', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const window = new RuntimeSignalWindow();
    window.record({ lane: 'critical', latencyMs: 1, success: true, timestampMs: 1 });
    expect(globalThis.setTimeout).toBe(originalSetTimeout);
    expect(window.snapshot().count).toBe(1);
  });
});
