import { describe, expect, it } from 'vitest';
import { ArcGisIdentifyStateCoordinator, type ArcGisIdentifyPolicy } from './ArcGisIdentifyStateCoordinator';

const policy: ArcGisIdentifyPolicy = {
  maxEntries: 2,
  maxTargetsPerEntry: 2,
  maxIdLength: 16,
  maxLayerKeyLength: 16,
  maxDiagnosticLength: 24,
  retentionMs: 100,
  maxCoordinateMagnitude: 10_000,
};

function coordinator() {
  return new ArcGisIdentifyStateCoordinator(policy);
}

function request(id: string, observedAtMs: number) {
  return { id, mode: '2d' as const, x: 1, y: 2, wkid: 4326, observedAtMs };
}

describe('ArcGisIdentifyStateCoordinator regression boundaries', () => {
  it('does not mutate generation for no-op activation', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    const before = state.snapshot().generation;
    expect(state.activate('a', 1)).toBe(false);
    expect(state.snapshot().generation).toBe(before);
  });

  it('does not mutate generation when removing an absent entry', () => {
    const state = coordinator();
    const before = state.snapshot().generation;
    expect(state.remove('missing')).toBe(false);
    expect(state.snapshot().generation).toBe(before);
  });

  it('does not mutate generation when clearing an empty registry', () => {
    const state = coordinator();
    const before = state.snapshot().generation;
    state.clear();
    expect(state.snapshot().generation).toBe(before);
  });

  it('increments generation after successful completion', () => {
    const state = coordinator();
    const pending = state.begin(request('a', 1), 1);
    const ready = state.resolve('a', [], 2, 2);
    expect(ready.generation).toBeGreaterThan(pending.generation);
  });

  it('preserves active continuity when a non-active entry is evicted', () => {
    const state = coordinator();
    state.begin(request('old', 1), 1);
    state.begin(request('active', 2), 2);
    state.begin(request('new', 3), 3);
    expect(state.snapshot().activeId).toBe('new');
    expect(state.snapshot().entries.map((entry) => entry.id)).toEqual(['new', 'active']);
  });

  it('rejects completion of unknown ids', () => {
    const state = coordinator();
    expect(() => state.resolve('missing', [], 1, 1)).toThrow('identify entry does not exist');
    expect(() => state.fail('missing', 'nope', 1, 1)).toThrow('identify entry does not exist');
  });

  it('rejects malformed string object identities', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(() => state.resolve('a', [{ layerKey: 'roads', objectId: '' }], 2, 2)).toThrow('invalid string object id');
    expect(() => state.resolve('a', [{ layerKey: 'roads', objectId: ' bad' }], 2, 2)).toThrow('invalid string object id');
  });

  it('rejects unsafe integer object identities', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(() => state.resolve('a', [{ layerKey: 'roads', objectId: Number.MAX_VALUE }], 2, 2)).toThrow('invalid numeric object id');
  });

  it('rejects layer keys beyond the configured bound', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(() => state.resolve('a', [{ layerKey: 'x'.repeat(17), objectId: 1 }], 2, 2)).toThrow('invalid layer key');
  });

  it('rejects null-byte identities', () => {
    const state = coordinator();
    expect(() => state.begin(request('a\u0000b', 1), 1)).toThrow('invalid identify id');
    state.begin(request('a', 1), 1);
    expect(() => state.resolve('a', [{ layerKey: 'r\u0000oads', objectId: 1 }], 2, 2)).toThrow('invalid layer key');
  });

  it('rejects null-byte diagnostics', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(() => state.fail('a', 'bad\u0000message', 2, 2)).toThrow('invalid identify diagnostic');
  });

  it('rejects invalid modes during begin', () => {
    const state = coordinator();
    expect(() => state.begin({ ...request('a', 1), mode: '4d' as '2d' }, 1)).toThrow('invalid identify mode');
  });

  it('rejects fractional and negative WKIDs', () => {
    const state = coordinator();
    expect(() => state.begin({ ...request('a', 1), wkid: 4326.5 }, 1)).toThrow('invalid identify WKID');
    expect(() => state.begin({ ...request('b', 1), wkid: -1 }, 1)).toThrow('invalid identify WKID');
  });

  it('rejects negative and non-finite clocks', () => {
    const state = coordinator();
    expect(() => state.begin(request('a', 0), -1)).toThrow('nowMs must be finite and non-negative');
    expect(() => state.begin(request('a', 0), Number.NaN)).toThrow('nowMs must be finite and non-negative');
  });

  it('keeps entries exactly at the retention boundary', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(state.prune(101)).toBe(0);
    expect(state.snapshot().entries).toHaveLength(1);
  });

  it('prunes entries immediately beyond the retention boundary', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    expect(state.prune(102)).toBe(1);
    expect(state.snapshot().entries).toHaveLength(0);
  });

  it('rejects restore payloads beyond entry capacity', () => {
    const state = coordinator();
    const entries = ['a', 'b', 'c'].map((id, index) => ({
      ...request(id, index + 1),
      status: 'pending' as const,
      targets: [],
      generation: index + 1,
    }));
    expect(() => state.restore({ activeId: null, entries }, 3)).toThrow('invalid identify snapshot');
  });

  it('rejects malformed restored status', () => {
    const state = coordinator();
    const entry = { ...request('a', 1), status: 'unknown' as 'ready', targets: [], generation: 1 };
    expect(() => state.restore({ activeId: null, entries: [entry] }, 1)).toThrow('invalid identify status');
  });

  it('validates restored failed diagnostics', () => {
    const state = coordinator();
    const entry = { ...request('a', 1), status: 'failed' as const, targets: [], generation: 1, diagnostic: 'x'.repeat(25) };
    expect(() => state.restore({ activeId: null, entries: [entry] }, 1)).toThrow('invalid identify diagnostic');
  });

  it('snapshot pruning is bounded and deterministic', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    state.begin(request('b', 50), 50);
    const snapshot = state.snapshot(102);
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['b']);
    expect(snapshot.activeId).toBe('b');
  });

  it('preserves zero as a valid numeric object id', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    const ready = state.resolve('a', [{ layerKey: 'roads', objectId: 0 }], 2, 2);
    expect(ready.targets[0]?.objectId).toBe(0);
  });

  it('preserves empty ready result sets', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    const ready = state.resolve('a', [], 2, 2);
    expect(ready.status).toBe('ready');
    expect(ready.targets).toEqual([]);
  });

  it('does not retain a diagnostic after a later successful completion', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    state.fail('a', 'timeout', 2, 2);
    const ready = state.resolve('a', [{ layerKey: 'roads', objectId: 1 }], 3, 3);
    expect(ready.status).toBe('ready');
    expect(ready.diagnostic).toBeUndefined();
  });

  it('can restart an existing id with a newer observation', () => {
    const state = coordinator();
    state.begin(request('a', 1), 1);
    state.resolve('a', [], 2, 2);
    const restarted = state.begin(request('a', 3), 3);
    expect(restarted.status).toBe('pending');
    expect(restarted.observedAtMs).toBe(3);
  });

  it('rejects restarting an existing id with an older observation', () => {
    const state = coordinator();
    state.begin(request('a', 5), 5);
    expect(() => state.begin(request('a', 4), 5)).toThrow('stale identify request');
  });
});
