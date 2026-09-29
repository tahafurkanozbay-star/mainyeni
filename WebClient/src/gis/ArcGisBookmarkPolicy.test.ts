import { describe, expect, it } from 'vitest';
import { ArcGisBookmarkPolicy, type ArcGisBookmarkInput } from './ArcGisBookmarkPolicy';

const policy = () => new ArcGisBookmarkPolicy({ maxBookmarks: 4, maxTitleLength: 40, maxVisibleLayers: 3, minScale: 10, maxScale: 10_000_000, minAltitude: 0, maxAltitude: 100_000 });
const bookmark = (patch: Partial<ArcGisBookmarkInput> = {}): ArcGisBookmarkInput => ({ id: 'home', title: 'Merkez', dimension: '2d', pose: { x: 10, y: 20, wkid: 102100, scale: 5000 }, visibleLayerIds: ['roads', 'parks'], revision: 3, ...patch });

describe('ArcGisBookmarkPolicy', () => {
  it('canonicalizes Web Mercator and freezes plans', () => {
    const plan = policy().plan(bookmark());
    expect(plan.pose.wkid).toBe(3857);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.pose)).toBe(true);
    expect(Object.isFrozen(plan.visibleLayerIds)).toBe(true);
  });

  it('normalizes headings deterministically', () => {
    expect(policy().plan(bookmark({ pose: { x: 1, y: 2, wkid: 3857, scale: 100, heading: -10 } })).pose.heading).toBe(350);
  });

  it('sorts layer ids before fingerprinting', () => {
    const a = policy().plan(bookmark({ visibleLayerIds: ['roads', 'parks'] }));
    const b = policy().plan(bookmark({ visibleLayerIds: ['parks', 'roads'] }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.visibleLayerIds).toEqual(['parks', 'roads']);
  });

  it('changes fingerprint when revision changes', () => {
    expect(policy().plan(bookmark()).fingerprint).not.toBe(policy().plan(bookmark({ revision: 4 })).fingerprint);
  });

  it('rejects duplicate visible layers', () => {
    expect(() => policy().plan(bookmark({ visibleLayerIds: ['roads', 'roads'] }))).toThrow(/duplicate/);
  });

  it('rejects excess visible layers', () => {
    expect(() => policy().plan(bookmark({ visibleLayerIds: ['a', 'b', 'c', 'd'] }))).toThrow(/budget/);
  });

  it('rejects malformed layer ids', () => {
    expect(() => policy().plan(bookmark({ visibleLayerIds: [' bad'] }))).toThrow(/invalid visible/);
  });

  it('rejects non-finite coordinates', () => {
    expect(() => policy().plan(bookmark({ pose: { x: Number.NaN, y: 2, wkid: 3857, scale: 100 } }))).toThrow(/finite/);
  });

  it('rejects out-of-budget scale', () => {
    expect(() => policy().plan(bookmark({ pose: { x: 1, y: 2, wkid: 3857, scale: 1 } }))).toThrow(/scale/);
  });

  it('rejects 3d state in a 2d bookmark', () => {
    expect(() => policy().plan(bookmark({ pose: { x: 1, y: 2, wkid: 3857, scale: 100, altitude: 10 } }))).toThrow(/2d/);
  });

  it('requires altitude and tilt for 3d', () => {
    expect(() => policy().plan(bookmark({ dimension: '3d' }))).toThrow(/requires/);
  });

  it('accepts bounded 3d pose', () => {
    const plan = policy().plan(bookmark({ dimension: '3d', pose: { x: 1, y: 2, wkid: 3857, scale: 100, altitude: 200, tilt: 45, heading: 370 } }));
    expect(plan.pose).toMatchObject({ altitude: 200, tilt: 45, heading: 10 });
  });

  it('rejects excessive altitude', () => {
    expect(() => policy().plan(bookmark({ dimension: '3d', pose: { x: 1, y: 2, wkid: 3857, scale: 100, altitude: 200_000, tilt: 45 } }))).toThrow(/altitude/);
  });

  it('rejects invalid tilt', () => {
    expect(() => policy().plan(bookmark({ dimension: '3d', pose: { x: 1, y: 2, wkid: 3857, scale: 100, altitude: 20, tilt: 181 } }))).toThrow(/tilt/);
  });

  it('rejects invalid bookmark ids', () => {
    expect(() => policy().plan(bookmark({ id: ' bad id ' }))).toThrow(/id/);
  });

  it('rejects empty and overlong titles', () => {
    expect(() => policy().plan(bookmark({ title: ' ' }))).toThrow(/title/);
    expect(() => policy().plan(bookmark({ title: 'x'.repeat(41) }))).toThrow(/title/);
  });

  it('rejects invalid revisions', () => {
    expect(() => policy().plan(bookmark({ revision: -1 }))).toThrow(/revision/);
  });

  it('bounds collection cardinality', () => {
    const items = Array.from({ length: 5 }, (_, index) => bookmark({ id: `b${index}` }));
    expect(() => policy().planCollection(items)).toThrow(/bookmark budget/);
  });

  it('rejects duplicate collection ids', () => {
    expect(() => policy().planCollection([bookmark(), bookmark({ title: 'Other' })])).toThrow(/duplicate bookmark/);
  });

  it('orders collections deterministically', () => {
    const plans = policy().planCollection([bookmark({ id: 'z' }), bookmark({ id: 'a' })]);
    expect(plans.map((entry) => entry.id)).toEqual(['a', 'z']);
    expect(Object.isFrozen(plans)).toBe(true);
  });
});
