import { buildClosedPolygonRing } from './adminGeometryRuntime';

describe('adminGeometryRuntime', () => {
  test('parses comma decimals and closes open polygon rings', () => {
    expect(buildClosedPolygonRing([
      { X: '32,8', Y: '39,9' },
      { X: '32.9', Y: '39.9' },
      { X: 32.9, Y: 40 },
    ])).toEqual([
      [32.8, 39.9],
      [32.9, 39.9],
      [32.9, 40],
      [32.8, 39.9],
    ]);
  });

  test('does not duplicate an already closed ring', () => {
    const ring = buildClosedPolygonRing([
      { X: 0, Y: 0 },
      { X: 10, Y: 0 },
      { X: 10, Y: 10 },
      { X: 0, Y: 0 },
    ]);

    expect(ring).toHaveLength(4);
  });

  test('filters non-finite points and fails closed below three valid vertices', () => {
    expect(buildClosedPolygonRing([
      { X: 'bad', Y: 0 },
      { X: 1, Y: 1 },
      { X: 2, Y: 2 },
    ])).toBeNull();
  });

  test('returns immutable coordinate collections', () => {
    const ring = buildClosedPolygonRing([
      { X: 0, Y: 0 },
      { X: 1, Y: 0 },
      { X: 1, Y: 1 },
    ]);

    expect(Object.isFrozen(ring)).toBe(true);
    expect(Object.isFrozen(ring?.[0])).toBe(true);
  });
});
