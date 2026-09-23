import { describe, expect, it } from 'vitest';
import { RuntimeDegradationController } from './runtimeDegradationController';

const pressures = (controller: RuntimeDegradationController, values: readonly number[], start = 0) => {
  values.forEach((pressure, index) => controller.record({ lane: 'interactive', signal: 'saturation', pressure, at: start + index }));
};

describe('RuntimeDegradationController', () => {
  it('stays normal until evidence is mature', () => {
    const controller = new RuntimeDegradationController({ minimumSamples: 3, windowSize: 4 });
    pressures(controller, [1, 1]);
    expect(controller.snapshot().lanes.interactive.level).toBe('normal');
    pressures(controller, [1], 2);
    expect(controller.snapshot().lanes.interactive.level).toBe('emergency');
  });

  it('classifies constrained, degraded and emergency pressure', () => {
    const constrained = new RuntimeDegradationController({ minimumSamples: 2 });
    pressures(constrained, [0.5, 0.5]);
    expect(constrained.snapshot().level).toBe('constrained');
    const degraded = new RuntimeDegradationController({ minimumSamples: 2 });
    pressures(degraded, [0.7, 0.7]);
    expect(degraded.snapshot().level).toBe('degraded');
    const emergency = new RuntimeDegradationController({ minimumSamples: 2 });
    pressures(emergency, [0.9, 0.9]);
    expect(emergency.snapshot().level).toBe('emergency');
  });

  it('recovers one level at a time after sustained healthy evidence', () => {
    const controller = new RuntimeDegradationController({ windowSize: 2, minimumSamples: 2, recoverySamples: 2, recoveryThreshold: 0.2 });
    pressures(controller, [1, 1]);
    expect(controller.snapshot().level).toBe('emergency');
    pressures(controller, [0, 0, 0], 2);
    expect(controller.snapshot().level).toBe('degraded');
    pressures(controller, [0, 0], 5);
    expect(controller.snapshot().level).toBe('constrained');
    pressures(controller, [0, 0], 7);
    expect(controller.snapshot().level).toBe('normal');
  });

  it('uses the worst lane as aggregate state without mixing lane evidence', () => {
    const controller = new RuntimeDegradationController({ minimumSamples: 2 });
    controller.recordBatch([
      { lane: 'critical', signal: 'failure', pressure: 0.9, at: 1 },
      { lane: 'critical', signal: 'failure', pressure: 0.9, at: 2 },
      { lane: 'background', signal: 'latency', pressure: 0.1, at: 1 },
      { lane: 'background', signal: 'latency', pressure: 0.1, at: 2 },
    ]);
    const snapshot = controller.snapshot();
    expect(snapshot.level).toBe('emergency');
    expect(snapshot.lanes.critical.level).toBe('emergency');
    expect(snapshot.lanes.background.level).toBe('normal');
  });

  it('keeps only the configured rolling evidence window', () => {
    const controller = new RuntimeDegradationController({ windowSize: 3, minimumSamples: 2 });
    pressures(controller, [1, 1, 0, 0, 0]);
    expect(controller.snapshot().lanes.interactive.samples).toBe(3);
    expect(controller.snapshot().lanes.interactive.score).toBe(0);
  });

  it('weights signal families without allowing unknown signal injection', () => {
    const controller = new RuntimeDegradationController({ minimumSamples: 2 });
    controller.record({ lane: 'interactive', signal: 'latency', pressure: 0.6, at: 1 });
    controller.record({ lane: 'interactive', signal: 'failure', pressure: 0.6, at: 2 });
    expect(controller.snapshot().lanes.interactive.score).toBeCloseTo(0.6);
    expect(() => controller.record({ lane: 'interactive', signal: 'forged' as never, pressure: 0.5, at: 3 })).toThrow(TypeError);
  });

  it('rejects non-monotonic lane clocks while allowing independent lane clocks', () => {
    const controller = new RuntimeDegradationController();
    controller.record({ lane: 'critical', signal: 'memory', pressure: 0.2, at: 10 });
    controller.record({ lane: 'background', signal: 'memory', pressure: 0.2, at: 1 });
    expect(() => controller.record({ lane: 'critical', signal: 'memory', pressure: 0.2, at: 9 })).toThrow(RangeError);
  });

  it('bounds transition history and exposes immutable snapshots', () => {
    const controller = new RuntimeDegradationController({ windowSize: 1, minimumSamples: 1, recoverySamples: 1, maximumHistory: 2 });
    controller.record({ lane: 'interactive', signal: 'failure', pressure: 1, at: 1 });
    controller.record({ lane: 'interactive', signal: 'failure', pressure: 0, at: 2 });
    controller.record({ lane: 'interactive', signal: 'failure', pressure: 0, at: 3 });
    controller.record({ lane: 'interactive', signal: 'failure', pressure: 0, at: 4 });
    expect(controller.history()).toHaveLength(2);
    const snapshot = controller.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.interactive)).toBe(true);
  });

  it('can disable event retention entirely', () => {
    const controller = new RuntimeDegradationController({ minimumSamples: 1, maximumHistory: 0 });
    controller.record({ lane: 'critical', signal: 'failure', pressure: 1, at: 1 });
    expect(controller.snapshot().level).toBe('emergency');
    expect(controller.history()).toEqual([]);
  });

  it('resets one lane without mutating unrelated lane evidence', () => {
    const controller = new RuntimeDegradationController({ minimumSamples: 1 });
    controller.record({ lane: 'critical', signal: 'failure', pressure: 1, at: 1 });
    controller.record({ lane: 'background', signal: 'failure', pressure: 0.7, at: 1 });
    controller.reset('critical');
    expect(controller.snapshot().lanes.critical.level).toBe('normal');
    expect(controller.snapshot().lanes.background.level).toBe('degraded');
    controller.reset();
    expect(controller.snapshot().level).toBe('normal');
  });

  it('validates policy ordering and bounded allocation controls', () => {
    expect(() => new RuntimeDegradationController({ windowSize: 0 })).toThrow(RangeError);
    expect(() => new RuntimeDegradationController({ windowSize: 2, minimumSamples: 3 })).toThrow(RangeError);
    expect(() => new RuntimeDegradationController({ constrainedThreshold: 0.7, degradedThreshold: 0.6 })).toThrow(RangeError);
    expect(() => new RuntimeDegradationController({ maximumHistory: 10_001 })).toThrow(RangeError);
  });

  it('rejects malformed runtime samples and oversized batches', () => {
    const controller = new RuntimeDegradationController();
    expect(() => controller.record({ lane: 'forged' as never, signal: 'failure', pressure: 0.5, at: 1 })).toThrow(TypeError);
    expect(() => controller.record({ lane: 'critical', signal: 'failure', pressure: Number.NaN, at: 1 })).toThrow(RangeError);
    expect(() => controller.record({ lane: 'critical', signal: 'failure', pressure: 2, at: 1 })).toThrow(RangeError);
    expect(() => controller.record({ lane: 'critical', signal: 'failure', pressure: 0.2, at: -1 })).toThrow(RangeError);
    const oversized = Array.from({ length: 10_001 }, (_, at) => ({ lane: 'critical' as const, signal: 'failure' as const, pressure: 0, at }));
    expect(() => controller.recordBatch(oversized)).toThrow(RangeError);
  });

  it('returns frozen normalized policy and supports explicit history cleanup', () => {
    const controller = new RuntimeDegradationController({ windowSize: 8, minimumSamples: 4 });
    expect(controller.policy()).toMatchObject({ windowSize: 8, minimumSamples: 4 });
    expect(Object.isFrozen(controller.policy())).toBe(true);
    pressures(controller, [1, 1, 1, 1]);
    expect(controller.history()).toHaveLength(1);
    controller.clearHistory();
    expect(controller.history()).toEqual([]);
  });
});
