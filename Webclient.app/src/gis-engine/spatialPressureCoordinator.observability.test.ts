import { describe, expect, it } from 'vitest';
import { GIS_PERFORMANCE_PROFILE, performanceBudgetForProfile } from './adaptivePerformanceRuntime';
import { createSpatialPressureCoordinator } from './spatialPressureCoordinator';

const budget = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.BALANCED, { memoryGb: 4 });
const normalObservation = {
  requestedLevel: 12,
  visibleFeatures: 100,
  estimatedVertices: 1_000,
} as const;

describe('spatial pressure coordinator observability', () => {
  it('distinguishes observed pressure from hysteresis-stabilized pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget, {
      hysteresisSamples: 2,
    });

    const first = runtime.observe({ ...normalObservation, framePressure: 'critical' });
    expect(first?.observedPressure).toBe('critical');
    expect(first?.lod.pressure).toBe('normal');
    expect(first?.transitionSuppressed).toBe(true);
    expect(first?.pressureChanged).toBe(false);

    const second = runtime.observe({ ...normalObservation, framePressure: 'critical' });
    expect(second?.observedPressure).toBe('critical');
    expect(second?.lod.pressure).toBe('critical');
    expect(second?.transitionSuppressed).toBe(false);
    expect(second?.pressureChanged).toBe(true);
  });

  it('does not report suppression when the observed pressure equals the stable pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget);
    const plan = runtime.observe(normalObservation);
    expect(plan?.observedPressure).toBe('normal');
    expect(plan?.lod.pressure).toBe('normal');
    expect(plan?.transitionSuppressed).toBe(false);
    expect(plan?.pressureChanged).toBe(false);
  });

  it('reports a newly competing pressure as suppressed while retaining the current stable pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget, {
      hysteresisSamples: 2,
    });
    runtime.observe({ ...normalObservation, framePressure: 'warm' });
    runtime.observe({ ...normalObservation, framePressure: 'warm' });

    const competing = runtime.observe({ ...normalObservation, framePressure: 'hot' });
    expect(competing?.observedPressure).toBe('hot');
    expect(competing?.lod.pressure).toBe('warm');
    expect(competing?.transitionSuppressed).toBe(true);
    expect(runtime.getSnapshot().pendingPressure).toBe('hot');
    expect(runtime.getSnapshot().pendingSamples).toBe(1);
  });

  it('clears suppression evidence when observations return to the stable pressure', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget, {
      hysteresisSamples: 3,
    });
    runtime.observe({ ...normalObservation, framePressure: 'hot' });
    expect(runtime.getSnapshot().pendingPressure).toBe('hot');

    const stable = runtime.observe(normalObservation);
    expect(stable?.transitionSuppressed).toBe(false);
    expect(runtime.getSnapshot().pendingPressure).toBeNull();
    expect(runtime.getSnapshot().pendingSamples).toBe(0);
  });

  it('freezes nested metrics snapshots so callers cannot corrupt diagnostics', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget);
    runtime.observe(normalObservation);
    const snapshot = runtime.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metrics)).toBe(true);
    expect(snapshot.metrics.observations).toBe(1);
  });

  it('keeps observed pressure provenance when data pressure is the source', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget, {
      hysteresisSamples: 2,
    });
    const plan = runtime.observe({
      ...normalObservation,
      visibleFeatures: Math.ceil(budget.maxVisibleFeatures * 0.9),
    });

    expect(plan?.observedPressure).toBe('hot');
    expect(plan?.lod.pressure).toBe('normal');
    expect(plan?.transitionSuppressed).toBe(true);
  });

  it('does not mark accepted single-sample transitions as suppressed', () => {
    const runtime = createSpatialPressureCoordinator(GIS_PERFORMANCE_PROFILE.BALANCED, budget, {
      hysteresisSamples: 1,
    });
    const plan = runtime.observe({ ...normalObservation, framePressure: 'warm' });

    expect(plan?.observedPressure).toBe('warm');
    expect(plan?.lod.pressure).toBe('warm');
    expect(plan?.transitionSuppressed).toBe(false);
    expect(plan?.pressureChanged).toBe(true);
  });
});
