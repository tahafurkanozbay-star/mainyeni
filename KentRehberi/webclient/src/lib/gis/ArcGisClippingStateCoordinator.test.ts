import { describe, expect, it } from 'vitest';
import { ArcGisClippingStateCoordinator, type ArcGisClippingStatePolicy } from './ArcGisClippingStateCoordinator';

const policy: ArcGisClippingStatePolicy = {
  maxStates: 2,
  maxPointsPerState: 4,
  maxIdLength: 24,
  maxAbsCoordinate: 1_000_000,
  maxAbsElevation: 10_000,
  maxClockSkewMs: 100,
  retentionMs: 1_000,
};

const points2d = [
  { x: 1, y: 2, z: 0 },
  { x: 3, y: 4, z: 0 },
];
const points3d = [
  { x: 1, y: 2, z: 30 },
  { x: 3, y: 4, z: 40 },
];

function state(id: string, mode: '2d' | '3d' = '2d') {
  return { id, mode, operation: 'exclude' as const, wkid: 4326, points: mode === '2d' ? points2d : points3d, enabled: true };
}

describe('ArcGisClippingStateCoordinator', () => {
  it('stores immutable primitive clipping state', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    const saved = coordinator.upsert(state('section'), 10);
    expect(saved.revision).toBe(1);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.points)).toBe(true);
    expect(Object.isFrozen(saved.points[0])).toBe(true);
  });

  it('preserves independent 2d and 3d definitions', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('plan', '2d'), 10);
    coordinator.upsert(state('scene', '3d'), 20);
    expect(coordinator.snapshot(20).states.map(item => item.mode)).toEqual(['2d', '3d']);
  });

  it('tracks active state without retaining ArcGIS runtime objects', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('scene', '3d'), 10);
    expect(coordinator.activate('scene', 11).id).toBe('scene');
    expect(coordinator.snapshot(11).activeId).toBe('scene');
    coordinator.clearActive();
    expect(coordinator.snapshot(12).activeId).toBeNull();
  });

  it('increments revision for updates', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    expect(coordinator.upsert({ ...state('a'), operation: 'include' }, 20).revision).toBe(2);
  });

  it('rejects stale updates beyond skew allowance', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 500);
    expect(() => coordinator.upsert(state('a'), 399)).toThrow(/stale/);
  });

  it('allows bounded clock skew', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 500);
    expect(coordinator.upsert(state('a'), 400).revision).toBe(2);
  });

  it('evicts the oldest non-protected state deterministically', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    coordinator.upsert(state('b'), 20);
    coordinator.activate('a', 20);
    coordinator.upsert(state('c'), 30);
    expect(coordinator.snapshot(30).states.map(item => item.id)).toEqual(['b', 'c']);
    expect(coordinator.snapshot(30).activeId).toBeNull();
  });

  it('prunes expired state and active identity', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    coordinator.activate('a', 10);
    expect(coordinator.snapshot(1_011).states).toHaveLength(0);
    expect(coordinator.snapshot(1_011).activeId).toBeNull();
  });

  it('keeps state at exact retention boundary', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    expect(coordinator.snapshot(1_010).states).toHaveLength(1);
  });

  it('rejects too few clipping points', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), points: [points2d[0]!] }, 10)).toThrow(/points/);
  });

  it('rejects too many clipping points', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), points: [...points2d, ...points2d, points2d[0]!] }, 10)).toThrow(/points/);
  });

  it('rejects non-finite coordinates', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), points: [{ x: Number.NaN, y: 0, z: 0 }, points2d[1]!] }, 10)).toThrow(/finite/);
  });

  it('rejects excessive planar coordinates', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), points: [{ x: 1_000_001, y: 0, z: 0 }, points2d[1]!] }, 10)).toThrow(/coordinate/);
  });

  it('rejects excessive elevation', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a', '3d'), points: [{ x: 1, y: 2, z: 10_001 }, points3d[1]!] }, 10)).toThrow(/elevation/);
  });

  it('rejects elevation in 2d state', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), points: [{ x: 1, y: 2, z: 1 }, points2d[1]!] }, 10)).toThrow(/2d/);
  });

  it('rejects invalid WKID', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), wkid: 0 }, 10)).toThrow(/wkid/);
  });

  it('rejects invalid operation at runtime', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), operation: 'merge' as 'exclude' }, 10)).toThrow(/operation/);
  });

  it('rejects invalid mode at runtime', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert({ ...state('a'), mode: '4d' as '2d' }, 10)).toThrow(/mode/);
  });

  it('rejects null bytes and oversized ids', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    expect(() => coordinator.upsert(state('bad\0id'), 10)).toThrow(/id/);
    expect(() => coordinator.upsert(state('x'.repeat(25)), 10)).toThrow(/id/);
  });

  it('restores a valid bounded snapshot atomically', () => {
    const source = new ArcGisClippingStateCoordinator(policy);
    source.upsert(state('a'), 10);
    source.upsert(state('b', '3d'), 20);
    source.activate('b', 20);
    const target = new ArcGisClippingStateCoordinator(policy);
    target.restore(source.snapshot(20), 20);
    expect(target.snapshot(20).activeId).toBe('b');
    expect(target.snapshot(20).states.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids during restore without mutating current state', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('safe'), 10);
    const saved = coordinator.snapshot(10).states[0]!;
    expect(() => coordinator.restore({ activeId: null, states: [saved, saved] }, 20)).toThrow(/duplicate/);
    expect(coordinator.snapshot(20).states.map(item => item.id)).toEqual(['safe']);
  });

  it('rejects future snapshots', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    const source = new ArcGisClippingStateCoordinator(policy);
    source.upsert(state('a'), 500);
    expect(() => coordinator.restore(source.snapshot(500), 399)).toThrow(/future/);
  });

  it('rejects an active id omitted after retention pruning', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    const source = new ArcGisClippingStateCoordinator(policy);
    source.upsert(state('old'), 10);
    const snapshot = source.snapshot(10);
    expect(() => coordinator.restore({ activeId: 'old', states: snapshot.states }, 1_011)).toThrow(/active/);
  });

  it('rejects invalid policy bounds', () => {
    expect(() => new ArcGisClippingStateCoordinator({ ...policy, maxStates: 0 })).toThrow(/maxStates/);
    expect(() => new ArcGisClippingStateCoordinator({ ...policy, maxAbsElevation: Number.POSITIVE_INFINITY })).toThrow(/maxAbsElevation/);
  });

  it('removes state and clears active identity', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    coordinator.activate('a', 10);
    expect(coordinator.remove('a')).toBe(true);
    expect(coordinator.remove('a')).toBe(false);
    expect(coordinator.snapshot(10).activeId).toBeNull();
  });

  it('fails closed after disposal', () => {
    const coordinator = new ArcGisClippingStateCoordinator(policy);
    coordinator.upsert(state('a'), 10);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(10)).toThrow(/disposed/);
    expect(() => coordinator.upsert(state('b'), 20)).toThrow(/disposed/);
  });
});
