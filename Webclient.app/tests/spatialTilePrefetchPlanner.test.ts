import { describe, expect, it } from 'vitest';
import {
  SpatialTilePrefetchPlanner,
  type SpatialTilePrefetchCandidate,
} from '../src/gis-engine/spatialTilePrefetchPlanner';

const candidate = (
  column: number,
  overrides: Partial<SpatialTilePrefetchCandidate> = {},
): SpatialTilePrefetchCandidate => ({
  layerId: 'verified-arcgis-layer',
  level: 12,
  row: 42,
  column,
  priority: 'nearby',
  distance: column,
  estimatedBytes: 256,
  ...overrides,
});

describe('SpatialTilePrefetchPlanner', () => {
  it('orders visible work before nearby and speculative work', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { priority: 'speculative', distance: 0 }),
      candidate(2, { priority: 'nearby', distance: 0 }),
      candidate(3, { priority: 'visible', distance: 8 }),
    ]);

    expect(plan.selected.map((item) => item.column)).toEqual([3, 2, 1]);
  });

  it('uses distance as the deterministic tie breaker within a priority', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { distance: 4 }),
      candidate(2, { distance: 1 }),
      candidate(3, { distance: 2 }),
    ]);

    expect(plan.selected.map((item) => item.column)).toEqual([2, 3, 1]);
  });

  it('prefers the more detailed level after equal priority and distance', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { level: 10, distance: 1 }),
      candidate(2, { level: 14, distance: 1 }),
    ]);

    expect(plan.selected.map((item) => item.level)).toEqual([14, 10]);
  });

  it('prefers the smaller payload after equal priority, distance, and level', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { distance: 1, estimatedBytes: 512 }),
      candidate(2, { distance: 1, estimatedBytes: 128 }),
    ]);

    expect(plan.selected.map((item) => item.estimatedBytes)).toEqual([128, 512]);
  });

  it('deduplicates identical spatial identities', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1),
      candidate(1, { priority: 'visible', estimatedBytes: 64 }),
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.rejectedDuplicate).toBe(1);
  });

  it('keeps variants as distinct cache and prefetch identities', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { variant: 'day' }),
      candidate(1, { variant: 'night' }),
    ]);

    expect(plan.selected).toHaveLength(2);
    expect(plan.rejectedDuplicate).toBe(0);
  });

  it('enforces the selected-entry budget', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxSelected: 2, maxPerLayer: 2 });
    const plan = planner.plan([candidate(1), candidate(2), candidate(3)]);

    expect(plan.selected).toHaveLength(2);
    expect(plan.rejectedBudget).toBe(1);
  });

  it('enforces the aggregate byte budget without exceeding it', () => {
    const planner = new SpatialTilePrefetchPlanner({
      maxEstimatedBytes: 500,
      maxSelected: 4,
      maxPerLayer: 4,
    });
    const plan = planner.plan([
      candidate(1, { estimatedBytes: 300 }),
      candidate(2, { estimatedBytes: 250 }),
      candidate(3, { estimatedBytes: 150 }),
    ]);

    expect(plan.estimatedBytes).toBe(450);
    expect(plan.selected.map((item) => item.column)).toEqual([3, 1]);
    expect(plan.rejectedBudget).toBe(1);
  });

  it('enforces a fair per-layer admission budget', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxSelected: 4, maxPerLayer: 1 });
    const plan = planner.plan([
      candidate(1, { layerId: 'a' }),
      candidate(2, { layerId: 'a' }),
      candidate(3, { layerId: 'b' }),
    ]);

    expect(plan.selected).toHaveLength(2);
    expect(plan.selected.map((item) => item.layerId).sort()).toEqual(['a', 'b']);
    expect(plan.rejectedLayerBudget).toBe(1);
  });

  it('rejects malformed layer identifiers fail-closed', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([candidate(1, { layerId: '<script>' })]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.rejectedInvalid).toBe(1);
  });

  it('trims safe layer identifiers before identity comparison', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { layerId: ' layer-a ' }),
      candidate(1, { layerId: 'layer-a' }),
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]?.layerId).toBe('layer-a');
    expect(plan.rejectedDuplicate).toBe(1);
  });

  it('rejects negative and non-integer tile coordinates', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { row: -1 }),
      candidate(2, { column: 1.5 }),
      candidate(3, { level: -1 }),
    ]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.rejectedInvalid).toBe(3);
  });

  it('rejects coordinates above the configured level ceiling', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxLevel: 10 });
    const plan = planner.plan([candidate(1, { level: 11 })]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.rejectedInvalid).toBe(1);
  });

  it('rejects candidates outside the bounded prefetch distance', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxDistance: 3 });
    const plan = planner.plan([
      candidate(1, { distance: 3 }),
      candidate(2, { distance: 3.01 }),
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.rejectedInvalid).toBe(1);
  });

  it('rejects non-finite distances', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(1, { distance: Number.NaN }),
      candidate(2, { distance: Number.POSITIVE_INFINITY }),
    ]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.rejectedInvalid).toBe(2);
  });

  it('rejects zero, fractional, and oversized byte estimates', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxEstimatedBytes: 1024 });
    const plan = planner.plan([
      candidate(1, { estimatedBytes: 0 }),
      candidate(2, { estimatedBytes: 1.5 }),
      candidate(3, { estimatedBytes: 1025 }),
    ]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.rejectedInvalid).toBe(3);
  });

  it('caps candidate scanning before normalization work', () => {
    const planner = new SpatialTilePrefetchPlanner({
      maxCandidates: 2,
      maxSelected: 2,
      maxPerLayer: 2,
    });
    const plan = planner.plan([candidate(1), candidate(2), candidate(3)]);

    expect(plan.considered).toBe(2);
    expect(plan.selected).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });

  it('reports no truncation when candidate count fits the scan budget', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxCandidates: 3 });
    const plan = planner.plan([candidate(1), candidate(2), candidate(3)]);

    expect(plan.considered).toBe(3);
    expect(plan.truncated).toBe(false);
  });

  it('returns frozen plans and selected arrays', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([candidate(1)]);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selected)).toBe(true);
    expect(Object.isFrozen(plan.selected[0])).toBe(true);
  });

  it('does not mutate the caller candidate array', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const input = [candidate(2), candidate(1)];
    const before = input.map((item) => item.column);

    planner.plan(input);

    expect(input.map((item) => item.column)).toEqual(before);
  });

  it('uses stable identity ordering as the final tie breaker', () => {
    const planner = new SpatialTilePrefetchPlanner();
    const plan = planner.plan([
      candidate(2, { distance: 1, estimatedBytes: 128 }),
      candidate(1, { distance: 1, estimatedBytes: 128 }),
    ]);

    expect(plan.selected.map((item) => item.column)).toEqual([1, 2]);
  });

  it('exposes immutable validated limits', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxSelected: 7, maxPerLayer: 3 });

    expect(planner.limits.maxSelected).toBe(7);
    expect(planner.limits.maxPerLayer).toBe(3);
    expect(Object.isFrozen(planner.limits)).toBe(true);
  });

  it('rejects invalid constructor limits', () => {
    expect(() => new SpatialTilePrefetchPlanner({ maxCandidates: 0 })).toThrow(RangeError);
    expect(() => new SpatialTilePrefetchPlanner({ maxSelected: 0 })).toThrow(RangeError);
    expect(() => new SpatialTilePrefetchPlanner({ maxSelected: 3, maxPerLayer: 4 })).toThrow(RangeError);
    expect(() => new SpatialTilePrefetchPlanner({ maxEstimatedBytes: 0 })).toThrow(RangeError);
    expect(() => new SpatialTilePrefetchPlanner({ maxLevel: 65 })).toThrow(RangeError);
    expect(() => new SpatialTilePrefetchPlanner({ maxDistance: -1 })).toThrow(RangeError);
  });

  it('admits later smaller work when an earlier candidate does not fit bytes', () => {
    const planner = new SpatialTilePrefetchPlanner({
      maxEstimatedBytes: 400,
      maxSelected: 4,
      maxPerLayer: 4,
    });
    const plan = planner.plan([
      candidate(1, { priority: 'visible', estimatedBytes: 350 }),
      candidate(2, { priority: 'nearby', estimatedBytes: 200 }),
      candidate(3, { priority: 'speculative', estimatedBytes: 40 }),
    ]);

    expect(plan.selected.map((item) => item.column)).toEqual([1, 3]);
    expect(plan.estimatedBytes).toBe(390);
    expect(plan.rejectedBudget).toBe(1);
  });

  it('keeps per-layer accounting independent across variants', () => {
    const planner = new SpatialTilePrefetchPlanner({ maxSelected: 3, maxPerLayer: 2 });
    const plan = planner.plan([
      candidate(1, { layerId: 'a', variant: 'day' }),
      candidate(2, { layerId: 'a', variant: 'night' }),
      candidate(3, { layerId: 'a', variant: 'print' }),
      candidate(4, { layerId: 'b' }),
    ]);

    expect(plan.selected.filter((item) => item.layerId === 'a')).toHaveLength(2);
    expect(plan.selected.filter((item) => item.layerId === 'b')).toHaveLength(1);
    expect(plan.rejectedLayerBudget).toBe(1);
  });
});