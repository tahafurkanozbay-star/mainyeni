import { describe, expect, it } from 'vitest';
import { ArcGisPopupStateCoordinator } from './ArcGisPopupStateCoordinator';

const policy = { maxEntries: 3, maxLayerKeyLength: 32, maxObjectIdLength: 32, maxTitleLength: 64, retentionMs: 1_000 } as const;
const create = () => new ArcGisPopupStateCoordinator(policy);

describe('ArcGisPopupStateCoordinator', () => {
  it('preserves stable identity while switching between 2D and 3D', () => {
    const state = create();
    state.open({ layerKey: 'parcels', objectId: 7, requestedAtMs: 10, title: 'Parcel' }, 10);
    expect(state.setMode('3d')).toBe(true);
    const snapshot = state.snapshot(20);
    expect(snapshot.mode).toBe('3d');
    expect(snapshot.active).toEqual({ layerKey: 'parcels', objectId: 7 });
    expect(snapshot.entries[0]?.title).toBe('Parcel');
  });

  it('keeps numeric and string object ids distinct', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1);
    state.open({ layerKey: 'a', objectId: '1', requestedAtMs: 2 }, 2);
    expect(state.snapshot(2).entries).toHaveLength(2);
  });

  it('evicts the deterministic oldest entry at capacity', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 10 }, 10);
    state.open({ layerKey: 'a', objectId: 2, requestedAtMs: 20 }, 20);
    state.open({ layerKey: 'b', objectId: 3, requestedAtMs: 30 }, 30);
    state.open({ layerKey: 'c', objectId: 4, requestedAtMs: 40 }, 40);
    expect(state.snapshot(40).entries.map((entry) => entry.objectId)).toEqual([4, 3, 2]);
  });

  it('rejects stale updates for an existing identity', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 20 }, 20);
    expect(() => state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 19 }, 21)).toThrow(/stale/);
  });

  it('prunes retained popup state and closes an expired active popup', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 10 }, 10);
    expect(state.prune(1_011)).toBe(1);
    expect(state.snapshot(1_011).active).toBeNull();
  });

  it('rejects clock rollback during pruning', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 10 }, 10);
    expect(() => state.prune(9)).toThrow(/clock moved/);
  });

  it('supports explicit activation only for retained identities', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1);
    state.open({ layerKey: 'a', objectId: 2, requestedAtMs: 2 }, 2);
    expect(state.activate({ layerKey: 'a', objectId: 1 }, 3)).toBe(true);
    expect(state.snapshot(3).active).toEqual({ layerKey: 'a', objectId: 1 });
    expect(state.activate({ layerKey: 'missing', objectId: 1 }, 3)).toBe(false);
  });

  it('removes all popup state for a layer', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1);
    state.open({ layerKey: 'a', objectId: 2, requestedAtMs: 2 }, 2);
    state.open({ layerKey: 'b', objectId: 3, requestedAtMs: 3 }, 3);
    expect(state.removeLayer('a')).toBe(2);
    expect(state.snapshot(3).entries.map((entry) => entry.layerKey)).toEqual(['b']);
  });

  it('validates anchors and retains only primitive coordinate state', () => {
    const state = create();
    const entry = state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1, anchor: { x: 32.1, y: 39.9, wkid: 4326 } }, 1);
    expect(entry.anchor).toEqual({ x: 32.1, y: 39.9, wkid: 4326 });
    expect(() => state.open({ layerKey: 'a', objectId: 2, requestedAtMs: 2, anchor: { x: Number.NaN, y: 1, wkid: 4326 } }, 2)).toThrow(/anchor/);
    expect(() => state.open({ layerKey: 'a', objectId: 2, requestedAtMs: 2, anchor: { x: 1, y: 1, wkid: 0 } }, 2)).toThrow(/WKID/);
  });

  it('restores a bounded snapshot and preserves its active identity', () => {
    const source = create();
    source.open({ layerKey: 'a', objectId: 1, requestedAtMs: 10, title: 'A' }, 10);
    source.open({ layerKey: 'b', objectId: 'g-2', requestedAtMs: 20 }, 20);
    source.setMode('3d');
    const restored = create();
    restored.restore(source.snapshot(20), 20);
    expect(restored.snapshot(20).mode).toBe('3d');
    expect(restored.snapshot(20).active).toEqual({ layerKey: 'b', objectId: 'g-2' });
  });

  it('rejects duplicate and dangling active identities in restore', () => {
    const state = create();
    const entry = { layerKey: 'a', objectId: 1, requestedAtMs: 10, title: null, anchor: null, generation: 1 } as const;
    expect(() => state.restore({ mode: '2d', active: null, entries: [entry, entry] }, 10)).toThrow(/duplicate/);
    expect(() => state.restore({ mode: '2d', active: { layerKey: 'b', objectId: 2 }, entries: [entry] }, 10)).toThrow(/absent/);
  });

  it('drops expired entries during restore', () => {
    const state = create();
    state.restore({ mode: '2d', active: null, entries: [{ layerKey: 'a', objectId: 1, requestedAtMs: 1, title: null, anchor: null, generation: 1 }] }, 1_002);
    expect(state.snapshot(1_002).entries).toHaveLength(0);
  });

  it('fails closed on malformed policy and identity inputs', () => {
    expect(() => new ArcGisPopupStateCoordinator({ ...policy, maxEntries: 0 })).toThrow(/maxEntries/);
    const state = create();
    expect(() => state.open({ layerKey: ' a', objectId: 1, requestedAtMs: 1 }, 1)).toThrow(/layerKey/);
    expect(() => state.open({ layerKey: 'a', objectId: -1, requestedAtMs: 1 }, 1)).toThrow(/objectId/);
    expect(() => state.open({ layerKey: 'a', objectId: ' x', requestedAtMs: 1 }, 1)).toThrow(/objectId/);
    expect(() => state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 2 }, 1)).toThrow(/future/);
  });

  it('bounds title size and rejects whitespace mutation', () => {
    const state = create();
    expect(() => state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1, title: ' x' }, 1)).toThrow(/title/);
    expect(() => state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1, title: 'x'.repeat(65) }, 1)).toThrow(/title/);
  });

  it('returns immutable snapshots and entries', () => {
    const state = create();
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1);
    const snapshot = state.snapshot(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
  });

  it('makes close and clear idempotent', () => {
    const state = create();
    expect(state.close()).toBe(false);
    state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1);
    expect(state.close()).toBe(true);
    expect(state.close()).toBe(false);
    state.clear();
    state.clear();
    expect(state.snapshot(1).entries).toHaveLength(0);
  });

  it('rejects use after disposal while disposal itself is idempotent', () => {
    const state = create();
    state.dispose();
    state.dispose();
    expect(() => state.snapshot()).toThrow(/disposed/);
    expect(() => state.open({ layerKey: 'a', objectId: 1, requestedAtMs: 1 }, 1)).toThrow(/disposed/);
  });
});
