import { describe, expect, it } from 'vitest';
import { GIS_PERFORMANCE_PROFILE, performanceBudgetForProfile } from './adaptivePerformanceRuntime';
import { createSpatialPressureCoordinator } from './spatialPressureCoordinator';

const balancedBudget = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.BALANCED, { memoryGb: 4 });

const observation = (overrides: Partial<{
  requestedLevel: number;
  visibleFeatures: number;
  estimatedVertices: number;
  framePressure: 'normal' | 'warm' | 'hot' | 'critical';
}> = {}) => ({
  requestedLevel: 12,
  visibleFeatures: 100,
  estimatedVertices: 1000,
  ...overrides,
});

describe('spatial pressure coordinator', () => {
  it('keeps normal observations at requested detail with prefetch enabled', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    const plan = runtime.observe(observation());
    expect(plan).not.toBeNull();
    expect(plan?.lod.pressure).toBe('normal');
    expect(plan?.lod.effectiveLevel).toBe(12);
    expect(plan?.prefetch).toBe(true);
    expect(plan?.clusterTarget).toBe(balancedBudget.clusterThreshold);
  });

  it('requires consecutive pressure evidence before changing the stable pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    const hot = observation({ visibleFeatures: Math.ceil(balancedBudget.maxVisibleFeatures * 0.9) });
    const first = runtime.observe(hot);
    const second = runtime.observe(hot);
    expect(first?.lod.pressure).toBe('normal');
    expect(first?.pressureChanged).toBe(false);
    expect(second?.lod.pressure).toBe('hot');
    expect(second?.pressureChanged).toBe(true);
    expect(runtime.getSnapshot().metrics.suppressedTransitions).toBe(1);
    expect(runtime.getSnapshot().metrics.pressureTransitions).toBe(1);
  });

  it('cancels pending pressure when observations return to the stable state', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 3 });
    runtime.observe(observation({ framePressure: 'critical' }));
    expect(runtime.getSnapshot().pendingPressure).toBe('critical');
    runtime.observe(observation());
    expect(runtime.getSnapshot().pendingPressure).toBeNull();
    expect(runtime.getSnapshot().pendingSamples).toBe(0);
  });

  it('does not oscillate when candidate pressure alternates', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 2 });
    runtime.observe(observation({ framePressure: 'warm' }));
    runtime.observe(observation({ framePressure: 'hot' }));
    runtime.observe(observation({ framePressure: 'warm' }));
    runtime.observe(observation({ framePressure: 'hot' }));
    expect(runtime.getSnapshot().pressure).toBe('normal');
    expect(runtime.getSnapshot().metrics.pressureTransitions).toBe(0);
    expect(runtime.getSnapshot().metrics.suppressedTransitions).toBe(4);
  });

  it('disables prefetch once sustained pressure is accepted', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    runtime.observe(observation({ framePressure: 'warm' }));
    const plan = runtime.observe(observation({ framePressure: 'warm' }));
    expect(plan?.lod.pressure).toBe('warm');
    expect(plan?.prefetch).toBe(false);
  });

  it('scales clustering and request concurrency from stabilized pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 1, baseConcurrentRequests: 8 });
    const warm = runtime.observe(observation({ framePressure: 'warm' }));
    const hot = runtime.observe(observation({ framePressure: 'hot' }));
    const critical = runtime.observe(observation({ framePressure: 'critical' }));
    expect(warm?.clusterTarget).toBe(balancedBudget.clusterThreshold * 2);
    expect(hot?.clusterTarget).toBe(balancedBudget.clusterThreshold * 3);
    expect(critical?.clusterTarget).toBe(balancedBudget.clusterThreshold * 4);
    expect(warm?.concurrentRequests).toBe(4);
    expect(hot?.concurrentRequests).toBe(2);
    expect(critical?.concurrentRequests).toBe(2);
  });

  it('caps cluster targets and request concurrency to policy boundaries', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, {
      hysteresisSamples: 1,
      maxClusterTarget: 1000,
      minConcurrentRequests: 3,
      maxConcurrentRequests: 4,
      baseConcurrentRequests: 20,
    });
    const plan = runtime.observe(observation({ framePressure: 'critical' }));
    expect(plan?.clusterTarget).toBe(1000);
    expect(plan?.concurrentRequests).toBe(3);
  });

  it('uses performance maxVisibleFeatures as the LOD data budget', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 1 });
    const plan = runtime.observe(observation({ visibleFeatures: balancedBudget.maxVisibleFeatures }));
    expect(plan?.lod.featureRatio).toBe(1);
    expect(plan?.lod.pressure).toBe('critical');
    expect(plan?.visibleFeatureBudget).toBe(balancedBudget.maxVisibleFeatures);
  });

  it('uses a separately bounded vertex budget', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, {
      hysteresisSamples: 1,
      maxEstimatedVertices: 10_000,
    });
    const plan = runtime.observe(observation({ estimatedVertices: 10_000 }));
    expect(plan?.lod.vertexRatio).toBe(1);
    expect(plan?.lod.reason).toBe('vertex-budget');
  });

  it('preserves combined provenance from frame and data pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 1 });
    const plan = runtime.observe(observation({
      visibleFeatures: Math.ceil(balancedBudget.maxVisibleFeatures * 0.8),
      framePressure: 'warm',
    }));
    expect(plan?.lod.reason).toBe('combined');
  });

  it('rejects malformed observations without mutating sequence', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    expect(runtime.observe(observation({ requestedLevel: 1.5 }))).toBeNull();
    expect(runtime.getSnapshot().sequence).toBe(0);
    expect(runtime.getSnapshot().metrics.observations).toBe(1);
    expect(runtime.getSnapshot().metrics.rejectedObservations).toBe(1);
  });

  it('rejects negative feature and vertex observations', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    expect(runtime.observe(observation({ visibleFeatures: -1 }))).toBeNull();
    expect(runtime.observe(observation({ estimatedVertices: -1 }))).toBeNull();
    expect(runtime.getSnapshot().metrics.rejectedObservations).toBe(2);
  });

  it('clamps requested levels through the LOD policy', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { minLevel: 3, maxLevel: 18 });
    expect(runtime.observe(observation({ requestedLevel: 1 }))?.lod.requestedLevel).toBe(3);
    expect(runtime.observe(observation({ requestedLevel: 99 }))?.lod.requestedLevel).toBe(18);
  });

  it('updates performance budgets without retaining stale hysteresis evidence', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 2 });
    runtime.observe(observation({ framePressure: 'hot' }));
    expect(runtime.getSnapshot().pendingPressure).toBe('hot');
    const ecoBudget = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.ECO, { memoryGb: 2 });
    const snapshot = runtime.updatePerformance(GIS_PERFORMANCE_PROFILE.ECO, ecoBudget);
    expect(snapshot.profile).toBe('eco');
    expect(snapshot.pendingPressure).toBeNull();
    expect(snapshot.metrics.profileChanges).toBe(1);
    const plan = runtime.observe(observation());
    expect(plan?.visibleFeatureBudget).toBe(ecoBudget.maxVisibleFeatures);
    expect(plan?.queryCacheBytes).toBe(ecoBudget.maxQueryCacheBytes);
  });

  it('does not count same-profile budget refresh as a profile change', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    runtime.updatePerformance(GIS_PERFORMANCE_PROFILE.BALANCED, { ...balancedBudget, maxVisibleFeatures: 5000 });
    expect(runtime.getSnapshot().metrics.profileChanges).toBe(0);
  });

  it('fails closed for invalid performance budgets', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    expect(() => runtime.updatePerformance(GIS_PERFORMANCE_PROFILE.ECO, { ...balancedBudget, maxVisibleFeatures: 0 })).toThrow(/maxVisibleFeatures/);
    expect(runtime.getSnapshot().profile).toBe('balanced');
  });

  it('fails closed for invalid coordinator policies', () => {
    expect(() => createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 0 })).toThrow(/hysteresisSamples/);
    expect(() => createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { minConcurrentRequests: 5, maxConcurrentRequests: 4 })).toThrow(/maxConcurrentRequests/);
    expect(() => createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { warmFeatureRatio: 0.9, hotFeatureRatio: 0.8 })).toThrow(/hotFeatureRatio/);
  });

  it('exposes monotonic sequence numbers only for accepted observations', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    expect(runtime.observe(observation())?.sequence).toBe(1);
    expect(runtime.observe(observation({ visibleFeatures: -1 }))).toBeNull();
    expect(runtime.observe(observation())?.sequence).toBe(2);
  });

  it('resets state and metrics while retaining current performance budget', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget, { hysteresisSamples: 1 });
    runtime.observe(observation({ framePressure: 'hot' }));
    const ecoBudget = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.ECO, { memoryGb: 2 });
    runtime.updatePerformance(GIS_PERFORMANCE_PROFILE.ECO, ecoBudget);
    const reset = runtime.reset();
    expect(reset.sequence).toBe(0);
    expect(reset.pressure).toBe('normal');
    expect(reset.lastPlan).toBeNull();
    expect(reset.metrics.observations).toBe(0);
    expect(reset.profile).toBe('eco');
    expect(runtime.observe(observation())?.visibleFeatureBudget).toBe(ecoBudget.maxVisibleFeatures);
  });

  it('returns immutable top-level plans and snapshots', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, balancedBudget);
    const plan = runtime.observe(observation());
    const snapshot = runtime.getSnapshot();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(plan?.lod)).toBe(true);
  });
});
