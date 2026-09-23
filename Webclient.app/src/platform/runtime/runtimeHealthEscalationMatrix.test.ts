import { describe, expect, it } from 'vitest';
import { RuntimeHealthEscalationMatrix, type RuntimeHealthSignal } from './runtimeHealthEscalationMatrix';

const signal = (at: number, pressure: number, overrides: Partial<RuntimeHealthSignal> = {}): RuntimeHealthSignal => ({ lane: 'interactive', kind: 'latency', pressure, at, ...overrides });
const mature = { windowSize: 4, minimumSamples: 2, recoverySamples: 2, watchScore: 0.25, degradedScore: 0.5, criticalScore: 0.75 } as const;

describe('RuntimeHealthEscalationMatrix', () => {
  it('stays healthy before evidence reaches maturity', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    const snapshot = matrix.record(signal(1, 1));
    expect(snapshot).toMatchObject({ severity: 'healthy', mature: false, sampleCount: 1 });
    expect(matrix.history()).toEqual([]);
  });

  it('escalates directly to critical when mature score is critical', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 1));
    expect(matrix.record(signal(2, 1))).toMatchObject({ severity: 'critical', mature: true, score: 1 });
    expect(matrix.history()).toHaveLength(1);
    expect(matrix.history()[0]).toMatchObject({ from: 'healthy', to: 'critical', at: 2 });
  });

  it('classifies watch pressure', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 0.3));
    expect(matrix.record(signal(2, 0.3)).severity).toBe('watch');
  });

  it('classifies degraded pressure', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 0.6));
    expect(matrix.record(signal(2, 0.6)).severity).toBe('degraded');
  });

  it('requires consecutive recovery evidence and recovers one level at a time', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2 });
    matrix.record(signal(1, 1)); matrix.record(signal(2, 1));
    expect(matrix.snapshot().severity).toBe('critical');
    matrix.record(signal(3, 0));
    expect(matrix.snapshot().severity).toBe('critical');
    matrix.record(signal(4, 0));
    expect(matrix.snapshot().severity).toBe('degraded');
    matrix.record(signal(5, 0)); matrix.record(signal(6, 0));
    expect(matrix.snapshot().severity).toBe('watch');
    matrix.record(signal(7, 0)); matrix.record(signal(8, 0));
    expect(matrix.snapshot().severity).toBe('healthy');
  });

  it('clears recovery streak when target equals current severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2 });
    matrix.record(signal(1, 0.6)); matrix.record(signal(2, 0.6));
    matrix.record(signal(3, 0));
    expect(matrix.snapshot().lanes.interactive.healthyRecoverySamples).toBe(1);
    matrix.record(signal(4, 0.6));
    expect(matrix.snapshot().lanes.interactive.healthyRecoverySamples).toBe(0);
  });

  it('tracks lanes independently and aggregates worst severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 1, { lane: 'background' }));
    matrix.record(signal(2, 1, { lane: 'background' }));
    matrix.record(signal(3, 0, { lane: 'critical' }));
    matrix.record(signal(4, 0, { lane: 'critical' }));
    const snapshot = matrix.snapshot();
    expect(snapshot.severity).toBe('critical');
    expect(snapshot.lanes.background.severity).toBe('critical');
    expect(snapshot.lanes.critical.severity).toBe('healthy');
  });

  it('weights integrity pressure more strongly than latency by default', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 2 });
    matrix.record(signal(1, 0, { kind: 'latency' }));
    const snapshot = matrix.record(signal(2, 1, { kind: 'integrity' }));
    expect(snapshot.score).toBeGreaterThan(0.5);
  });

  it('honors custom signal weights', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, latencyWeight: 10, integrityWeight: 1 });
    matrix.record(signal(1, 1, { kind: 'latency' }));
    const snapshot = matrix.record(signal(2, 0, { kind: 'integrity' }));
    expect(snapshot.score).toBeGreaterThan(0.9);
    expect(snapshot.severity).toBe('critical');
  });

  it('bounds the rolling evidence window', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 3, minimumSamples: 1 });
    matrix.record(signal(1, 1)); matrix.record(signal(2, 1)); matrix.record(signal(3, 1)); matrix.record(signal(4, 0));
    expect(matrix.snapshot().lanes.interactive.sampleCount).toBe(3);
    expect(matrix.snapshot().lanes.interactive.score).toBeCloseTo(2 / 3);
  });

  it('reports per-kind rolling means', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    matrix.record(signal(1, 0.2, { kind: 'availability' }));
    matrix.record(signal(2, 0.6, { kind: 'availability' }));
    matrix.record(signal(3, 0.5, { kind: 'saturation' }));
    expect(matrix.snapshot().lanes.interactive.signals).toMatchObject({ availability: 0.4, saturation: 0.5, integrity: 0 });
  });

  it('records a bounded immutable transition history', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2, minimumSamples: 1, recoverySamples: 1, maximumHistory: 2 });
    matrix.record(signal(1, 1));
    matrix.record(signal(2, 0));
    matrix.record(signal(3, 0));
    matrix.record(signal(4, 0));
    expect(matrix.history().length).toBeLessThanOrEqual(2);
    expect(Object.isFrozen(matrix.history())).toBe(true);
    if (matrix.history()[0]) expect(Object.isFrozen(matrix.history()[0])).toBe(true);
  });

  it('supports disabling transition history', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1, maximumHistory: 0 });
    matrix.record(signal(1, 1));
    expect(matrix.history()).toEqual([]);
  });

  it('accepts bounded batches and returns aggregate snapshot', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    const snapshot = matrix.recordBatch([signal(1, 1), signal(2, 1)]);
    expect(snapshot.severity).toBe('critical');
  });

  it('rejects oversized batches before processing', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    const signals = Array.from({ length: 10_001 }, (_, index) => signal(index, 0));
    expect(() => matrix.recordBatch(signals)).toThrow(/batch exceeds/);
    expect(matrix.snapshot().lanes.interactive.sampleCount).toBe(0);
  });

  it('rejects non-array batches at runtime', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.recordBatch(null as unknown as readonly RuntimeHealthSignal[])).toThrow(/must be an array/);
  });

  it('enforces a monotonic caller clock across lanes', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    matrix.record(signal(10, 0, { lane: 'background' }));
    expect(() => matrix.record(signal(9, 0, { lane: 'critical' }))).toThrow(/monotonic/);
  });

  it('allows equal timestamps for atomic sampling rounds', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    matrix.record(signal(10, 0, { lane: 'critical' }));
    expect(() => matrix.record(signal(10, 0, { lane: 'interactive' }))).not.toThrow();
  });

  it('resets one lane without touching other lane evidence', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    matrix.record(signal(1, 1, { lane: 'critical' }));
    matrix.record(signal(2, 1, { lane: 'background' }));
    matrix.reset('background');
    expect(matrix.snapshot().lanes.background).toMatchObject({ severity: 'healthy', sampleCount: 0 });
    expect(matrix.snapshot().lanes.critical.severity).toBe('critical');
  });

  it('global reset clears evidence, history, severity and clock', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    matrix.record(signal(100, 1));
    matrix.reset();
    expect(matrix.snapshot().severity).toBe('healthy');
    expect(matrix.history()).toEqual([]);
    expect(() => matrix.record(signal(1, 0))).not.toThrow();
  });

  it('returns frozen policy and snapshots', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(Object.isFrozen(matrix.policy())).toBe(true);
    const snapshot = matrix.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.critical)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.critical.signals)).toBe(true);
  });

  it.each([
    [{ windowSize: 0 }, /windowSize/],
    [{ windowSize: 1.5 }, /windowSize/],
    [{ minimumSamples: 0 }, /minimumSamples/],
    [{ recoverySamples: 0 }, /recoverySamples/],
    [{ maximumHistory: -1 }, /maximumHistory/],
    [{ availabilityWeight: 0 }, /availabilityWeight/],
    [{ latencyWeight: 0 }, /latencyWeight/],
    [{ saturationWeight: 0 }, /saturationWeight/],
    [{ integrityWeight: 0 }, /integrityWeight/],
    [{ watchScore: -0.1 }, /watchScore/],
    [{ degradedScore: 1.1 }, /degradedScore/],
    [{ criticalScore: Number.NaN }, /criticalScore/],
  ] as const)('rejects malformed policy %o', (policy, pattern) => {
    expect(() => new RuntimeHealthEscalationMatrix(policy)).toThrow(pattern);
  });

  it('rejects minimum samples larger than the window', () => {
    expect(() => new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 3 })).toThrow(/must not exceed windowSize/);
  });

  it.each([
    [{ watchScore: 0.5, degradedScore: 0.5, criticalScore: 0.8 }, /strictly increasing/],
    [{ watchScore: 0.6, degradedScore: 0.5, criticalScore: 0.8 }, /strictly increasing/],
    [{ watchScore: 0.2, degradedScore: 0.8, criticalScore: 0.8 }, /strictly increasing/],
  ] as const)('rejects non-increasing thresholds', (policy, pattern) => {
    expect(() => new RuntimeHealthEscalationMatrix(policy)).toThrow(pattern);
  });

  it.each([
    [signal(-1, 0), /at/],
    [signal(1, -0.1), /pressure/],
    [signal(1, 1.1), /pressure/],
    [signal(1, Number.NaN), /pressure/],
  ] as const)('rejects malformed signal input', (input, pattern) => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.record(input)).toThrow(pattern);
  });

  it('rejects unsupported lanes at runtime', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.record(signal(1, 0, { lane: 'other' as RuntimeHealthSignal['lane'] }))).toThrow(/unsupported health lane/);
  });

  it('rejects unsupported signal kinds at runtime', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.record(signal(1, 0, { kind: 'other' as RuntimeHealthSignal['kind'] }))).toThrow(/unsupported health signal kind/);
  });

  it('treats exact threshold values as entering the corresponding severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    expect(matrix.record(signal(1, 0.25)).severity).toBe('watch');
    matrix.reset();
    expect(matrix.record(signal(1, 0.5)).severity).toBe('degraded');
    matrix.reset();
    expect(matrix.record(signal(1, 0.75)).severity).toBe('critical');
  });

  it('does not emit duplicate transitions while severity remains stable', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    matrix.record(signal(1, 1));
    matrix.record(signal(2, 1));
    matrix.record(signal(3, 1));
    expect(matrix.history()).toHaveLength(1);
  });

  it('includes sample count and score in transition evidence', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 0.8));
    matrix.record(signal(2, 0.8));
    expect(matrix.history()[0]).toMatchObject({ sampleCount: 2, score: 0.8 });
  });
});
