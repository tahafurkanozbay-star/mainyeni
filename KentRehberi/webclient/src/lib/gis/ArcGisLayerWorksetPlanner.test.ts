import { describe, expect, it } from 'vitest';
import {
  ArcGisLayerWorksetPlanner,
  type ArcGisLayerWorksetCandidate,
  type ArcGisLayerWorksetPolicy,
} from './ArcGisLayerWorksetPlanner';

const policy: ArcGisLayerWorksetPolicy = {
  maxCandidates: 12,
  maxLayerKeyLength: 64,
  maxActiveLayers2d: 4,
  maxActiveLayers3d: 2,
  maxFeatures2d: 20_000,
  maxFeatures3d: 8_000,
  maxCpuMs2d: 12,
  maxCpuMs3d: 8,
  maxGpuBytes2d: 64_000_000,
  maxGpuBytes3d: 48_000_000,
  maxDrawCalls2d: 240,
  maxDrawCalls3d: 140,
};

const planner = () => new ArcGisLayerWorksetPlanner(policy);

const candidate = (layerKey: string, overrides: Partial<ArcGisLayerWorksetCandidate> = {}): ArcGisLayerWorksetCandidate => ({
  layerKey,
  priority: 'visible',
  health: 'available',
  requestedVisible: true,
  minScale: 0,
  maxScale: 0,
  featureCountEstimate: 1_000,
  cpuMsEstimate: 1,
  gpuBytesEstimate: 2_000_000,
  drawCallsEstimate: 20,
  ...overrides,
});

describe('ArcGisLayerWorksetPlanner', () => {
  it('admits bounded visible layers and aggregates resource estimates', () => {
    const plan = planner().plan('2d', 50_000, [candidate('a'), candidate('b')]);
    expect(plan.admittedLayerKeys).toEqual(['a', 'b']);
    expect(plan.activeLayerCount).toBe(2);
    expect(plan.featureCountEstimate).toBe(2_000);
    expect(plan.cpuMsEstimate).toBe(2);
    expect(plan.gpuBytesEstimate).toBe(4_000_000);
    expect(plan.drawCallsEstimate).toBe(40);
  });

  it('prioritizes critical then visible then background candidates deterministically', () => {
    const plan = new ArcGisLayerWorksetPlanner({ ...policy, maxActiveLayers2d: 2 }).plan('2d', 50_000, [
      candidate('background', { priority: 'background' }),
      candidate('visible', { priority: 'visible' }),
      candidate('critical', { priority: 'critical' }),
    ]);
    expect(plan.admittedLayerKeys).toEqual(['critical', 'visible']);
    expect(plan.rejected).toContainEqual({ layerKey: 'background', reason: 'active-layer-budget' });
  });

  it('prefers available over degraded layers within the same priority', () => {
    const plan = new ArcGisLayerWorksetPlanner({ ...policy, maxActiveLayers2d: 1 }).plan('2d', 50_000, [
      candidate('degraded', { health: 'degraded' }),
      candidate('available', { health: 'available' }),
    ]);
    expect(plan.admittedLayerKeys).toEqual(['available']);
  });

  it('rejects unavailable layers before resource admission', () => {
    const plan = planner().plan('2d', 50_000, [candidate('offline', { health: 'unavailable' }), candidate('healthy')]);
    expect(plan.admittedLayerKeys).toEqual(['healthy']);
    expect(plan.rejected).toContainEqual({ layerKey: 'offline', reason: 'unavailable' });
  });

  it('rejects user-hidden layers without consuming budgets', () => {
    const plan = planner().plan('2d', 50_000, [candidate('hidden', { requestedVisible: false, featureCountEstimate: 100_000 }), candidate('visible')]);
    expect(plan.admittedLayerKeys).toEqual(['visible']);
    expect(plan.rejected).toContainEqual({ layerKey: 'hidden', reason: 'hidden' });
  });

  it('implements ArcGIS minScale/maxScale visibility semantics', () => {
    const bounded = candidate('bounded', { minScale: 100_000, maxScale: 10_000 });
    expect(planner().plan('2d', 50_000, [bounded]).admittedLayerKeys).toEqual(['bounded']);
    expect(planner().plan('2d', 200_000, [bounded]).rejected).toContainEqual({ layerKey: 'bounded', reason: 'scale-range' });
    expect(planner().plan('2d', 5_000, [bounded]).rejected).toContainEqual({ layerKey: 'bounded', reason: 'scale-range' });
  });

  it('treats zero minScale and maxScale as unbounded', () => {
    expect(planner().plan('2d', 1, [candidate('a')]).admittedLayerKeys).toEqual(['a']);
    expect(planner().plan('2d', 1_000_000_000, [candidate('a')]).admittedLayerKeys).toEqual(['a']);
  });

  it('uses stricter 3D active-layer capacity', () => {
    const plan = planner().plan('3d', 50_000, [candidate('a'), candidate('b'), candidate('c')]);
    expect(plan.admittedLayerKeys).toEqual(['a', 'b']);
    expect(plan.rejected).toContainEqual({ layerKey: 'c', reason: 'active-layer-budget' });
  });

  it('enforces feature budget without starving a cheaper later layer', () => {
    const plan = planner().plan('2d', 50_000, [
      candidate('heavy', { priority: 'critical', featureCountEstimate: 20_001 }),
      candidate('small', { priority: 'visible', featureCountEstimate: 1_000 }),
    ]);
    expect(plan.rejected).toContainEqual({ layerKey: 'heavy', reason: 'feature-budget' });
    expect(plan.admittedLayerKeys).toEqual(['small']);
  });

  it('admits candidates up to the exact CPU budget boundary', () => {
    const plan = planner().plan('2d', 50_000, [
      candidate('a', { cpuMsEstimate: 7 }),
      candidate('b', { cpuMsEstimate: 5 }),
    ]);
    expect(plan.admittedLayerKeys).toEqual(['b', 'a']);
    expect(plan.cpuMsEstimate).toBe(12);
  });

  it('sorts lower CPU candidates first before enforcing CPU budget', () => {
    const constrained = new ArcGisLayerWorksetPlanner({ ...policy, maxCpuMs2d: 10 });
    const plan = constrained.plan('2d', 50_000, [candidate('heavy', { cpuMsEstimate: 8 }), candidate('light', { cpuMsEstimate: 3 })]);
    expect(plan.admittedLayerKeys).toEqual(['light']);
    expect(plan.rejected).toContainEqual({ layerKey: 'heavy', reason: 'cpu-budget' });
  });

  it('enforces GPU and draw-call budgets independently', () => {
    const constrained = new ArcGisLayerWorksetPlanner({ ...policy, maxGpuBytes2d: 5_000_000, maxDrawCalls2d: 30 });
    const gpu = constrained.plan('2d', 50_000, [candidate('gpu', { gpuBytesEstimate: 6_000_000 })]);
    expect(gpu.rejected).toContainEqual({ layerKey: 'gpu', reason: 'gpu-budget' });
    const draw = constrained.plan('2d', 50_000, [candidate('draw', { drawCallsEstimate: 31 })]);
    expect(draw.rejected).toContainEqual({ layerKey: 'draw', reason: 'draw-call-budget' });
  });

  it('keeps rejected output deterministic by layer key', () => {
    const plan = planner().plan('2d', 50_000, [
      candidate('z', { requestedVisible: false }),
      candidate('a', { health: 'unavailable' }),
    ]);
    expect(plan.rejected.map((entry) => entry.layerKey)).toEqual(['a', 'z']);
  });

  it('rejects duplicate layer identities fail-closed', () => {
    expect(() => planner().plan('2d', 50_000, [candidate('same'), candidate('same')])).toThrow('duplicate layer workset candidate');
  });

  it('rejects inverted ArcGIS scale ranges', () => {
    expect(() => planner().plan('2d', 50_000, [candidate('bad', { minScale: 10_000, maxScale: 100_000 })])).toThrow('minScale must be zero or greater than or equal to maxScale');
  });

  it('rejects malformed layer identity, enums and visibility flags', () => {
    const p = planner();
    expect(() => p.plan('2d', 50_000, [candidate('\0bad')])).toThrow();
    expect(() => p.plan('4d' as never, 50_000, [candidate('a')])).toThrow('invalid workset view mode');
    expect(() => p.plan('2d', 50_000, [candidate('a', { priority: 'urgent' as never })])).toThrow('invalid layer workset priority');
    expect(() => p.plan('2d', 50_000, [candidate('a', { health: 'unknown' as never })])).toThrow('invalid layer workset health');
    expect(() => p.plan('2d', 50_000, [candidate('a', { requestedVisible: 1 as never })])).toThrow('requestedVisible must be boolean');
  });

  it('rejects malformed and unsafe resource estimates', () => {
    const p = planner();
    expect(() => p.plan('2d', Number.NaN, [candidate('a')])).toThrow();
    expect(() => p.plan('2d', 50_000, [candidate('a', { featureCountEstimate: -1 })])).toThrow();
    expect(() => p.plan('2d', 50_000, [candidate('a', { gpuBytesEstimate: Number.MAX_SAFE_INTEGER + 1 })])).toThrow();
    expect(() => p.plan('2d', 50_000, [candidate('a', { cpuMsEstimate: Number.POSITIVE_INFINITY })])).toThrow();
  });

  it('enforces candidate count before allocating normalized workset state', () => {
    const constrained = new ArcGisLayerWorksetPlanner({ ...policy, maxCandidates: 2 });
    expect(() => constrained.plan('2d', 50_000, [candidate('a'), candidate('b'), candidate('c')])).toThrow('candidate count outside configured bounds');
  });

  it('returns immutable plan arrays', () => {
    const plan = planner().plan('2d', 50_000, [candidate('a')]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.admittedLayerKeys)).toBe(true);
    expect(Object.isFrozen(plan.rejected)).toBe(true);
  });

  it('rejects invalid policy frame budgets', () => {
    expect(() => new ArcGisLayerWorksetPlanner({ ...policy, maxCpuMs2d: 0 })).toThrow('maxCpuMs2d must be positive');
  });
});
