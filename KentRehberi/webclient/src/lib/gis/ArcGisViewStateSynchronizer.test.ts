import { describe, expect, it } from 'vitest';
import { ArcGisViewStateSynchronizer, type ArcGisViewState } from './ArcGisViewStateSynchronizer';

const policy = { maxHistory: 3, minScale: 100, maxScale: 10_000_000, maxAltitude: 1_000_000, maxClockSkewMs: 50 } as const;
const twoD: ArcGisViewState = { centerX: 32.8, centerY: 39.9, wkid: 4326, scale: 25_000, rotation: 0, tilt: 0, altitude: 0 };
const threeD: ArcGisViewState = { ...twoD, tilt: 45, altitude: 5_000 };

describe('ArcGisViewStateSynchronizer', () => {
  it('retains independent bounded 2d and 3d revisions', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    const a = sync.observe('2d', twoD, 'user', 100);
    const b = sync.observe('3d', threeD, 'programmatic', 110);
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    expect(sync.snapshot().twoD?.state).toEqual(twoD);
    expect(sync.snapshot().threeD?.state).toEqual(threeD);
  });

  it('projects 3d state to planar state without leaking camera altitude', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    sync.observe('3d', threeD, 'user', 100);
    expect(sync.project('3d', '2d')).toEqual({ ...threeD, tilt: 0, altitude: 0 });
  });

  it('derives a bounded altitude when projecting 2d state to 3d', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    sync.observe('2d', twoD, 'user', 100);
    const projected = sync.project('2d', '3d');
    expect(projected?.altitude).toBeGreaterThan(0);
    expect(projected?.altitude).toBeLessThanOrEqual(policy.maxAltitude);
    expect(projected?.wkid).toBe(4326);
  });

  it('rejects stale observations outside the configured clock skew', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    sync.observe('2d', twoD, 'user', 1000);
    expect(() => sync.observe('2d', twoD, 'user', 900)).toThrow('stale view observation rejected');
    expect(() => sync.observe('2d', twoD, 'user', 951)).not.toThrow();
  });

  it('bounds history while preserving latest state', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    for (let index = 0; index < 6; index += 1) sync.observe('2d', { ...twoD, centerX: index }, 'user', index * 100);
    const snapshot = sync.snapshot();
    expect(snapshot.history).toHaveLength(3);
    expect(snapshot.history.map(x => x.state.centerX)).toEqual([3, 4, 5]);
    expect(snapshot.twoD?.state.centerX).toBe(5);
  });

  it('restores both modes through validated restore revisions', () => {
    const source = new ArcGisViewStateSynchronizer(policy);
    source.observe('2d', twoD, 'user', 100);
    source.observe('3d', threeD, 'user', 110);
    source.setActiveMode('3d');
    const target = new ArcGisViewStateSynchronizer(policy);
    target.restore(source.snapshot(), 200);
    const restored = target.snapshot();
    expect(restored.activeMode).toBe('3d');
    expect(restored.twoD?.origin).toBe('restore');
    expect(restored.threeD?.origin).toBe('restore');
  });

  it.each([
    [{ ...twoD, centerY: 91 }, '2d'],
    [{ ...twoD, scale: 1 }, '2d'],
    [{ ...twoD, wkid: 0 }, '2d'],
    [{ ...twoD, tilt: 1 }, '2d'],
    [{ ...threeD, tilt: 91 }, '3d'],
    [{ ...threeD, altitude: policy.maxAltitude + 1 }, '3d'],
    [{ ...threeD, centerX: Number.NaN }, '3d'],
  ] as const)('fails closed for malformed spatial/camera state %#', (state, mode) => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    expect(() => sync.observe(mode, state, 'user', 100)).toThrow();
  });

  it('returns immutable snapshots and clears state deterministically', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    sync.observe('2d', twoD, 'user', 100);
    const snapshot = sync.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    sync.clear();
    expect(sync.snapshot().twoD).toBeNull();
  });

  it('rejects use after disposal', () => {
    const sync = new ArcGisViewStateSynchronizer(policy);
    sync.dispose();
    sync.dispose();
    expect(() => sync.snapshot()).toThrow('disposed');
    expect(() => sync.observe('2d', twoD, 'user', 100)).toThrow('disposed');
  });
});
