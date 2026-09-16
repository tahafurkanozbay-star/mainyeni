import {
  assertGeometryIntegrity,
  extentContains,
  extentIntersects,
  extentUnion,
  inspectGeometry,
  simplifyGeometryForDisplay,
} from './geometryGuard';

describe('geometryGuard', () => {
  it('validates finite point coordinates and spatial reference', () => {
    const inspection = inspectGeometry({ x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } }, {
      requireSpatialReference: true,
      allowedWkids: [4326],
    });
    expect(inspection.valid).toBe(true);
    expect(inspection.kind).toBe('point');
    expect(inspection.vertexCount).toBe(1);
    expect(inspection.wkid).toBe(4326);
    expect(inspection.extent).toEqual({ xmin: 32.8, ymin: 39.9, xmax: 32.8, ymax: 39.9 });
  });

  it('rejects NaN and Infinity coordinates', () => {
    expect(inspectGeometry({ x: Number.NaN, y: 2 }).issues[0]?.code).toBe('non-finite-coordinate');
    expect(inspectGeometry({ x: 2, y: Number.POSITIVE_INFINITY }).valid).toBe(false);
  });

  it('rejects disallowed spatial references without attempting reprojection', () => {
    const inspection = inspectGeometry({ x: 1, y: 2, spatialReference: { wkid: 3857 } }, {
      requireSpatialReference: true,
      allowedWkids: [4326],
    });
    expect(inspection.valid).toBe(false);
    expect(inspection.issues.some((entry) => entry.code === 'disallowed-spatial-reference')).toBe(true);
  });

  it('enforces explicit vertex budgets', () => {
    const geometry = { points: [[0, 0], [1, 1], [2, 2]], spatialReference: { wkid: 4326 } };
    const inspection = inspectGeometry(geometry, { maxVertices: 2 });
    expect(inspection.valid).toBe(false);
    expect(inspection.issues.some((entry) => entry.code === 'vertex-budget-exceeded')).toBe(true);
  });

  it('enforces per-part limits before oversized linework reaches renderers', () => {
    const geometry = { paths: [[[0, 0], [1, 1], [2, 2], [3, 3]]] };
    const inspection = inspectGeometry(geometry, { maxCoordinatesPerPart: 3 });
    expect(inspection.issues.some((entry) => entry.code === 'part-size-exceeded')).toBe(true);
  });

  it('requires polygon rings to be closed and structurally large enough', () => {
    const open = inspectGeometry({ rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
    expect(open.valid).toBe(false);
    expect(open.issues.some((entry) => entry.code === 'ring-not-closed')).toBe(true);
    const small = inspectGeometry({ rings: [[[0, 0], [1, 0], [0, 0]]] });
    expect(small.issues.some((entry) => entry.code === 'ring-too-small')).toBe(true);
  });

  it('detects inverted extents', () => {
    const inspection = inspectGeometry({ xmin: 10, ymin: 0, xmax: 5, ymax: 2 });
    expect(inspection.valid).toBe(false);
    expect(inspection.issues.some((entry) => entry.code === 'invalid-extent')).toBe(true);
  });

  it('can prohibit Z ordinates while leaving XY-only geometry valid', () => {
    expect(inspectGeometry({ x: 1, y: 2, z: 3 }, { allowZ: false }).valid).toBe(false);
    expect(inspectGeometry({ x: 1, y: 2 }, { allowZ: false }).valid).toBe(true);
  });

  it('simplifies polyline display geometry deterministically', () => {
    const source = {
      paths: [[[0, 0], [1, 0.01], [2, -0.01], [3, 0], [4, 0]]],
      spatialReference: { wkid: 4326 },
    };
    const simplified = simplifyGeometryForDisplay(source, { tolerance: 0.1 }) as { paths: number[][][] };
    expect(simplified.paths[0]?.length).toBeLessThan(source.paths[0]!.length);
    expect(source.paths[0]).toHaveLength(5);
  });

  it('preserves polygon closure during simplification', () => {
    const source = { rings: [[[0, 0], [1, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
    const simplified = simplifyGeometryForDisplay(source, { tolerance: 0.25 }) as { rings: number[][][] };
    const ring = simplified.rings[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBeGreaterThanOrEqual(4);
  });

  it('throws from assertGeometryIntegrity at the first blocking integrity issue', () => {
    expect(() => assertGeometryIntegrity({ points: [['x', 1]] })).toThrow('finite numbers');
  });

  it('computes extent relationships for viewport culling', () => {
    const a = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
    const b = { xmin: 2, ymin: 2, xmax: 4, ymax: 4 };
    const c = { xmin: 20, ymin: 20, xmax: 30, ymax: 30 };
    expect(extentContains(a, b)).toBe(true);
    expect(extentIntersects(a, b)).toBe(true);
    expect(extentIntersects(a, c)).toBe(false);
    expect(extentUnion([a, c])).toEqual({ xmin: 0, ymin: 0, xmax: 30, ymax: 30 });
  });
});
