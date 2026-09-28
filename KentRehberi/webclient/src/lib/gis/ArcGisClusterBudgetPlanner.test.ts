import { describe, expect, it } from 'vitest';
import {
  ArcGisClusterBudgetPlanner,
  type ArcGisClusterBudgetPolicy,
  type ArcGisClusterBudgetRequest,
} from './ArcGisClusterBudgetPlanner';

const policy: ArcGisClusterBudgetPolicy = {
  maxLayerKeyLength: 64,
  directFeatureThreshold2d: 2_000,
  directFeatureThreshold3d: 1_000,
  minClusterRadiusPx: 20,
  maxClusterRadiusPx: 160,
  minClusterSymbolSizePx: 8,
  maxClusterSymbolSizePx: 96,
  maxAggregateFields: 12,
  maxLabelClasses: 4,
  maxPopupFields: 16,
  maxEstimatedClusters: 500,
  maxClusterMemoryBytes: 2_000_000,
  estimatedBytesPerCluster: 2_000,
  maxViewportPixelArea: 20_000_000,
};

const planner = () => new ArcGisClusterBudgetPlanner(policy);

const request = (overrides: Partial<ArcGisClusterBudgetRequest> = {}): ArcGisClusterBudgetRequest => ({
  layerKey: 'incidents',
  viewMode: '2d',
  geometryType: 'point',
  featureCountEstimate: 10_000,
  viewportPixelArea: 2_000_000,
  requestedRadiusPx: 60,
  clusterMinSizePx: 16,
  clusterMaxSizePx: 48,
  aggregateFieldCount: 3,
  labelClassCount: 1,
  popupFieldCount: 5,
  viewScale: 100_000,
  clusterMaxScale: 50_000,
  clusteringSupported: true,
  ...overrides,
});

describe('ArcGisClusterBudgetPlanner', () => {
  it('admits clustering for dense layers with bounded estimates', () => {
    const plan = planner().plan(request());
    expect(plan.mode).toBe('cluster');
    expect(plan.clusterRadiusPx).toBe(60);
    expect(plan.estimatedClusterCount).toBeGreaterThan(0);
    expect(plan.estimatedClusterCount).toBeLessThanOrEqual(500);
    expect(plan.estimatedClusterMemoryBytes).toBeLessThanOrEqual(2_000_000);
    expect(plan.reasons).toEqual([]);
  });

  it('keeps small layers on direct rendering without cluster allocation', () => {
    const plan = planner().plan(request({ featureCountEstimate: 1_000 }));
    expect(plan.mode).toBe('direct');
    expect(plan.clusterRadiusPx).toBe(0);
    expect(plan.estimatedClusterCount).toBe(0);
  });

  it('uses the stricter 3D direct feature threshold', () => {
    const plan = planner().plan(request({ viewMode: '3d', featureCountEstimate: 1_500 }));
    expect(plan.mode).toBe('cluster');
  });

  it('supports current ArcGIS clustering across point, multipoint, polyline and polygon geometries', () => {
    const p = planner();
    for (const geometryType of ['point', 'multipoint', 'polyline', 'polygon'] as const) {
      expect(p.plan(request({ geometryType })).mode).toBe('cluster');
    }
  });

  it('disables clustering beyond clusterMaxScale and rejects dense direct fallback', () => {
    const plan = planner().plan(request({ viewScale: 25_000, clusterMaxScale: 50_000 }));
    expect(plan.mode).toBe('reject');
    expect(plan.scaleAllowsClustering).toBe(false);
    expect(plan.reasons).toEqual(expect.arrayContaining(['scale-disables-clustering', 'direct-feature-budget']));
  });

  it('allows direct rendering beyond clusterMaxScale when feature count is bounded', () => {
    const plan = planner().plan(request({ featureCountEstimate: 1_000, viewScale: 25_000, clusterMaxScale: 50_000 }));
    expect(plan.mode).toBe('direct');
    expect(plan.scaleAllowsClustering).toBe(false);
  });

  it('treats maxScale zero as clustering enabled at every view scale', () => {
    const plan = planner().plan(request({ viewScale: 1, clusterMaxScale: 0 }));
    expect(plan.mode).toBe('cluster');
    expect(plan.scaleAllowsClustering).toBe(true);
  });

  it('rejects dense layers when the adapter reports clustering unsupported', () => {
    const plan = planner().plan(request({ clusteringSupported: false }));
    expect(plan.mode).toBe('reject');
    expect(plan.reasons).toEqual(expect.arrayContaining(['clustering-unsupported', 'direct-feature-budget']));
  });

  it('allows bounded direct rendering when clustering is unsupported', () => {
    const plan = planner().plan(request({ clusteringSupported: false, featureCountEstimate: 1_000 }));
    expect(plan.mode).toBe('direct');
  });

  it('increases cluster radius deterministically to satisfy cluster-count memory bounds', () => {
    const constrained = new ArcGisClusterBudgetPlanner({ ...policy, maxEstimatedClusters: 20, maxClusterMemoryBytes: 40_000 });
    const plan = constrained.plan(request({ viewportPixelArea: 10_000_000, requestedRadiusPx: 20 }));
    expect(plan.mode).toBe('cluster');
    expect(plan.clusterRadiusPx).toBeGreaterThan(20);
    expect(plan.estimatedClusterCount).toBeLessThanOrEqual(20);
    expect(plan.estimatedClusterMemoryBytes).toBeLessThanOrEqual(40_000);
  });

  it('rejects when even maximum cluster radius cannot satisfy memory pressure', () => {
    const constrained = new ArcGisClusterBudgetPlanner({
      ...policy,
      maxClusterRadiusPx: 30,
      maxEstimatedClusters: 1,
      maxClusterMemoryBytes: 2_000,
    });
    const plan = constrained.plan(request({ viewportPixelArea: 20_000_000, requestedRadiusPx: 20 }));
    expect(plan.mode).toBe('reject');
    expect(plan.reasons).toEqual(expect.arrayContaining(['cluster-memory-budget', 'direct-feature-budget']));
  });

  it('clamps a too-small requested radius up to policy minimum', () => {
    const plan = planner().plan(request({ requestedRadiusPx: 1 }));
    expect(plan.mode).toBe('cluster');
    expect(plan.clusterRadiusPx).toBeGreaterThanOrEqual(20);
  });

  it('clamps a too-large requested radius down to policy maximum', () => {
    const plan = planner().plan(request({ requestedRadiusPx: 1_000 }));
    expect(plan.mode).toBe('cluster');
    expect(plan.clusterRadiusPx).toBeLessThanOrEqual(160);
  });

  it('rejects cluster symbol sizing outside bounded policy', () => {
    const p = planner();
    expect(p.plan(request({ clusterMinSizePx: 7 })).reasons).toContain('cluster-size-budget');
    expect(p.plan(request({ clusterMaxSizePx: 97 })).reasons).toContain('cluster-size-budget');
    expect(p.plan(request({ clusterMinSizePx: 60, clusterMaxSizePx: 40 })).reasons).toContain('cluster-size-budget');
  });

  it('rejects aggregate field, label and popup complexity beyond policy', () => {
    const p = planner();
    expect(p.plan(request({ aggregateFieldCount: 13 })).reasons).toContain('aggregate-field-budget');
    expect(p.plan(request({ labelClassCount: 5 })).reasons).toContain('label-budget');
    expect(p.plan(request({ popupFieldCount: 17 })).reasons).toContain('popup-field-budget');
  });

  it('rejects viewport areas over the configured pixel budget', () => {
    expect(() => planner().plan(request({ viewportPixelArea: 20_000_001 }))).toThrow('viewportPixelArea exceeds configured bound');
  });

  it('rejects malformed identities, enums and numeric state', () => {
    const p = planner();
    expect(() => p.plan(request({ layerKey: '\0bad' }))).toThrow();
    expect(() => p.plan(request({ viewMode: '4d' as never }))).toThrow('invalid cluster view mode');
    expect(() => p.plan(request({ geometryType: 'mesh' as never }))).toThrow('invalid cluster geometry type');
    expect(() => p.plan(request({ featureCountEstimate: -1 }))).toThrow();
    expect(() => p.plan(request({ requestedRadiusPx: Number.NaN }))).toThrow();
  });

  it('rejects malformed clustering capability flags', () => {
    expect(() => planner().plan(request({ clusteringSupported: 'yes' as never }))).toThrow('clusteringSupported must be boolean');
  });

  it('rejects invalid radius and symbol-size policy bounds', () => {
    expect(() => new ArcGisClusterBudgetPlanner({ ...policy, minClusterRadiusPx: 100, maxClusterRadiusPx: 50 })).toThrow('invalid cluster radius policy');
    expect(() => new ArcGisClusterBudgetPlanner({ ...policy, minClusterSymbolSizePx: 100, maxClusterSymbolSizePx: 50 })).toThrow('invalid cluster symbol size policy');
  });

  it('returns immutable plans and reason arrays', () => {
    const plan = planner().plan(request());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
  });
});
