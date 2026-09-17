import { createSpatialGridIndex, SpatialGridIndexError } from './spatialGridIndex';

const extent = (xmin: number, ymin: number, xmax: number, ymax: number, wkid = 3857) => ({
  xmin,
  ymin,
  xmax,
  ymax,
  spatialReference: { wkid },
});

describe('createSpatialGridIndex', () => {
  it('indexes and queries records by exact intersecting extent', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 100, spatialReference: { wkid: 3857 } });
    index.upsert({ id: 1, extent: extent(0, 0, 25, 25), value: 'a' });
    index.upsert({ id: 2, extent: extent(200, 200, 240, 240), value: 'b' });

    expect(index.queryExtent(extent(10, 10, 30, 30)).map((hit) => hit.id)).toEqual([1]);
    expect(index.queryExtent(extent(90, 90, 110, 110))).toEqual([]);
    expect(index.snapshot().featureCount).toBe(2);
  });

  it('preserves numeric identity zero', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });
    index.upsert({ id: 0, extent: extent(0, 0, 1, 1), value: 'zero' });

    expect(index.has(0)).toBe(true);
    expect(index.get(0)?.value).toBe('zero');
    expect(index.queryPoint({ x: 0, y: 0, spatialReference: { wkid: 3857 } })[0]?.id).toBe(0);
  });

  it('updates an existing identity without leaving stale cell references', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10, spatialReference: { wkid: 3857 } });
    index.upsert({ id: 'moving', extent: extent(0, 0, 1, 1), value: 'old' });
    index.upsert({ id: 'moving', extent: extent(100, 100, 101, 101), value: 'new' });

    expect(index.queryExtent(extent(0, 0, 2, 2))).toEqual([]);
    expect(index.queryExtent(extent(99, 99, 102, 102))[0]?.value).toBe('new');
    expect(index.snapshot().featureCount).toBe(1);
  });

  it('removes all resources owned by one layer without touching others', () => {
    const index = createSpatialGridIndex<number>({ cellSize: 10 });
    index.upsertMany([
      { id: 1, extent: extent(0, 0, 1, 1), value: 1, owner: 'roads' },
      { id: 2, extent: extent(2, 2, 3, 3), value: 2, owner: 'roads' },
      { id: 3, extent: extent(4, 4, 5, 5), value: 3, owner: 'parks' },
    ]);

    expect(index.owners()).toEqual(['parks', 'roads']);
    expect(index.removeOwner('roads')).toBe(2);
    expect(index.has(1)).toBe(false);
    expect(index.has(2)).toBe(false);
    expect(index.has(3)).toBe(true);
    expect(index.owners()).toEqual(['parks']);
  });

  it('fails closed when a record uses a different known spatial reference', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10, spatialReference: { wkid: 3857 } });

    expect(() => index.upsert({
      id: 'wrong-sr',
      extent: extent(0, 0, 1, 1, 4326),
      value: 'bad',
    })).toThrow('Spatial reference mismatch');
  });

  it('canonicalizes Web Mercator aliases', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10, spatialReference: { wkid: 102100 } });
    index.upsert({ id: 'a', extent: extent(0, 0, 1, 1, 3857), value: 'ok' });

    expect(index.snapshot().spatialReference?.wkid).toBe(3857);
    expect(index.queryExtent(extent(0, 0, 1, 1, 102113))).toHaveLength(1);
  });

  it('returns no matches for a query in a different known spatial reference', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10, spatialReference: { wkid: 3857 } });
    index.upsert({ id: 1, extent: extent(0, 0, 1, 1), value: 'a' });

    expect(index.queryExtent(extent(0, 0, 1, 1, 4326))).toEqual([]);
    expect(index.queryPoint({ x: 0, y: 0, spatialReference: { wkid: 4326 } })).toEqual([]);
  });

  it('enforces the feature budget before mutating state', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10, maximumFeatures: 2 });
    index.upsertMany([
      { id: 1, extent: extent(0, 0, 1, 1), value: 'a' },
      { id: 2, extent: extent(2, 2, 3, 3), value: 'b' },
    ]);

    expect(() => index.upsert({ id: 3, extent: extent(4, 4, 5, 5), value: 'c' })).toThrow(SpatialGridIndexError);
    expect(index.snapshot().featureCount).toBe(2);
  });

  it('rejects a feature that spans too many cells', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 1, maximumCellsPerFeature: 4 });

    expect(() => index.upsert({
      id: 'huge',
      extent: extent(0, 0, 10, 10),
      value: 'huge',
    })).toThrow('grid cells');
    expect(index.snapshot().featureCount).toBe(0);
  });

  it('rejects batches with duplicate stable identities atomically', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });

    expect(() => index.upsertMany([
      { id: 'same', extent: extent(0, 0, 1, 1), value: 'a' },
      { id: 'same', extent: extent(2, 2, 3, 3), value: 'b' },
    ])).toThrow('Duplicate spatial identity');
    expect(index.snapshot().featureCount).toBe(0);
  });

  it('supports atomic replacement of the indexed dataset', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });
    index.upsert({ id: 1, extent: extent(0, 0, 1, 1), value: 'old' });

    const replaced = index.replaceAll([
      { id: 2, extent: extent(20, 20, 21, 21), value: 'new-a' },
      { id: 3, extent: extent(30, 30, 31, 31), value: 'new-b' },
    ]);

    expect(replaced.map((hit) => hit.id)).toEqual([2, 3]);
    expect(index.has(1)).toBe(false);
    expect(index.snapshot().featureCount).toBe(2);
  });

  it('uses exact geometry bounds after grid candidate lookup', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 100 });
    index.upsert({ id: 1, extent: extent(0, 0, 5, 5), value: 'tiny' });

    expect(index.queryExtent(extent(90, 90, 95, 95))).toEqual([]);
  });

  it('keeps query output deterministic in insertion order', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 100 });
    index.upsertMany([
      { id: 'z', extent: extent(0, 0, 10, 10), value: 'z' },
      { id: 'a', extent: extent(0, 0, 10, 10), value: 'a' },
      { id: 'm', extent: extent(0, 0, 10, 10), value: 'm' },
    ]);

    expect(index.queryExtent(extent(0, 0, 10, 10)).map((hit) => hit.id)).toEqual(['z', 'a', 'm']);
    expect(index.queryExtent(extent(0, 0, 10, 10), 2).map((hit) => hit.id)).toEqual(['z', 'a']);
  });

  it('tracks bounded cell-reference accounting through removals', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });
    index.upsert({ id: 1, extent: extent(0, 0, 15, 15), value: 'multi-cell' });
    const before = index.snapshot();
    expect(before.referenceCount).toBeGreaterThan(1);

    expect(index.remove(1)).toBe(true);
    expect(index.snapshot().referenceCount).toBe(0);
    expect(index.snapshot().cellCount).toBe(0);
  });

  it('clears dynamic spatial reference ownership when empty', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });
    index.upsert({ id: 1, extent: extent(0, 0, 1, 1, 4326), value: 'wgs84' });
    expect(index.snapshot().spatialReference?.wkid).toBe(4326);

    index.clear();
    expect(index.snapshot().spatialReference).toBeNull();
    index.upsert({ id: 2, extent: extent(0, 0, 1, 1, 3857), value: 'web-mercator' });
    expect(index.snapshot().spatialReference?.wkid).toBe(3857);
  });

  it('becomes unusable after deterministic disposal', () => {
    const index = createSpatialGridIndex<string>({ cellSize: 10 });
    index.upsert({ id: 1, extent: extent(0, 0, 1, 1), value: 'a' });
    index.dispose();

    expect(() => index.get(1)).toThrow('disposed');
    expect(() => index.queryExtent(extent(0, 0, 1, 1))).toThrow('disposed');
  });
});
