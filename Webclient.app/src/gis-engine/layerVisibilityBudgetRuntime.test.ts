import { describe, expect, it } from 'vitest';
import {
  planLayerVisibility,
  scaleLayerVisibilityBudget,
  selectLayerVisibilityBudget,
  type LayerVisibilityBudget,
  type LayerVisibilityCandidate,
} from './layerVisibilityBudgetRuntime';

const budget: LayerVisibilityBudget = {
  maxLayers: 2,
  maxFeatures: 1000,
  maxDrawCalls: 20,
  maxGpuBytes: 10_000,
  maxCpuBytes: 20_000,
};

function layer(overrides: Partial<LayerVisibilityCandidate> = {}): LayerVisibilityCandidate {
  return {
    id: 'a',
    kind: 'feature',
    priority: 'normal',
    visible: true,
    estimatedFeatures: 100,
    estimatedDrawCalls: 2,
    estimatedGpuBytes: 1000,
    estimatedCpuBytes: 2000,
    ...overrides,
  };
}

const context = { scale: 10_000, now: 100, mode: '2d' as const };

describe('planLayerVisibility', () => {
  it('admits eligible layers while reporting immutable usage', () => {
    const result = planLayerVisibility([layer(), layer({ id: 'b' })], budget, context);
    expect(result.admittedIds).toEqual(['a', 'b']);
    expect(result.rejectedIds).toEqual([]);
    expect(result.usage).toEqual({ layers: 2, features: 200, drawCalls: 4, gpuBytes: 2000, cpuBytes: 4000 });
    expect(result.pressure).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  it('rejects hidden and out-of-scale candidates before budget admission', () => {
    const result = planLayerVisibility([
      layer({ id: 'hidden', visible: false }),
      layer({ id: 'too-far', minScale: 5000 }),
      layer({ id: 'too-close', maxScale: 20_000 }),
    ], budget, context);
    expect(result.decisions).toEqual([
      { id: 'hidden', admitted: false, reason: 'hidden' },
      { id: 'too-far', admitted: false, reason: 'outside-scale' },
      { id: 'too-close', admitted: false, reason: 'outside-scale' },
    ]);
  });

  it('prioritizes critical work deterministically under layer pressure', () => {
    const result = planLayerVisibility([
      layer({ id: 'low', priority: 'low' }),
      layer({ id: 'critical', priority: 'critical' }),
      layer({ id: 'high', priority: 'high' }),
    ], { ...budget, maxLayers: 1 }, context);
    expect(result.admittedIds).toEqual(['critical']);
    expect(result.decisions.find((entry) => entry.id === 'high')?.reason).toBe('layer-budget');
  });

  it('uses recency and then lower render cost as deterministic tie breakers', () => {
    const result = planLayerVisibility([
      layer({ id: 'old', lastVisibleAt: 1 }),
      layer({ id: 'recent', lastVisibleAt: 2 }),
    ], { ...budget, maxLayers: 1 }, context);
    expect(result.admittedIds).toEqual(['recent']);

    const costResult = planLayerVisibility([
      layer({ id: 'expensive', estimatedDrawCalls: 5 }),
      layer({ id: 'cheap', estimatedDrawCalls: 1 }),
    ], { ...budget, maxLayers: 1 }, context);
    expect(costResult.admittedIds).toEqual(['cheap']);
  });

  it.each([
    ['feature-budget', { estimatedFeatures: 1001 }],
    ['draw-call-budget', { estimatedDrawCalls: 21 }],
    ['gpu-budget', { estimatedGpuBytes: 10_001 }],
    ['cpu-budget', { estimatedCpuBytes: 20_001 }],
  ] as const)('reports %s independently', (reason, overrides) => {
    const result = planLayerVisibility([layer(overrides)], budget, context);
    expect(result.decisions[0]).toEqual({ id: 'a', admitted: false, reason });
    expect(result.usage.layers).toBe(0);
  });

  it('does not let a rejected expensive layer consume later capacity', () => {
    const result = planLayerVisibility([
      layer({ id: 'expensive', priority: 'critical', estimatedGpuBytes: 20_000 }),
      layer({ id: 'fit', priority: 'normal' }),
    ], budget, context);
    expect(result.admittedIds).toEqual(['fit']);
    expect(result.decisions[0]?.reason).toBe('gpu-budget');
  });

  it('rejects duplicate ids to keep downstream layer identity deterministic', () => {
    expect(() => planLayerVisibility([layer(), layer()], budget, context)).toThrow('duplicate layer id: a');
  });

  it('validates candidate estimates and scale context', () => {
    expect(() => planLayerVisibility([layer({ estimatedFeatures: -1 })], budget, context)).toThrow(RangeError);
    expect(() => planLayerVisibility([layer({ id: ' ' })], budget, context)).toThrow(TypeError);
    expect(() => planLayerVisibility([layer()], budget, { ...context, scale: Number.NaN })).toThrow(RangeError);
  });
});

describe('budget helpers', () => {
  it('selects a validated 2d or 3d budget', () => {
    const mode3d = { ...budget, maxLayers: 1 };
    const profile = { mode2d: budget, mode3d };
    expect(selectLayerVisibilityBudget(profile, '2d')).toBe(budget);
    expect(selectLayerVisibilityBudget(profile, '3d')).toBe(mode3d);
  });

  it('scales all budgets down without producing zero capacity', () => {
    expect(scaleLayerVisibilityBudget({ maxLayers: 1, maxFeatures: 2, maxDrawCalls: 3, maxGpuBytes: 4, maxCpuBytes: 5 }, 0.1)).toEqual({
      maxLayers: 1,
      maxFeatures: 1,
      maxDrawCalls: 1,
      maxGpuBytes: 1,
      maxCpuBytes: 1,
    });
  });

  it('rejects unsafe scaling factors and invalid budgets', () => {
    expect(() => scaleLayerVisibilityBudget(budget, 0)).toThrow(RangeError);
    expect(() => scaleLayerVisibilityBudget(budget, 1.1)).toThrow(RangeError);
    expect(() => selectLayerVisibilityBudget({ mode2d: { ...budget, maxLayers: 0 }, mode3d: budget }, '2d')).toThrow(RangeError);
  });
});
