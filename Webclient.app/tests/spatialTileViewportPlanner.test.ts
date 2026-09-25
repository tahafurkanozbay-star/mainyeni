import { describe, expect, it } from 'vitest';
import {
  SpatialTileViewportPlanner,
  type SpatialTileViewportCandidate,
} from '../src/gis-engine/spatialTileViewportPlanner';

const candidate = (overrides: Partial<SpatialTileViewportCandidate> = {}): SpatialTileViewportCandidate => ({
  key: 'tile-1',
  layerId: 'roads',
  level: 12,
  row: 100,
  column: 200,
  estimatedBytes: 1_024,
  priority: 'visible',
  screenDistance: 0,
  projectedPixels: 256,
  ...overrides,
});

describe('SpatialTileViewportPlanner', () => {
  it('selects a valid visible tile', () => {
    const plan = new SpatialTileViewportPlanner().plan([candidate()]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.visibleCount).toBe(1);
    expect(plan.selectedBytes).toBe(1_024);
  });

  it('orders visible before nearby and speculative', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 's', column: 3, priority: 'speculative' }),
      candidate({ key: 'n', column: 2, priority: 'nearby' }),
      candidate({ key: 'v', column: 1, priority: 'visible' }),
    ]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['v', 'n', 's']);
  });

  it('uses screen distance as deterministic priority tie breaker', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'far', column: 2, screenDistance: 200 }),
      candidate({ key: 'near', column: 1, screenDistance: 10 }),
    ]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['near', 'far']);
  });

  it('prefers larger projected footprint after equal distance', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'small', column: 2, projectedPixels: 20 }),
      candidate({ key: 'large', column: 1, projectedPixels: 200 }),
    ]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['large', 'small']);
  });

  it('deduplicates by spatial identity rather than caller key', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'first' }),
      candidate({ key: 'second' }),
    ]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.duplicateCount).toBe(1);
  });

  it('keeps variants as distinct spatial identities', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'a', variant: 'day' }),
      candidate({ key: 'b', variant: 'night' }),
    ]);
    expect(plan.selected).toHaveLength(2);
  });

  it('rejects malformed identity text', () => {
    const plan = new SpatialTileViewportPlanner().plan([candidate({ layerId: '<script>' })]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.rejected).toBe(1);
  });

  it('rejects non-finite screen distance', () => {
    const plan = new SpatialTileViewportPlanner().plan([candidate({ screenDistance: Number.POSITIVE_INFINITY })]);
    expect(plan.rejected).toBe(1);
  });

  it('rejects non-finite projected footprint', () => {
    const plan = new SpatialTileViewportPlanner().plan([candidate({ projectedPixels: Number.NaN })]);
    expect(plan.rejected).toBe(1);
  });

  it('filters candidates outside configured LOD range', () => {
    const planner = new SpatialTileViewportPlanner({ minLevel: 5, maxLevel: 10 });
    const plan = planner.plan([candidate({ level: 4 }), candidate({ key: 'ok', column: 201, level: 8 }), candidate({ level: 11 })]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['ok']);
    expect(plan.rejected).toBe(2);
  });

  it('filters sub-pixel projected work', () => {
    const planner = new SpatialTileViewportPlanner({ minProjectedPixels: 2 });
    expect(planner.plan([candidate({ projectedPixels: 1.5 })]).selected).toHaveLength(0);
  });

  it('filters candidates beyond screen-distance budget', () => {
    const planner = new SpatialTileViewportPlanner({ maxScreenDistance: 100 });
    expect(planner.plan([candidate({ screenDistance: 101 })]).selected).toHaveLength(0);
  });

  it('enforces global selected-count budget', () => {
    const planner = new SpatialTileViewportPlanner({ maxSelected: 2, maxPerLayer: 2, maxVisible: 2, maxNearby: 2, maxSpeculative: 2 });
    const plan = planner.plan([
      candidate({ key: 'a', column: 1 }),
      candidate({ key: 'b', column: 2 }),
      candidate({ key: 'c', column: 3 }),
    ]);
    expect(plan.selected).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });

  it('enforces global selected-byte budget', () => {
    const planner = new SpatialTileViewportPlanner({ maxSelectedBytes: 2_048, maxPerLayerBytes: 2_048 });
    const plan = planner.plan([
      candidate({ key: 'a', column: 1, estimatedBytes: 1_500 }),
      candidate({ key: 'b', column: 2, estimatedBytes: 1_500 }),
    ]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selectedBytes).toBe(1_500);
  });

  it('enforces per-layer count budget without starving another layer', () => {
    const planner = new SpatialTileViewportPlanner({ maxPerLayer: 1 });
    const plan = planner.plan([
      candidate({ key: 'r1', column: 1, layerId: 'roads' }),
      candidate({ key: 'r2', column: 2, layerId: 'roads' }),
      candidate({ key: 'b1', column: 3, layerId: 'buildings' }),
    ]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['r1', 'b1']);
  });

  it('enforces per-layer byte budget', () => {
    const planner = new SpatialTileViewportPlanner({ maxPerLayerBytes: 2_000 });
    const plan = planner.plan([
      candidate({ key: 'a', column: 1, estimatedBytes: 1_500 }),
      candidate({ key: 'b', column: 2, estimatedBytes: 1_500 }),
    ]);
    expect(plan.selected).toHaveLength(1);
  });

  it('enforces independent priority budgets', () => {
    const planner = new SpatialTileViewportPlanner({ maxVisible: 1, maxNearby: 1, maxSpeculative: 1 });
    const plan = planner.plan([
      candidate({ key: 'v1', column: 1 }),
      candidate({ key: 'v2', column: 2 }),
      candidate({ key: 'n1', column: 3, priority: 'nearby' }),
      candidate({ key: 'n2', column: 4, priority: 'nearby' }),
      candidate({ key: 's1', column: 5, priority: 'speculative' }),
      candidate({ key: 's2', column: 6, priority: 'speculative' }),
    ]);
    expect(plan.selected.map((entry) => entry.key)).toEqual(['v1', 'n1', 's1']);
  });

  it('bounds candidate scanning', () => {
    const planner = new SpatialTileViewportPlanner({ maxCandidates: 2, maxSelected: 2, maxPerLayer: 2 });
    const plan = planner.plan([
      candidate({ key: 'a', column: 1 }),
      candidate({ key: 'b', column: 2 }),
      candidate({ key: 'c', column: 3 }),
    ]);
    expect(plan.candidateCount).toBe(2);
    expect(plan.truncated).toBe(true);
  });

  it('returns immutable plan collections', () => {
    const plan = new SpatialTileViewportPlanner().plan([candidate()]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selected)).toBe(true);
    expect(Object.isFrozen(plan.selected[0])).toBe(true);
    expect(Object.isFrozen(plan.selectedByLayer)).toBe(true);
  });

  it('tracks deterministic per-layer accounting', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'r', layerId: 'roads', column: 1, estimatedBytes: 100 }),
      candidate({ key: 'b', layerId: 'buildings', column: 2, estimatedBytes: 200 }),
    ]);
    expect(plan.selectedByLayer).toEqual({ roads: 1, buildings: 1 });
    expect(plan.selectedBytesByLayer).toEqual({ roads: 100, buildings: 200 });
  });

  it('normalizes surrounding whitespace before identity comparison', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: ' a ', layerId: ' roads ' }),
      candidate({ key: 'b', layerId: 'roads' }),
    ]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.duplicateCount).toBe(1);
  });

  it('uses variant in deterministic final ordering', () => {
    const plan = new SpatialTileViewportPlanner().plan([
      candidate({ key: 'z', variant: 'z' }),
      candidate({ key: 'a', variant: 'a' }),
    ]);
    expect(plan.selected.map((entry) => entry.variant)).toEqual(['a', 'z']);
  });

  it('fails closed for invalid constructor limits', () => {
    expect(() => new SpatialTileViewportPlanner({ maxCandidates: 0 })).toThrow(RangeError);
    expect(() => new SpatialTileViewportPlanner({ minLevel: 10, maxLevel: 9 })).toThrow(RangeError);
    expect(() => new SpatialTileViewportPlanner({ maxSelectedBytes: 0 })).toThrow(RangeError);
  });

  it('does not mutate caller candidates', () => {
    const input = candidate();
    const before = { ...input };
    new SpatialTileViewportPlanner().plan([input]);
    expect(input).toEqual(before);
  });
});
