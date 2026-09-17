import { describe, expect, it } from 'vitest';
import {
  buildSpatialGrid,
  extentContainsPoint,
  filterByExtent,
  findNearest,
  normalizeSpatialAnalysisBudget,
  querySpatialGrid,
  squaredDistance,
  type SpatialFeature,
} from './spatialAnalysisRuntime';

const features: readonly SpatialFeature<string>[] = [
  { id: 0, point: { x: 0, y: 0 }, data: 'origin' },
  { id: 1, point: { x: 3, y: 4 }, data: 'five' },
  { id: '2', point: { x: 2, y: 0 }, data: 'two' },
  { id: 3, point: { x: 50, y: 50 }, data: 'far' },
];

describe('spatialAnalysisRuntime', () => {
  it('normalizes finite bounded budgets', () => {
    expect(normalizeSpatialAnalysisBudget({ maxCandidates: 4, maxResults: 2, maxDistance: 10 })).toEqual({
      maxCandidates: 4,
      maxResults: 2,
      maxDistance: 10,
    });
    expect(() => normalizeSpatialAnalysisBudget({ maxCandidates: 0, maxResults: 1, maxDistance: 1 })).toThrow();
    expect(() => normalizeSpatialAnalysisBudget({ maxCandidates: 1, maxResults: 1.2, maxDistance: 1 })).toThrow();
  });

  it('computes deterministic planar squared distance', () => {
    expect(squaredDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(25);
    expect(() => squaredDistance({ x: Number.NaN, y: 0 }, { x: 0, y: 0 })).toThrow();
  });

  it('validates extents and includes boundaries', () => {
    expect(extentContainsPoint({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(extentContainsPoint({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, { x: 11, y: 10 })).toBe(false);
    expect(() => extentContainsPoint({ xmin: 2, ymin: 0, xmax: 1, ymax: 1 }, { x: 1, y: 1 })).toThrow();
  });

  it('bounds extent filtering', () => {
    expect(filterByExtent(features, { xmin: -1, ymin: -1, xmax: 10, ymax: 10 }, 2).map((feature) => feature.id)).toEqual([0, 1]);
  });

  it('finds nearest features with stable tie/order and budgets', () => {
    const result = findNearest({ x: 0, y: 0 }, features, { maxCandidates: 4, maxResults: 2, maxDistance: 10 });
    expect(result.results.map((item) => [item.feature.id, item.distance])).toEqual([[0, 0], ['2', 2]]);
    expect(result.inspected).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('reports candidate truncation', () => {
    const result = findNearest({ x: 0, y: 0 }, features, { maxCandidates: 1, maxResults: 5, maxDistance: 100 });
    expect(result.inspected).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('honors cancellation before analysis work', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    expect(() => findNearest({ x: 0, y: 0 }, features, { maxCandidates: 4, maxResults: 2, maxDistance: 10 }, controller.signal)).toThrow('stop');
  });

  it('builds bounded grid cells and queries only matching features', () => {
    const grid = buildSpatialGrid(features, { cellSize: 10, maxCells: 2, maxFeaturesPerCell: 3 });
    expect(grid.size).toBe(2);
    expect(querySpatialGrid(grid, { xmin: -1, ymin: -1, xmax: 5, ymax: 5 }, 10, 10).map((feature) => feature.id)).toEqual([0, 1, '2']);
  });

  it('caps features retained in each grid cell', () => {
    const grid = buildSpatialGrid(features, { cellSize: 100, maxCells: 1, maxFeaturesPerCell: 2 });
    expect([...grid.values()][0]?.map((feature) => feature.id)).toEqual([0, 1]);
  });
});
