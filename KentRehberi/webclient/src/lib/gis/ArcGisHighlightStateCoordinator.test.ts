import { describe, expect, it } from 'vitest';
import { ArcGisHighlightStateCoordinator, type ArcGisHighlightPolicy } from './ArcGisHighlightStateCoordinator';

const policy: ArcGisHighlightPolicy = {
  maxHighlights: 4,
  maxPerLayer: 2,
  maxLayerKeyLength: 32,
  maxObjectIdLength: 32,
  maxTtlMs: 10_000,
};

function create(): ArcGisHighlightStateCoordinator {
  return new ArcGisHighlightStateCoordinator(policy);
}

describe('ArcGisHighlightStateCoordinator', () => {
  it('shares stable highlight identities across 2d and 3d modes', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'roads', objectId: 7, priority: 'selection', requestedAtMs: 100 }, 100);
    expect(coordinator.setMode('3d')).toBe(true);
    const snapshot = coordinator.snapshot();
    expect(snapshot.mode).toBe('3d');
    expect(snapshot.highlights).toHaveLength(1);
    expect(snapshot.highlights[0]?.objectId).toBe(7);
  });

  it('does not advance generation for an idempotent mode assignment', () => {
    const coordinator = create();
    const before = coordinator.snapshot().generation;
    expect(coordinator.setMode('2d')).toBe(false);
    expect(coordinator.snapshot().generation).toBe(before);
  });

  it('preserves numeric and string object id identity separation', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'poi', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'poi', objectId: '1', priority: 'selection', requestedAtMs: 2 }, 2);
    expect(coordinator.has({ layerKey: 'poi', objectId: 1 })).toBe(true);
    expect(coordinator.has({ layerKey: 'poi', objectId: '1' })).toBe(true);
    expect(coordinator.snapshot().highlights).toHaveLength(2);
  });

  it('rejects stale updates for an existing identity', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'buildings', objectId: 4, priority: 'selection', requestedAtMs: 20 }, 20);
    expect(() => coordinator.upsert({ layerKey: 'buildings', objectId: 4, priority: 'critical', requestedAtMs: 19 }, 21)).toThrow('stale highlight update');
  });

  it('allows a newer update and records its new priority', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'buildings', objectId: 4, priority: 'hover', requestedAtMs: 20 }, 20);
    const updated = coordinator.upsert({ layerKey: 'buildings', objectId: 4, priority: 'critical', requestedAtMs: 21 }, 21);
    expect(updated.priority).toBe('critical');
    expect(updated.generation).toBeGreaterThan(0);
  });

  it('enforces per-layer capacity for equal priority work', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'roads', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'roads', objectId: 2, priority: 'selection', requestedAtMs: 2 }, 2);
    expect(() => coordinator.upsert({ layerKey: 'roads', objectId: 3, priority: 'selection', requestedAtMs: 3 }, 3)).toThrow('highlight layer capacity exceeded');
  });

  it('evicts lower priority work under per-layer pressure', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'roads', objectId: 1, priority: 'hover', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'roads', objectId: 2, priority: 'selection', requestedAtMs: 2 }, 2);
    coordinator.upsert({ layerKey: 'roads', objectId: 3, priority: 'critical', requestedAtMs: 3 }, 3);
    expect(coordinator.has({ layerKey: 'roads', objectId: 1 })).toBe(false);
    expect(coordinator.has({ layerKey: 'roads', objectId: 3 })).toBe(true);
  });

  it('evicts lower priority work under global pressure', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'a', objectId: 1, priority: 'hover', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'b', objectId: 2, priority: 'selection', requestedAtMs: 2 }, 2);
    coordinator.upsert({ layerKey: 'c', objectId: 3, priority: 'selection', requestedAtMs: 3 }, 3);
    coordinator.upsert({ layerKey: 'd', objectId: 4, priority: 'selection', requestedAtMs: 4 }, 4);
    coordinator.upsert({ layerKey: 'e', objectId: 5, priority: 'critical', requestedAtMs: 5 }, 5);
    expect(coordinator.has({ layerKey: 'a', objectId: 1 })).toBe(false);
    expect(coordinator.snapshot().highlights).toHaveLength(4);
  });

  it('refuses lower priority admission when global capacity is protected', () => {
    const coordinator = create();
    for (const [index, layer] of ['a', 'b', 'c', 'd'].entries()) {
      coordinator.upsert({ layerKey: layer, objectId: index, priority: 'critical', requestedAtMs: index }, index);
    }
    expect(() => coordinator.upsert({ layerKey: 'e', objectId: 5, priority: 'hover', requestedAtMs: 5 }, 5)).toThrow('highlight capacity exceeded');
  });

  it('expires bounded transient highlights', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'poi', objectId: 1, priority: 'hover', requestedAtMs: 100, expiresAtMs: 150 }, 100);
    expect(coordinator.pruneExpired(149)).toBe(0);
    expect(coordinator.pruneExpired(150)).toBe(1);
    expect(coordinator.snapshot().highlights).toHaveLength(0);
  });

  it('rejects TTL beyond policy', () => {
    const coordinator = create();
    expect(() => coordinator.upsert({ layerKey: 'poi', objectId: 1, priority: 'hover', requestedAtMs: 1, expiresAtMs: 20_000 }, 1)).toThrow('highlight TTL exceeds policy');
  });

  it('rejects already expired highlight requests', () => {
    const coordinator = create();
    expect(() => coordinator.upsert({ layerKey: 'poi', objectId: 1, priority: 'hover', requestedAtMs: 1, expiresAtMs: 5 }, 5)).toThrow('highlight is already expired');
  });

  it('rejects future request timestamps', () => {
    const coordinator = create();
    expect(() => coordinator.upsert({ layerKey: 'poi', objectId: 1, priority: 'hover', requestedAtMs: 11 }, 10)).toThrow('requestedAtMs cannot be in the future');
  });

  it('removes all highlights for one layer without affecting another', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'a', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'a', objectId: 2, priority: 'selection', requestedAtMs: 2 }, 2);
    coordinator.upsert({ layerKey: 'b', objectId: 3, priority: 'selection', requestedAtMs: 3 }, 3);
    expect(coordinator.removeLayer('a')).toBe(2);
    expect(coordinator.has({ layerKey: 'b', objectId: 3 })).toBe(true);
  });

  it('orders snapshots deterministically by priority layer and typed object id', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'z', objectId: 8, priority: 'hover', requestedAtMs: 1 }, 1);
    coordinator.upsert({ layerKey: 'a', objectId: '2', priority: 'critical', requestedAtMs: 2 }, 2);
    coordinator.upsert({ layerKey: 'a', objectId: 2, priority: 'critical', requestedAtMs: 3 }, 3);
    expect(coordinator.snapshot().highlights.map((entry) => entry.objectId)).toEqual([2, '2', 8]);
  });

  it('returns immutable snapshots and entries', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'a', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    const snapshot = coordinator.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.highlights)).toBe(true);
    expect(Object.isFrozen(snapshot.highlights[0])).toBe(true);
  });

  it('restores a validated cross-view snapshot', () => {
    const coordinator = create();
    coordinator.restore({ mode: '3d', highlights: [{ layerKey: 'a', objectId: 1, priority: 'selection', requestedAtMs: 10, expiresAtMs: null, generation: 1 }] }, 20);
    expect(coordinator.snapshot().mode).toBe('3d');
    expect(coordinator.has({ layerKey: 'a', objectId: 1 })).toBe(true);
  });

  it('rejects duplicate identities during restore', () => {
    const coordinator = create();
    const entry = { layerKey: 'a', objectId: 1, priority: 'selection' as const, requestedAtMs: 10, expiresAtMs: null, generation: 1 };
    expect(() => coordinator.restore({ mode: '2d', highlights: [entry, entry] }, 20)).toThrow('duplicate highlight identity');
  });

  it('rejects restore snapshots that exceed per-layer capacity', () => {
    const coordinator = create();
    const highlights = [1, 2, 3].map((objectId) => ({ layerKey: 'a', objectId, priority: 'selection' as const, requestedAtMs: 1, expiresAtMs: null, generation: 1 }));
    expect(() => coordinator.restore({ mode: '2d', highlights }, 2)).toThrow('snapshot layer capacity exceeded');
  });

  it('rejects malformed layer keys and object ids', () => {
    const coordinator = create();
    expect(() => coordinator.upsert({ layerKey: ' a', objectId: 1, priority: 'hover', requestedAtMs: 1 }, 1)).toThrow('invalid layerKey');
    expect(() => coordinator.upsert({ layerKey: 'a', objectId: -1, priority: 'hover', requestedAtMs: 1 }, 1)).toThrow('invalid numeric objectId');
    expect(() => coordinator.upsert({ layerKey: 'a', objectId: ' x ', priority: 'hover', requestedAtMs: 1 }, 1)).toThrow('invalid string objectId');
  });

  it('rejects non-finite clocks', () => {
    const coordinator = create();
    expect(() => coordinator.pruneExpired(Number.NaN)).toThrow('nowMs must be finite and non-negative');
    expect(() => coordinator.pruneExpired(Number.POSITIVE_INFINITY)).toThrow('nowMs must be finite and non-negative');
  });

  it('validates policy bounds', () => {
    expect(() => new ArcGisHighlightStateCoordinator({ ...policy, maxHighlights: 0 })).toThrow('maxHighlights must be a positive safe integer');
    expect(() => new ArcGisHighlightStateCoordinator({ ...policy, maxPerLayer: 5 })).toThrow('maxPerLayer cannot exceed maxHighlights');
  });

  it('clears deterministically and advances generation only when needed', () => {
    const coordinator = create();
    coordinator.clear();
    const initial = coordinator.snapshot().generation;
    coordinator.upsert({ layerKey: 'a', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    coordinator.clear();
    expect(coordinator.snapshot().generation).toBeGreaterThan(initial);
    const after = coordinator.snapshot().generation;
    coordinator.clear();
    expect(coordinator.snapshot().generation).toBe(after);
  });

  it('disposes idempotently and rejects later use', () => {
    const coordinator = create();
    coordinator.upsert({ layerKey: 'a', objectId: 1, priority: 'selection', requestedAtMs: 1 }, 1);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot()).toThrow('ArcGisHighlightStateCoordinator is disposed');
    expect(() => coordinator.remove({ layerKey: 'a', objectId: 1 })).toThrow('ArcGisHighlightStateCoordinator is disposed');
  });
});
