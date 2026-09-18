import { describe, expect, it } from 'vitest';
import { aggregateSpatialGrid } from './spatialAggregationRuntime';

const budget = { maxPoints: 100, maxCells: 10, maxCategoriesPerCell: 3 } as const;

describe('aggregateSpatialGrid', () => {
  it('aggregates deterministic cells with weighted centroids', () => {
    const result = aggregateSpatialGrid([
      { x: 1, y: 1, weight: 1, category: 0 },
      { x: 3, y: 1, weight: 3, category: '0' },
      { x: 12, y: 2, weight: 2, category: 'park' },
    ], 10, budget);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]).toMatchObject({ key: '0:0', count: 2, weight: 4, centroidX: 2.5, centroidY: 1 });
    expect(result.cells[0]?.categories.map((item) => item.category)).toEqual(['number:0', 'string:0']);
    expect(result.acceptedPoints).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('honors a deterministic grid origin including negative coordinates', () => {
    const result = aggregateSpatialGrid([{ x: -1, y: -1 }, { x: 9, y: 9 }], 10, budget, { originX: -5, originY: -5 });
    expect(result.cells.map((cell) => cell.key)).toEqual(['0:0', '1:1']);
  });

  it('fails closed when the point inspection budget is exhausted', () => {
    const result = aggregateSpatialGrid([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 10, { ...budget, maxPoints: 2 });
    expect(result.acceptedPoints).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toContain('point-budget-exhausted');
  });

  it('bounds unique cell allocation without evicting accepted cells', () => {
    const result = aggregateSpatialGrid([{ x: 1, y: 1 }, { x: 21, y: 1 }, { x: 2, y: 2 }], 10, { ...budget, maxCells: 1 });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.count).toBe(2);
    expect(result.rejectedPoints).toBe(1);
    expect(result.diagnostics).toContain('cell-budget-exhausted');
  });

  it('bounds per-cell category cardinality', () => {
    const result = aggregateSpatialGrid([
      { x: 1, y: 1, category: 'a' },
      { x: 2, y: 2, category: 'b' },
      { x: 3, y: 3, category: 'c' },
    ], 10, { ...budget, maxCategoriesPerCell: 2 });
    expect(result.cells[0]?.categories).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics).toContain('category-budget-exhausted');
  });

  it('rejects non-finite and negative-weight observations', () => {
    const result = aggregateSpatialGrid([
      { x: Number.NaN, y: 1 },
      { x: 1, y: Number.POSITIVE_INFINITY },
      { x: 1, y: 1, weight: -1 },
      { x: 2, y: 2 },
    ], 10, budget);
    expect(result.acceptedPoints).toBe(1);
    expect(result.rejectedPoints).toBe(3);
  });

  it('uses an unweighted centroid when all accepted weights are zero', () => {
    const result = aggregateSpatialGrid([{ x: 2, y: 4, weight: 0 }, { x: 6, y: 8, weight: 0 }], 10, budget);
    expect(result.cells[0]).toMatchObject({ centroidX: 4, centroidY: 6, weight: 0 });
  });

  it('validates configuration before allocating cells', () => {
    expect(() => aggregateSpatialGrid([], 0, budget)).toThrow(RangeError);
    expect(() => aggregateSpatialGrid([], 10, { ...budget, maxCells: 0 })).toThrow(RangeError);
    expect(() => aggregateSpatialGrid([], 10, budget, { originX: Number.NaN })).toThrow(RangeError);
  });

  it('observes cancellation before processing', () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    expect(() => aggregateSpatialGrid([{ x: 1, y: 1 }], 10, budget, { signal: controller.signal })).toThrow('cancelled');
  });
});
