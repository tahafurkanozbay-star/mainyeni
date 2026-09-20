import { describe, expect, it } from 'vitest';
import {
  estimateSpatialGeometryBytes,
  geometryIntersectsBounds,
  normalizeSpatialGeometry,
  normalizeSpatialGeometryLimits,
} from './spatialGeometryContract';

describe('normalizeSpatialGeometryLimits', () => {
  it('provides bounded defaults', () => {
    const limits = normalizeSpatialGeometryLimits();
    expect(limits.maxParts).toBeGreaterThan(0);
    expect(limits.maxVertices).toBeGreaterThan(limits.maxParts);
    expect(limits.maxCoordinatesPerVertex).toBe(4);
  });

  it('rejects unsafe budgets', () => {
    expect(() => normalizeSpatialGeometryLimits({ maxParts: 0 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometryLimits({ maxVertices: -1 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometryLimits({ maxCoordinatesPerVertex: 1 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometryLimits({ maxCoordinatesPerVertex: 5 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometryLimits({ maxAbsoluteCoordinate: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('normalizeSpatialGeometry', () => {
  it('normalizes point coordinates and latest WKID', () => {
    const result = normalizeSpatialGeometry({
      type: 'point',
      x: -0,
      y: 41,
      spatialReference: { wkid: 102100, latestWkid: 3857 },
    });
    expect(result.geometry).toEqual({ type: 'point', x: 0, y: 41, spatialReference: { wkid: 3857 } });
    expect(result.inspection).toMatchObject({
      type: 'point',
      partCount: 1,
      vertexCount: 1,
      coordinateCount: 2,
      spatialReferenceWkid: 3857,
      bounds: { xmin: 0, ymin: 41, xmax: 0, ymax: 41 },
    });
  });

  it('preserves point z and m dimensions', () => {
    const result = normalizeSpatialGeometry({ type: 'point', x: 1, y: 2, z: 3, m: 4 });
    expect(result.geometry).toEqual({ type: 'point', x: 1, y: 2, z: 3, m: 4 });
    expect(result.inspection.hasZ).toBe(true);
    expect(result.inspection.hasM).toBe(true);
    expect(result.inspection.coordinateCount).toBe(4);
  });

  it('normalizes multipoint bounds', () => {
    const result = normalizeSpatialGeometry({
      type: 'multipoint',
      points: [[3, 4], [-1, 10], [5, 2]],
    });
    expect(result.inspection).toMatchObject({
      partCount: 1,
      vertexCount: 3,
      bounds: { xmin: -1, ymin: 2, xmax: 5, ymax: 10 },
    });
  });

  it('normalizes multipart polylines', () => {
    const result = normalizeSpatialGeometry({
      type: 'polyline',
      paths: [
        [[0, 0], [1, 1]],
        [[10, 10], [20, 20], [30, 15]],
      ],
    });
    expect(result.inspection.partCount).toBe(2);
    expect(result.inspection.vertexCount).toBe(5);
    expect(result.inspection.bounds).toEqual({ xmin: 0, ymin: 0, xmax: 30, ymax: 20 });
  });

  it('accepts closed polygon rings', () => {
    const result = normalizeSpatialGeometry({
      type: 'polygon',
      rings: [[[0, 0], [10, 0], [10, 10], [0, 0]]],
    });
    expect(result.inspection.partCount).toBe(1);
    expect(result.inspection.vertexCount).toBe(4);
  });

  it('rejects unclosed polygon rings', () => {
    expect(() => normalizeSpatialGeometry({
      type: 'polygon',
      rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    })).toThrow('must be closed');
  });

  it('normalizes valid extents', () => {
    const result = normalizeSpatialGeometry({
      type: 'extent', xmin: -10, ymin: -20, xmax: 30, ymax: 40, zmin: 5, zmax: 9,
    });
    expect(result.inspection.bounds).toEqual({ xmin: -10, ymin: -20, xmax: 30, ymax: 40 });
    expect(result.inspection.hasZ).toBe(true);
  });

  it('rejects inverted extents', () => {
    expect(() => normalizeSpatialGeometry({ type: 'extent', xmin: 2, ymin: 0, xmax: 1, ymax: 1 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometry({ type: 'extent', xmin: 0, ymin: 2, xmax: 1, ymax: 1 })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometry({ type: 'extent', xmin: 0, ymin: 0, xmax: 1, ymax: 1, zmin: 2, zmax: 1 })).toThrow(RangeError);
  });

  it('rejects empty multipart geometries', () => {
    expect(() => normalizeSpatialGeometry({ type: 'multipoint', points: [] })).toThrow(TypeError);
    expect(() => normalizeSpatialGeometry({ type: 'polyline', paths: [] })).toThrow(TypeError);
    expect(() => normalizeSpatialGeometry({ type: 'polygon', rings: [] })).toThrow(TypeError);
  });

  it('rejects underspecified parts', () => {
    expect(() => normalizeSpatialGeometry({ type: 'polyline', paths: [[[0, 0]]] })).toThrow(TypeError);
    expect(() => normalizeSpatialGeometry({ type: 'polygon', rings: [[[0, 0], [1, 0], [0, 0]]] })).toThrow(TypeError);
  });

  it('rejects malformed vertices', () => {
    expect(() => normalizeSpatialGeometry({ type: 'multipoint', points: [[1]] })).toThrow(TypeError);
    expect(() => normalizeSpatialGeometry({ type: 'multipoint', points: [[1, Number.NaN]] })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometry({ type: 'multipoint', points: [[1, 2, 3, 4, 5]] })).toThrow(RangeError);
  });

  it('enforces absolute coordinate limits', () => {
    expect(() => normalizeSpatialGeometry(
      { type: 'point', x: 101, y: 0 },
      { maxAbsoluteCoordinate: 100 },
    )).toThrow('coordinate budget');
  });

  it('enforces vertex limits across all parts', () => {
    expect(() => normalizeSpatialGeometry(
      { type: 'polyline', paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
      { maxVertices: 3 },
    )).toThrow('vertex budget');
  });

  it('enforces part limits', () => {
    expect(() => normalizeSpatialGeometry(
      { type: 'polyline', paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
      { maxParts: 1 },
    )).toThrow('part budget');
  });

  it('rejects malformed WKIDs', () => {
    expect(() => normalizeSpatialGeometry({ type: 'point', x: 1, y: 2, spatialReference: { wkid: 0 } })).toThrow(RangeError);
    expect(() => normalizeSpatialGeometry({ type: 'point', x: 1, y: 2, spatialReference: { latestWkid: Number.NaN } })).toThrow(RangeError);
  });
});

describe('spatial geometry estimates and coarse bounds', () => {
  it('produces a deterministic positive memory estimate', () => {
    const inspection = normalizeSpatialGeometry({ type: 'multipoint', points: [[0, 0], [1, 1]] }).inspection;
    expect(estimateSpatialGeometryBytes(inspection)).toBe(96 + 2 * 8 + 1 * 16 + 4 * 8);
  });

  it('detects intersecting bounds inclusively', () => {
    const inspection = normalizeSpatialGeometry({ type: 'extent', xmin: 0, ymin: 0, xmax: 10, ymax: 10 }).inspection;
    expect(geometryIntersectsBounds(inspection, { xmin: 10, ymin: 10, xmax: 20, ymax: 20 })).toBe(true);
    expect(geometryIntersectsBounds(inspection, { xmin: 11, ymin: 11, xmax: 20, ymax: 20 })).toBe(false);
  });

  it('rejects invalid comparison bounds', () => {
    const inspection = normalizeSpatialGeometry({ type: 'point', x: 0, y: 0 }).inspection;
    expect(() => geometryIntersectsBounds(inspection, { xmin: 2, ymin: 0, xmax: 1, ymax: 1 })).toThrow(RangeError);
    expect(() => geometryIntersectsBounds(inspection, { xmin: Number.NaN, ymin: 0, xmax: 1, ymax: 1 })).toThrow(RangeError);
  });
});
