import { describe, expect, it } from 'vitest';
import {
  ViewportPrefetchPlanner,
  createViewportPrefetchPlanner,
  type ViewportPrefetchInput,
} from './viewportPrefetchPlanner';

const input = (
  overrides: Partial<ViewportPrefetchInput> = {},
): ViewportPrefetchInput => ({
  extent: {
    xmin: 0,
    ymin: 0,
    xmax: 1_000,
    ymax: 500,
    spatialReference: 'EPSG:3857',
  },
  scale: 10_000,
  pixelWidth: 1_000,
  pixelHeight: 500,
  viewMode: '2d',
  motion: {
    velocityXPxPerSecond: 500,
    velocityYPxPerSecond: 0,
  },
  ...overrides,
});

describe('ViewportPrefetchPlanner', () => {
  it('predicts the primary extent in the pan direction', () => {
    const planner = createViewportPrefetchPlanner({
      lookaheadMs: 1_000,
      maximumShiftViewports: 2,
    });
    const plan = planner.plan(input());

    expect(plan.moving).toBe(true);
    expect(plan.candidates[0]).toMatchObject({
      reason: 'pan-primary',
      scale: 10_000,
      viewMode: '2d',
      extent: {
        xmin: 500,
        ymin: 0,
        xmax: 1_500,
        ymax: 500,
        spatialReference: 'EPSG:3857',
      },
    });
  });

  it('maps positive screen Y motion to decreasing map Y', () => {
    const planner = new ViewportPrefetchPlanner({
      lookaheadMs: 1_000,
      maximumShiftViewports: 2,
    });
    const plan = planner.plan(input({
      motion: {
        velocityXPxPerSecond: 0,
        velocityYPxPerSecond: 250,
      },
    }));

    expect(plan.candidates[0]?.extent).toEqual({
      xmin: 0,
      ymin: -250,
      xmax: 1_000,
      ymax: 250,
      spatialReference: 'EPSG:3857',
    });
  });

  it('caps extreme prediction distance', () => {
    const planner = new ViewportPrefetchPlanner({
      lookaheadMs: 2_000,
      maximumShiftViewports: 0.5,
    });
    const plan = planner.plan(input({
      motion: {
        velocityXPxPerSecond: 50_000,
        velocityYPxPerSecond: 50_000,
      },
    }));

    expect(plan.candidates[0]?.extent.xmin).toBe(500);
    expect(plan.candidates[0]?.extent.ymin).toBe(-250);
  });

  it('suppresses sub-threshold motion', () => {
    const planner = new ViewportPrefetchPlanner({
      minimumVelocityPxPerSecond: 100,
      minimumZoomVelocityPerSecond: 0.5,
    });
    const plan = planner.plan(input({
      motion: {
        velocityXPxPerSecond: 20,
        velocityYPxPerSecond: 30,
        zoomVelocityPerSecond: 0.1,
      },
    }));

    expect(plan).toMatchObject({
      moving: false,
      candidateBudget: 0,
      candidates: [],
    });
  });

  it('creates a bounded zoom-out candidate', () => {
    const planner = new ViewportPrefetchPlanner({
      lookaheadMs: 1_000,
      maximumZoomOutFactor: 1.5,
    });
    const plan = planner.plan(input({
      motion: {
        velocityXPxPerSecond: 0,
        velocityYPxPerSecond: 0,
        zoomVelocityPerSecond: 3,
      },
    }));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      reason: 'zoom-out',
      scale: 15_000,
      extent: {
        xmin: -250,
        ymin: -125,
        xmax: 1_250,
        ymax: 625,
      },
    });
  });

  it('does not prefetch zoom-out work while zooming inward', () => {
    const planner = new ViewportPrefetchPlanner();
    const plan = planner.plan(input({
      motion: {
        velocityXPxPerSecond: 200,
        velocityYPxPerSecond: 0,
        zoomVelocityPerSecond: -2,
      },
    }));

    expect(plan.candidates.some((candidate) => candidate.reason === 'zoom-out')).toBe(false);
  });

  it('prioritizes forward work over side work', () => {
    const plan = new ViewportPrefetchPlanner({ maxCandidates: 8 }).plan(input());
    const forward = plan.candidates.find((candidate) => candidate.reason === 'pan-forward');
    const side = plan.candidates.find((candidate) => candidate.reason === 'pan-left');

    expect(forward?.score).toBeGreaterThan(side?.score ?? 0);
  });

  it('reduces candidate count under resource pressure', () => {
    const planner = new ViewportPrefetchPlanner({ maxCandidates: 8 });
    const full = planner.plan(input({
      budgetProfile: { pressure: 'normal', prefetchFactor: 1 },
    }));
    const reduced = planner.plan(input({
      budgetProfile: { pressure: 'critical', prefetchFactor: 0.25 },
    }));

    expect(full.candidateBudget).toBe(8);
    expect(reduced.candidateBudget).toBe(2);
    expect(reduced.candidates).toHaveLength(2);
    expect(reduced.suppressedCandidates).toBeGreaterThan(0);
  });

  it('keeps one useful candidate when a positive factor rounds below one', () => {
    const plan = new ViewportPrefetchPlanner({ maxCandidates: 4 }).plan(input({
      budgetProfile: { pressure: 'critical', prefetchFactor: 0.01 },
    }));

    expect(plan.candidateBudget).toBe(1);
    expect(plan.candidates[0]?.reason).toBe('pan-primary');
  });

  it('suppresses all candidates when the factor is zero', () => {
    const plan = new ViewportPrefetchPlanner().plan(input({
      budgetProfile: { pressure: 'critical', prefetchFactor: 0 },
    }));

    expect(plan).toMatchObject({
      moving: false,
      candidateBudget: 0,
      candidates: [],
    });
  });

  it('generates deterministic keys and fingerprints', () => {
    const planner = new ViewportPrefetchPlanner();
    const first = planner.plan(input());
    const second = planner.plan(input());

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.candidates.map((candidate) => candidate.key))
      .toEqual(first.candidates.map((candidate) => candidate.key));
  });

  it('absorbs tiny coordinate jitter at configured precision', () => {
    const planner = new ViewportPrefetchPlanner({ coordinatePrecision: 3 });
    const first = planner.plan(input());
    const second = planner.plan(input({
      extent: {
        xmin: 0.0001,
        ymin: 0.0001,
        xmax: 1_000.0001,
        ymax: 500.0001,
        spatialReference: 'EPSG:3857',
      },
    }));

    expect(second.candidates.map((candidate) => candidate.key))
      .toEqual(first.candidates.map((candidate) => candidate.key));
  });

  it('keeps 2d and 3d prefetch keys separate', () => {
    const planner = new ViewportPrefetchPlanner();
    const twoD = planner.plan(input({ viewMode: '2d' }));
    const threeD = planner.plan(input({ viewMode: '3d' }));

    expect(threeD.fingerprint).not.toBe(twoD.fingerprint);
    expect(threeD.candidates[0]?.score).toBeGreaterThan(twoD.candidates[0]?.score ?? 0);
  });

  it('returns sorted stale keys for cancellation', () => {
    const planner = new ViewportPrefetchPlanner({ maxCandidates: 2 });
    const next = planner.plan(input());
    const keep = next.candidates[0]?.key ?? '';

    expect(planner.cancelKeys(['stale-b', keep, 'stale-a', 'stale-a', ''], next))
      .toEqual(['stale-a', 'stale-b']);
  });

  it('rejects invalid extents and dimensions', () => {
    const planner = new ViewportPrefetchPlanner();
    expect(() => planner.plan(input({
      extent: {
        xmin: 10,
        ymin: 0,
        xmax: 10,
        ymax: 20,
        spatialReference: 'EPSG:3857',
      },
    }))).toThrow('prefetch extent must have positive width and height');
    expect(() => planner.plan(input({ scale: 0 }))).toThrow(RangeError);
    expect(() => planner.plan(input({ pixelWidth: -1 }))).toThrow(RangeError);
  });

  it('rejects malformed motion and pressure values', () => {
    const planner = new ViewportPrefetchPlanner();
    expect(() => planner.plan(input({
      motion: {
        velocityXPxPerSecond: Number.NaN,
        velocityYPxPerSecond: 0,
      },
    }))).toThrow('velocityXPxPerSecond must be finite');
    expect(() => planner.plan(input({
      budgetProfile: { pressure: 'critical', prefetchFactor: 1.1 },
    }))).toThrow('prefetchFactor must be between 0 and 1');
  });

  it('rejects unsafe planner configuration', () => {
    expect(() => new ViewportPrefetchPlanner({ maxCandidates: 65 }))
      .toThrow('maxCandidates exceeds the bounded prefetch budget');
    expect(() => new ViewportPrefetchPlanner({ lookaheadMs: 10_001 }))
      .toThrow('lookaheadMs exceeds the bounded prediction horizon');
    expect(() => new ViewportPrefetchPlanner({ maximumZoomOutFactor: 0.9 }))
      .toThrow('maximumZoomOutFactor must be between 1 and 4');
    expect(() => new ViewportPrefetchPlanner({ coordinatePrecision: 13 }))
      .toThrow('coordinatePrecision must be an integer from 0 through 12');
  });

  it('tracks bounded diagnostics and resets them', () => {
    const planner = new ViewportPrefetchPlanner({ maxCandidates: 2 });
    planner.plan(input());
    planner.plan(input({
      motion: {
        velocityXPxPerSecond: 0,
        velocityYPxPerSecond: 0,
      },
    }));

    expect(planner.snapshot()).toMatchObject({
      plans: 2,
      movingPlans: 1,
      idlePlans: 1,
      candidates: 2,
    });
    expect(planner.reset()).toEqual({
      plans: 0,
      movingPlans: 0,
      idlePlans: 0,
      candidates: 0,
      suppressedCandidates: 0,
      lastFingerprint: null,
    });
  });
});
