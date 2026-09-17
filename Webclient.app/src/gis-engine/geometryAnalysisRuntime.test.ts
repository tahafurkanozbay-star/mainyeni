import { describe, expect, it } from 'vitest';
import {
  clipPointToExtent,
  distance3d,
  expandExtent,
  extentFromPoints,
  extentsIntersect,
  intersectionExtent,
  measurePolygon,
  measurePolyline,
  nearestPointOnPolyline,
  normalizeExtent,
  normalizeGeometryAnalysisBudget,
  planarDistance,
  pointInPolygon,
  projectPointToSegment,
  simplifyPolyline,
  validateAnalysisPoint,
  type AnalysisPolygon,
} from './geometryAnalysisRuntime';

const budget = { maxVertices: 100, maxSegments: 100, maxRings: 10 } as const;
const square: AnalysisPolygon = [[
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
  { x: 0, y: 0 },
]];

describe('geometryAnalysisRuntime', () => {
  it('normalizes bounded budgets and rejects unsafe values', () => {
    expect(normalizeGeometryAnalysisBudget(budget)).toEqual(budget);
    expect(() => normalizeGeometryAnalysisBudget({ ...budget, maxVertices: 0 })).toThrow();
    expect(() => normalizeGeometryAnalysisBudget({ ...budget, maxSegments: 1.5 })).toThrow();
  });

  it('validates point coordinates without inventing elevation', () => {
    expect(validateAnalysisPoint({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(validateAnalysisPoint({ x: 1, y: 2, z: 0 })).toEqual({ x: 1, y: 2, z: 0 });
    expect(() => validateAnalysisPoint({ x: Number.NaN, y: 2 })).toThrow();
  });

  it('normalizes and intersects extents including touching edges', () => {
    expect(normalizeExtent({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 })).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    expect(() => normalizeExtent({ xmin: 2, ymin: 0, xmax: 1, ymax: 1 })).toThrow();
    expect(extentsIntersect({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, { xmin: 1, ymin: 1, xmax: 2, ymax: 2 })).toBe(true);
    expect(intersectionExtent({ xmin: 0, ymin: 0, xmax: 2, ymax: 2 }, { xmin: 1, ymin: 1, xmax: 3, ymax: 3 })).toEqual({ xmin: 1, ymin: 1, xmax: 2, ymax: 2 });
  });

  it('derives bounded point extents and handles empty input', () => {
    expect(extentFromPoints([], 10)).toBeNull();
    expect(extentFromPoints([{ x: 5, y: -1 }, { x: -2, y: 9 }, { x: 100, y: 100 }], 2)).toEqual({ xmin: -2, ymin: -1, xmax: 5, ymax: 9 });
  });

  it('expands extents only with non-negative finite distances', () => {
    expect(expandExtent({ xmin: 1, ymin: 2, xmax: 3, ymax: 4 }, 2)).toEqual({ xmin: -1, ymin: 0, xmax: 5, ymax: 6 });
    expect(() => expandExtent({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, -1)).toThrow();
  });

  it('measures planar and 3d distances independently', () => {
    expect(planarDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(distance3d({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 })).toBe(13);
  });

  it('measures polyline length and elevation gain/loss', () => {
    const result = measurePolyline([
      { x: 0, y: 0, z: 10 },
      { x: 3, y: 4, z: 15 },
      { x: 6, y: 8, z: 12 },
    ], budget);
    expect(result.planarLength).toBe(10);
    expect(result.elevationGain).toBe(5);
    expect(result.elevationLoss).toBe(3);
    expect(result.minimumZ).toBe(10);
    expect(result.maximumZ).toBe(15);
    expect(result.diagnostics.truncated).toBe(false);
  });

  it('fails closed with explicit polyline truncation at vertex budget', () => {
    const result = measurePolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], { maxVertices: 2, maxSegments: 10, maxRings: 1 });
    expect(result.planarLength).toBe(1);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.verticesVisited).toBe(2);
  });

  it('measures polygon area, perimeter and centroid', () => {
    const result = measurePolygon(square, budget);
    expect(result.signedArea).toBe(100);
    expect(result.area).toBe(100);
    expect(result.perimeter).toBe(40);
    expect(result.centroid).toEqual({ x: 5, y: 5 });
    expect(result.diagnostics.truncated).toBe(false);
  });

  it('marks truncated polygon analysis and withholds a misleading centroid', () => {
    const result = measurePolygon(square, { maxVertices: 2, maxSegments: 2, maxRings: 1 });
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.centroid).toBeNull();
  });

  it('supports holes with even-odd point-in-polygon semantics', () => {
    const polygon: AnalysisPolygon = [
      square[0]!,
      [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }, { x: 2, y: 2 }],
    ];
    expect(pointInPolygon({ x: 1, y: 1 }, polygon, budget).inside).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, polygon, budget).inside).toBe(false);
    expect(pointInPolygon({ x: 20, y: 20 }, polygon, budget).inside).toBe(false);
  });

  it('reports polygon boundary separately', () => {
    expect(pointInPolygon({ x: 0, y: 5 }, square, budget)).toMatchObject({ inside: true, onBoundary: true });
  });

  it('fails closed when containment budget is exhausted', () => {
    const result = pointInPolygon({ x: 5, y: 5 }, square, { maxVertices: 1, maxSegments: 1, maxRings: 1 });
    expect(result.inside).toBe(false);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('projects points onto finite segments with clamped fractions', () => {
    expect(projectPointToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ point: { x: 5, y: 0 }, distance: 3, fraction: 0.5 });
    expect(projectPointToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }).fraction).toBe(0);
    expect(projectPointToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }).fraction).toBe(1);
  });

  it('finds nearest point on a bounded polyline', () => {
    const result = nearestPointOnPolyline({ x: 7, y: 3 }, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], 10);
    expect(result).toEqual({ point: { x: 7, y: 0 }, distance: 3, fraction: 0.4, segmentIndex: 1 });
  });

  it('simplifies sequential samples without exceeding the vertex scan budget', () => {
    const result = simplifyPolyline([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 2, y: 0 }, { x: 2.1, y: 0 }, { x: 4, y: 0 }], 1, 5);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }]);
  });

  it('clips point coordinates to a validated extent while preserving z=0', () => {
    expect(clipPointToExtent({ x: -2, y: 20, z: 0 }, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 })).toEqual({ x: 0, y: 10, z: 0 });
  });

  it('honors cancellation before geometry traversal', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop geometry'));
    expect(() => measurePolyline([{ x: 0, y: 0 }, { x: 1, y: 1 }], budget, controller.signal)).toThrow('stop geometry');
    expect(() => pointInPolygon({ x: 1, y: 1 }, square, budget, controller.signal)).toThrow('stop geometry');
  });
});
