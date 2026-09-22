import { describe, expect, it } from 'vitest';
import { RuntimeSloTracker, type SloLane, type SloObservation } from './runtimeSloTracker';

function observation(at: number, overrides: Partial<SloObservation> = {}): SloObservation {
  return { at, lane: 'interactive', latencyMs: 100, success: true, ...overrides };
}

function feed(tracker: RuntimeSloTracker, count: number, factory: (index: number) => Partial<SloObservation> = () => ({})): void {
  for (let index = 0; index < count; index += 1) tracker.observe(observation(index + 1, factory(index)));
}

describe('RuntimeSloTracker', () => {
  it('starts with immutable unknown lane diagnostics', () => {
    const tracker = new RuntimeSloTracker();
    const snapshot = tracker.snapshot();
    expect(snapshot.totalSamples).toBe(0);
    expect(snapshot.lanes.interactive).toMatchObject({ status: 'unknown', samples: 0, successRate: 1, burnRate: 0 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.interactive)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it('becomes healthy after the minimum evidence window', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 3, windowSize: 4 });
    feed(tracker, 2);
    expect(tracker.snapshot().lanes.interactive.status).toBe('unknown');
    tracker.observe(observation(3));
    expect(tracker.snapshot().lanes.interactive.status).toBe('healthy');
  });

  it('marks a lane exhausted when failures burn budget critically', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 4, targetSuccessRate: 0.75, burnWarning: 1, burnCritical: 2 });
    feed(tracker, 4, () => ({ success: false }));
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ failures: 4, successRate: 0, burnRate: 4, status: 'exhausted' });
  });

  it('marks a lane at risk at the warning burn threshold', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 4, targetSuccessRate: 0.75, burnWarning: 1, burnCritical: 2 });
    feed(tracker, 4, (index) => ({ success: index !== 0 }));
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ failures: 1, successRate: 0.75, burnRate: 1, status: 'at-risk' });
  });

  it('counts latency violations against the same bounded burn signal', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 4, targetSuccessRate: 0.75, targetLatencyMs: 200, burnWarning: 1, burnCritical: 2 });
    feed(tracker, 4, (index) => ({ latencyMs: index === 0 ? 300 : 100 }));
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ failures: 0, errorBudgetConsumed: 0, burnRate: 1, status: 'at-risk' });
  });

  it('uses the worse of failure and latency budget consumption', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 4, targetSuccessRate: 0.75, targetLatencyMs: 200, burnWarning: 1, burnCritical: 3 });
    feed(tracker, 4, (index) => ({ success: index !== 0, latencyMs: index < 2 ? 300 : 100 }));
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ errorBudgetConsumed: 1, burnRate: 2, status: 'at-risk' });
  });

  it('keeps lane evidence isolated', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2 });
    tracker.observe(observation(1, { lane: 'critical', success: false }));
    tracker.observe(observation(2, { lane: 'background', success: true }));
    expect(tracker.snapshot().lanes.critical.status).toBe('exhausted');
    expect(tracker.snapshot().lanes.background.status).toBe('healthy');
    expect(tracker.snapshot().lanes.interactive.status).toBe('unknown');
  });

  it('evicts old evidence at the configured per-lane window bound', () => {
    const tracker = new RuntimeSloTracker({ windowSize: 3, minimumSamples: 1, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2 });
    tracker.observe(observation(1, { success: false }));
    tracker.observe(observation(2));
    tracker.observe(observation(3));
    tracker.observe(observation(4));
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ samples: 3, failures: 0, successRate: 1, status: 'healthy' });
  });

  it('computes nearest-rank p95 from the bounded lane window', () => {
    const tracker = new RuntimeSloTracker({ windowSize: 20, minimumSamples: 1 });
    feed(tracker, 18);
    tracker.observe(observation(19, { latencyMs: 900 }));
    tracker.observe(observation(20, { latencyMs: 900 }));
    expect(tracker.snapshot().lanes.interactive.p95LatencyMs).toBe(900);
  });

  it('records status transitions with bounded history', () => {
    const tracker = new RuntimeSloTracker({ windowSize: 1, minimumSamples: 1, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2, historySize: 2 });
    tracker.observe(observation(1));
    tracker.observe(observation(2, { success: false }));
    tracker.observe(observation(3));
    expect(tracker.snapshot().history).toHaveLength(2);
    expect(tracker.snapshot().history.map((entry) => entry.to)).toEqual(['exhausted', 'healthy']);
  });

  it('freezes transition copies exposed through diagnostics', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1 });
    tracker.observe(observation(1));
    const transition = tracker.snapshot().history[0];
    expect(transition).toBeDefined();
    expect(Object.isFrozen(transition)).toBe(true);
  });

  it('resets one lane without discarding evidence from another lane', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1 });
    tracker.observe(observation(1, { lane: 'critical' }));
    tracker.observe(observation(2, { lane: 'interactive' }));
    tracker.reset('interactive');
    expect(tracker.snapshot().lanes.interactive).toMatchObject({ samples: 0, status: 'unknown' });
    expect(tracker.snapshot().lanes.critical).toMatchObject({ samples: 1, status: 'healthy' });
    expect(tracker.snapshot().history.every((entry) => entry.lane !== 'interactive')).toBe(true);
  });

  it('resets all evidence and accepts a new clock epoch', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1 });
    tracker.observe(observation(100));
    tracker.reset();
    expect(tracker.snapshot()).toMatchObject({ totalSamples: 0, history: [] });
    expect(() => tracker.observe(observation(1))).not.toThrow();
  });

  it('rejects non-monotonic observations before mutating evidence', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1 });
    tracker.observe(observation(10));
    expect(() => tracker.observe(observation(9))).toThrow(/monotonic/);
    expect(tracker.snapshot().totalSamples).toBe(1);
  });

  it.each([
    ['at', Number.NaN],
    ['latencyMs', Number.POSITIVE_INFINITY],
  ] as const)('rejects non-finite %s', (field, value) => {
    const tracker = new RuntimeSloTracker();
    expect(() => tracker.observe(observation(1, { [field]: value }))).toThrow(/finite/);
  });

  it('rejects negative timestamp and latency values', () => {
    const tracker = new RuntimeSloTracker();
    expect(() => tracker.observe(observation(-1))).toThrow(/at cannot be negative/);
    expect(() => tracker.observe(observation(1, { latencyMs: -1 }))).toThrow(/latencyMs cannot be negative/);
  });

  it('rejects invalid lane values at runtime', () => {
    const tracker = new RuntimeSloTracker();
    expect(() => tracker.observe(observation(1, { lane: 'other' as SloLane }))).toThrow(/unsupported lane/);
  });

  it('rejects invalid success values at runtime', () => {
    const tracker = new RuntimeSloTracker();
    expect(() => tracker.observe(observation(1, { success: 1 as unknown as boolean }))).toThrow(/success must be boolean/);
  });

  it('rejects impossible evidence-window configuration', () => {
    expect(() => new RuntimeSloTracker({ windowSize: 2, minimumSamples: 3 })).toThrow(/cannot exceed/);
  });

  it('rejects invalid success target configuration', () => {
    expect(() => new RuntimeSloTracker({ targetSuccessRate: 1 })).toThrow(/between 0 and 1/);
    expect(() => new RuntimeSloTracker({ targetSuccessRate: 0 })).toThrow(/between 0 and 1/);
  });

  it('rejects invalid latency target configuration', () => {
    expect(() => new RuntimeSloTracker({ targetLatencyMs: 0 })).toThrow(/positive/);
  });

  it('rejects unordered burn thresholds', () => {
    expect(() => new RuntimeSloTracker({ burnWarning: 2, burnCritical: 2 })).toThrow(/ordered/);
    expect(() => new RuntimeSloTracker({ burnWarning: 0 })).toThrow(/positive and ordered/);
  });

  it('tracks aggregate sample count across all lanes', () => {
    const tracker = new RuntimeSloTracker();
    tracker.observe(observation(1, { lane: 'critical' }));
    tracker.observe(observation(2, { lane: 'interactive' }));
    tracker.observe(observation(3, { lane: 'background' }));
    expect(tracker.snapshot().totalSamples).toBe(3);
  });

  it('does not mutate caller-owned observation objects', () => {
    const tracker = new RuntimeSloTracker({ minimumSamples: 1 });
    const input = observation(1);
    tracker.observe(input);
    expect(input).toEqual({ at: 1, lane: 'interactive', latencyMs: 100, success: true });
  });
});
