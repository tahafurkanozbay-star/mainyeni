import { describe, expect, it } from 'vitest';
import { ArcGisTileResidencyPolicy, type TileResidencyIntent } from './ArcGisTileResidencyPolicy';

function intent(overrides: Partial<TileResidencyIntent> = {}): TileResidencyIntent {
  return { viewId: 'map', layerId: 'parcels', tileId: '10/512/384', revision: 1, priority: 'visible', estimatedBytes: 100, ...overrides };
}

function harness(overrides: ConstructorParameters<typeof ArcGisTileResidencyPolicy>[0] = {}) {
  let now = 0;
  const policy = new ArcGisTileResidencyPolicy({ now: () => now, maxEntries: 8, maxEntriesPerLayer: 4, maxResidentBytes: 1000, maxTileBytes: 500, leaseTtlMs: 100, ...overrides });
  return { policy, setNow: (value: number) => { now = value; } };
}

describe('ArcGisTileResidencyPolicy', () => {
  it('admits a detached immutable lease without retaining payloads', () => {
    const { policy } = harness();
    const lease = policy.admit(intent());
    expect(lease).toEqual({ ...intent(), generation: 1, admittedAt: 0 });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(policy.snapshot()).toMatchObject({ queued: 1, resident: 0, residentBytes: 0 });
  });

  it('rejects unsafe identifiers and malformed numeric input', () => {
    const { policy } = harness();
    expect(policy.admit(intent({ viewId: '<script>' }))).toBeNull();
    expect(policy.admit(intent({ layerId: 'bad layer' }))).toBeNull();
    expect(policy.admit(intent({ tileId: '' }))).toBeNull();
    expect(policy.admit(intent({ revision: -1 }))).toBeNull();
    expect(policy.admit(intent({ revision: 1.5 }))).toBeNull();
    expect(policy.admit(intent({ estimatedBytes: Number.NaN }))).toBeNull();
    expect(policy.admit(intent({ estimatedBytes: 501 }))).toBeNull();
    expect(policy.snapshot().rejected).toBe(7);
  });

  it('bounds global and per-layer cardinality', () => {
    const { policy } = harness({ maxEntries: 3, maxEntriesPerLayer: 2 });
    expect(policy.admit(intent({ tileId: 'a' }))).not.toBeNull();
    expect(policy.admit(intent({ tileId: 'b' }))).not.toBeNull();
    expect(policy.admit(intent({ tileId: 'c' }))).toBeNull();
    expect(policy.admit(intent({ layerId: 'roads', tileId: 'c' }))).not.toBeNull();
    expect(policy.admit(intent({ layerId: 'buildings', tileId: 'd' }))).toBeNull();
  });

  it('deduplicates identical tile identities without increasing generation', () => {
    const { policy, setNow } = harness();
    const first = policy.admit(intent())!;
    setNow(10);
    const second = policy.admit(intent())!;
    expect(second.generation).toBe(first.generation);
    expect(second.admittedAt).toBe(first.admittedAt);
    expect(policy.snapshot().queued).toBe(1);
  });

  it('schedules priority deterministically', () => {
    const { policy } = harness();
    policy.admit(intent({ tileId: 'bg', priority: 'background' }));
    policy.admit(intent({ tileId: 'visible', priority: 'visible' }));
    policy.admit(intent({ tileId: 'interactive', priority: 'interactive' }));
    expect(policy.next()?.tileId).toBe('interactive');
  });

  it('uses stable layer and tile ordering for equal-time equal-priority work', () => {
    const { policy } = harness();
    policy.admit(intent({ layerId: 'z', tileId: 'z' }));
    policy.admit(intent({ layerId: 'a', tileId: 'z' }));
    policy.admit(intent({ layerId: 'a', tileId: 'a' }));
    expect(policy.next()?.tileId).toBe('a');
  });

  it('reconciles actual bytes on commit', () => {
    const { policy } = harness();
    const lease = policy.admit(intent({ estimatedBytes: 400 }))!;
    expect(policy.commit(lease, 250)).toBe(true);
    expect(policy.snapshot()).toMatchObject({ queued: 0, resident: 1, residentBytes: 250 });
  });

  it('rejects oversized actual tiles without corrupting queued state', () => {
    const { policy } = harness();
    const lease = policy.admit(intent())!;
    expect(policy.commit(lease, 501)).toBe(false);
    expect(policy.snapshot()).toMatchObject({ queued: 1, resident: 0, residentBytes: 0 });
  });

  it('enforces aggregate resident-byte pressure', () => {
    const { policy } = harness({ maxResidentBytes: 500, maxTileBytes: 500 });
    const first = policy.admit(intent({ tileId: 'a' }))!;
    const second = policy.admit(intent({ tileId: 'b' }))!;
    expect(policy.commit(first, 300)).toBe(true);
    expect(policy.commit(second, 201)).toBe(false);
    expect(policy.commit(second, 200)).toBe(true);
    expect(policy.snapshot().residentBytes).toBe(500);
  });

  it('rejects duplicate commit and only touches resident entries', () => {
    const { policy } = harness();
    const lease = policy.admit(intent())!;
    expect(policy.touch(lease)).toBe(false);
    expect(policy.commit(lease, 10)).toBe(true);
    expect(policy.commit(lease, 10)).toBe(false);
    expect(policy.touch(lease)).toBe(true);
  });

  it('invalidates older revision work when view revision advances', () => {
    const { policy } = harness();
    const stale = policy.admit(intent({ revision: 4 }))!;
    expect(policy.setRevision('map', 5)).toBe(true);
    expect(policy.snapshot()).toMatchObject({ queued: 0, stale: 1 });
    expect(policy.commit(stale, 10)).toBe(false);
    expect(policy.admit(intent({ revision: 4 }))).toBeNull();
    expect(policy.admit(intent({ revision: 5 }))).not.toBeNull();
  });

  it('does not allow revision rollback', () => {
    const { policy } = harness();
    expect(policy.setRevision('map', 3)).toBe(true);
    expect(policy.setRevision('map', 2)).toBe(false);
    expect(policy.admit(intent({ revision: 2 }))).toBeNull();
  });

  it('expires queued leases before new admission', () => {
    const { policy, setNow } = harness({ maxEntries: 1, leaseTtlMs: 100 });
    policy.admit(intent({ tileId: 'old' }));
    setNow(101);
    expect(policy.admit(intent({ tileId: 'new' }))).not.toBeNull();
    expect(policy.snapshot().expired).toBe(1);
  });

  it('expires resident leases using last-touch time', () => {
    const { policy, setNow } = harness({ leaseTtlMs: 100 });
    const lease = policy.admit(intent())!;
    policy.commit(lease, 100);
    setNow(80);
    expect(policy.touch(lease)).toBe(true);
    setNow(150);
    expect(policy.snapshot().resident).toBe(1);
    setNow(181);
    expect(policy.snapshot()).toMatchObject({ resident: 0, residentBytes: 0, expired: 1 });
  });

  it('releases exact-generation leases and rejects stale handles', () => {
    const { policy } = harness();
    const oldLease = policy.admit(intent())!;
    expect(policy.release(oldLease)).toBe(true);
    const newLease = policy.admit(intent())!;
    expect(newLease.generation).toBeGreaterThan(oldLease.generation);
    expect(policy.release(oldLease)).toBe(false);
    expect(policy.release(newLease)).toBe(true);
  });

  it('cancels one view without disturbing another', () => {
    const { policy } = harness();
    policy.admit(intent({ tileId: 'a' }));
    policy.admit(intent({ viewId: 'scene', tileId: 'b' }));
    expect(policy.cancelView('map')).toBe(1);
    expect(policy.snapshot().queued).toBe(1);
    expect(policy.next()?.viewId).toBe('scene');
  });

  it('allows a cancelled view to establish a fresh revision', () => {
    const { policy } = harness();
    policy.setRevision('map', 9);
    expect(policy.cancelView('map')).toBe(0);
    expect(policy.admit(intent({ revision: 1 }))).not.toBeNull();
  });

  it('returns frozen scalar snapshots', () => {
    const { policy } = harness();
    const snapshot = policy.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.values(snapshot).every((value) => typeof value === 'number')).toBe(true);
  });

  it('fails closed after disposal', () => {
    const { policy } = harness();
    const lease = policy.admit(intent())!;
    policy.dispose();
    expect(policy.snapshot()).toMatchObject({ queued: 0, resident: 0, residentBytes: 0 });
    expect(policy.admit(intent())).toBeNull();
    expect(policy.commit(lease, 10)).toBe(false);
    expect(policy.touch(lease)).toBe(false);
    expect(policy.release(lease)).toBe(false);
    expect(policy.cancelView('map')).toBe(0);
  });
});
