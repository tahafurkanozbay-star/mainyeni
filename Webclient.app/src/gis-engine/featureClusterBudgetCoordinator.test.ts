import { describe, expect, it } from 'vitest';
import { FeatureClusterBudgetCoordinator, type ClusterLayerDescriptor } from './featureClusterBudgetCoordinator';

const budget = {
  maxVisibleFeatures: 20_000,
  maxClusters: 2_000,
  maxCpuBytes: 8_000_000,
  maxGpuBytes: 4_000_000,
  maxDrawCalls: 32,
  maxLayers: 3,
};

const viewport = { scale: 5_000, width: 1280, height: 720, devicePixelRatio: 1 };

const layer = (layerId: string, overrides: Partial<ClusterLayerDescriptor> = {}): ClusterLayerDescriptor => ({
  layerId,
  priority: 'normal',
  targetPixelRadius: 24,
  estimatedFeatureCount: 8_000,
  estimatedClusterCount: 800,
  ...overrides,
});

describe('FeatureClusterBudgetCoordinator', () => {
  it('plans a bounded cluster workload', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('parcels'));
    const plan = coordinator.plan(viewport);
    expect(plan.admissions[0]?.admitted).toBe(true);
    expect(plan.usage.visibleFeatures).toBeLessThanOrEqual(budget.maxVisibleFeatures);
    expect(plan.usage.clusters).toBeLessThanOrEqual(budget.maxClusters);
    expect(plan.usage.cpuBytes).toBeLessThanOrEqual(budget.maxCpuBytes);
    expect(plan.usage.gpuBytes).toBeLessThanOrEqual(budget.maxGpuBytes);
    expect(plan.usage.drawCalls).toBeLessThanOrEqual(budget.maxDrawCalls);
  });

  it('honors ArcGIS scale visibility semantics', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    // ArcGIS minScale is the zoomed-out denominator and maxScale is the
    // zoomed-in denominator, so a visible band is minScale >= scale >= maxScale.
    coordinator.register(layer('roads', { minScale: 10_000, maxScale: 1_000 }));
    expect(coordinator.plan({ ...viewport, scale: 500 }).admissions[0]?.reason).toBe('scale');
    expect(coordinator.plan({ ...viewport, scale: 5_000 }).admissions[0]?.admitted).toBe(true);
    expect(coordinator.plan({ ...viewport, scale: 20_000 }).admissions[0]?.reason).toBe('scale');
  });

  it('admits higher-priority layers before background work', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget: { ...budget, maxLayers: 1 } });
    coordinator.register(layer('background', { priority: 'background' }));
    coordinator.register(layer('critical', { priority: 'critical' }));
    const plan = coordinator.plan(viewport);
    expect(plan.admissions.map((entry) => entry.layerId)).toEqual(['critical', 'background']);
    expect(plan.admissions[0]?.admitted).toBe(true);
    expect(plan.admissions[1]?.reason).toBe('capacity');
  });

  it('degrades radius before refusing work under pressure', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({
      budget: { ...budget, maxVisibleFeatures: 4_000, maxClusters: 500, maxCpuBytes: 1_000_000, maxGpuBytes: 500_000 },
    });
    coordinator.register(layer('dense', {
      targetPixelRadius: 16,
      maxPixelRadius: 48,
      estimatedFeatureCount: 100_000,
      estimatedClusterCount: 10_000,
    }));
    const admission = coordinator.plan(viewport).admissions[0];
    expect(admission).toBeDefined();
    if (!admission) throw new Error('expected dense cluster admission');
    if (admission.admitted) {
      expect(admission.pixelRadius).toBeGreaterThanOrEqual(16);
      expect(admission.visibleFeatureBudget).toBeLessThanOrEqual(4_000);
    } else {
      expect(admission.reason).toBe('capacity');
    }
  });

  it('classifies aggregate pressure deterministically', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({
      budget: { ...budget, maxLayers: 1, maxVisibleFeatures: 2_000, maxClusters: 200 },
    });
    coordinator.register(layer('dense', { estimatedFeatureCount: 20_000, estimatedClusterCount: 2_000 }));
    expect(['normal', 'elevated', 'critical']).toContain(coordinator.plan(viewport).pressure);
  });

  it('supports requested layer subsets without mutating registry state', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('a'));
    coordinator.register(layer('b'));
    expect(coordinator.plan(viewport, ['b']).admissions.map((entry) => entry.layerId)).toEqual(['b']);
    expect(coordinator.snapshotDescriptors().map((entry) => entry.layerId)).toEqual(['a', 'b']);
  });

  it('replaces descriptor metadata deterministically', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('poi', { priority: 'background' }));
    coordinator.register(layer('poi', { priority: 'critical', targetPixelRadius: 30 }));
    expect(coordinator.snapshotDescriptors()).toHaveLength(1);
    expect(coordinator.snapshotDescriptors()[0]?.priority).toBe('critical');
    expect(coordinator.snapshotDescriptors()[0]?.targetPixelRadius).toBe(30);
  });

  it('bounds descriptor metadata', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget, maxDescriptors: 1 });
    coordinator.register(layer('a'));
    expect(() => coordinator.register(layer('b'))).toThrow('capacity exceeded');
  });

  it('validates malformed descriptors and budgets', () => {
    expect(() => new FeatureClusterBudgetCoordinator({ budget: { ...budget, maxLayers: 0 } })).toThrow();
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    expect(() => coordinator.register(layer(' '))).toThrow();
    expect(() => coordinator.register(layer('bad-radius', { targetPixelRadius: 0 }))).toThrow();
    expect(() => coordinator.register(layer('bad-range', { minScale: 1_000, maxScale: 10_000 }))).toThrow();
    expect(() => coordinator.plan({ ...viewport, width: 0 })).toThrow();
  });

  it('removes layers without leaving stale admissions', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('temporary'));
    expect(coordinator.remove('temporary')).toBe(true);
    expect(coordinator.remove('temporary')).toBe(false);
    expect(coordinator.plan(viewport).admissions).toEqual([]);
  });

  it('returns immutable snapshots and descriptor copies', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('immutable'));
    const plan = coordinator.plan(viewport);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.admissions)).toBe(true);
    expect(Object.isFrozen(plan.usage)).toBe(true);
    expect(Object.isFrozen(coordinator.snapshotDescriptors())).toBe(true);
  });

  it('fails closed after idempotent disposal', () => {
    const coordinator = new FeatureClusterBudgetCoordinator({ budget });
    coordinator.register(layer('a'));
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.plan(viewport)).toThrow('disposed');
    expect(() => coordinator.register(layer('b'))).toThrow('disposed');
  });
});
