import { describe, expect, it } from 'vitest';
import {
  ArcGisRendererBudgetPlanner,
  type ArcGisRendererBudgetPolicy,
  type ArcGisRendererBudgetRequest,
} from './ArcGisRendererBudgetPlanner';

const policy: ArcGisRendererBudgetPolicy = {
  maxLayerKeyLength: 64,
  maxFeatures2d: 10_000,
  maxFeatures3d: 4_000,
  maxUniqueValues: 64,
  maxClassBreaks: 20,
  maxSymbols: 80,
  maxSymbolLayers: 160,
  maxLabelClasses: 8,
  maxVisualVariables: 4,
  maxColorOpacityStops: 8,
  maxSizeStops: 6,
  maxRotationStops: 4,
  maxGpuBytesPerFrame: 64_000_000,
  maxCpuMsPerFrame: 12,
  maxDrawCallsPerFrame: 200,
  maxComplexityUnits: 1_000,
  clusterRecommendationThreshold: 5_000,
  threeDimensionalCostPercent: 150,
};

const planner = () => new ArcGisRendererBudgetPlanner(policy);

const request = (overrides: Partial<ArcGisRendererBudgetRequest> = {}): ArcGisRendererBudgetRequest => ({
  layerKey: 'parcels',
  viewMode: '2d',
  geometryType: 'polygon',
  rendererType: 'simple',
  featureCountEstimate: 1_000,
  uniqueValueCount: 0,
  classBreakCount: 0,
  symbolCount: 1,
  symbolLayerCount: 2,
  labelClassCount: 1,
  visualVariables: [],
  gpuBytesPerFeature: 1_000,
  cpuMicrosPerFeature: 5,
  expectedDrawCalls: 20,
  clusterEnabled: false,
  ...overrides,
});

describe('ArcGisRendererBudgetPlanner', () => {
  it('admits a bounded 2D renderer at full quality', () => {
    const plan = planner().plan(request());
    expect(plan.qualityTier).toBe('full');
    expect(plan.admittedFeatureCount).toBe(1_000);
    expect(plan.admissionRatio).toBe(1);
    expect(plan.estimatedGpuBytes).toBe(1_000_000);
    expect(plan.estimatedCpuMs).toBe(5);
    expect(plan.reasons).toEqual([]);
  });

  it('applies the configured lower 3D feature and cost budget deterministically', () => {
    const plan = planner().plan(request({
      viewMode: '3d',
      featureCountEstimate: 8_000,
      gpuBytesPerFeature: 4_000,
      cpuMicrosPerFeature: 1,
    }));
    expect(plan.admittedFeatureCount).toBe(4_000);
    expect(plan.qualityTier).toBe('reduced');
    expect(plan.reasons).toContain('feature-budget');
    expect(plan.estimatedGpuBytes).toBe(24_000_000);
  });

  it('reduces feature admission when GPU budget is the limiting resource', () => {
    const plan = planner().plan(request({ featureCountEstimate: 10_000, gpuBytesPerFeature: 10_000, cpuMicrosPerFeature: 0 }));
    expect(plan.admittedFeatureCount).toBe(6_400);
    expect(plan.qualityTier).toBe('reduced');
    expect(plan.reasons).toContain('gpu-budget');
    expect(plan.estimatedGpuBytes).toBe(64_000_000);
  });

  it('reduces feature admission when CPU frame budget is the limiting resource', () => {
    const plan = planner().plan(request({ featureCountEstimate: 10_000, gpuBytesPerFeature: 0, cpuMicrosPerFeature: 4 }));
    expect(plan.admittedFeatureCount).toBe(3_000);
    expect(plan.qualityTier).toBe('minimum');
    expect(plan.reasons).toContain('cpu-budget');
    expect(plan.estimatedCpuMs).toBe(12);
  });

  it('rejects structurally excessive draw-call pressure before allocation', () => {
    const plan = planner().plan(request({ expectedDrawCalls: 201 }));
    expect(plan.qualityTier).toBe('rejected');
    expect(plan.admittedFeatureCount).toBe(0);
    expect(plan.reasons).toContain('draw-call-budget');
  });

  it('rejects unique-value renderer cardinality over policy', () => {
    const plan = planner().plan(request({
      rendererType: 'unique-value',
      geometryType: 'point',
      uniqueValueCount: 65,
      symbolCount: 66,
    }));
    expect(plan.qualityTier).toBe('rejected');
    expect(plan.reasons).toContain('unique-value-complexity');
  });

  it('rejects class-break renderer cardinality over policy', () => {
    const plan = planner().plan(request({ rendererType: 'class-breaks', classBreakCount: 21, symbolCount: 22 }));
    expect(plan.qualityTier).toBe('rejected');
    expect(plan.reasons).toContain('class-break-complexity');
  });

  it('validates renderer-specific cardinality contracts fail-closed', () => {
    const p = planner();
    expect(() => p.plan(request({ rendererType: 'simple', uniqueValueCount: 1 }))).toThrow('simple renderer cannot declare');
    expect(() => p.plan(request({ rendererType: 'unique-value', uniqueValueCount: 0 }))).toThrow('invalid unique-value renderer cardinality');
    expect(() => p.plan(request({ rendererType: 'class-breaks', classBreakCount: 0 }))).toThrow('invalid class-breaks renderer cardinality');
  });

  it('accepts the four ArcGIS visual-variable classes with bounded stop counts', () => {
    const plan = planner().plan(request({
      visualVariables: [
        { type: 'color', stopCount: 8 },
        { type: 'opacity', stopCount: 8 },
        { type: 'rotation', stopCount: 4 },
        { type: 'size', stopCount: 6 },
      ],
    }));
    expect(plan.qualityTier).toBe('full');
    expect(plan.reasons).not.toContain('visual-variable-complexity');
  });

  it('rejects color, opacity, size and rotation stop counts over configured bounds', () => {
    const p = planner();
    for (const visualVariables of [
      [{ type: 'color' as const, stopCount: 9 }],
      [{ type: 'opacity' as const, stopCount: 9 }],
      [{ type: 'size' as const, stopCount: 7 }],
      [{ type: 'rotation' as const, stopCount: 5 }],
    ]) {
      expect(p.plan(request({ visualVariables })).reasons).toContain('visual-variable-complexity');
    }
  });

  it('rejects duplicate or unsupported visual-variable types', () => {
    const p = planner();
    expect(() => p.plan(request({ visualVariables: [{ type: 'color', stopCount: 2 }, { type: 'color', stopCount: 3 }] }))).toThrow('duplicate visual variable type');
    expect(() => p.plan(request({ visualVariables: [{ type: 'blur' as never, stopCount: 2 }] }))).toThrow('unsupported visual variable type');
  });

  it('rejects symbol and label complexity over hard policy bounds', () => {
    const p = planner();
    expect(p.plan(request({ symbolCount: 81 })).reasons).toContain('symbol-complexity');
    expect(p.plan(request({ symbolLayerCount: 161 })).reasons).toContain('symbol-complexity');
    expect(p.plan(request({ labelClassCount: 9 })).reasons).toContain('label-complexity');
  });

  it('rejects aggregate renderer complexity even when individual counts are bounded', () => {
    const constrained = new ArcGisRendererBudgetPlanner({ ...policy, maxComplexityUnits: 20 });
    const plan = constrained.plan(request({
      rendererType: 'unique-value',
      uniqueValueCount: 4,
      symbolCount: 5,
      symbolLayerCount: 4,
      labelClassCount: 1,
      visualVariables: [{ type: 'color', stopCount: 2 }],
    }));
    expect(plan.qualityTier).toBe('rejected');
    expect(plan.reasons).toContain('symbol-complexity');
  });

  it('recommends clustering only for high-pressure point or multipoint layers', () => {
    expect(planner().plan(request({ geometryType: 'point', featureCountEstimate: 5_000 })).clusterRecommended).toBe(true);
    expect(planner().plan(request({ geometryType: 'multipoint', featureCountEstimate: 5_000 })).clusterRecommended).toBe(true);
    expect(planner().plan(request({ geometryType: 'polyline', featureCountEstimate: 8_000 })).clusterRecommended).toBe(false);
    expect(planner().plan(request({ geometryType: 'point', featureCountEstimate: 8_000, clusterEnabled: true })).clusterRecommended).toBe(false);
  });

  it('recommends clustering for a point layer when resource pressure truncates admission', () => {
    const plan = planner().plan(request({ geometryType: 'point', featureCountEstimate: 4_000, gpuBytesPerFeature: 32_000 }));
    expect(plan.admittedFeatureCount).toBe(2_000);
    expect(plan.clusterRecommended).toBe(true);
  });

  it('uses full quality for an empty but structurally valid layer', () => {
    const plan = planner().plan(request({ featureCountEstimate: 0, gpuBytesPerFeature: 0, cpuMicrosPerFeature: 0 }));
    expect(plan.qualityTier).toBe('full');
    expect(plan.admissionRatio).toBe(1);
    expect(plan.admittedFeatureCount).toBe(0);
  });

  it('returns rejected when resource budgets cannot admit even one requested feature', () => {
    const constrained = new ArcGisRendererBudgetPlanner({ ...policy, maxGpuBytesPerFrame: 100 });
    const plan = constrained.plan(request({ featureCountEstimate: 10, gpuBytesPerFeature: 101, cpuMicrosPerFeature: 0 }));
    expect(plan.qualityTier).toBe('rejected');
    expect(plan.admittedFeatureCount).toBe(0);
    expect(plan.reasons).toContain('gpu-budget');
  });

  it('deduplicates deterministic rejection reasons', () => {
    const constrained = new ArcGisRendererBudgetPlanner({ ...policy, maxComplexityUnits: 1 });
    const plan = constrained.plan(request({ symbolCount: 81, symbolLayerCount: 161 }));
    expect(plan.reasons.filter((reason) => reason === 'symbol-complexity')).toHaveLength(1);
  });

  it('rejects malformed layer identity and renderer enums', () => {
    const p = planner();
    expect(() => p.plan(request({ layerKey: '\0bad' }))).toThrow();
    expect(() => p.plan(request({ viewMode: '4d' as never }))).toThrow('invalid renderer view mode');
    expect(() => p.plan(request({ geometryType: 'mesh' as never }))).toThrow('invalid renderer geometry type');
    expect(() => p.plan(request({ rendererType: 'dictionary' as never }))).toThrow('unsupported renderer type');
  });

  it('rejects negative, non-finite and unsafe workload estimates', () => {
    const p = planner();
    expect(() => p.plan(request({ featureCountEstimate: -1 }))).toThrow();
    expect(() => p.plan(request({ cpuMicrosPerFeature: Number.NaN }))).toThrow();
    expect(() => p.plan(request({ gpuBytesPerFeature: Number.MAX_SAFE_INTEGER + 1 }))).toThrow();
  });

  it('rejects invalid planner policies', () => {
    expect(() => new ArcGisRendererBudgetPlanner({ ...policy, maxCpuMsPerFrame: 0 })).toThrow('maxCpuMsPerFrame must be positive');
    expect(() => new ArcGisRendererBudgetPlanner({ ...policy, threeDimensionalCostPercent: 99 })).toThrow('threeDimensionalCostPercent must be at least 100');
  });

  it('returns immutable reason lists and plan objects', () => {
    const plan = planner().plan(request({ featureCountEstimate: 20_000 }));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
  });
});
