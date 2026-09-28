import { describe, expect, it } from 'vitest';
import { ArcGisServiceFreshnessCoordinator, type ArcGisServiceFreshnessPolicy } from './ArcGisServiceFreshnessCoordinator';

const policy: ArcGisServiceFreshnessPolicy = {
  maxEntries: 3,
  maxEntriesPerService: 2,
  maxServiceKeyLength: 40,
  maxResourceKeyLength: 80,
  maxEtagLength: 40,
  maxAgeMs: 1_000,
  maxStaleMs: 2_000,
  maxClockSkewMs: 50,
};

const make = () => new ArcGisServiceFreshnessCoordinator(policy);
const observe = (coordinator: ArcGisServiceFreshnessCoordinator, serviceKey: string, resourceKey: string, observedAtMs = 100) => coordinator.observe({ serviceKey, resourceKey, freshnessClass: 'features', observedAtMs, maxAgeMs: 100, staleMs: 200, etag: 'v1' });

describe('ArcGisServiceFreshnessCoordinator', () => {
  it('moves deterministically through fresh, stale and expired decisions', () => {
    const coordinator = make();
    observe(coordinator, 'parcels', 'query:a');
    expect(coordinator.decide('parcels', 'query:a', 199)).toMatchObject({ state: 'fresh', mayServe: true, shouldRevalidate: false });
    expect(coordinator.decide('parcels', 'query:a', 200)).toMatchObject({ state: 'stale', mayServe: true, shouldRevalidate: true });
    expect(coordinator.decide('parcels', 'query:a', 400)).toMatchObject({ state: 'stale', mayServe: true });
    expect(coordinator.decide('parcels', 'query:a', 401)).toMatchObject({ state: 'expired', mayServe: false, shouldRevalidate: true });
  });

  it('returns a fail-closed missing decision without allocating state', () => {
    const coordinator = make();
    expect(coordinator.decide('parcels', 'query:none', 100)).toEqual({ state: 'missing', mayServe: false, shouldRevalidate: true, revision: null, ageMs: null });
    expect(coordinator.snapshot(100).entries).toHaveLength(0);
  });

  it('renews validated freshness while preserving bounded lifetimes', () => {
    const coordinator = make();
    const first = observe(coordinator, 'roads', 'metadata', 100);
    const next = coordinator.validate('roads', 'metadata', 150, 'v2');
    expect(next.revision).toBe(first.revision + 1);
    expect(next.validatedAtMs).toBe(150);
    expect(next.expiresAtMs).toBe(250);
    expect(next.staleUntilMs).toBe(450);
    expect(next.etag).toBe('v2');
  });

  it('bounds global and per-service capacity with deterministic oldest eviction', () => {
    const coordinator = make();
    observe(coordinator, 'a', 'one', 100);
    observe(coordinator, 'a', 'two', 110);
    observe(coordinator, 'a', 'three', 120);
    expect(coordinator.decide('a', 'one', 120).state).toBe('missing');
    observe(coordinator, 'b', 'one', 130);
    observe(coordinator, 'c', 'one', 140);
    expect(coordinator.snapshot(140).entries).toHaveLength(3);
    expect(coordinator.decide('a', 'two', 140).state).toBe('missing');
  });

  it('prunes entries only after the stale horizon', () => {
    const coordinator = make();
    observe(coordinator, 'a', 'one', 100);
    expect(coordinator.prune(400)).toBe(0);
    expect(coordinator.prune(401)).toBe(1);
    expect(coordinator.decide('a', 'one', 401).state).toBe('missing');
  });

  it('invalidates one service without disturbing another', () => {
    const coordinator = make();
    observe(coordinator, 'a', 'one');
    observe(coordinator, 'a', 'two');
    observe(coordinator, 'b', 'one');
    expect(coordinator.invalidateService('a')).toBe(2);
    expect(coordinator.decide('b', 'one', 100).state).toBe('fresh');
  });

  it('restores valid primitive state atomically', () => {
    const source = make();
    observe(source, 'a', 'one', 100);
    const snapshot = source.snapshot(120);
    const target = make();
    target.restore(snapshot, 120);
    expect(target.snapshot(120).entries).toEqual(snapshot.entries);
  });

  it('rejects duplicate restore identities without mutating existing state', () => {
    const coordinator = make();
    observe(coordinator, 'safe', 'one', 100);
    const before = coordinator.snapshot(100);
    const entry = before.entries[0]!;
    expect(() => coordinator.restore({ entries: [entry, entry] }, 100)).toThrow('duplicate freshness entry');
    expect(coordinator.snapshot(100).entries).toEqual(before.entries);
  });

  it('rejects future and inverted restore chronology', () => {
    const coordinator = make();
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', resourceKey: 'x', freshnessClass: 'features', observedAtMs: 200, validatedAtMs: 200, expiresAtMs: 250, staleUntilMs: 300, revision: 1, etag: null }] }, 100)).toThrow('future freshness timestamp');
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', resourceKey: 'x', freshnessClass: 'features', observedAtMs: 100, validatedAtMs: 90, expiresAtMs: 150, staleUntilMs: 200, revision: 1, etag: null }] }, 100)).toThrow('invalid freshness chronology');
  });

  it('rejects durations and capacities outside policy', () => {
    const coordinator = make();
    expect(() => coordinator.observe({ serviceKey: 'a', resourceKey: 'x', freshnessClass: 'features', observedAtMs: 100, maxAgeMs: 1_001 })).toThrow('freshness duration exceeds policy');
    const entry = observe(coordinator, 'a', 'one', 100);
    expect(() => coordinator.restore({ entries: [entry, { ...entry, resourceKey: 'two' }, { ...entry, resourceKey: 'three' }] }, 100)).toThrow('per-service freshness capacity exceeded');
  });

  it('rejects malformed identities, classes and stale clocks', () => {
    const coordinator = make();
    expect(() => coordinator.observe({ serviceKey: '\0bad', resourceKey: 'x', freshnessClass: 'features', observedAtMs: 100 })).toThrow();
    expect(() => coordinator.observe({ serviceKey: 'a', resourceKey: 'x', freshnessClass: 'other' as never, observedAtMs: 100 })).toThrow('invalid freshness class');
    observe(coordinator, 'a', 'one', 200);
    expect(() => coordinator.snapshot(100)).toThrow('stale freshness clock');
  });

  it('disposes idempotently and rejects later use', () => {
    const coordinator = make();
    observe(coordinator, 'a', 'one');
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(100)).toThrow('disposed');
  });
});
