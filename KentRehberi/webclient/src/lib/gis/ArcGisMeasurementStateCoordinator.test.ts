import { describe, expect, it } from 'vitest';
import { ArcGisMeasurementStateCoordinator } from './ArcGisMeasurementStateCoordinator';

const policy = {
  maxEntries: 2,
  maxPointsPerEntry: 4,
  maxIdLength: 32,
  retentionMs: 1_000,
  maxCoordinateMagnitude: 1_000_000,
  maxAbsoluteZ: 20_000,
} as const;

const point = (x: number, y: number, z?: number) => z === undefined ? { x, y } : { x, y, z };

describe('ArcGisMeasurementStateCoordinator', () => {
  it('preserves primitive measurement state across 2d/3d mode changes', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'd1', kind: 'distance', wkid: 3857, points: [point(1, 2), point(3, 4)], observedAtMs: 10, status: 'complete' }, 10);
    expect(state.setMode('3d')).toBe(true);
    const snapshot = state.snapshot();
    expect(snapshot.mode).toBe('3d');
    expect(snapshot.activeId).toBe('d1');
    expect(snapshot.entries[0]?.points).toEqual([point(1, 2), point(3, 4)]);
    expect(Object.isFrozen(snapshot.entries[0]?.points)).toBe(true);
  });

  it('requires elevations for height measurements', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    expect(() => state.upsert({ id: 'h1', kind: 'height', wkid: 4326, points: [point(1, 2), point(2, 3, 4)], observedAtMs: 1 }, 1)).toThrow(/elevation/);
    state.upsert({ id: 'h1', kind: 'height', wkid: 4326, points: [point(1, 2, 3), point(2, 3, 4)], observedAtMs: 1 }, 1);
    expect(state.snapshot().entries).toHaveLength(1);
  });

  it('enforces completed geometry cardinality', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    expect(() => state.upsert({ id: 'a', kind: 'area', wkid: 4326, points: [point(0, 0), point(1, 0)], observedAtMs: 1, status: 'complete' }, 1)).toThrow(/three points/);
    expect(() => state.upsert({ id: 'd', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 1, status: 'complete' }, 1)).toThrow(/two points/);
  });

  it('rejects stale updates and future observations', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'd', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 10 }, 10);
    expect(() => state.upsert({ id: 'd', kind: 'distance', wkid: 4326, points: [point(1, 1)], observedAtMs: 9 }, 10)).toThrow(/stale/);
    expect(() => state.upsert({ id: 'x', kind: 'distance', wkid: 4326, points: [point(1, 1)], observedAtMs: 11 }, 10)).toThrow(/future/);
  });

  it('evicts oldest entries deterministically at capacity', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'a', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 1 }, 1);
    state.upsert({ id: 'b', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 2 }, 2);
    state.upsert({ id: 'c', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 3 }, 3);
    expect(state.snapshot().entries.map((entry) => entry.id)).toEqual(['c', 'b']);
  });

  it('prunes retained state and clears active identity', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'a', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 1 }, 1);
    expect(state.prune(1_002)).toBe(1);
    expect(state.snapshot().activeId).toBeNull();
  });

  it('rejects clock rollback during pruning', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'a', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 10 }, 10);
    expect(() => state.prune(9)).toThrow(/clock moved/);
  });

  it('completes a draft monotonically', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.upsert({ id: 'd', kind: 'distance', wkid: 4326, points: [point(0, 0), point(1, 1)], observedAtMs: 5 }, 5);
    expect(state.complete('d', 6, 6).status).toBe('complete');
    expect(() => state.complete('d', 4, 6)).toThrow(/stale/);
  });

  it('restores bounded snapshots and rejects duplicates', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.restore({ mode: '3d', activeId: 'a', entries: [{ id: 'a', kind: 'height', wkid: 3857, points: [point(0, 0, 2), point(0, 0, 5)], observedAtMs: 5, status: 'complete', generation: 99 }] }, 5);
    expect(state.snapshot().mode).toBe('3d');
    expect(state.snapshot().activeId).toBe('a');
    expect(() => state.restore({ mode: '2d', activeId: null, entries: [
      { id: 'x', kind: 'distance', wkid: 4326, points: [point(0, 0)], observedAtMs: 5, status: 'draft', generation: 1 },
      { id: 'x', kind: 'distance', wkid: 4326, points: [point(1, 1)], observedAtMs: 5, status: 'draft', generation: 2 },
    ] }, 5)).toThrow(/duplicate/);
  });

  it('rejects malformed ids, coordinates, wkids and point budgets', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    const base = { kind: 'distance' as const, wkid: 4326, observedAtMs: 1 };
    expect(() => state.upsert({ ...base, id: ' bad', points: [point(0, 0)] }, 1)).toThrow(/id/);
    expect(() => state.upsert({ ...base, id: 'x', wkid: 0, points: [point(0, 0)] }, 1)).toThrow(/WKID/);
    expect(() => state.upsert({ ...base, id: 'x', points: [point(Number.NaN, 0)] }, 1)).toThrow(/finite/);
    expect(() => state.upsert({ ...base, id: 'x', points: [point(2_000_000, 0)] }, 1)).toThrow(/magnitude/);
    expect(() => state.upsert({ ...base, id: 'x', points: [] }, 1)).toThrow(/point count/);
  });

  it('rejects invalid policies', () => {
    expect(() => new ArcGisMeasurementStateCoordinator({ ...policy, maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new ArcGisMeasurementStateCoordinator({ ...policy, maxAbsoluteZ: Number.POSITIVE_INFINITY })).toThrow(/maxAbsoluteZ/);
  });

  it('disposes idempotently and rejects subsequent use', () => {
    const state = new ArcGisMeasurementStateCoordinator(policy);
    state.dispose();
    state.dispose();
    expect(() => state.snapshot()).toThrow(/disposed/);
  });
});
