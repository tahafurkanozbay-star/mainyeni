import { describe, expect, it } from 'vitest';
import { ArcGisTimeStateCoordinator } from './ArcGisTimeStateCoordinator';

const policy = { maxStates: 2, maxIdLength: 24, maxExtentMs: 10_000, maxStepMs: 1_000, maxClockSkewMs: 50 };
const base = { id: 'traffic', extent: { startMs: 100, endMs: 1_100 }, cursorMs: 100, stepMs: 100, direction: 'forward' as const, playing: true };

describe('ArcGisTimeStateCoordinator', () => {
  it('stores primitive bounded time state and advances deterministically', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    const first = c.upsert(base, 10);
    expect(first.revision).toBe(1);
    expect(c.advance('traffic', 20).cursorMs).toBe(200);
    expect(c.snapshot().states[0]?.cursorMs).toBe(200);
  });

  it('clamps playback to temporal boundaries in both directions', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    c.upsert({ ...base, cursorMs: 1_050, stepMs: 100 }, 10);
    expect(c.advance('traffic', 20).cursorMs).toBe(1_100);
    c.upsert({ ...base, cursorMs: 120, direction: 'reverse' }, 30);
    expect(c.advance('traffic', 40).cursorMs).toBe(100);
  });

  it('evicts oldest state and clears active identity under capacity pressure', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    c.upsert(base, 10); c.activate('traffic');
    c.upsert({ ...base, id: 'weather' }, 20);
    c.upsert({ ...base, id: 'events' }, 30);
    expect(c.snapshot().states.map(x => x.id)).toEqual(['weather', 'events']);
    expect(c.snapshot().activeId).toBeNull();
  });

  it('rejects malformed extents, cursor, step and stale updates', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    expect(() => c.upsert({ ...base, extent: { startMs: 2, endMs: 1 } }, 10)).toThrow('reversed');
    expect(() => c.upsert({ ...base, cursorMs: 99 }, 10)).toThrow('inside extent');
    expect(() => c.upsert({ ...base, stepMs: 1_001 }, 10)).toThrow('maximum');
    c.upsert(base, 100);
    expect(() => c.upsert(base, 40)).toThrow('stale');
  });

  it('restores atomically and validates active identity', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    c.upsert(base, 10);
    const snap = c.snapshot();
    const restored = new ArcGisTimeStateCoordinator(policy);
    restored.restore({ states: snap.states, activeId: null }, 20);
    expect(restored.snapshot().states).toHaveLength(1);
    expect(() => restored.restore({ states: snap.states, activeId: 'missing' }, 20)).toThrow('active time state');
    expect(restored.snapshot().states).toHaveLength(1);
  });

  it('rejects duplicate and future snapshot records', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    const record = c.upsert(base, 10);
    expect(() => c.restore({ activeId: null, states: [record, record] }, 20)).toThrow('duplicate');
    expect(() => c.restore({ activeId: null, states: [{ ...record, updatedAtMs: 100 }] }, 20)).toThrow('future');
  });

  it('returns immutable snapshots', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    c.upsert(base, 10);
    const snapshot = c.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.states)).toBe(true);
    expect(Object.isFrozen(snapshot.states[0])).toBe(true);
    expect(Object.isFrozen(snapshot.states[0]?.extent)).toBe(true);
  });

  it('rejects use after disposal', () => {
    const c = new ArcGisTimeStateCoordinator(policy);
    c.upsert(base, 10); c.dispose(); c.dispose();
    expect(() => c.snapshot()).toThrow('disposed');
    expect(() => c.upsert(base, 20)).toThrow('disposed');
  });

  it('rejects invalid policy and identifiers', () => {
    expect(() => new ArcGisTimeStateCoordinator({ ...policy, maxStates: 0 })).toThrow('maxStates');
    const c = new ArcGisTimeStateCoordinator(policy);
    expect(() => c.upsert({ ...base, id: ' ' }, 10)).toThrow('id');
    expect(() => c.upsert({ ...base, id: 'bad\0id' }, 10)).toThrow('id');
  });
});
