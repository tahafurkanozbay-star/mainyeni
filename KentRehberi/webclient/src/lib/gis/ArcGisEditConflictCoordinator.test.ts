import { describe, expect, it } from 'vitest';
import { ArcGisEditConflictCoordinator, type ArcGisEditConflictPolicy } from './ArcGisEditConflictCoordinator';

const policy: ArcGisEditConflictPolicy = {
  maxConflicts: 2,
  maxIdLength: 24,
  maxLayerKeyLength: 32,
  retentionMs: 100,
  maxClockSkewMs: 10,
};
const target = (objectId: string | number = 1) => ({ layerKey: 'parcels', objectId });
const detect = (id: string, objectId: string | number = 1) => ({
  id, target: target(objectId), kind: 'revision' as const, localRevision: 2, remoteRevision: 3,
});

describe('ArcGisEditConflictCoordinator', () => {
  it('records immutable typed optimistic conflicts', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    const conflict = state.detect(detect('c1'), 10);
    expect(conflict.resolution).toBeNull();
    expect(conflict.revision).toBe(1);
    expect(Object.isFrozen(conflict)).toBe(true);
    expect(Object.isFrozen(conflict.target)).toBe(true);
  });

  it('keeps numeric and string object identities type-distinct', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('numeric', 7), 10);
    state.detect(detect('string', '7'), 20);
    const snapshot = state.snapshot(20);
    expect(typeof snapshot.conflicts[0]?.target.objectId).toBe('number');
    expect(typeof snapshot.conflicts[1]?.target.objectId).toBe('string');
  });

  it('rejects unsafe and malformed object identities', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    expect(() => state.detect(detect('unsafe', Number.MAX_SAFE_INTEGER + 1), 10)).toThrow('safe integer');
    expect(() => state.detect(detect('blank', '   '), 10)).toThrow('objectId');
    expect(() => state.detect(detect('null', 'x\0y'), 10)).toThrow('objectId');
  });

  it('requires divergent revisions for revision conflicts', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    expect(() => state.detect({ ...detect('same'), localRevision: 3 }, 10)).toThrow('divergent revisions');
  });

  it('accepts non-revision conflicts even when revisions match', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    expect(state.detect({ ...detect('geometry'), kind: 'geometry', localRevision: 3 }, 10).kind).toBe('geometry');
  });

  it('preserves first detection time and increments revision on repeated observation', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('c1'), 10);
    const updated = state.detect({ ...detect('c1'), remoteRevision: 4 }, 20);
    expect(updated.detectedAtMs).toBe(10);
    expect(updated.updatedAtMs).toBe(20);
    expect(updated.revision).toBe(2);
    expect(updated.remoteRevision).toBe(4);
  });

  it('prevents a conflict id from being rebound to another target', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('c1', 1), 10);
    expect(() => state.detect(detect('c1', 2), 20)).toThrow('cannot change target');
  });

  it('rejects stale observations outside the configured skew', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('c1'), 100);
    expect(() => state.detect(detect('c1'), 89)).toThrow('stale conflict observation');
    expect(() => state.detect(detect('c1'), 90)).not.toThrow();
  });

  it('resolves once with an explicit strategy', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('c1'), 10);
    const resolved = state.resolve('c1', 'remote', 20);
    expect(resolved.resolution).toBe('remote');
    expect(resolved.revision).toBe(2);
    expect(() => state.resolve('c1', 'local', 30)).toThrow('already resolved');
  });

  it('rejects stale resolution and invalid runtime resolution values', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('c1'), 100);
    expect(() => state.resolve('c1', 'local', 89)).toThrow('stale conflict resolution');
    expect(() => state.resolve('c1', 'invalid' as never, 100)).toThrow('invalid conflict resolution');
  });

  it('evicts the least recently observed conflict deterministically', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('a', 1), 10);
    state.detect(detect('b', 2), 20);
    state.detect(detect('c', 3), 30);
    expect(state.snapshot(30).conflicts.map(item => item.id)).toEqual(['b', 'c']);
  });

  it('uses stable id ordering to break equal-time capacity ties', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('b', 1), 10);
    state.detect(detect('a', 2), 10);
    state.detect(detect('c', 3), 20);
    expect(state.snapshot(20).conflicts.map(item => item.id)).toEqual(['b', 'c']);
  });

  it('clears active identity when capacity evicts it', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('a', 1), 10);
    state.detect(detect('b', 2), 20);
    state.activate('a', 20);
    state.detect(detect('c', 3), 30);
    expect(state.snapshot(30).activeId).toBeNull();
  });

  it('prunes only beyond the retention boundary', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('a'), 10);
    expect(state.snapshot(110).conflicts).toHaveLength(1);
    expect(state.snapshot(111).conflicts).toHaveLength(0);
  });

  it('restores atomically and preserves active identity', () => {
    const source = new ArcGisEditConflictCoordinator(policy);
    source.detect(detect('a'), 10);
    source.resolve('a', 'manual', 20);
    const snapshot = source.snapshot(20);
    const restored = new ArcGisEditConflictCoordinator(policy);
    restored.restore(snapshot, 20);
    expect(restored.snapshot(20).activeId).toBe('a');
    expect(restored.snapshot(20).conflicts[0]?.resolution).toBe('manual');
  });

  it('rejects duplicate restore ids without replacing live state', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('live'), 10);
    const item = state.snapshot(10).conflicts[0]!;
    expect(() => state.restore({ activeId: null, conflicts: [item, item] }, 10)).toThrow('duplicate conflict id');
    expect(state.snapshot(10).conflicts[0]?.id).toBe('live');
  });

  it('rejects dangling active identity atomically', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('live'), 10);
    expect(() => state.restore({ activeId: 'missing', conflicts: [] }, 10)).toThrow('active conflict is missing');
    expect(state.snapshot(10).conflicts[0]?.id).toBe('live');
  });

  it('rejects future and temporally inverted restore records', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    const base = state.detect(detect('a'), 10);
    expect(() => state.restore({ activeId: null, conflicts: [{ ...base, updatedAtMs: 21 }] }, 10)).toThrow('future conflict snapshot');
    expect(() => state.restore({ activeId: null, conflicts: [{ ...base, detectedAtMs: 11 }] }, 10)).toThrow('precedes detection');
  });

  it('rejects malformed restored revision conflicts', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    const base = state.detect(detect('a'), 10);
    expect(() => state.restore({ activeId: null, conflicts: [{ ...base, localRevision: 3 }] }, 10)).toThrow('divergent revisions');
  });

  it('drops expired restored records but rejects a dangling active id', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    const old = state.detect(detect('old'), 10);
    const targetState = new ArcGisEditConflictCoordinator(policy);
    targetState.restore({ activeId: null, conflicts: [old] }, 111);
    expect(targetState.snapshot(111).conflicts).toHaveLength(0);
    expect(() => targetState.restore({ activeId: 'old', conflicts: [old] }, 111)).toThrow('active conflict is missing');
  });

  it('rejects snapshot capacity overflow before mutating state', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('live'), 10);
    const base = state.snapshot(10).conflicts[0]!;
    expect(() => state.restore({ activeId: null, conflicts: [base, { ...base, id: 'b' }, { ...base, id: 'c' }] }, 10)).toThrow('exceeds capacity');
    expect(state.snapshot(10).conflicts.map(item => item.id)).toEqual(['live']);
  });

  it('removes conflicts idempotently and clears active state', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('a'), 10);
    expect(state.remove('a')).toBe(true);
    expect(state.remove('a')).toBe(false);
    expect(state.snapshot(10).activeId).toBeNull();
  });

  it('fails closed after disposal', () => {
    const state = new ArcGisEditConflictCoordinator(policy);
    state.detect(detect('a'), 10);
    state.dispose();
    state.dispose();
    expect(() => state.snapshot(10)).toThrow('disposed');
    expect(() => state.detect(detect('b'), 20)).toThrow('disposed');
  });
});
