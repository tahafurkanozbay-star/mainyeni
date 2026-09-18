import {
  GEOMETRY_ISSUE,
  GEOMETRY_KIND,
  assessGeometryCollection,
  countGeometryVertices,
  detectGeometryKind,
  geometryComplexity,
  geometryExtent,
  geometryFingerprint,
  normalizeGeometry,
  normalizeSpatialReference,
} from './geometryIntegrityRuntime';

describe('geometryIntegrityRuntime', () => {
  test('detects ArcGIS geometry kinds from structural fields', () => {
    expect(detectGeometryKind({ x: 1, y: 2 })).toBe(GEOMETRY_KIND.POINT);
    expect(detectGeometryKind({ points: [[1, 2]] })).toBe(GEOMETRY_KIND.MULTIPOINT);
    expect(detectGeometryKind({ paths: [[[1, 2], [3, 4]]] })).toBe(GEOMETRY_KIND.POLYLINE);
    expect(detectGeometryKind({ rings: [[[1, 2], [3, 4], [1, 2]]] })).toBe(GEOMETRY_KIND.POLYGON);
    expect(detectGeometryKind({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 })).toBe(GEOMETRY_KIND.EXTENT);
  });

  test('normalizes latestWkid to a stable wkid contract', () => {
    expect(normalizeSpatialReference({ wkid: 102100, latestWkid: 3857 })).toEqual({ wkid: 3857 });
  });

  test('preserves WKT only when no numeric wkid is available', () => {
    expect(normalizeSpatialReference({ wkt: 'LOCAL_CS["test"]' })).toEqual({ wkt: 'LOCAL_CS["test"]' });
  });

  test('normalizes a point and preserves z/m dimensions when valid', () => {
    const result = normalizeGeometry({
      x: 32.85,
      y: 39.93,
      z: 950,
      m: 10,
      spatialReference: { wkid: 4326 },
    });
    expect(result.geometry).toEqual(expect.objectContaining({
      type: 'point',
      x: 32.85,
      y: 39.93,
      z: 950,
      m: 10,
      spatialReference: { wkid: 4326 },
    }));
    expect(result.diagnostics.valid).toBe(true);
    expect(result.diagnostics.hasZ).toBe(true);
    expect(result.diagnostics.hasM).toBe(true);
  });

  test('preserves M without reinterpreting it as Z', () => {
    const result = normalizeGeometry({ x: 32.85, y: 39.93, m: 77 });
    expect(result.geometry).toEqual(expect.objectContaining({
      type: 'point',
      x: 32.85,
      y: 39.93,
      m: 77,
    }));
    expect(result.geometry).not.toHaveProperty('z');
    expect(result.diagnostics.hasZ).toBe(false);
    expect(result.diagnostics.hasM).toBe(true);
  });

  test('reports malformed point coordinates as coordinate integrity errors', () => {
    const result = normalizeGeometry({ x: 'not-a-number', y: 39.9 });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.valid).toBe(false);
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.INVALID_COORDINATE }),
    ]));
  });

  test('reports WGS84 coordinates outside geographic range', () => {
    const result = normalizeGeometry({
      x: 400,
      y: 100,
      spatialReference: { wkid: 4326 },
    });
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.OUT_OF_RANGE }),
    ]));
    expect(result.diagnostics.valid).toBe(true);
  });

  test('can fail WGS84 range violations for strict release gates', () => {
    const result = normalizeGeometry({
      x: 400,
      y: 100,
      spatialReference: { wkid: 4326 },
    }, { failOnOutOfRange: true });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.valid).toBe(false);
  });

  test('can drop WGS84 out-of-range vertices from multipoints', () => {
    const result = normalizeGeometry({
      points: [[32, 39], [500, 100]],
      spatialReference: { wkid: 4326 },
    }, { dropOutOfRange: true });
    expect(result.geometry.points).toEqual([[32, 39]]);
    expect(result.diagnostics.droppedVertices).toBe(1);
  });

  test('drops malformed polyline vertices and preserves valid paths', () => {
    const result = normalizeGeometry({
      paths: [[[1, 2], ['bad', 3], [4, 5]]],
      spatialReference: { wkid: 3857 },
    });
    expect(result.geometry.paths).toEqual([[[1, 2], [4, 5]]]);
    expect(result.diagnostics.droppedVertices).toBe(1);
    expect(result.diagnostics.valid).toBe(true);
  });

  test('drops a polyline part that becomes too short after validation', () => {
    const result = normalizeGeometry({ paths: [[[1, 2], ['bad', 3]]] });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.TOO_FEW_VERTICES }),
    ]));
  });

  test('repairs an open polygon ring deterministically by default', () => {
    const result = normalizeGeometry({
      rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    });
    expect(result.geometry.rings[0]).toEqual([
      [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
    ]);
    expect(result.diagnostics.repairedRings).toBe(1);
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.OPEN_RING }),
    ]));
  });

  test('does not repair rings when explicitly disabled', () => {
    const result = normalizeGeometry({
      rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    }, { repairRings: false });
    expect(result.geometry.rings[0]).toHaveLength(4);
    expect(result.diagnostics.repairedRings).toBe(0);
  });

  test('drops polygon parts with fewer than four closed-ring vertices', () => {
    const result = normalizeGeometry({ rings: [[[0, 0], [1, 1]]] });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.valid).toBe(false);
  });

  test('rejects an inverted extent', () => {
    const result = normalizeGeometry({ xmin: 10, ymin: 0, xmax: 1, ymax: 2 });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.INVALID_EXTENT }),
    ]));
  });

  test('requires a spatial reference when configured for strict contracts', () => {
    const result = normalizeGeometry({ x: 1, y: 2 }, { requireSpatialReference: true });
    expect(result.geometry).toBeNull();
    expect(result.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: GEOMETRY_ISSUE.INVALID_SPATIAL_REFERENCE }),
    ]));
  });

  test('applies default wkid when source geometry omits it', () => {
    const result = normalizeGeometry({ x: 1, y: 2 }, { defaultWkid: 3857 });
    expect(result.geometry.spatialReference).toEqual({ wkid: 3857 });
  });

  test('calculates an extent from point collections', () => {
    expect(geometryExtent({
      points: [[2, 8], [1, 9], [5, 3]],
      spatialReference: { wkid: 3857 },
    })).toEqual({
      xmin: 1,
      ymin: 3,
      xmax: 5,
      ymax: 9,
      spatialReference: { wkid: 3857 },
    });
  });

  test('calculates an extent from polygon vertices', () => {
    expect(geometryExtent({
      rings: [[[0, 0], [5, 0], [5, 7], [0, 0]]],
    })).toEqual({ xmin: 0, ymin: 0, xmax: 5, ymax: 7 });
  });

  test('returns null extent for data without valid coordinates', () => {
    expect(geometryExtent({ points: [['x', 'y']] })).toBeNull();
  });

  test('counts vertices consistently across geometry kinds', () => {
    expect(countGeometryVertices({ x: 1, y: 2 })).toBe(1);
    expect(countGeometryVertices({ points: [[1, 2], [3, 4]] })).toBe(2);
    expect(countGeometryVertices({ paths: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] })).toBe(4);
  });

  test('weights polygon geometry complexity above point geometry', () => {
    expect(geometryComplexity({
      rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    })).toBeGreaterThan(geometryComplexity({ x: 0, y: 0 }));
  });

  test('produces deterministic fingerprints independent of object property order', () => {
    const left = geometryFingerprint({ x: 1, y: 2, spatialReference: { wkid: 4326 } });
    const right = geometryFingerprint({ spatialReference: { wkid: 4326 }, y: 2, x: 1 });
    expect(left).toBe(right);
  });

  test('summarizes mixed geometry collection integrity', () => {
    const summary = assessGeometryCollection([
      { geometry: { x: 32, y: 39, spatialReference: { wkid: 4326 } } },
      { geometry: null },
      { geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.valid).toBe(2);
    expect(summary.invalid).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.issueCounts[GEOMETRY_ISSUE.MISSING]).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(summary.invalidIndexes).toEqual([1]);
    expect(summary.byKind.point).toBe(1);
    expect(summary.byKind.polygon).toBe(1);
  });

  test('empty collections are valid release samples with ratio 1', () => {
    expect(assessGeometryCollection([])).toEqual(expect.objectContaining({
      total: 0,
      validRatio: 1,
      invalidRatio: 0,
    }));
  });

  test('can keep invalid normalized geometry for diagnostics without claiming validity', () => {
    const result = normalizeGeometry({
      points: [['bad', 1]],
    }, { returnInvalidGeometry: true });
    expect(result.geometry).toEqual(expect.objectContaining({ type: 'multipoint', points: [] }));
    expect(result.diagnostics.valid).toBe(false);
  });
});
