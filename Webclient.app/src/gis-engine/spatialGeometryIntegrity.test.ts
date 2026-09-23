import { describe, expect, it } from 'vitest';
import {
  geometriesShareSpatialReference,
  inspectSpatialGeometry,
  type SpatialGeometryInput,
} from './spatialGeometryIntegrity';

const sr = Object.freeze({ wkid: 4326 });

describe('inspectSpatialGeometry', () => {
  it('accepts a finite point and derives its extent', () => {
    const result = inspectSpatialGeometry({ type: 'point', x: 29.1, y: 41.1, spatialReference: sr });
    expect(result.valid).toBe(true);
    expect(result.extent).toEqual({ xmin: 29.1, ymin: 41.1, xmax: 29.1, ymax: 41.1 });
    expect(result.vertexCount).toBe(1);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects missing spatial reference by default', () => {
    const result = inspectSpatialGeometry({ type: 'point', x: 1, y: 2 });
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain('missing-spatial-reference');
  });

  it('can explicitly allow geometry without spatial reference', () => {
    const result = inspectSpatialGeometry(
      { type: 'point', x: 1, y: 2 },
      { requireSpatialReference: false },
    );
    expect(result.valid).toBe(true);
    expect(result.spatialReference).toBeNull();
  });

  it('enforces an explicit WKID allowlist', () => {
    const result = inspectSpatialGeometry(
      { type: 'point', x: 1, y: 2, spatialReference: sr },
      { allowedWkids: [3857] },
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('unsupported-spatial-reference');
  });

  it('prefers latestWkid when checking an allowlist', () => {
    const result = inspectSpatialGeometry(
      { type: 'point', x: 1, y: 2, spatialReference: { wkid: 102100, latestWkid: 3857 } },
      { allowedWkids: [3857] },
    );
    expect(result.valid).toBe(true);
  });

  it('rejects non-finite coordinates', () => {
    const result = inspectSpatialGeometry({ type: 'point', x: Number.NaN, y: 2, spatialReference: sr });
    expect(result.valid).toBe(false);
    expect(result.extent).toBeNull();
    expect(result.issues.some((entry) => entry.code === 'invalid-coordinate')).toBe(true);
  });

  it('rejects coordinates beyond the configured magnitude', () => {
    const result = inspectSpatialGeometry(
      { type: 'point', x: 101, y: 2, spatialReference: sr },
      { maxCoordinateMagnitude: 100 },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'coordinate-out-of-range')).toBe(true);
  });

  it('derives an extent for a multipoint', () => {
    const result = inspectSpatialGeometry({
      type: 'multipoint',
      points: [[2, 4], [-1, 8], [3, -2]],
      spatialReference: sr,
    });
    expect(result.valid).toBe(true);
    expect(result.extent).toEqual({ xmin: -1, ymin: -2, xmax: 3, ymax: 8 });
    expect(result.vertexCount).toBe(3);
  });

  it('rejects empty multipoints', () => {
    const result = inspectSpatialGeometry({ type: 'multipoint', points: [], spatialReference: sr });
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'empty-geometry')).toBe(true);
  });

  it('bounds multipoint traversal by total vertex budget', () => {
    const points = Array.from({ length: 20 }, (_, index) => [index, index] as const);
    const result = inspectSpatialGeometry(
      { type: 'multipoint', points, spatialReference: sr },
      { maxVertices: 5 },
    );
    expect(result.valid).toBe(false);
    expect(result.vertexCount).toBe(20);
    expect(result.issues.some((entry) => entry.code === 'too-many-vertices')).toBe(true);
    expect(result.extent).toEqual({ xmin: 0, ymin: 0, xmax: 4, ymax: 4 });
  });

  it('validates polyline part and total vertex budgets', () => {
    const geometry: SpatialGeometryInput = {
      type: 'polyline',
      paths: [
        [[0, 0], [1, 1], [2, 2]],
        [[3, 3], [4, 4], [5, 5]],
      ],
      spatialReference: sr,
    };
    const result = inspectSpatialGeometry(geometry, { maxParts: 1, maxVerticesPerPart: 2, maxVertices: 4 });
    expect(result.valid).toBe(false);
    expect(result.partCount).toBe(2);
    expect(result.vertexCount).toBe(6);
    expect(result.issues.map((entry) => entry.code)).toContain('too-many-parts');
    expect(result.issues.map((entry) => entry.code)).toContain('too-many-vertices');
  });

  it('accepts explicitly closed polygon rings', () => {
    const result = inspectSpatialGeometry({
      type: 'polygon',
      rings: [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]],
      spatialReference: sr,
    });
    expect(result.valid).toBe(true);
    expect(result.extent).toEqual({ xmin: 0, ymin: 0, xmax: 4, ymax: 3 });
  });

  it('rejects open polygon rings', () => {
    const result = inspectSpatialGeometry({
      type: 'polygon',
      rings: [[[0, 0], [4, 0], [4, 3]]],
      spatialReference: sr,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'invalid-ring')).toBe(true);
  });

  it('accepts a normalized extent', () => {
    const result = inspectSpatialGeometry({
      type: 'extent', xmin: -5, ymin: -2, xmax: 10, ymax: 8, spatialReference: sr,
    });
    expect(result.valid).toBe(true);
    expect(result.extent).toEqual({ xmin: -5, ymin: -2, xmax: 10, ymax: 8 });
  });

  it('rejects inverted extents', () => {
    const result = inspectSpatialGeometry({
      type: 'extent', xmin: 10, ymin: 0, xmax: 1, ymax: 2, spatialReference: sr,
    });
    expect(result.valid).toBe(false);
    expect(result.extent).toBeNull();
    expect(result.issues.some((entry) => entry.code === 'invalid-extent')).toBe(true);
  });

  it('produces deterministic fingerprints for equivalent input', () => {
    const geometry: SpatialGeometryInput = {
      type: 'polyline',
      paths: [[[0, 0], [1, 2], [3, 4]]],
      spatialReference: sr,
    };
    expect(inspectSpatialGeometry(geometry).fingerprint).toBe(inspectSpatialGeometry(geometry).fingerprint);
  });
});

describe('geometriesShareSpatialReference', () => {
  it('recognizes matching latest WKIDs', () => {
    expect(geometriesShareSpatialReference(
      { type: 'point', x: 0, y: 0, spatialReference: { wkid: 102100, latestWkid: 3857 } },
      { type: 'point', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    )).toBe(true);
  });

  it('rejects different or missing WKIDs', () => {
    expect(geometriesShareSpatialReference(
      { type: 'point', x: 0, y: 0, spatialReference: { wkid: 4326 } },
      { type: 'point', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    )).toBe(false);
    expect(geometriesShareSpatialReference(
      { type: 'point', x: 0, y: 0 },
      { type: 'point', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    )).toBe(false);
  });
});
