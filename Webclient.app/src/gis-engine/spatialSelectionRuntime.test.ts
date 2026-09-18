import { describe, expect, it } from 'vitest';
import type { SpatialFeature } from './spatialAnalysisRuntime';
import {
  createSelectionStore,
  mergeSelection,
  pointInPolygon,
  selectByExtent,
  selectByPolygon,
} from './spatialSelectionRuntime';

const feature = (id: string | number, x: number, y: number): SpatialFeature<{ label: string }> => ({
  id,
  point: { x, y },
  data: { label: String(id) },
});
const budget = { maxCandidates: 20, maxSelected: 10, maxPolygonVertices: 20 } as const;

describe('spatialSelectionRuntime', () => {
  it('selects points inside an extent deterministically', () => {
    const result = selectByExtent([feature(0, 0, 0), feature(1, 5, 5), feature(2, 11, 11)], { xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, budget);
    expect(result.features.map(({ id }) => id)).toEqual([0, 1]);
    expect(result.diagnostics).toEqual({ inspected: 3, matched: 2, selected: 2, truncated: false });
  });

  it('preserves numeric and string identities independently', () => {
    const result = selectByExtent([feature(0, 1, 1), feature('0', 2, 2)], { xmin: 0, ymin: 0, xmax: 3, ymax: 3 }, budget);
    expect(result.features).toHaveLength(2);
  });

  it('reports candidate truncation', () => {
    const result = selectByExtent([feature(1, 1, 1), feature(2, 2, 2)], { xmin: 0, ymin: 0, xmax: 3, ymax: 3 }, { ...budget, maxCandidates: 1 });
    expect(result.features).toHaveLength(1);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('reports result-budget truncation', () => {
    const result = selectByExtent([feature(1, 1, 1), feature(2, 2, 2)], { xmin: 0, ymin: 0, xmax: 3, ymax: 3 }, { ...budget, maxSelected: 1 });
    expect(result.features).toHaveLength(1);
    expect(result.diagnostics.matched).toBe(2);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('supports polygon selection', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, polygon)).toBe(false);
    expect(selectByPolygon([feature(1, 5, 5), feature(2, 15, 5)], polygon, budget).features.map(({ id }) => id)).toEqual([1]);
  });

  it('rejects polygon work beyond the configured vertex budget', () => {
    expect(() => selectByPolygon([], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { ...budget, maxPolygonVertices: 3 })).toThrow('polygon vertex budget exceeded');
  });

  it('rejects invalid extent and non-finite coordinates', () => {
    expect(() => selectByExtent([], { xmin: 2, ymin: 0, xmax: 1, ymax: 1 }, budget)).toThrow('extent bounds are inverted');
    expect(() => selectByExtent([feature(1, Number.NaN, 0)], { xmin: 0, ymin: 0, xmax: 2, ymax: 2 }, budget)).toThrow('point.x must be finite');
  });

  it('honors cancellation before scanning candidates', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop-selection'));
    expect(() => selectByExtent([feature(1, 1, 1)], { xmin: 0, ymin: 0, xmax: 2, ymax: 2 }, budget, controller.signal)).toThrow('stop-selection');
  });

  it('merges selection using replace/add/remove/toggle semantics', () => {
    const one = feature(1, 1, 1);
    const two = feature(2, 2, 2);
    const three = feature(3, 3, 3);
    expect(mergeSelection([one], [two], 'replace', 10).map(({ id }) => id)).toEqual([2]);
    expect(mergeSelection([one], [two], 'add', 10).map(({ id }) => id)).toEqual([1, 2]);
    expect(mergeSelection([one, two], [one], 'remove', 10).map(({ id }) => id)).toEqual([2]);
    expect(mergeSelection([one, two], [two, three], 'toggle', 10).map(({ id }) => id)).toEqual([1, 3]);
  });

  it('provides a bounded mutable store with immutable snapshots', () => {
    const store = createSelectionStore<{ label: string }>(2);
    store.apply([feature(1, 1, 1), feature(2, 2, 2), feature(3, 3, 3)]);
    expect(store.getSnapshot().map(({ id }) => id)).toEqual([1, 2]);
    store.apply([feature(2, 2, 2)], 'toggle');
    expect(store.getSnapshot().map(({ id }) => id)).toEqual([1]);
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
  });
});
