import { describe, expect, it } from 'vitest';
import { ArcGisShareStateCoordinator, type ArcGisSharePolicy } from './ArcGisShareStateCoordinator';

const policy: ArcGisSharePolicy = {
  maxStates: 2,
  maxLayersPerState: 3,
  maxIdLength: 24,
  maxLayerKeyLength: 32,
  retentionMs: 1_000,
  maxClockSkewMs: 10,
};

const camera2d = { x: 10, y: 20, z: null, heading: null, tilt: null, wkid: 3857 } as const;
const camera3d = { x: 10, y: 20, z: 500, heading: 90, tilt: 45, wkid: 3857 } as const;
const layers = [{ key: 'roads', visible: true, opacity: 1 }, { key: 'parks', visible: false, opacity: 0.5 }] as const;

function create(coordinator: ArcGisShareStateCoordinator, id: string, now: number) {
  return coordinator.create({ id, viewMode: '2d', camera: camera2d, layers, selectedLayerKey: 'roads' }, now);
}

describe('ArcGisShareStateCoordinator', () => {
  it('stores bounded primitive 2d share state', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    const state = create(coordinator, 'a', 1);
    expect(state.viewMode).toBe('2d');
    expect(state.layers).toHaveLength(2);
    expect(state.selectedLayerKey).toBe('roads');
    expect(coordinator.snapshot(1).activeId).toBe('a');
  });

  it('updates to valid 3d camera state', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    const state = coordinator.update('a', { viewMode: '3d', camera: camera3d, layers, selectedLayerKey: 'parks' }, 2);
    expect(state.viewMode).toBe('3d');
    expect(state.camera.z).toBe(500);
    expect(state.revision).toBe(2);
  });

  it('rejects 3d fields on 2d cameras', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: camera3d, layers }, 1)).toThrow(/2d camera/);
  });

  it('requires complete bounded 3d orientation', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '3d', camera: { ...camera3d, heading: 360 }, layers }, 1)).toThrow(/heading/);
    expect(() => coordinator.create({ id: 'b', viewMode: '3d', camera: { ...camera3d, tilt: 181 }, layers }, 1)).toThrow(/tilt/);
    expect(() => coordinator.create({ id: 'c', viewMode: '3d', camera: { ...camera3d, z: Number.NaN }, layers }, 1)).toThrow(/z/);
  });

  it('rejects invalid wkid and non-finite coordinates', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: { ...camera2d, wkid: 0 }, layers }, 1)).toThrow(/wkid/);
    expect(() => coordinator.create({ id: 'b', viewMode: '2d', camera: { ...camera2d, x: Number.POSITIVE_INFINITY }, layers }, 1)).toThrow(/coordinates/);
  });

  it('rejects duplicate layer keys', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: camera2d, layers: [layers[0], layers[0]] }, 1)).toThrow(/duplicate/);
  });

  it('rejects layer lists beyond capacity', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    const tooMany = [
      { key: 'a', visible: true, opacity: 1 },
      { key: 'b', visible: true, opacity: 1 },
      { key: 'c', visible: true, opacity: 1 },
      { key: 'd', visible: true, opacity: 1 },
    ];
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: camera2d, layers: tooMany }, 1)).toThrow(/capacity/);
  });

  it('rejects invalid opacity and visibility', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: camera2d, layers: [{ key: 'x', visible: true, opacity: 2 }] }, 1)).toThrow(/opacity/);
    expect(() => coordinator.create({ id: 'b', viewMode: '2d', camera: camera2d, layers: [{ key: 'x', visible: 'yes' as unknown as boolean, opacity: 1 }] }, 1)).toThrow(/visibility/);
  });

  it('requires selected layer to exist in serialized layer state', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.create({ id: 'a', viewMode: '2d', camera: camera2d, layers, selectedLayerKey: 'missing' }, 1)).toThrow(/selected layer/);
  });

  it('rejects duplicate and unsafe share ids', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    expect(() => create(coordinator, 'a', 2)).toThrow(/already exists/);
    expect(() => create(coordinator, 'bad\0id', 2)).toThrow(/bounds/);
  });

  it('rejects stale updates beyond clock skew', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 100);
    coordinator.update('a', { viewMode: '2d', camera: camera2d, layers }, 200);
    expect(() => coordinator.update('a', { viewMode: '2d', camera: camera2d, layers }, 180)).toThrow(/stale/);
  });

  it('evicts the oldest state deterministically', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'old', 1);
    create(coordinator, 'middle', 2);
    create(coordinator, 'new', 3);
    expect(coordinator.snapshot(3).states.map(state => state.id)).toEqual(['middle', 'new']);
  });

  it('prunes states after retention and clears active identity', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    const snapshot = coordinator.snapshot(1_002);
    expect(snapshot.states).toHaveLength(0);
    expect(snapshot.activeId).toBeNull();
  });

  it('keeps states exactly on the retention boundary', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    expect(coordinator.snapshot(1_001).states).toHaveLength(1);
  });

  it('returns deeply immutable state', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    const snapshot = coordinator.snapshot(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.states)).toBe(true);
    expect(Object.isFrozen(snapshot.states[0])).toBe(true);
    expect(Object.isFrozen(snapshot.states[0]?.camera)).toBe(true);
    expect(Object.isFrozen(snapshot.states[0]?.layers)).toBe(true);
  });

  it('restores a valid snapshot', () => {
    const source = new ArcGisShareStateCoordinator(policy);
    create(source, 'a', 1);
    const target = new ArcGisShareStateCoordinator(policy);
    target.restore(source.snapshot(1), 1);
    expect(target.snapshot(1).states[0]?.id).toBe('a');
  });

  it('rejects duplicate restore ids atomically', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'stable', 1);
    const state = coordinator.snapshot(1).states[0]!;
    expect(() => coordinator.restore({ activeId: null, states: [state, state] }, 2)).toThrow(/duplicate/);
    expect(coordinator.snapshot(2).states[0]?.id).toBe('stable');
  });

  it('rejects future and inverted restore timestamps atomically', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'stable', 1);
    const state = coordinator.snapshot(1).states[0]!;
    expect(() => coordinator.restore({ activeId: null, states: [{ ...state, updatedAtMs: 100 }] }, 2)).toThrow(/future/);
    expect(() => coordinator.restore({ activeId: null, states: [{ ...state, createdAtMs: 10, updatedAtMs: 5 }] }, 10)).toThrow(/precedes/);
    expect(coordinator.snapshot(10).states[0]?.id).toBe('stable');
  });

  it('rejects dangling active identity during restore', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    expect(() => coordinator.restore({ activeId: 'missing', states: [] }, 1)).toThrow(/active share state is missing/);
  });

  it('activates and removes state deterministically', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    create(coordinator, 'b', 2);
    expect(coordinator.activate('a', 3).id).toBe('a');
    expect(coordinator.snapshot(3).activeId).toBe('a');
    expect(coordinator.remove('a')).toBe(true);
    expect(coordinator.snapshot(3).activeId).toBeNull();
    expect(coordinator.remove('a')).toBe(false);
  });

  it('fails closed after disposal', () => {
    const coordinator = new ArcGisShareStateCoordinator(policy);
    create(coordinator, 'a', 1);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(2)).toThrow(/disposed/);
    expect(() => create(coordinator, 'b', 2)).toThrow(/disposed/);
  });
});
