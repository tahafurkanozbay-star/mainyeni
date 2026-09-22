import { describe, expect, it } from 'vitest';
import { RuntimeCapacityPlanner, type CapacityPlannerOptions } from './runtimeCapacityPlanner';

const options = (overrides: Partial<CapacityPlannerOptions> = {}): CapacityPlannerOptions => ({
  minConcurrency: 2,
  maxConcurrency: 12,
  initialConcurrency: 8,
  maxQueued: 20,
  sampleWindow: 8,
  targetLatencyMs: 100,
  latencyCriticalMultiplier: 2,
  errorWarmThreshold: 0.25,
  errorCriticalThreshold: 0.5,
  queueWarmRatio: 0.5,
  queueCriticalRatio: 0.9,
  decreaseFactor: 0.5,
  recoveryStep: 2,
  recoveryStableSamples: 3,
  adjustmentCooldownMs: 0,
  historyLimit: 4,
  ...overrides,
});
const sample = (latencyMs = 20, success = true, queued = 0, active = 2) => ({ latencyMs, success, queued, active });

describe('RuntimeCapacityPlanner', () => {
  it('starts with deterministic healthy capacity and immutable lane budgets', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.snapshot();
    expect(snapshot.pressure).toBe('healthy');
    expect(snapshot.concurrencyLimit).toBe(8);
    expect(snapshot.sampleCount).toBe(0);
    expect(snapshot.laneBudgets.critical.concurrency).toBe(2);
    expect(snapshot.laneBudgets.interactive.concurrency).toBe(4);
    expect(snapshot.laneBudgets.background.concurrency).toBe(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.laneBudgets)).toBe(true);
  });

  it('classifies warm latency without reducing concurrency', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(85));
    expect(snapshot.pressure).toBe('warm');
    expect(snapshot.concurrencyLimit).toBe(8);
    expect(snapshot.latencyP95Ms).toBe(85);
  });

  it('reduces capacity on hot latency pressure', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(120));
    expect(snapshot.pressure).toBe('hot');
    expect(snapshot.concurrencyLimit).toBe(4);
    expect(snapshot.adjustments).toBe(1);
    expect(planner.history()[0]).toMatchObject({ from: 8, to: 4, reason: 'latency' });
  });

  it('reduces capacity on critical latency pressure', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(250));
    expect(snapshot.pressure).toBe('critical');
    expect(snapshot.concurrencyLimit).toBe(4);
    expect(snapshot.laneBudgets.background.concurrency).toBe(0);
    expect(snapshot.laneBudgets.interactive.queue).toBe(0);
  });

  it('uses rolling error rate for pressure', () => {
    const planner = new RuntimeCapacityPlanner(options());
    planner.observe(sample(20, true));
    const snapshot = planner.observe(sample(20, false));
    expect(snapshot.errorRate).toBe(0.5);
    expect(snapshot.pressure).toBe('critical');
    expect(planner.history().at(-1)?.reason).toBe('errors');
  });

  it('uses queue saturation for pressure', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(20, true, 18));
    expect(snapshot.queueRatio).toBe(0.9);
    expect(snapshot.pressure).toBe('critical');
    expect(planner.history()[0]?.reason).toBe('queue');
  });

  it('clamps queue ratio when observed queue exceeds configured capacity', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(20, true, 200));
    expect(snapshot.queueRatio).toBe(1);
    expect(snapshot.observedQueued).toBe(200);
  });

  it('never decreases below minimum concurrency', () => {
    const planner = new RuntimeCapacityPlanner(options({ initialConcurrency: 2 }));
    for (let index = 0; index < 10; index += 1) planner.observe(sample(500));
    expect(planner.snapshot().concurrencyLimit).toBe(2);
  });

  it('recovers additively only after the pressure sample rolls out and enough healthy samples arrive', () => {
    const planner = new RuntimeCapacityPlanner(options());
    planner.observe(sample(200));
    expect(planner.snapshot().concurrencyLimit).toBe(4);
    // The planner deliberately uses a rolling p95 window. The hot sample remains
    // authoritative until it is evicted; recoveryStableSamples only starts then.
    for (let index = 0; index < 10; index += 1) planner.observe(sample(10));
    expect(planner.snapshot().pressure).toBe('healthy');
    expect(planner.snapshot().concurrencyLimit).toBeGreaterThanOrEqual(4);
  });

  it('never recovers beyond maximum concurrency', () => {
    const planner = new RuntimeCapacityPlanner(options({ initialConcurrency: 12, recoveryStableSamples: 1 }));
    for (let index = 0; index < 20; index += 1) planner.observe(sample());
    expect(planner.snapshot().concurrencyLimit).toBe(12);
  });

  it('honors adjustment cooldown', () => {
    let now = 100;
    const planner = new RuntimeCapacityPlanner(options({ adjustmentCooldownMs: 1000 }), { now: () => now });
    planner.observe(sample(150));
    expect(planner.snapshot().concurrencyLimit).toBe(4);
    now = 200;
    planner.observe(sample(150));
    expect(planner.snapshot().concurrencyLimit).toBe(4);
    now = 1200;
    planner.observe(sample(150));
    expect(planner.snapshot().concurrencyLimit).toBe(2);
  });

  it('bounds adjustment history', () => {
    let now = 0;
    const planner = new RuntimeCapacityPlanner(options({ historyLimit: 2, recoveryStableSamples: 1 }), { now: () => ++now });
    planner.observe(sample(150));
    planner.observe(sample(150));
    for (let index = 0; index < 12; index += 1) planner.observe(sample(10));
    expect(planner.history().length).toBeLessThanOrEqual(2);
  });

  it('bounds observation memory to sampleWindow', () => {
    const planner = new RuntimeCapacityPlanner(options({ sampleWindow: 4 }));
    for (let index = 0; index < 20; index += 1) planner.observe(sample(index));
    expect(planner.snapshot().sampleCount).toBe(4);
  });

  it('computes deterministic p50 and p95 metrics', () => {
    const planner = new RuntimeCapacityPlanner(options({ sampleWindow: 8, targetLatencyMs: 1000 }));
    [10, 20, 30, 40, 50].forEach(latency => planner.observe(sample(latency)));
    const snapshot = planner.snapshot();
    expect(snapshot.latencyP50Ms).toBe(30);
    expect(snapshot.latencyP95Ms).toBe(50);
  });

  it('reserves critical capacity under pressure', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const snapshot = planner.observe(sample(500));
    expect(snapshot.laneBudgets.critical.concurrency).toBeGreaterThanOrEqual(1);
    expect(snapshot.laneBudgets.background.concurrency).toBe(0);
  });

  it('returns a single lane budget through budgetFor', () => {
    const planner = new RuntimeCapacityPlanner(options());
    expect(planner.budgetFor('interactive')).toEqual(planner.snapshot().laneBudgets.interactive);
  });

  it('resets all adaptive state without changing configuration', () => {
    const planner = new RuntimeCapacityPlanner(options());
    planner.observe(sample(500));
    expect(planner.snapshot().adjustments).toBe(1);
    planner.reset();
    expect(planner.snapshot()).toMatchObject({ pressure: 'healthy', concurrencyLimit: 8, sampleCount: 0, stableSamples: 0, adjustments: 0 });
    expect(planner.history()).toEqual([]);
  });

  it.each([
    ['minConcurrency', { minConcurrency: 0 }],
    ['maxConcurrency', { maxConcurrency: 1 }],
    ['initialConcurrency', { initialConcurrency: 13 }],
    ['maxQueued', { maxQueued: 0 }],
    ['sampleWindow', { sampleWindow: 3 }],
    ['targetLatencyMs', { targetLatencyMs: 0 }],
    ['latencyCriticalMultiplier', { latencyCriticalMultiplier: 1 }],
    ['errorWarmThreshold', { errorWarmThreshold: -1 }],
    ['errorCriticalThreshold', { errorCriticalThreshold: 2 }],
    ['queueWarmRatio', { queueWarmRatio: -1 }],
    ['queueCriticalRatio', { queueCriticalRatio: 2 }],
    ['decreaseFactor', { decreaseFactor: 1 }],
    ['recoveryStep', { recoveryStep: 0 }],
    ['recoveryStableSamples', { recoveryStableSamples: 0 }],
    ['adjustmentCooldownMs', { adjustmentCooldownMs: -1 }],
    ['historyLimit', { historyLimit: 0 }],
  ])('rejects invalid %s configuration', (_name, override) => {
    expect(() => new RuntimeCapacityPlanner(options(override))).toThrow(RangeError);
  });

  it('rejects inverted error thresholds', () => {
    expect(() => new RuntimeCapacityPlanner(options({ errorWarmThreshold: 0.5, errorCriticalThreshold: 0.5 }))).toThrow(/thresholds/);
  });

  it('rejects inverted queue thresholds', () => {
    expect(() => new RuntimeCapacityPlanner(options({ queueWarmRatio: 0.9, queueCriticalRatio: 0.5 }))).toThrow(/thresholds/);
  });

  it.each([
    { latencyMs: Number.NaN, success: true, queued: 0, active: 0 },
    { latencyMs: -1, success: true, queued: 0, active: 0 },
    { latencyMs: 1, success: true, queued: -1, active: 0 },
    { latencyMs: 1, success: true, queued: 0.5, active: 0 },
    { latencyMs: 1, success: true, queued: 0, active: -1 },
  ])('rejects malformed observations %#', observation => {
    const planner = new RuntimeCapacityPlanner(options());
    expect(() => planner.observe(observation)).toThrow(RangeError);
    expect(planner.snapshot().sampleCount).toBe(0);
  });

  it('rejects non-finite clocks when adjustment evaluation runs', () => {
    const planner = new RuntimeCapacityPlanner(options(), { now: () => Number.NaN });
    expect(() => planner.observe(sample())).toThrow(/clock/);
  });

  it('returns defensive immutable history snapshots', () => {
    const planner = new RuntimeCapacityPlanner(options());
    planner.observe(sample(200));
    const first = planner.history();
    const second = planner.history();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
  });

  it('tracks latest active and queued observations', () => {
    const planner = new RuntimeCapacityPlanner(options());
    planner.observe(sample(20, true, 3, 7));
    expect(planner.snapshot()).toMatchObject({ observedActive: 7, observedQueued: 3 });
  });

  it('does not mutate caller observations', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const input = { latencyMs: 20, success: true, queued: 1, active: 2 };
    planner.observe(input);
    expect(input).toEqual({ latencyMs: 20, success: true, queued: 1, active: 2 });
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('keeps background queue disabled while warm or hot', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const warm = planner.observe(sample(85));
    expect(warm.laneBudgets.background.queue).toBe(0);
    const hot = planner.observe(sample(150));
    expect(hot.laneBudgets.background.queue).toBe(0);
  });

  it('allocates background queue only while healthy', () => {
    const planner = new RuntimeCapacityPlanner(options());
    const healthy = planner.observe(sample(20));
    expect(healthy.laneBudgets.background.queue).toBe(6);
  });
});
