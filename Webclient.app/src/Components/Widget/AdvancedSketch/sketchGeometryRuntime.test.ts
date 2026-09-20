import { describe, expect, it } from 'vitest';
import {
  analyzeGeometry,
  createGraphicSnapshot,
  estimateGraphicBytes,
  snapshotGeometry,
  totalGraphicBytes,
} from './sketchGeometryRuntime';

describe('sketchGeometryRuntime', () => {
  it('analyzes point coordinates and bounds', () => {
    const result = analyzeGeometry({
      type: 'point',
      spatialReferenceWkid: 4326,
      payload: { x: 32.85, y: 39.92 },
    });
    expect(result).toEqual(expect.objectContaining({
      type: 'point',
      coordinateCount: 1,
      finiteCoordinateCount: 1,
      invalidCoordinateCount: 0,
      bounds: [32.85, 39.92, 32.85, 39.92],
    }));
  });

  it('analyzes polyline paths', () => {
    const result = analyzeGeometry({
      type: 'polyline',
      spatialReferenceWkid: 4326,
      payload: {
        paths: [
          [[0, 0], [10, 4]],
          [[-2, 3], [5, 8]],
        ],
      },
    });
    expect(result.coordinateCount).toBe(4);
    expect(result.bounds).toEqual([-2, 0, 10, 8]);
  });

  it('analyzes polygon rings', () => {
    const result = analyzeGeometry({
      type: 'polygon',
      spatialReferenceWkid: 4326,
      payload: {
        rings: [[[0, 0], [4, 0], [4, 5], [0, 0]]],
      },
    });
    expect(result.coordinateCount).toBe(4);
    expect(result.bounds).toEqual([0, 0, 4, 5]);
  });

  it('flags invalid and non-finite coordinates', () => {
    const result = analyzeGeometry({
      type: 'point',
      spatialReferenceWkid: 4326,
      payload: { x: Number.NaN, y: 5 },
    });
    expect(result.invalidCoordinateCount).toBe(1);
    expect(result.finiteCoordinateCount).toBe(0);
    expect(result.bounds).toBeNull();
  });

  it('flags coordinates outside the configured absolute limit', () => {
    const result = analyzeGeometry({
      type: 'point',
      spatialReferenceWkid: 4326,
      payload: { x: 500, y: 10 },
    }, { maxAbsoluteCoordinate: 100 });
    expect(result.invalidCoordinateCount).toBe(1);
  });

  it('enforces polygon ring budgets', () => {
    expect(() => analyzeGeometry({
      type: 'polygon',
      spatialReferenceWkid: 4326,
      payload: {
        rings: [
          [[0, 0]],
          [[1, 1]],
        ],
      },
    }, { maxRings: 1 })).toThrow('ring budget');
  });

  it('enforces polyline path budgets', () => {
    expect(() => analyzeGeometry({
      type: 'polyline',
      spatialReferenceWkid: 4326,
      payload: {
        paths: [
          [[0, 0]],
          [[1, 1]],
        ],
      },
    }, { maxPaths: 1 })).toThrow('path budget');
  });

  it('snapshots ArcGIS-like point objects', () => {
    const snapshot = snapshotGeometry({
      type: 'point',
      x: 32.85,
      y: 39.92,
      spatialReference: { wkid: 4326 },
      toJSON() {
        return {
          type: 'point',
          x: this.x,
          y: this.y,
          spatialReference: this.spatialReference,
        };
      },
    });
    expect(snapshot.type).toBe('point');
    expect(snapshot.spatialReferenceWkid).toBe(4326);
    expect(snapshot.payload).toEqual(expect.objectContaining({
      x: 32.85,
      y: 39.92,
    }));
  });

  it('rejects invalid geometry coordinates during snapshot creation', () => {
    expect(() => snapshotGeometry({
      type: 'point',
      x: Number.POSITIVE_INFINITY,
      y: 1,
    })).toThrow('invalid or non-finite coordinates');
  });

  it('creates immutable graphic snapshots', () => {
    const graphic = createGraphicSnapshot({
      id: '  g-1  ',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: { name: 'Park', nested: { safe: true } },
      symbol: { type: 'simple-marker', color: '#fff' },
      createdAt: 10,
      updatedAt: 11,
    });
    expect(graphic.id).toBe('g-1');
    expect(graphic.createdAt).toBe(10);
    expect(graphic.updatedAt).toBe(11);
    expect(Object.isFrozen(graphic)).toBe(true);
  });

  it('rejects empty graphic identifiers', () => {
    expect(() => createGraphicSnapshot({
      id: '   ',
      geometry: { type: 'point', x: 1, y: 2 },
    })).toThrow('id is required');
  });

  it('drops prototype-pollution keys from attributes', () => {
    const attributes = JSON.parse('{"name":"safe","__proto__":{"polluted":true},"constructor":"bad"}');
    const graphic = createGraphicSnapshot({
      id: 'safe',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes,
    });
    expect(graphic.attributes.name).toBe('safe');
    expect(graphic.attributes.__proto__).toBeUndefined();
    expect(graphic.attributes.constructor).toBeUndefined();
  });

  it('estimates graphic and collection byte sizes', () => {
    const first = createGraphicSnapshot({
      id: 'a',
      geometry: { type: 'point', x: 1, y: 2 },
    });
    const second = createGraphicSnapshot({
      id: 'b',
      geometry: { type: 'point', x: 3, y: 4 },
    });
    expect(estimateGraphicBytes(first)).toBeGreaterThan(0);
    expect(totalGraphicBytes([first, second]))
      .toBe(estimateGraphicBytes(first) + estimateGraphicBytes(second));
  });

  it('classifies unknown geometry types safely', () => {
    const result = analyzeGeometry({
      type: 'future-geometry',
      payload: { coordinates: [[1, 2], [3, 4]] },
    });
    expect(result.type).toBe('unknown');
    expect(result.coordinateCount).toBe(2);
  });

  it('bounds coordinate traversal', () => {
    const coordinates = Array.from({ length: 100 }, (_, index) => [index, index]);
    const result = analyzeGeometry({
      type: 'unknown',
      payload: { coordinates },
    }, { maxCoordinates: 10 });
    expect(result.coordinateCount).toBe(10);
  });
});
