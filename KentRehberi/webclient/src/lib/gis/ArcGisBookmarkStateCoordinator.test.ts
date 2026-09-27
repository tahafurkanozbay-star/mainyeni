import { describe, expect, it } from 'vitest';
import { ArcGisBookmarkStateCoordinator, type ArcGisBookmarkCameraState } from './ArcGisBookmarkStateCoordinator';

const policy = {
  maxBookmarks: 2,
  maxTitleLength: 40,
  maxIdLength: 24,
  maxScale: 100_000_000,
  maxAltitude: 1_000_000,
  maxClockSkewMs: 50,
} as const;
const camera2d = (overrides: Partial<ArcGisBookmarkCameraState> = {}): ArcGisBookmarkCameraState => ({
  centerX: 32.85, centerY: 39.93, wkid: 4326, scale: 25_000, rotation: 0, tilt: 0, altitude: 0, ...overrides,
});
const camera3d = (overrides: Partial<ArcGisBookmarkCameraState> = {}): ArcGisBookmarkCameraState => ({
  centerX: 32.85, centerY: 39.93, wkid: 4326, scale: 25_000, rotation: 10, tilt: 45, altitude: 2_000, ...overrides,
});
const input = (id: string, mode: '2d' | '3d' = '2d') => ({ id, title: `Bookmark ${id}`, mode, camera: mode === '2d' ? camera2d() : camera3d() });

describe('ArcGisBookmarkStateCoordinator', () => {
  it('stores immutable primitive 2d and 3d bookmark state', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    const two = registry.upsert(input('two'), 10);
    const three = registry.upsert(input('three', '3d'), 20);
    expect(two.camera.tilt).toBe(0);
    expect(three.camera.tilt).toBe(45);
    expect(Object.isFrozen(two)).toBe(true);
    expect(Object.isFrozen(two.camera)).toBe(true);
    expect(registry.snapshot().bookmarks.map(item => item.id)).toEqual(['two', 'three']);
  });

  it('preserves creation time and increments record revision on update', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('home'), 100);
    const updated = registry.upsert({ ...input('home'), title: 'Updated' }, 120);
    expect(updated.createdAtMs).toBe(100);
    expect(updated.updatedAtMs).toBe(120);
    expect(updated.revision).toBe(2);
    expect(updated.title).toBe('Updated');
  });

  it('rejects observations older than configured clock skew', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('home'), 100);
    expect(() => registry.upsert(input('home'), 49)).toThrow('stale bookmark update rejected');
    expect(() => registry.upsert(input('home'), 50)).not.toThrow();
  });

  it('evicts the least recently updated bookmark deterministically', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('a'), 10);
    registry.upsert(input('b'), 20);
    registry.upsert(input('c'), 30);
    expect(registry.get('a')).toBeNull();
    expect(registry.snapshot().bookmarks.map(item => item.id)).toEqual(['b', 'c']);
  });

  it('never evicts the bookmark being admitted', () => {
    const registry = new ArcGisBookmarkStateCoordinator({ ...policy, maxBookmarks: 1 });
    registry.upsert(input('old'), 10);
    registry.upsert(input('new'), 20);
    expect(registry.get('old')).toBeNull();
    expect(registry.get('new')?.id).toBe('new');
  });

  it('clears active state when an active bookmark is capacity-evicted', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('a'), 10);
    registry.upsert(input('b'), 20);
    registry.activate('a');
    registry.upsert(input('c'), 30);
    expect(registry.snapshot().activeBookmarkId).toBeNull();
  });

  it('activates only existing bookmarks and keeps no-op generation stable', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('home'), 10);
    registry.activate('home');
    const generation = registry.snapshot().generation;
    registry.activate('home');
    expect(registry.snapshot().generation).toBe(generation);
    expect(() => registry.activate('missing')).toThrow('bookmark does not exist');
  });

  it('clears active bookmark idempotently', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('home'), 10);
    registry.activate('home');
    registry.clearActive();
    const generation = registry.snapshot().generation;
    registry.clearActive();
    expect(registry.snapshot().activeBookmarkId).toBeNull();
    expect(registry.snapshot().generation).toBe(generation);
  });

  it('removes bookmarks and active state together', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('home'), 10);
    registry.activate('home');
    expect(registry.remove('home')).toBe(true);
    expect(registry.snapshot().activeBookmarkId).toBeNull();
    expect(registry.remove('home')).toBe(false);
  });

  it('orders equal timestamps by stable id', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('z'), 10);
    registry.upsert(input('a'), 10);
    expect(registry.snapshot().bookmarks.map(item => item.id)).toEqual(['a', 'z']);
  });

  it.each([
    ['', 'id'], ['   ', 'id'], ['x\0y', 'id'], ['x'.repeat(25), 'id'],
  ])('rejects malformed bookmark id %j', (id) => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('ok'), id }, 10)).toThrow();
  });

  it.each(['', '   ', 'bad\0title', 'x'.repeat(41)])('rejects malformed title %j', title => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('ok'), title }, 10)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid timestamps %s', timestamp => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert(input('home'), timestamp)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite camera centerX %s', centerX => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ centerX }) }, 10)).toThrow();
  });

  it.each([-90.1, 90.1, NaN])('rejects invalid latitude %s', centerY => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ centerY }) }, 10)).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid wkid %s', wkid => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ wkid }) }, 10)).toThrow();
  });

  it.each([0, -1, Infinity, 100_000_001])('rejects invalid scale %s', scale => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ scale }) }, 10)).toThrow();
  });

  it.each([-361, 361, NaN])('rejects invalid rotation %s', rotation => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ rotation }) }, 10)).toThrow();
  });

  it('rejects tilt and altitude in 2d bookmarks', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ tilt: 1 }) }, 10)).toThrow('2d bookmark');
    expect(() => registry.upsert({ ...input('home'), camera: camera2d({ altitude: 1 }) }, 10)).toThrow('2d bookmark');
  });

  it.each([-1, 91, Infinity])('rejects invalid 3d tilt %s', tilt => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home', '3d'), camera: camera3d({ tilt }) }, 10)).toThrow();
  });

  it.each([-1, 1_000_001, Infinity])('rejects invalid 3d altitude %s', altitude => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.upsert({ ...input('home', '3d'), camera: camera3d({ altitude }) }, 10)).toThrow();
  });

  it('restores a validated snapshot atomically', () => {
    const source = new ArcGisBookmarkStateCoordinator(policy);
    source.upsert(input('a'), 10);
    source.upsert(input('b', '3d'), 20);
    source.activate('b');
    const target = new ArcGisBookmarkStateCoordinator(policy);
    target.restore(source.snapshot(), 30);
    expect(target.snapshot().activeBookmarkId).toBe('b');
    expect(target.snapshot().bookmarks.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids during restore without mutating current state', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('safe'), 5);
    const record = registry.get('safe')!;
    expect(() => registry.restore({ activeBookmarkId: null, bookmarks: [record, record] }, 10)).toThrow('duplicate bookmark id');
    expect(registry.snapshot().bookmarks.map(item => item.id)).toEqual(['safe']);
  });

  it('rejects snapshots over capacity', () => {
    const registry = new ArcGisBookmarkStateCoordinator({ ...policy, maxBookmarks: 1 });
    const source = new ArcGisBookmarkStateCoordinator(policy);
    source.upsert(input('a'), 1);
    source.upsert(input('b'), 2);
    expect(() => registry.restore(source.snapshot(), 10)).toThrow('capacity');
  });

  it('rejects missing active bookmark during restore', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => registry.restore({ activeBookmarkId: 'missing', bookmarks: [] }, 10)).toThrow('active bookmark is missing');
  });

  it('rejects future snapshot timestamps beyond clock skew', () => {
    const source = new ArcGisBookmarkStateCoordinator(policy);
    source.upsert(input('a'), 100);
    const target = new ArcGisBookmarkStateCoordinator(policy);
    expect(() => target.restore(source.snapshot(), 49)).toThrow('future bookmark snapshot rejected');
    expect(() => target.restore(source.snapshot(), 50)).not.toThrow();
  });

  it('rejects snapshots whose update precedes creation', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    const malformed = { ...input('a'), createdAtMs: 20, updatedAtMs: 10, revision: 1 };
    expect(() => registry.restore({ activeBookmarkId: null, bookmarks: [malformed] }, 30)).toThrow('precedes creation');
  });

  it('rejects non-positive or unsafe restored revisions', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = { ...input('a'), createdAtMs: 10, updatedAtMs: 10, revision };
      expect(() => registry.restore({ activeBookmarkId: null, bookmarks: [malformed] }, 20)).toThrow();
    }
  });

  it('clear is bounded and idempotent', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('a'), 1);
    registry.clear();
    const generation = registry.snapshot().generation;
    registry.clear();
    expect(registry.snapshot().bookmarks).toHaveLength(0);
    expect(registry.snapshot().generation).toBe(generation);
  });

  it('dispose releases state and rejects subsequent operations', () => {
    const registry = new ArcGisBookmarkStateCoordinator(policy);
    registry.upsert(input('a'), 1);
    registry.dispose();
    registry.dispose();
    expect(() => registry.snapshot()).toThrow('disposed');
    expect(() => registry.upsert(input('b'), 2)).toThrow('disposed');
  });

  it.each([
    { ...policy, maxBookmarks: 0 },
    { ...policy, maxTitleLength: 0 },
    { ...policy, maxIdLength: 0 },
    { ...policy, maxScale: 0 },
    { ...policy, maxAltitude: Infinity },
    { ...policy, maxClockSkewMs: NaN },
  ])('fails closed for malformed policy %#', malformed => {
    expect(() => new ArcGisBookmarkStateCoordinator(malformed)).toThrow();
  });
});
