import { describe, expect, it } from 'vitest';
import { SpatialQueryKeyRegistry, createSpatialQueryKey } from './spatialQueryKey';
const base = { serviceId: 'parcels', layerId: 2 } as const;
describe('createSpatialQueryKey', () => {
  it('is deterministic across set-like field and object-id ordering', () => { const a = createSpatialQueryKey({ ...base, outFields: ['NAME', 'ID'], objectIds: [3, 1, 3] }); const b = createSpatialQueryKey({ ...base, outFields: ['ID', 'NAME'], objectIds: [1, 3] }); expect(a).toBe(b); });
  it('normalizes where whitespace without changing literal content', () => { expect(createSpatialQueryKey({ ...base, where: ' STATUS   =  1 ' })).toBe(createSpatialQueryKey({ ...base, where: 'STATUS = 1' })); });
  it('distinguishes pagination and geometry-return contracts', () => { expect(createSpatialQueryKey({ ...base, resultOffset: 0 })).not.toBe(createSpatialQueryKey({ ...base, resultOffset: 1 })); expect(createSpatialQueryKey({ ...base, returnGeometry: false })).not.toBe(createSpatialQueryKey({ ...base, returnGeometry: true })); });
  it('normalizes negative zero in geometry', () => { expect(createSpatialQueryKey({ ...base, geometry: { x: -0, y: 1, spatialReference: { wkid: 4326 } } })).toBe(createSpatialQueryKey({ ...base, geometry: { x: 0, y: 1, spatialReference: { wkid: 4326 } } })); });
  it('prefers latestWkid for stable spatial-reference identity', () => { expect(createSpatialQueryKey({ ...base, geometry: { x: 1, y: 2, spatialReference: { wkid: 102100, latestWkid: 3857 } } })).toContain('3857'); });
  it('rejects malformed identity metadata', () => { expect(() => createSpatialQueryKey({ serviceId: ' ', layerId: 0 })).toThrow(TypeError); expect(() => createSpatialQueryKey({ ...base, layerId: -1 })).toThrow(RangeError); expect(() => createSpatialQueryKey({ ...base, objectIds: [Number.NaN] })).toThrow(RangeError); expect(() => createSpatialQueryKey({ ...base, geometry: { x: Number.POSITIVE_INFINITY, y: 0 } })).toThrow(RangeError); });
});
describe('SpatialQueryKeyRegistry', () => {
  it('tracks reuse without retaining unbounded entries', () => { const registry = new SpatialQueryKeyRegistry({ maxEntries: 2, ttlMs: 100 }); expect(registry.touch(base, 0).reused).toBe(false); expect(registry.touch(base, 1)).toMatchObject({ reused: true, hits: 2 }); registry.touch({ serviceId: 'roads', layerId: 0 }, 2); registry.touch({ serviceId: 'buildings', layerId: 0 }, 3); expect(registry.size).toBe(2); });
  it('expires stale identities', () => { const registry = new SpatialQueryKeyRegistry({ ttlMs: 10 }); registry.touch(base, 0); expect(registry.prune(9)).toBe(0); expect(registry.prune(10)).toBe(1); expect(registry.size).toBe(0); });
  it('validates registry budgets', () => { expect(() => new SpatialQueryKeyRegistry({ maxEntries: 0 })).toThrow(RangeError); expect(() => new SpatialQueryKeyRegistry({ ttlMs: 0 })).toThrow(RangeError); });
});
