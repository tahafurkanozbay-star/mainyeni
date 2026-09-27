import { describe, expect, it } from 'vitest';
import { ArcGisSpatialAnalysisStateCoordinator, type ArcGisSpatialAnalysisPolicy } from './ArcGisSpatialAnalysisStateCoordinator';

const policy: ArcGisSpatialAnalysisPolicy = {
  maxAnalyses: 2,
  maxResultsPerAnalysis: 2,
  maxIdLength: 32,
  maxLayerKeyLength: 32,
  maxFailureCodeLength: 32,
  maxDistanceMeters: 100_000,
  retentionMs: 1_000,
  maxClockSkewMs: 10,
};
const create = () => new ArcGisSpatialAnalysisStateCoordinator(policy);

describe('ArcGisSpatialAnalysisStateCoordinator', () => {
  it('runs a bounded completed analysis lifecycle with immutable typed results', () => {
    const state = create();
    expect(state.create({ id: 'nearest-1', kind: 'nearest', wkid: 4326 }, 100).status).toBe('queued');
    expect(state.transition('nearest-1', 'running', 101).status).toBe('running');
    const completed = state.transition('nearest-1', 'completed', 102, { results: [
      { target: { layerKey: 'roads', objectId: 7 }, distanceMeters: 12.5 },
      { target: { layerKey: 'roads', objectId: 'A-8' }, distanceMeters: 18 },
    ] });
    expect(completed.status).toBe('completed');
    expect(completed.revision).toBe(3);
    expect(completed.results.map(x => x.target.objectId)).toEqual([7, 'A-8']);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.results)).toBe(true);
    expect(Object.isFrozen(completed.results[0]?.target)).toBe(true);
  });

  it('supports failed and cancelled terminal paths without mixing payload semantics', () => {
    const state = create();
    state.create({ id: 'buffer', kind: 'buffer', wkid: 3857 }, 1);
    state.transition('buffer', 'running', 2);
    expect(state.transition('buffer', 'failed', 3, { failureCode: 'adapter-timeout' }).failureCode).toBe('adapter-timeout');
    state.create({ id: 'filter', kind: 'spatial-filter', wkid: 4326 }, 4);
    expect(state.transition('filter', 'cancelled', 5).status).toBe('cancelled');
    expect(() => state.transition('filter', 'running', 6)).toThrow(/invalid analysis transition/);
  });

  it('rejects invalid lifecycle transitions and malformed terminal payloads', () => {
    const state = create();
    state.create({ id: 'a', kind: 'proximity', wkid: 4326 }, 10);
    expect(() => state.transition('a', 'completed', 11)).toThrow(/invalid analysis transition/);
    state.transition('a', 'running', 11);
    expect(() => state.transition('a', 'completed', 12, { failureCode: 'bad' })).toThrow(/cannot contain failure/);
    expect(() => state.transition('a', 'failed', 12, { results: [] })).toThrow(/cannot contain results/);
    expect(() => state.transition('a', 'failed', 12)).toThrow(/failureCode outside/);
  });

  it('enforces result capacity, unique typed targets and distance bounds', () => {
    const state = create();
    state.create({ id: 'a', kind: 'nearest', wkid: 4326 }, 1);
    state.transition('a', 'running', 2);
    expect(() => state.transition('a', 'completed', 3, { results: [
      { target: { layerKey: 'x', objectId: 1 }, distanceMeters: 1 },
      { target: { layerKey: 'x', objectId: 2 }, distanceMeters: 2 },
      { target: { layerKey: 'x', objectId: 3 }, distanceMeters: 3 },
    ] })).toThrow(/exceed capacity/);
    expect(() => state.transition('a', 'completed', 3, { results: [
      { target: { layerKey: 'x', objectId: 1 }, distanceMeters: 1 },
      { target: { layerKey: 'x', objectId: 1 }, distanceMeters: 2 },
    ] })).toThrow(/duplicate/);
    expect(() => state.transition('a', 'completed', 3, { results: [{ target: { layerKey: 'x', objectId: 1 }, distanceMeters: -1 }] })).toThrow(/distanceMeters/);
    expect(() => state.transition('a', 'completed', 3, { results: [{ target: { layerKey: 'x', objectId: 1 }, distanceMeters: 100_001 }] })).toThrow(/distanceMeters/);
  });

  it('preserves numeric and string object ids as distinct identities', () => {
    const state = create();
    state.create({ id: 'a', kind: 'nearest', wkid: 4326 }, 1);
    state.transition('a', 'running', 2);
    const result = state.transition('a', 'completed', 3, { results: [
      { target: { layerKey: 'x', objectId: 7 }, distanceMeters: null },
      { target: { layerKey: 'x', objectId: '7' }, distanceMeters: null },
    ] });
    expect(result.results).toHaveLength(2);
  });

  it('rejects unsafe identities and null-byte strings', () => {
    const state = create();
    expect(() => state.create({ id: 'bad\0id', kind: 'buffer', wkid: 4326 }, 1)).toThrow(/bounds/);
    expect(() => state.create({ id: 'bad-wkid', kind: 'buffer', wkid: 0 }, 1)).toThrow(/wkid/);
    state.create({ id: 'a', kind: 'nearest', wkid: 4326 }, 1);
    state.transition('a', 'running', 2);
    expect(() => state.transition('a', 'completed', 3, { results: [{ target: { layerKey: 'x', objectId: Number.MAX_SAFE_INTEGER + 1 }, distanceMeters: 1 }] })).toThrow(/safe integer/);
    expect(() => state.transition('a', 'completed', 3, { results: [{ target: { layerKey: 'x\0y', objectId: 1 }, distanceMeters: 1 }] })).toThrow(/bounds/);
  });

  it('evicts terminal work before active work deterministically', () => {
    const state = create();
    state.create({ id: 'terminal', kind: 'buffer', wkid: 4326 }, 1);
    state.transition('terminal', 'running', 2);
    state.transition('terminal', 'completed', 3, { results: [] });
    state.create({ id: 'running', kind: 'nearest', wkid: 4326 }, 4);
    state.transition('running', 'running', 5);
    state.create({ id: 'new', kind: 'proximity', wkid: 4326 }, 6);
    expect(state.snapshot(6).analyses.map(x => x.id).sort()).toEqual(['new', 'running']);
  });

  it('prunes only terminal work after the retention boundary', () => {
    const state = create();
    state.create({ id: 'done', kind: 'buffer', wkid: 4326 }, 1);
    state.transition('done', 'running', 2);
    state.transition('done', 'completed', 3, { results: [] });
    state.create({ id: 'live', kind: 'nearest', wkid: 4326 }, 4);
    state.transition('live', 'running', 5);
    expect(state.snapshot(1_003).analyses.map(x => x.id)).toContain('done');
    expect(state.snapshot(1_004).analyses.map(x => x.id)).toEqual(['live']);
  });

  it('rejects stale transitions outside the clock-skew budget', () => {
    const state = create();
    state.create({ id: 'a', kind: 'buffer', wkid: 4326 }, 100);
    expect(() => state.transition('a', 'running', 89)).toThrow(/stale/);
    expect(state.transition('a', 'running', 90).status).toBe('running');
  });

  it('restores valid state atomically and keeps active continuity', () => {
    const state = create();
    state.restore({ activeId: 'a', analyses: [{
      id: 'a', kind: 'spatial-filter', wkid: 4326, status: 'completed', createdAtMs: 10, updatedAtMs: 20,
      revision: 3, results: [{ target: { layerKey: 'parcels', objectId: 'P-1' }, distanceMeters: null }], failureCode: null,
    }] }, 20);
    const snapshot = state.snapshot(20);
    expect(snapshot.activeId).toBe('a');
    expect(snapshot.analyses[0]?.results[0]?.target.objectId).toBe('P-1');
  });

  it('rejects duplicate, dangling, future and inverted restore state without partial mutation', () => {
    const state = create();
    state.create({ id: 'keep', kind: 'buffer', wkid: 4326 }, 10);
    const before = state.snapshot(10);
    const valid = { id: 'x', kind: 'buffer' as const, wkid: 4326, status: 'queued' as const, createdAtMs: 10, updatedAtMs: 10, revision: 1, results: [], failureCode: null };
    expect(() => state.restore({ activeId: null, analyses: [valid, valid] }, 20)).toThrow(/duplicate/);
    expect(() => state.restore({ activeId: 'missing', analyses: [valid] }, 20)).toThrow(/active analysis is missing/);
    expect(() => state.restore({ activeId: null, analyses: [{ ...valid, updatedAtMs: 31 }] }, 20)).toThrow(/future/);
    expect(() => state.restore({ activeId: null, analyses: [{ ...valid, createdAtMs: 12, updatedAtMs: 11 }] }, 20)).toThrow(/precedes creation/);
    expect(state.snapshot(20).analyses.map(x => x.id)).toEqual(before.analyses.map(x => x.id));
  });

  it('validates restored terminal payload invariants', () => {
    const state = create();
    const base = { id: 'x', kind: 'buffer' as const, wkid: 4326, createdAtMs: 1, updatedAtMs: 2, revision: 1 };
    expect(() => state.restore({ activeId: null, analyses: [{ ...base, status: 'failed', results: [], failureCode: null }] }, 2)).toThrow(/invalid payload/);
    expect(() => state.restore({ activeId: null, analyses: [{ ...base, status: 'completed', results: [], failureCode: 'bad' }] }, 2)).toThrow(/cannot contain failure/);
    expect(() => state.restore({ activeId: null, analyses: [{ ...base, status: 'running', results: [{ target: { layerKey: 'x', objectId: 1 }, distanceMeters: 1 }], failureCode: null }] }, 2)).toThrow(/terminal payload/);
  });

  it('makes activation idempotent and removal explicit', () => {
    const state = create();
    state.create({ id: 'a', kind: 'buffer', wkid: 4326 }, 1);
    const generation = state.snapshot(1).generation;
    state.activate('a', 1);
    expect(state.snapshot(1).generation).toBe(generation);
    expect(state.remove('missing')).toBe(false);
    expect(state.remove('a')).toBe(true);
    expect(state.snapshot(1).activeId).toBeNull();
  });

  it('fails closed after disposal', () => {
    const state = create();
    state.create({ id: 'a', kind: 'buffer', wkid: 4326 }, 1);
    state.dispose();
    state.dispose();
    expect(() => state.snapshot(1)).toThrow(/disposed/);
    expect(() => state.create({ id: 'b', kind: 'nearest', wkid: 4326 }, 2)).toThrow(/disposed/);
  });
});
