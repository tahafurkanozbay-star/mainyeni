import { describe, expect, it } from 'vitest';
import { RuntimeHealthEscalationMatrix, type RuntimeHealthSignal } from './runtimeHealthEscalationMatrix';

const signal = (at: number, pressure: number, overrides: Partial<RuntimeHealthSignal> = {}): RuntimeHealthSignal => ({ lane: 'interactive', kind: 'latency', pressure, at, ...overrides });
const mature = { windowSize: 4, minimumSamples: 2, recoverySamples: 2, watchScore: 0.25, degradedScore: 0.5, criticalScore: 0.75 } as const;

describe('RuntimeHealthEscalationMatrix', () => {
  it('stays healthy before evidence reaches maturity', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    expect(matrix.record(signal(1, 1))).toMatchObject({ severity: 'healthy', mature: false, sampleCount: 1 });
  });
  it('escalates directly to critical when mature score is critical', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 1));
    expect(matrix.record(signal(2, 1))).toMatchObject({ severity: 'critical', mature: true, score: 1 });
    expect(matrix.history()[0]).toMatchObject({ from: 'healthy', to: 'critical', at: 2 });
  });
  it('classifies watch and degraded thresholds', () => {
    const watch = new RuntimeHealthEscalationMatrix(mature);
    watch.record(signal(1, .3));
    expect(watch.record(signal(2, .3)).severity).toBe('watch');
    const degraded = new RuntimeHealthEscalationMatrix(mature);
    degraded.record(signal(1, .6));
    expect(degraded.record(signal(2, .6)).severity).toBe('degraded');
  });
  it('requires consecutive recovery evidence and recovers one level at a time', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2 });
    matrix.record(signal(1, 1)); matrix.record(signal(2, 1));
    matrix.record(signal(3, 0)); expect(matrix.snapshot().severity).toBe('critical');
    matrix.record(signal(4, 0)); expect(matrix.snapshot().severity).toBe('degraded');
    matrix.record(signal(5, 0)); matrix.record(signal(6, 0)); expect(matrix.snapshot().severity).toBe('watch');
    matrix.record(signal(7, 0)); matrix.record(signal(8, 0)); expect(matrix.snapshot().severity).toBe('healthy');
  });
  it('clears recovery streak when target equals current severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2 });
    matrix.record(signal(1, .6)); matrix.record(signal(2, .6)); matrix.record(signal(3, 0));
    expect(matrix.snapshot().lanes.interactive.healthyRecoverySamples).toBe(1);
    matrix.record(signal(4, 1));
    expect(matrix.snapshot().lanes.interactive).toMatchObject({ healthyRecoverySamples: 0, severity: 'degraded' });
  });
  it('tracks lanes independently and aggregates worst severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix(mature);
    matrix.record(signal(1, 1, { lane: 'background' })); matrix.record(signal(2, 1, { lane: 'background' }));
    matrix.record(signal(3, 0, { lane: 'critical' })); matrix.record(signal(4, 0, { lane: 'critical' }));
    expect(matrix.snapshot()).toMatchObject({ severity: 'critical', lanes: { background: { severity: 'critical' }, critical: { severity: 'healthy' } } });
  });
  it('weights integrity pressure more strongly than latency by default', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 2 });
    matrix.record(signal(1, 0, { kind: 'latency' }));
    expect(matrix.record(signal(2, 1, { kind: 'integrity' })).score).toBeGreaterThan(.5);
  });
  it('bounds the rolling evidence window', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 3, minimumSamples: 1 });
    matrix.record(signal(1,1)); matrix.record(signal(2,1)); matrix.record(signal(3,1)); matrix.record(signal(4,0));
    expect(matrix.snapshot().lanes.interactive).toMatchObject({ sampleCount: 3 });
    expect(matrix.snapshot().lanes.interactive.score).toBeCloseTo(2/3);
  });
  it('records bounded immutable transition history', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, windowSize: 2, minimumSamples: 1, recoverySamples: 1, maximumHistory: 2 });
    matrix.record(signal(1,1)); matrix.record(signal(2,0)); matrix.record(signal(3,0)); matrix.record(signal(4,0));
    expect(matrix.history().length).toBeLessThanOrEqual(2);
    expect(Object.isFrozen(matrix.history())).toBe(true);
  });
  it('rejects oversized and non-array batches', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.recordBatch(Array.from({ length: 10_001 }, (_, index) => signal(index, 0)))).toThrow(/batch exceeds/);
    expect(() => matrix.recordBatch(null as unknown as readonly RuntimeHealthSignal[])).toThrow(/must be an array/);
  });
  it('enforces a monotonic caller clock across lanes', () => {
    const matrix = new RuntimeHealthEscalationMatrix();
    matrix.record(signal(10,0,{lane:'background'}));
    expect(() => matrix.record(signal(9,0,{lane:'critical'}))).toThrow(/monotonic/);
  });
  it('global reset clears evidence, history, severity and clock', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    matrix.record(signal(100,1)); matrix.reset();
    expect(matrix.snapshot().severity).toBe('healthy'); expect(matrix.history()).toEqual([]);
    expect(() => matrix.record(signal(1,0))).not.toThrow();
  });
  it('rejects malformed policy and signals', () => {
    expect(() => new RuntimeHealthEscalationMatrix({ windowSize: 0 })).toThrow(/windowSize/);
    expect(() => new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 3 })).toThrow(/must not exceed/);
    expect(() => new RuntimeHealthEscalationMatrix({ watchScore: .5, degradedScore: .5 })).toThrow(/strictly increasing/);
    const matrix = new RuntimeHealthEscalationMatrix();
    expect(() => matrix.record(signal(-1,0))).toThrow(/at/);
    expect(() => matrix.record(signal(1,1.1))).toThrow(/pressure/);
  });
  it('treats exact threshold values as entering corresponding severity', () => {
    const matrix = new RuntimeHealthEscalationMatrix({ ...mature, minimumSamples: 1 });
    expect(matrix.record(signal(1,.25)).severity).toBe('watch'); matrix.reset();
    expect(matrix.record(signal(1,.5)).severity).toBe('degraded'); matrix.reset();
    expect(matrix.record(signal(1,.75)).severity).toBe('critical');
  });
});
