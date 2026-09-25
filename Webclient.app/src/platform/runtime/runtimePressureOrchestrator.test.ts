import { describe, expect, it } from 'vitest';
import { RuntimePressureOrchestrator } from './runtimePressureOrchestrator';

const healthy = (lane: 'critical' | 'interactive' | 'background', at: number) => ({
  lane,
  at,
  utilization: 0.1,
  failurePressure: 0.1,
  saturation: 0.1,
} as const);

const constrained = (lane: 'critical' | 'interactive' | 'background', at: number) => ({
  lane,
  at,
  utilization: 0.7,
  failurePressure: 0.2,
  saturation: 0.3,
} as const);

const critical = (lane: 'critical' | 'interactive' | 'background', at: number) => ({
  lane,
  at,
  utilization: 0.2,
  failurePressure: 0.95,
  saturation: 0.4,
} as const);

describe('RuntimePressureOrchestrator', () => {
  it('admits healthy work and exposes bounded immutable snapshots', () => {
    const runtime = new RuntimePressureOrchestrator();
    expect(runtime.request({ id: 'a', lane: 'interactive', at: 1 })).toMatchObject({ decision: 'admit', reason: 'healthy' });
    expect(runtime.request({ id: 'b', lane: 'critical', at: 2 })).toMatchObject({ decision: 'admit', reason: 'healthy' });
    const snapshot = runtime.snapshot();
    expect(snapshot.inFlight).toBe(2);
    expect(snapshot.queued).toBe(0);
    expect(snapshot.lanes.interactive.inFlight).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.interactive)).toBe(true);
  });

  it('moves a lane to constrained mode when any pressure dimension crosses the threshold', () => {
    const runtime = new RuntimePressureOrchestrator();
    const snapshot = runtime.sample(constrained('interactive', 1));
    expect(snapshot.mode).toBe('constrained');
    expect(snapshot.pressure).toBe(0.7);
    expect(runtime.history()).toEqual([
      expect.objectContaining({ lane: 'interactive', from: 'normal', to: 'constrained', pressure: 0.7, at: 1 }),
    ]);
  });

  it('moves directly to critical mode under critical failure pressure', () => {
    const runtime = new RuntimePressureOrchestrator();
    expect(runtime.sample(critical('background', 1)).mode).toBe('critical');
    expect(runtime.request({ id: 'blocked', lane: 'background', at: 2 })).toMatchObject({ decision: 'reject', reason: 'critical-pressure', mode: 'critical' });
    expect(runtime.snapshot().queued).toBe(0);
  });

  it('defers constrained work into a bounded queue', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumLaneQueued: 2, maximumGlobalQueued: 4 });
    runtime.sample(constrained('interactive', 1));
    expect(runtime.request({ id: 'a', lane: 'interactive', at: 2 })).toMatchObject({ decision: 'defer', reason: 'pressure' });
    expect(runtime.request({ id: 'b', lane: 'interactive', at: 3 })).toMatchObject({ decision: 'defer', reason: 'pressure' });
    expect(runtime.request({ id: 'c', lane: 'interactive', at: 4 })).toMatchObject({ decision: 'reject', reason: 'queue-capacity' });
    expect(runtime.snapshot().lanes.interactive.queued).toBe(2);
  });

  it('enforces global in-flight capacity before admitting additional work', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 2, maximumLaneInFlight: 2 });
    runtime.request({ id: 'critical', lane: 'critical', at: 1 });
    runtime.request({ id: 'interactive', lane: 'interactive', at: 2 });
    expect(runtime.request({ id: 'background', lane: 'background', at: 3 })).toMatchObject({ decision: 'defer', reason: 'global-capacity' });
    expect(runtime.snapshot()).toMatchObject({ inFlight: 2, queued: 1 });
  });

  it('enforces lane capacity independently of global capacity', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 4, maximumLaneInFlight: 1 });
    runtime.request({ id: 'first', lane: 'interactive', at: 1 });
    expect(runtime.request({ id: 'second', lane: 'interactive', at: 2 })).toMatchObject({ decision: 'defer', reason: 'lane-capacity' });
    expect(runtime.request({ id: 'other-lane', lane: 'critical', at: 3 }).decision).toBe('admit');
    expect(runtime.snapshot().inFlight).toBe(2);
  });

  it('promotes queued work after completion when the lane is normal', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 2, maximumLaneInFlight: 1 });
    runtime.request({ id: 'first', lane: 'interactive', at: 1 });
    runtime.request({ id: 'second', lane: 'interactive', at: 2 });
    expect(runtime.complete('interactive', 'first', 3)).toEqual(['second']);
    expect(runtime.snapshot().lanes.interactive).toMatchObject({ inFlight: 1, queued: 0 });
  });

  it('does not promote queued work while the lane remains constrained', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumLaneInFlight: 1 });
    runtime.request({ id: 'first', lane: 'interactive', at: 1 });
    runtime.request({ id: 'second', lane: 'interactive', at: 2 });
    runtime.sample(constrained('interactive', 3));
    expect(runtime.complete('interactive', 'first', 4)).toEqual([]);
    expect(runtime.snapshot().lanes.interactive).toMatchObject({ inFlight: 0, queued: 1, mode: 'constrained' });
  });

  it('requires consecutive healthy evidence before recovering from constrained mode', () => {
    const runtime = new RuntimePressureOrchestrator({ minimumHealthySamples: 3 });
    runtime.sample(constrained('interactive', 1));
    expect(runtime.sample(healthy('interactive', 2))).toMatchObject({ mode: 'constrained', healthySamples: 1 });
    expect(runtime.sample(healthy('interactive', 3))).toMatchObject({ mode: 'constrained', healthySamples: 2 });
    expect(runtime.sample(healthy('interactive', 4))).toMatchObject({ mode: 'normal', healthySamples: 0 });
  });

  it('recovers critical mode through constrained mode instead of skipping a severity level', () => {
    const runtime = new RuntimePressureOrchestrator({ minimumHealthySamples: 2 });
    runtime.sample(critical('critical', 1));
    runtime.sample(healthy('critical', 2));
    expect(runtime.sample(healthy('critical', 3)).mode).toBe('constrained');
    runtime.sample(healthy('critical', 4));
    expect(runtime.sample(healthy('critical', 5)).mode).toBe('normal');
    expect(runtime.history().map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      'normal->critical',
      'critical->constrained',
      'constrained->normal',
    ]);
  });

  it('resets healthy evidence when pressure leaves the recovery band', () => {
    const runtime = new RuntimePressureOrchestrator({ minimumHealthySamples: 2 });
    runtime.sample(constrained('interactive', 1));
    runtime.sample(healthy('interactive', 2));
    expect(runtime.sample({ lane: 'interactive', at: 3, utilization: 0.5, failurePressure: 0.1, saturation: 0.1 }).healthySamples).toBe(0);
    expect(runtime.sample(healthy('interactive', 4)).mode).toBe('constrained');
  });

  it('uses the maximum pressure dimension as the lane pressure', () => {
    const runtime = new RuntimePressureOrchestrator();
    expect(runtime.sample({ lane: 'critical', at: 1, utilization: 0.2, failurePressure: 0.4, saturation: 0.8 }).pressure).toBe(0.8);
    expect(runtime.snapshot().lanes.critical.mode).toBe('constrained');
  });

  it('rejects duplicate ownership across lanes', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.request({ id: 'shared', lane: 'interactive', at: 1 });
    expect(runtime.request({ id: 'shared', lane: 'critical', at: 2 })).toMatchObject({ decision: 'reject', reason: 'duplicate' });
    expect(runtime.snapshot().inFlight).toBe(1);
  });

  it('returns a stable deferred decision for duplicate queued ownership in the same lane', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumLaneInFlight: 1 });
    runtime.request({ id: 'active', lane: 'interactive', at: 1 });
    runtime.request({ id: 'queued', lane: 'interactive', at: 2 });
    expect(runtime.request({ id: 'queued', lane: 'interactive', at: 3 })).toMatchObject({ decision: 'defer', reason: 'duplicate' });
    expect(runtime.snapshot().queued).toBe(1);
  });

  it('cancels in-flight ownership without promoting implicitly', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumLaneInFlight: 1 });
    runtime.request({ id: 'active', lane: 'interactive', at: 1 });
    runtime.request({ id: 'queued', lane: 'interactive', at: 2 });
    expect(runtime.cancel('interactive', 'active', 3)).toBe(true);
    expect(runtime.snapshot().lanes.interactive).toMatchObject({ inFlight: 0, queued: 1 });
    expect(runtime.promote('interactive', 4)).toEqual(['queued']);
  });

  it('cancels queued ownership deterministically', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumLaneInFlight: 1 });
    runtime.request({ id: 'active', lane: 'interactive', at: 1 });
    runtime.request({ id: 'queued', lane: 'interactive', at: 2 });
    expect(runtime.cancel('interactive', 'queued', 3)).toBe(true);
    expect(runtime.cancel('interactive', 'queued', 4)).toBe(false);
    expect(runtime.snapshot().queued).toBe(0);
  });

  it('preserves FIFO queue order during promotion', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 3, maximumLaneInFlight: 1 });
    runtime.request({ id: 'active', lane: 'background', at: 1 });
    runtime.request({ id: 'one', lane: 'background', at: 2 });
    runtime.request({ id: 'two', lane: 'background', at: 3 });
    expect(runtime.complete('background', 'active', 4)).toEqual(['one']);
    expect(runtime.complete('background', 'one', 5)).toEqual(['two']);
  });

  it('bounds transition history and returns immutable copies', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumHistory: 2, minimumHealthySamples: 1 });
    runtime.sample(constrained('interactive', 1));
    runtime.sample(healthy('interactive', 2));
    runtime.sample(critical('interactive', 3));
    const history = runtime.history();
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.to)).toEqual(['normal', 'critical']);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('supports disabling transition history without disabling state transitions', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumHistory: 0 });
    expect(runtime.sample(constrained('interactive', 1)).mode).toBe('constrained');
    expect(runtime.history()).toEqual([]);
  });

  it('rejects malformed threshold ordering', () => {
    expect(() => new RuntimePressureOrchestrator({ recoveryThreshold: 0.7, constrainedThreshold: 0.6 })).toThrow(RangeError);
    expect(() => new RuntimePressureOrchestrator({ constrainedThreshold: 0.9, criticalThreshold: 0.8 })).toThrow(RangeError);
  });

  it('rejects lane capacities that exceed global capacities', () => {
    expect(() => new RuntimePressureOrchestrator({ maximumGlobalInFlight: 2, maximumLaneInFlight: 3 })).toThrow(RangeError);
    expect(() => new RuntimePressureOrchestrator({ maximumGlobalQueued: 2, maximumLaneQueued: 3 })).toThrow(RangeError);
  });

  it('rejects invalid samples before mutating state', () => {
    const runtime = new RuntimePressureOrchestrator();
    expect(() => runtime.sample({ lane: 'interactive', at: 1, utilization: Number.NaN, failurePressure: 0, saturation: 0 })).toThrow(RangeError);
    expect(() => runtime.sample({ lane: 'interactive', at: 2, utilization: 0, failurePressure: -1, saturation: 0 })).toThrow(RangeError);
    expect(() => runtime.sample({ lane: 'interactive', at: 3, utilization: 0, failurePressure: 0, saturation: 2 })).toThrow(RangeError);
    expect(runtime.snapshot().lanes.interactive.lastSampleAt).toBeNull();
  });

  it('rejects forged lanes and malformed request identifiers', () => {
    const runtime = new RuntimePressureOrchestrator();
    expect(() => runtime.request({ id: 'x', lane: 'forged' as never, at: 1 })).toThrow(TypeError);
    expect(() => runtime.request({ id: '', lane: 'critical', at: 1 })).toThrow(TypeError);
    expect(() => runtime.request({ id: 'x'.repeat(257), lane: 'critical', at: 1 })).toThrow(TypeError);
  });

  it('enforces a monotonic caller clock across operations', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.sample(healthy('interactive', 10));
    expect(() => runtime.request({ id: 'old', lane: 'interactive', at: 9 })).toThrow(RangeError);
    expect(() => runtime.cancel('interactive', 'missing', 8)).toThrow(RangeError);
  });

  it('allows equal timestamps for deterministic batches', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.request({ id: 'a', lane: 'critical', at: 10 });
    runtime.request({ id: 'b', lane: 'interactive', at: 10 });
    runtime.sample(healthy('background', 10));
    expect(runtime.snapshot().inFlight).toBe(2);
  });

  it('resets one lane without mutating unrelated lane ownership', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.request({ id: 'critical', lane: 'critical', at: 1 });
    runtime.request({ id: 'interactive', lane: 'interactive', at: 2 });
    runtime.sample(constrained('critical', 3));
    runtime.reset('critical');
    const snapshot = runtime.snapshot();
    expect(snapshot.lanes.critical).toMatchObject({ mode: 'normal', inFlight: 0, queued: 0, pressure: 0 });
    expect(snapshot.lanes.interactive.inFlight).toBe(1);
    expect(runtime.history().some((entry) => entry.lane === 'critical')).toBe(false);
  });

  it('fully resets runtime state and monotonic time', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.request({ id: 'a', lane: 'critical', at: 100 });
    runtime.sample(constrained('interactive', 101));
    runtime.reset();
    expect(runtime.snapshot()).toMatchObject({ sequence: 0, inFlight: 0, queued: 0 });
    expect(runtime.history()).toEqual([]);
    expect(() => runtime.request({ id: 'fresh', lane: 'critical', at: 1 })).not.toThrow();
  });

  it('returns normalized frozen policy', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 10, maximumLaneInFlight: 5 });
    const policy = runtime.policy();
    expect(policy.maximumGlobalInFlight).toBe(10);
    expect(policy.maximumLaneInFlight).toBe(5);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('does not mutate sequence for rejected critical-pressure work', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.sample(critical('interactive', 1));
    const before = runtime.snapshot().sequence;
    runtime.request({ id: 'rejected', lane: 'interactive', at: 2 });
    expect(runtime.snapshot().sequence).toBe(before);
  });

  it('does not mutate ownership when a queue is full', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalQueued: 1, maximumLaneQueued: 1 });
    runtime.sample(constrained('background', 1));
    runtime.request({ id: 'one', lane: 'background', at: 2 });
    runtime.request({ id: 'two', lane: 'background', at: 3 });
    expect(runtime.cancel('background', 'two', 4)).toBe(false);
    expect(runtime.snapshot().queued).toBe(1);
  });

  it('limits promotion by global slots even when a lane has spare capacity', () => {
    const runtime = new RuntimePressureOrchestrator({ maximumGlobalInFlight: 2, maximumLaneInFlight: 2 });
    runtime.request({ id: 'critical', lane: 'critical', at: 1 });
    runtime.request({ id: 'interactive', lane: 'interactive', at: 2 });
    runtime.request({ id: 'queued-a', lane: 'background', at: 3 });
    runtime.request({ id: 'queued-b', lane: 'background', at: 4 });
    expect(runtime.promote('background', 5)).toEqual([]);
    runtime.complete('critical', 'critical', 6);
    expect(runtime.promote('background', 7)).toEqual(['queued-a']);
    expect(runtime.snapshot()).toMatchObject({ inFlight: 2, queued: 1 });
  });

  it('isolates pressure state between lanes', () => {
    const runtime = new RuntimePressureOrchestrator();
    runtime.sample(critical('background', 1));
    expect(runtime.request({ id: 'interactive', lane: 'interactive', at: 2 }).decision).toBe('admit');
    expect(runtime.snapshot().lanes.interactive.mode).toBe('normal');
    expect(runtime.snapshot().lanes.background.mode).toBe('critical');
  });

  it('keeps snapshots stable after later mutations', () => {
    const runtime = new RuntimePressureOrchestrator();
    const before = runtime.snapshot();
    runtime.request({ id: 'later', lane: 'critical', at: 1 });
    expect(before.inFlight).toBe(0);
    expect(before.lanes.critical.inFlight).toBe(0);
    expect(runtime.snapshot().inFlight).toBe(1);
  });
});
