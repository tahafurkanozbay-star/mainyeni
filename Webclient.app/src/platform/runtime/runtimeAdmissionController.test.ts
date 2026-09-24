import { describe, expect, it } from 'vitest';
import { RuntimeAdmissionController } from './runtimeAdmissionController';

describe('RuntimeAdmissionController', () => {
  it('admits work below pressure and capacity limits', () => {
    const controller = new RuntimeAdmissionController({ interactive: { maximumInFlight: 2 } });
    expect(controller.decide({ lane: 'interactive', key: 'a', pressure: 0.1 })).toMatchObject({ decision: 'admit', reason: 'admitted' });
    expect(controller.decide({ lane: 'interactive', key: 'b', pressure: 0.2 }).inFlight).toBe(2);
  });

  it('defers at capacity and promotes deterministically after completion', () => {
    const controller = new RuntimeAdmissionController({ critical: { maximumInFlight: 1, maximumQueued: 2 } });
    controller.decide({ lane: 'critical', key: 'first', pressure: 0 });
    expect(controller.decide({ lane: 'critical', key: 'second', pressure: 0 }).decision).toBe('defer');
    expect(controller.complete('critical', 'first')).toBe(true);
    expect(controller.promote('critical', 0)).toEqual(['second']);
    expect(controller.snapshot().lanes.critical).toEqual({ inFlight: 1, queued: 0 });
  });

  it('rejects work when failure pressure reaches the lane ceiling', () => {
    const controller = new RuntimeAdmissionController({ background: { deferPressure: 0.4, rejectPressure: 0.7 } });
    expect(controller.decide({ lane: 'background', key: 'work', pressure: 0.7 })).toMatchObject({ decision: 'reject', reason: 'failure-pressure' });
    expect(controller.snapshot().totalQueued).toBe(0);
  });

  it('bounds queues and rejects overflow instead of allocating indefinitely', () => {
    const controller = new RuntimeAdmissionController({ background: { maximumInFlight: 0, maximumQueued: 1 } });
    expect(controller.decide({ lane: 'background', key: 'queued', pressure: 0 }).decision).toBe('defer');
    expect(controller.decide({ lane: 'background', key: 'overflow', pressure: 0 })).toMatchObject({ decision: 'reject', reason: 'queue-full' });
    expect(controller.snapshot().lanes.background.queued).toBe(1);
  });

  it('does not duplicate existing in-flight or queued ownership', () => {
    const controller = new RuntimeAdmissionController({ interactive: { maximumInFlight: 1 } });
    controller.decide({ lane: 'interactive', key: 'active', pressure: 0 });
    expect(controller.decide({ lane: 'interactive', key: 'active', pressure: 0 }).decision).toBe('admit');
    controller.decide({ lane: 'interactive', key: 'queued', pressure: 0 });
    expect(controller.decide({ lane: 'interactive', key: 'queued', pressure: 0 }).decision).toBe('defer');
    expect(controller.snapshot().lanes.interactive).toEqual({ inFlight: 1, queued: 1 });
  });

  it('does not promote queued work while pressure remains elevated', () => {
    const controller = new RuntimeAdmissionController({ interactive: { maximumInFlight: 1, deferPressure: 0.5 } });
    controller.decide({ lane: 'interactive', key: 'active', pressure: 0 });
    controller.decide({ lane: 'interactive', key: 'queued', pressure: 0 });
    controller.complete('interactive', 'active');
    expect(controller.promote('interactive', 0.5)).toEqual([]);
    expect(controller.snapshot().lanes.interactive.queued).toBe(1);
  });

  it('cancels both queued and in-flight ownership without ambiguity', () => {
    const controller = new RuntimeAdmissionController({ critical: { maximumInFlight: 1 } });
    controller.decide({ lane: 'critical', key: 'active', pressure: 0 });
    controller.decide({ lane: 'critical', key: 'queued', pressure: 0 });
    expect(controller.cancel('critical', 'queued')).toBe(true);
    expect(controller.cancel('critical', 'active')).toBe(true);
    expect(controller.cancel('critical', 'missing')).toBe(false);
    expect(controller.snapshot().lanes.critical).toEqual({ inFlight: 0, queued: 0 });
  });

  it('exposes frozen normalized policy and snapshots', () => {
    const controller = new RuntimeAdmissionController({ critical: { maximumInFlight: 3, maximumQueued: 5 } });
    const policy = controller.policy('critical');
    const snapshot = controller.snapshot();
    expect(policy.maximumInFlight).toBe(3);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.critical)).toBe(true);
  });

  it('rejects malformed policies and forged runtime inputs', () => {
    expect(() => new RuntimeAdmissionController({ critical: { maximumInFlight: -1 } })).toThrow(RangeError);
    expect(() => new RuntimeAdmissionController({ critical: { deferPressure: 0.9, rejectPressure: 0.5 } })).toThrow(RangeError);
    const controller = new RuntimeAdmissionController();
    expect(() => controller.decide({ lane: 'unknown' as never, key: 'x', pressure: 0 })).toThrow(TypeError);
    expect(() => controller.decide({ lane: 'critical', key: '', pressure: 0 })).toThrow(TypeError);
    expect(() => controller.decide({ lane: 'critical', key: 'x', pressure: Number.NaN })).toThrow(RangeError);
  });

  it('resets one lane without mutating unrelated ownership', () => {
    const controller = new RuntimeAdmissionController();
    controller.decide({ lane: 'critical', key: 'critical', pressure: 0 });
    controller.decide({ lane: 'background', key: 'background', pressure: 0 });
    controller.reset('critical');
    expect(controller.snapshot().lanes.critical.inFlight).toBe(0);
    expect(controller.snapshot().lanes.background.inFlight).toBe(1);
    controller.reset();
    expect(controller.snapshot().totalInFlight).toBe(0);
  });
});
