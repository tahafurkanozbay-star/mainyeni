import { describe, expect, it } from 'vitest';
import { ArcGisIdentifyStateCoordinator, type ArcGisIdentifyPolicy } from './ArcGisIdentifyStateCoordinator';

const policy: ArcGisIdentifyPolicy = {
  maxEntries: 3,
  maxTargetsPerEntry: 3,
  maxIdLength: 32,
  maxLayerKeyLength: 48,
  maxDiagnosticLength: 80,
  retentionMs: 1_000,
  maxCoordinateMagnitude: 1_000_000,
};

const request = (id: string, observedAtMs: number, mode: '2d' | '3d' = '2d') => ({
  id,
  mode,
  x: 100,
  y: 200,
  wkid: 3857,
  observedAtMs,
});

const target = (layerKey: string, objectId: string | number) => ({ layerKey, objectId });

describe('ArcGisIdentifyStateCoordinator', () => {
  it('preserves primitive identify state across 2D and 3D requests', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('pick-2d', 10, '2d'), 10);
    state.resolve('pick-2d', [target('roads', 7)], 11, 11);
    state.begin(request('pick-3d', 12, '3d'), 12);
    state.resolve('pick-3d', [target('buildings', 'b-9')], 13, 13);
    const snapshot = state.snapshot();
    expect(snapshot.activeId).toBe('pick-3d');
    expect(snapshot.entries.map((entry) => entry.mode)).toEqual(['3d', '2d']);
    expect(snapshot.entries[0]?.targets[0]).toEqual({ layerKey: 'buildings', objectId: 'b-9' });
  });

  it('distinguishes numeric and string ArcGIS object identities', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('typed', 1), 1);
    const entry = state.resolve('typed', [target('parcels', 42), target('parcels', '42')], 2, 2);
    expect(entry.targets).toHaveLength(2);
    expect(typeof entry.targets[0]?.objectId).toBe('number');
    expect(typeof entry.targets[1]?.objectId).toBe('string');
  });

  it('rejects duplicate typed targets', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('dup', 1), 1);
    expect(() => state.resolve('dup', [target('roads', 3), target('roads', 3)], 2, 2)).toThrow('duplicate identify target');
  });

  it('bounds target count', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('many', 1), 1);
    expect(() => state.resolve('many', [target('a', 1), target('b', 2), target('c', 3), target('d', 4)], 2, 2)).toThrow('invalid identify target count');
  });

  it('evicts the oldest entry deterministically at capacity', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('b', 10), 10);
    state.begin(request('a', 10), 10);
    state.begin(request('c', 20), 20);
    state.begin(request('d', 30), 30);
    expect(state.snapshot().entries.map((entry) => entry.id)).toEqual(['d', 'c', 'b']);
  });

  it('prunes expired state and clears an expired active id', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('old', 1), 1);
    expect(state.prune(1_002)).toBe(1);
    expect(state.snapshot()).toMatchObject({ activeId: null, entries: [] });
  });

  it('rejects stale completions', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('pick', 50), 50);
    expect(() => state.resolve('pick', [], 49, 50)).toThrow('stale identify completion');
  });

  it('rejects observations from the future', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    expect(() => state.begin(request('future', 11), 10)).toThrow('observedAtMs cannot be in the future');
  });

  it('fails closed when the clock moves behind retained observations', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('clock', 100), 100);
    expect(() => state.prune(99)).toThrow('clock moved before identify observation');
  });

  it('records bounded failure diagnostics without retaining transport errors', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('failed', 1), 1);
    const entry = state.fail('failed', 'service unavailable', 2, 2);
    expect(entry.status).toBe('failed');
    expect(entry.diagnostic).toBe('service unavailable');
    expect(entry.targets).toEqual([]);
  });

  it('rejects oversized diagnostics', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('failed', 1), 1);
    expect(() => state.fail('failed', 'x'.repeat(81), 2, 2)).toThrow('invalid identify diagnostic');
  });

  it('validates coordinates and WKID', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    expect(() => state.begin({ ...request('nan', 1), x: Number.NaN }, 1)).toThrow('identify coordinates must be finite');
    expect(() => state.begin({ ...request('large', 1), y: 1_000_001 }, 1)).toThrow('identify coordinate exceeds configured magnitude');
    expect(() => state.begin({ ...request('wkid', 1), wkid: 0 }, 1)).toThrow('invalid identify WKID');
  });

  it('validates identifiers and layer keys', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    expect(() => state.begin(request(' bad', 1), 1)).toThrow('invalid identify id');
    state.begin(request('good', 1), 1);
    expect(() => state.resolve('good', [target(' bad', 1)], 2, 2)).toThrow('invalid layer key');
    expect(() => state.resolve('good', [target('roads', Number.NaN)], 2, 2)).toThrow('invalid numeric object id');
  });

  it('supports activation and explicit active clearing', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('a', 1), 1);
    state.begin(request('b', 2), 2);
    expect(state.activate('a', 2)).toBe(true);
    expect(state.snapshot().activeId).toBe('a');
    expect(state.clearActive()).toBe(true);
    expect(state.clearActive()).toBe(false);
  });

  it('removes entries and clears active state', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('a', 1), 1);
    expect(state.remove('a')).toBe(true);
    expect(state.remove('a')).toBe(false);
    expect(state.snapshot().activeId).toBeNull();
  });

  it('restores a bounded snapshot with active continuity', () => {
    const source = new ArcGisIdentifyStateCoordinator(policy);
    source.begin(request('a', 10), 10);
    source.resolve('a', [target('roads', 1)], 11, 11);
    source.begin(request('b', 12, '3d'), 12);
    source.fail('b', 'timeout', 13, 13);
    const restored = new ArcGisIdentifyStateCoordinator(policy);
    restored.restore(source.snapshot(), 13);
    const snapshot = restored.snapshot();
    expect(snapshot.activeId).toBe('b');
    expect(snapshot.entries.map((entry) => entry.status)).toEqual(['failed', 'ready']);
  });

  it('rejects duplicate snapshot ids', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    const duplicate = { ...request('a', 1), status: 'pending' as const, targets: [], generation: 1 };
    expect(() => state.restore({ activeId: 'a', entries: [duplicate, duplicate] }, 1)).toThrow('duplicate identify id');
  });

  it('rejects a snapshot whose active entry is absent', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    expect(() => state.restore({ activeId: 'missing', entries: [] }, 1)).toThrow('active identify entry is absent from snapshot');
  });

  it('drops expired entries during restore', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    const old = { ...request('old', 1), status: 'ready' as const, targets: [], generation: 1 };
    state.restore({ activeId: null, entries: [old] }, 1_002);
    expect(state.snapshot().entries).toEqual([]);
  });

  it('returns deterministic newest-first snapshots', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('z', 5), 5);
    state.begin(request('a', 5), 5);
    expect(state.snapshot().entries.map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('clears all retained state', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('a', 1), 1);
    state.clear();
    expect(state.snapshot()).toMatchObject({ activeId: null, entries: [] });
  });

  it('rejects invalid policy values', () => {
    expect(() => new ArcGisIdentifyStateCoordinator({ ...policy, maxEntries: 0 })).toThrow('maxEntries');
    expect(() => new ArcGisIdentifyStateCoordinator({ ...policy, maxCoordinateMagnitude: Number.POSITIVE_INFINITY })).toThrow('maxCoordinateMagnitude');
  });

  it('is idempotent on dispose and rejects later use', () => {
    const state = new ArcGisIdentifyStateCoordinator(policy);
    state.begin(request('a', 1), 1);
    state.dispose();
    state.dispose();
    expect(() => state.snapshot()).toThrow('ArcGisIdentifyStateCoordinator is disposed');
  });
});
