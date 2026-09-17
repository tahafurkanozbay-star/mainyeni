import { describe, expect, it } from 'vitest';
import { geometryVertexCount, normalizeArcgisGeometry } from './geometryNormalization';

describe('normalizeArcgisGeometry', () => {
  it('preserves zero-valued point coordinates and finite z', () => {
    const result = normalizeArcgisGeometry({ x: 0, y: 0, z: 12, spatialReference: { wkid: 102100 } });
    expect(result.geometry).toMatchObject({ type: 'point', coordinate: [0, 0], z: 12 });
    expect(result.vertexCount).toBe(1);
  });

  it('rejects malformed points instead of coercing strings', () => {
    expect(normalizeArcgisGeometry({ x: '32', y: 39 }).reason).toBe('invalid-point');
    expect(normalizeArcgisGeometry({ x: Number.NaN, y: 39 }).reason).toBe('invalid-point');
  });

  it('drops invalid and consecutive duplicate multipoints', () => {
    const result = normalizeArcgisGeometry({ points: [[1, 2], [1, 2], ['x', 3], [4, 5]] });
    expect(result.geometry).toMatchObject({ type: 'multipoint', points: [[1, 2], [4, 5]] });
    expect(result.vertexCount).toBe(2);
  });

  it('normalizes polyline parts and drops undersized parts', () => {
    const result = normalizeArcgisGeometry({ paths: [[[0, 0], [0, 0], [1, 1]], [[9, 9]], null] });
    expect(result.geometry).toMatchObject({ type: 'polyline', paths: [[[0, 0], [1, 1]]] });
    expect(result.droppedParts).toBe(2);
  });

  it('closes polygon rings deterministically', () => {
    const result = normalizeArcgisGeometry({ rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] });
    expect(result.geometry).toMatchObject({ type: 'polygon', rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] });
    expect(result.repairedRings).toBe(1);
    expect(result.vertexCount).toBe(5);
  });

  it('does not duplicate already closed polygon rings', () => {
    const result = normalizeArcgisGeometry({ rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    expect(result.repairedRings).toBe(0);
    expect(result.vertexCount).toBe(4);
  });

  it('fails closed when global vertex budget is exceeded', () => {
    expect(() => normalizeArcgisGeometry({ paths: [[[0, 0], [1, 1], [2, 2]]] }, { maxVertices: 2 })).toThrow('vertex budget');
  });

  it('fails closed when part budget is exceeded', () => {
    expect(() => normalizeArcgisGeometry({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, { maxParts: 1 })).toThrow('part budget');
  });

  it('fails closed when per-part vertex budget is exceeded', () => {
    expect(() => normalizeArcgisGeometry({ paths: [[[0, 0], [1, 1], [2, 2]]] }, { maxVerticesPerPart: 2 })).toThrow('per-part vertex budget');
  });

  it('rejects invalid budget configuration', () => {
    expect(() => normalizeArcgisGeometry({ x: 1, y: 2 }, { maxVertices: 0 })).toThrow('Invalid geometry normalization limit');
  });

  it('reports unsupported and empty geometry shapes explicitly', () => {
    expect(normalizeArcgisGeometry({ foo: [] }).reason).toBe('unsupported-geometry-shape');
    expect(normalizeArcgisGeometry({ points: [] }).reason).toBe('empty-multipoint');
    expect(normalizeArcgisGeometry({ paths: [] }).reason).toBe('empty-polyline');
    expect(normalizeArcgisGeometry({ rings: [] }).reason).toBe('empty-polygon');
  });

  it('counts normalized vertices without allocating flattened copies', () => {
    const result = normalizeArcgisGeometry({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] });
    if (!result.geometry) throw new Error('expected geometry');
    expect(geometryVertexCount(result.geometry)).toBe(5);
  });
});
