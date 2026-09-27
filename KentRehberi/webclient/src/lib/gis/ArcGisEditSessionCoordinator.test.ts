import { describe, expect, it } from 'vitest';
import { ArcGisEditSessionCoordinator, type ArcGisEditSessionPolicy } from './ArcGisEditSessionCoordinator';

const policy: ArcGisEditSessionPolicy = {
  maxSessions: 2,
  maxIdLength: 32,
  maxLayerKeyLength: 32,
  maxFailureCodeLength: 24,
  maxAttempts: 2,
  retentionMs: 1_000,
  maxClockSkewMs: 50,
};

function coordinator(overrides: Partial<ArcGisEditSessionPolicy> = {}) {
  return new ArcGisEditSessionCoordinator({ ...policy, ...overrides });
}

describe('ArcGisEditSessionCoordinator', () => {
  it('runs a bounded create lifecycle without retaining ArcGIS objects', () => {
    const state = coordinator();
    const draft = state.begin({ id: 'create-1', mode: '2d', operation: 'create', target: { layerKey: 'parcels', objectId: null } }, 100);
    expect(draft.status).toBe('draft');
    expect(draft.attempt).toBe(0);
    expect(state.transition('create-1', 'validated', 110).status).toBe('validated');
    expect(state.transition('create-1', 'committing', 120).attempt).toBe(1);
    expect(state.transition('create-1', 'committed', 130).status).toBe('committed');
    expect(state.snapshot(140).activeId).toBe('create-1');
  });

  it('requires stable object identity and base revision for update/delete', () => {
    const state = coordinator();
    expect(() => state.begin({ id: 'bad-update', mode: '2d', operation: 'update', target: { layerKey: 'roads', objectId: null }, baseRevision: 1 }, 1)).toThrow(/objectId/);
    expect(() => state.begin({ id: 'bad-revision', mode: '2d', operation: 'update', target: { layerKey: 'roads', objectId: 7 } }, 1)).toThrow(/baseRevision/);
    const edit = state.begin({ id: 'update', mode: '3d', operation: 'update', target: { layerKey: 'roads', objectId: 7 }, baseRevision: 4 }, 2);
    expect(edit.target.objectId).toBe(7);
    expect(edit.baseRevision).toBe(4);
  });

  it('preserves numeric and string object ids as distinct typed identities', () => {
    const numeric = coordinator();
    numeric.begin({ id: 'n', mode: '2d', operation: 'delete', target: { layerKey: 'x', objectId: 7 }, baseRevision: 1 }, 1);
    const stringy = coordinator();
    stringy.begin({ id: 's', mode: '2d', operation: 'delete', target: { layerKey: 'x', objectId: '7' }, baseRevision: 1 }, 1);
    expect(typeof numeric.snapshot(1).sessions[0]?.target.objectId).toBe('number');
    expect(typeof stringy.snapshot(1).sessions[0]?.target.objectId).toBe('string');
  });

  it('rejects unsafe numeric identity and null-byte string identity', () => {
    const state = coordinator();
    expect(() => state.begin({ id: 'unsafe', mode: '2d', operation: 'delete', target: { layerKey: 'x', objectId: Number.MAX_SAFE_INTEGER + 1 }, baseRevision: 1 }, 1)).toThrow(/safe integer/);
    expect(() => state.begin({ id: 'nul', mode: '2d', operation: 'delete', target: { layerKey: 'x', objectId: '7\0x' }, baseRevision: 1 }, 1)).toThrow(/null bytes/);
  });

  it('enforces legal lifecycle transitions', () => {
    const state = coordinator();
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    expect(() => state.transition('e', 'committing', 2)).toThrow(/invalid edit transition/);
    state.transition('e', 'validated', 3);
    expect(() => state.transition('e', 'validated', 4)).toThrow(/no-op/);
    state.transition('e', 'committing', 5);
    state.transition('e', 'committed', 6);
    expect(() => state.transition('e', 'failed', 7, 'late')).toThrow(/invalid edit transition/);
  });

  it('requires bounded failure diagnostics only for failed state', () => {
    const state = coordinator({ maxFailureCodeLength: 5 });
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    expect(() => state.transition('e', 'failed', 2)).toThrow(/failureCode/);
    expect(() => state.transition('e', 'failed', 2, 'TOO-LONG')).toThrow(/failureCode/);
    const failed = state.transition('e', 'failed', 2, 'E409');
    expect(failed.failureCode).toBe('E409');
  });

  it('bounds retry attempts across failure recovery', () => {
    const state = coordinator({ maxAttempts: 2 });
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    state.transition('e', 'validated', 2);
    state.transition('e', 'committing', 3);
    state.transition('e', 'failed', 4, 'E1');
    state.transition('e', 'validated', 5);
    expect(state.transition('e', 'committing', 6).attempt).toBe(2);
    state.transition('e', 'failed', 7, 'E2');
    state.transition('e', 'validated', 8);
    expect(() => state.transition('e', 'committing', 9)).toThrow(/retry budget/);
  });

  it('evicts deterministically under capacity pressure', () => {
    const state = coordinator({ maxSessions: 2 });
    state.begin({ id: 'b', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 10);
    state.begin({ id: 'a', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 10);
    state.begin({ id: 'c', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 11);
    expect(state.snapshot(11).sessions.map(value => value.id)).toEqual(['b', 'c']);
  });

  it('prunes expired sessions and clears active identity', () => {
    const state = coordinator({ retentionMs: 10 });
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    expect(state.snapshot(11).sessions).toHaveLength(1);
    expect(state.snapshot(12)).toMatchObject({ activeId: null, sessions: [] });
  });

  it('rejects stale transitions beyond clock-skew budget', () => {
    const state = coordinator({ maxClockSkewMs: 5 });
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 100);
    expect(() => state.transition('e', 'validated', 94)).toThrow(/stale/);
  });

  it('restores atomically and preserves active 2d/3d continuity', () => {
    const source = coordinator();
    source.begin({ id: 'scene-edit', mode: '3d', operation: 'update', target: { layerKey: 'buildings', objectId: 'A-7' }, baseRevision: 9 }, 100);
    source.transition('scene-edit', 'validated', 110);
    const snapshot = source.snapshot(120);
    const restored = coordinator();
    restored.restore(snapshot, 120);
    expect(restored.snapshot(120)).toMatchObject({ activeId: 'scene-edit', sessions: [{ id: 'scene-edit', mode: '3d', status: 'validated' }] });
  });

  it('rejects duplicate ids and missing active ids during restore', () => {
    const source = coordinator();
    source.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    const snap = source.snapshot(1);
    const target = coordinator();
    expect(() => target.restore({ activeId: null, sessions: [snap.sessions[0]!, snap.sessions[0]!] }, 1)).toThrow(/duplicate/);
    expect(() => target.restore({ activeId: 'missing', sessions: snap.sessions }, 1)).toThrow(/active edit session is missing/);
  });

  it('rejects future and internally inconsistent snapshots', () => {
    const source = coordinator({ maxClockSkewMs: 5 });
    source.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 10);
    const session = source.snapshot(10).sessions[0]!;
    const target = coordinator({ maxClockSkewMs: 5 });
    expect(() => target.restore({ activeId: null, sessions: [{ ...session, updatedAtMs: 20 }] }, 10)).toThrow(/future/);
    expect(() => target.restore({ activeId: null, sessions: [{ ...session, createdAtMs: 11, updatedAtMs: 10 }] }, 10)).toThrow(/precedes creation/);
  });

  it('keeps restore atomic when validation fails', () => {
    const target = coordinator();
    target.begin({ id: 'keep', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    const before = target.snapshot(1);
    expect(() => target.restore({ activeId: null, sessions: [{ ...before.sessions[0]!, id: '' }] }, 1)).toThrow();
    expect(target.snapshot(1)).toEqual(before);
  });

  it('returns immutable snapshots and nested targets', () => {
    const state = coordinator();
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    const snapshot = state.snapshot(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0])).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0]?.target)).toBe(true);
  });

  it('validates policy boundaries', () => {
    expect(() => coordinator({ maxSessions: 0 })).toThrow(/maxSessions/);
    expect(() => coordinator({ maxAttempts: 1.5 })).toThrow(/maxAttempts/);
    expect(() => coordinator({ retentionMs: Number.POSITIVE_INFINITY })).toThrow(/retentionMs/);
  });

  it('disposes idempotently and fails closed afterwards', () => {
    const state = coordinator();
    state.begin({ id: 'e', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 1);
    state.dispose();
    state.dispose();
    expect(() => state.snapshot(1)).toThrow(/disposed/);
    expect(() => state.begin({ id: 'x', mode: '2d', operation: 'create', target: { layerKey: 'x', objectId: null } }, 2)).toThrow(/disposed/);
  });
});
