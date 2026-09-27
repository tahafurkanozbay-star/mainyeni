import { describe, expect, it } from 'vitest';
import { ArcGisSelectionStateRegistry } from './ArcGisSelectionStateRegistry';

const policy = { maxSelections: 2, maxLayerKeyLength: 32, maxObjectIdLength: 16, maxAgeMs: 1000 };

describe('ArcGisSelectionStateRegistry', () => {
  it('shares stable feature identity across 2d and 3d modes', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'parcels', objectId: 42 }, 'user', 10);
    registry.setMode('3d');
    expect(registry.has({ layerKey: 'parcels', objectId: 42 })).toBe(true);
    expect(registry.snapshot().mode).toBe('3d');
  });

  it('distinguishes numeric and string object identifiers', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'assets', objectId: 1 }, 'query', 0);
    registry.select({ layerKey: 'assets', objectId: '1' }, 'query', 0);
    expect(registry.snapshot().selections).toHaveLength(2);
  });

  it('rejects capacity growth instead of evicting user selection implicitly', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'a', objectId: 1 }, 'user', 0);
    registry.select({ layerKey: 'b', objectId: 2 }, 'user', 0);
    expect(() => registry.select({ layerKey: 'c', objectId: 3 }, 'user', 0)).toThrow('capacity');
  });

  it('updates an existing identity without consuming additional capacity', () => {
    const registry = new ArcGisSelectionStateRegistry({ ...policy, maxSelections: 1 });
    const first = registry.select({ layerKey: 'a', objectId: 1 }, 'query', 0);
    const second = registry.select({ layerKey: 'a', objectId: 1 }, 'user', 1);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(registry.snapshot().selections).toHaveLength(1);
    expect(second.origin).toBe('user');
  });

  it('prunes only selections older than the bounded retention window', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'a', objectId: 1 }, 'user', 0);
    registry.select({ layerKey: 'b', objectId: 2 }, 'user', 500);
    expect(registry.prune(1001)).toBe(1);
    expect(registry.has({ layerKey: 'b', objectId: 2 })).toBe(true);
  });

  it('restores a bounded snapshot with restore provenance', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.restore({ mode: '3d', selections: [
      { layerKey: 'zoning', objectId: 'A-1', origin: 'user', selectedAtMs: 1, revision: 1 },
    ] }, 20);
    const snapshot = registry.snapshot();
    expect(snapshot.mode).toBe('3d');
    expect(snapshot.selections[0]?.origin).toBe('restore');
    expect(snapshot.selections[0]?.selectedAtMs).toBe(20);
  });

  it('rejects duplicate identities during restore', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    const entry = { layerKey: 'x', objectId: 7, origin: 'user' as const, selectedAtMs: 0, revision: 1 };
    expect(() => registry.restore({ mode: '2d', selections: [entry, entry] }, 10)).toThrow('duplicate');
  });

  it('orders snapshots deterministically', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'z', objectId: 2 }, 'user', 0);
    registry.select({ layerKey: 'a', objectId: 9 }, 'user', 0);
    expect(registry.snapshot().selections.map((entry) => entry.layerKey)).toEqual(['a', 'z']);
  });

  it.each([
    [{ layerKey: '', objectId: 1 }, 'layerKey'],
    [{ layerKey: ' '.repeat(4), objectId: 1 }, 'layerKey'],
    [{ layerKey: 'valid', objectId: -1 }, 'objectId'],
    [{ layerKey: 'valid', objectId: Number.NaN }, 'objectId'],
    [{ layerKey: 'valid', objectId: ' padded ' }, 'objectId'],
  ] as const)('fails closed for malformed identity %o', (identity, message) => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    expect(() => registry.select(identity, 'user', 0)).toThrow(message);
  });

  it('rejects invalid policy and clocks', () => {
    expect(() => new ArcGisSelectionStateRegistry({ ...policy, maxSelections: 0 })).toThrow('maxSelections');
    const registry = new ArcGisSelectionStateRegistry(policy);
    expect(() => registry.select({ layerKey: 'a', objectId: 1 }, 'user', Number.NaN)).toThrow('nowMs');
  });

  it('clears deterministically and advances revision only when state changes', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    const initial = registry.snapshot().revision;
    registry.clear();
    expect(registry.snapshot().revision).toBe(initial);
    registry.select({ layerKey: 'a', objectId: 1 }, 'user', 0);
    const selected = registry.snapshot().revision;
    registry.clear();
    expect(registry.snapshot().revision).toBe(selected + 1);
  });

  it('is unusable after disposal', () => {
    const registry = new ArcGisSelectionStateRegistry(policy);
    registry.select({ layerKey: 'a', objectId: 1 }, 'user', 0);
    registry.dispose();
    registry.dispose();
    expect(() => registry.snapshot()).toThrow('disposed');
    expect(() => registry.select({ layerKey: 'a', objectId: 1 }, 'user', 1)).toThrow('disposed');
  });
});
