import { describe, expect, it } from 'vitest';
import { ArcGisServiceRequestDedupeCoordinator, type ArcGisServiceRequestDedupePolicy } from './ArcGisServiceRequestDedupeCoordinator';

const policy = (overrides: Partial<ArcGisServiceRequestDedupePolicy> = {}): ArcGisServiceRequestDedupePolicy => ({
  maxEntries: 3,
  maxSubscribersPerEntry: 3,
  maxFingerprintLength: 96,
  maxServiceKeyLength: 64,
  maxSubscriberIdLength: 64,
  maxRequestAgeMs: 1_000,
  maxSettledRetentionMs: 500,
  maxClockSkewMs: 10,
  ...overrides,
});

const join = (coordinator: ArcGisServiceRequestDedupeCoordinator, fingerprint: string, requestId: string, subscriberId: string, at: number, service = 'parcels') =>
  coordinator.join(fingerprint, service, requestId, subscriberId, 'foreground', at);

describe('ArcGisServiceRequestDedupeCoordinator', () => {
  it('creates one owner and joins duplicate work without retaining runtime resources', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(join(coordinator, 'query:1', 'request-a', 'view-a', 100)).toEqual({ fingerprint: 'query:1', ownerRequestId: 'request-a', joined: true, owner: true, reason: 'owner' });
    expect(join(coordinator, 'query:1', 'request-b', 'view-b', 101)).toEqual({ fingerprint: 'query:1', ownerRequestId: 'request-a', joined: true, owner: false, reason: 'joined' });
    const snapshot = coordinator.snapshot(102);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.subscribers.map(item => item.subscriberId)).toEqual(['view-a', 'view-b']);
    expect(JSON.stringify(snapshot)).not.toContain('AbortController');
  });

  it('orders subscribers by priority then join time and identity', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    coordinator.join('query:1', 'parcels', 'owner', 'background', 'background', 100);
    coordinator.join('query:1', 'parcels', 'ignored', 'foreground', 'foreground', 102);
    coordinator.join('query:1', 'parcels', 'ignored-2', 'interactive', 'interactive', 103);
    expect(coordinator.snapshot(104).entries[0]?.subscribers.map(item => item.subscriberId)).toEqual(['interactive', 'foreground', 'background']);
  });

  it('returns terminal subscribers in deterministic priority order', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    coordinator.join('query:1', 'parcels', 'owner', 'one', 'background', 100);
    coordinator.join('query:1', 'parcels', 'ignored', 'two', 'interactive', 101);
    const subscribers = coordinator.settle('query:1', 'fulfilled', 110);
    expect(subscribers.map(item => item.subscriberId)).toEqual(['two', 'one']);
    expect(coordinator.snapshot(111).entries[0]?.outcome).toBe('fulfilled');
  });

  it('does not join settled work', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'query:1', 'owner', 'one', 100);
    coordinator.settle('query:1', 'fulfilled', 110);
    expect(join(coordinator, 'query:1', 'late', 'two', 111)).toMatchObject({ joined: false, owner: false, reason: 'settled', ownerRequestId: 'owner' });
  });

  it('cancels owner work when its final subscriber leaves', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'query:1', 'owner', 'one', 100);
    expect(coordinator.leave('query:1', 'one', 101)).toBe(true);
    expect(coordinator.snapshot(102).entries[0]).toMatchObject({ outcome: 'cancelled', settledAtMs: 101, subscribers: [] });
  });

  it('keeps pending work when another subscriber remains', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'query:1', 'owner', 'one', 100);
    join(coordinator, 'query:1', 'other', 'two', 101);
    expect(coordinator.leave('query:1', 'one', 102)).toBe(true);
    expect(coordinator.snapshot(103).entries[0]).toMatchObject({ outcome: 'pending' });
    expect(coordinator.snapshot(103).entries[0]?.subscribers.map(item => item.subscriberId)).toEqual(['two']);
  });

  it('bounds subscribers per single-flight entry', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxSubscribersPerEntry: 2 }));
    join(coordinator, 'query:1', 'owner', 'one', 100);
    join(coordinator, 'query:1', 'other', 'two', 101);
    expect(join(coordinator, 'query:1', 'third', 'three', 102)).toMatchObject({ joined: false, reason: 'subscriber-capacity' });
    expect(coordinator.snapshot(103).entries[0]?.subscribers).toHaveLength(2);
  });

  it('rejects duplicate subscriber identities', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'query:1', 'owner', 'same', 100);
    expect(() => join(coordinator, 'query:1', 'other', 'same', 101)).toThrow('duplicate subscriber id');
  });

  it('rejects a fingerprint reused across service boundaries', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'query:1', 'owner', 'one', 100, 'parcels');
    expect(() => join(coordinator, 'query:1', 'other', 'two', 101, 'roads')).toThrow('fingerprint cannot cross service boundaries');
  });

  it('fails closed when capacity contains only pending work', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxEntries: 2 }));
    join(coordinator, 'a', 'a', 'a', 100);
    join(coordinator, 'b', 'b', 'b', 101);
    expect(join(coordinator, 'c', 'c', 'c', 102)).toMatchObject({ joined: false, owner: false, reason: 'capacity' });
    expect(coordinator.snapshot(103).entries.map(item => item.fingerprint)).toEqual(['a', 'b']);
  });

  it('evicts the oldest terminal entry before rejecting new work', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxEntries: 2 }));
    join(coordinator, 'a', 'a', 'a', 100);
    coordinator.settle('a', 'fulfilled', 110);
    join(coordinator, 'b', 'b', 'b', 120);
    expect(join(coordinator, 'c', 'c', 'c', 121)).toMatchObject({ joined: true, owner: true, reason: 'owner' });
    expect(coordinator.snapshot(122).entries.map(item => item.fingerprint)).toEqual(['b', 'c']);
  });

  it('prunes pending entries after request age budget', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxRequestAgeMs: 100 }));
    join(coordinator, 'old', 'owner', 'one', 100);
    expect(coordinator.snapshot(201).entries).toEqual([]);
  });

  it('prunes terminal entries after retention budget', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxSettledRetentionMs: 50 }));
    join(coordinator, 'old', 'owner', 'one', 100);
    coordinator.settle('old', 'rejected', 110);
    expect(coordinator.snapshot(161).entries).toEqual([]);
  });

  it('preserves entries exactly at retention boundaries', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxRequestAgeMs: 100, maxSettledRetentionMs: 50 }));
    join(coordinator, 'pending', 'owner', 'one', 100);
    expect(coordinator.snapshot(200).entries).toHaveLength(1);
    coordinator.settle('pending', 'fulfilled', 200);
    expect(coordinator.snapshot(250).entries).toHaveLength(1);
  });

  it('rejects stale clocks beyond configured skew', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxClockSkewMs: 5 }));
    coordinator.snapshot(100);
    expect(() => coordinator.snapshot(94)).toThrow('stale dedupe clock');
  });

  it('allows bounded clock skew without moving logical time backwards', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxClockSkewMs: 10 }));
    join(coordinator, 'a', 'a', 'a', 100);
    expect(() => coordinator.snapshot(95)).not.toThrow();
    expect(() => coordinator.snapshot(89)).toThrow('stale dedupe clock');
  });

  it('validates bounded primitive identities', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxFingerprintLength: 4, maxServiceKeyLength: 4, maxSubscriberIdLength: 4 }));
    expect(() => join(coordinator, 'abcde', 'a', 'a', 100)).toThrow('fingerprint outside configured bounds');
    expect(() => join(coordinator, 'a', 'a', 'a', 100, 'abcde')).toThrow('service key outside configured bounds');
    expect(() => join(coordinator, 'a', 'a', 'abcde', 100)).toThrow('subscriber id outside configured bounds');
    expect(() => join(coordinator, 'a\0', 'a', 'a', 100)).toThrow('fingerprint outside configured bounds');
  });

  it('rejects invalid priority values at runtime', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.join('a', 'svc', 'req', 'sub', 'urgent' as never, 100)).toThrow('invalid dedupe priority');
  });

  it('restores a valid snapshot atomically', () => {
    const source = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(source, 'a', 'owner', 'one', 100);
    join(source, 'a', 'other', 'two', 101);
    join(source, 'b', 'b', 'b', 102);
    source.settle('b', 'fulfilled', 110);
    const snapshot = source.snapshot(111);
    const restored = new ArcGisServiceRequestDedupeCoordinator(policy());
    restored.restore(snapshot, 111);
    expect(restored.snapshot(111).entries).toEqual(snapshot.entries);
  });

  it('drops expired entries during restore without weakening validation', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxRequestAgeMs: 50, maxSettledRetentionMs: 50 }));
    coordinator.restore({ entries: [
      { fingerprint: 'pending', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'pending', subscribers: [{ subscriberId: 'a', priority: 'foreground', joinedAtMs: 100 }] },
      { fingerprint: 'settled', serviceKey: 'svc', ownerRequestId: 'b', createdAtMs: 100, settledAtMs: 120, outcome: 'fulfilled', subscribers: [{ subscriberId: 'b', priority: 'foreground', joinedAtMs: 100 }] },
    ] }, 200);
    expect(coordinator.snapshot(200).entries).toEqual([]);
  });

  it('rejects duplicate fingerprints in restore state', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    const entry = { fingerprint: 'same', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'pending' as const, subscribers: [{ subscriberId: 'a', priority: 'foreground' as const, joinedAtMs: 100 }] };
    expect(() => coordinator.restore({ entries: [entry, { ...entry, ownerRequestId: 'b' }] }, 110)).toThrow('duplicate fingerprint in snapshot');
  });

  it('rejects duplicate subscribers in restore state', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'pending', subscribers: [
      { subscriberId: 'same', priority: 'foreground', joinedAtMs: 100 },
      { subscriberId: 'same', priority: 'background', joinedAtMs: 101 },
    ] }] }, 110)).toThrow('duplicate subscriber in snapshot');
  });

  it('rejects future entry and subscriber timestamps', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxClockSkewMs: 5 }));
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 106, settledAtMs: null, outcome: 'pending', subscribers: [] }] }, 100)).toThrow('future dedupe entry');
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'pending', subscribers: [{ subscriberId: 'a', priority: 'foreground', joinedAtMs: 106 }] }] }, 100)).toThrow('invalid subscriber timestamp');
  });

  it('rejects inverted subscriber timestamps', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'pending', subscribers: [{ subscriberId: 'a', priority: 'foreground', joinedAtMs: 99 }] }] }, 110)).toThrow('invalid subscriber timestamp');
  });

  it('requires terminal entries to carry settlement timestamps', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: null, outcome: 'fulfilled', subscribers: [] }] }, 110)).toThrow('terminal entry requires settledAtMs');
  });

  it('forbids settlement timestamps on pending entries', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: 105, outcome: 'pending', subscribers: [] }] }, 110)).toThrow('pending entry cannot be settled');
  });

  it('rejects inverted and future settlement timestamps', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxClockSkewMs: 5 }));
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: 99, outcome: 'fulfilled', subscribers: [] }] }, 110)).toThrow('invalid settlement timestamp');
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'a', serviceKey: 'svc', ownerRequestId: 'a', createdAtMs: 100, settledAtMs: 116, outcome: 'fulfilled', subscribers: [] }] }, 110)).toThrow('invalid settlement timestamp');
  });

  it('does not partially replace state after malformed restore input', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'healthy', 'owner', 'one', 100);
    const before = coordinator.snapshot(101).entries;
    expect(() => coordinator.restore({ entries: [{ fingerprint: 'bad\0', serviceKey: 'svc', ownerRequestId: 'bad', createdAtMs: 100, settledAtMs: null, outcome: 'pending', subscribers: [] }] }, 102)).toThrow();
    expect(coordinator.snapshot(103).entries).toEqual(before);
  });

  it('enforces restore entry and subscriber capacities', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy({ maxEntries: 1, maxSubscribersPerEntry: 1 }));
    const makeEntry = (fingerprint: string) => ({ fingerprint, serviceKey: 'svc', ownerRequestId: fingerprint, createdAtMs: 100, settledAtMs: null, outcome: 'pending' as const, subscribers: [] });
    expect(() => coordinator.restore({ entries: [makeEntry('a'), makeEntry('b')] }, 110)).toThrow('invalid dedupe snapshot capacity');
    expect(() => coordinator.restore({ entries: [{ ...makeEntry('a'), subscribers: [{ subscriberId: 'a', priority: 'foreground' as const, joinedAtMs: 100 }, { subscriberId: 'b', priority: 'background' as const, joinedAtMs: 101 }] }] }, 110)).toThrow('invalid subscriber capacity');
  });

  it('treats leave of unknown subscribers as an idempotent no-op', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'a', 'owner', 'one', 100);
    const generation = coordinator.snapshot(101).generation;
    expect(coordinator.leave('a', 'missing', 102)).toBe(false);
    expect(coordinator.snapshot(103).generation).toBe(generation);
  });

  it('rejects settling unknown and already-settled entries', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    expect(() => coordinator.settle('missing', 'fulfilled', 100)).toThrow('dedupe entry not found');
    join(coordinator, 'a', 'owner', 'one', 101);
    coordinator.settle('a', 'fulfilled', 102);
    expect(() => coordinator.settle('a', 'rejected', 103)).toThrow('dedupe entry already settled');
  });

  it('freezes snapshots and nested subscriber records', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'a', 'owner', 'one', 100);
    const snapshot = coordinator.snapshot(101);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.subscribers)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.subscribers[0])).toBe(true);
  });

  it('clears primitive state and rejects all later operations after disposal', () => {
    const coordinator = new ArcGisServiceRequestDedupeCoordinator(policy());
    join(coordinator, 'a', 'owner', 'one', 100);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(101)).toThrow('ArcGisServiceRequestDedupeCoordinator is disposed');
    expect(() => join(coordinator, 'b', 'b', 'b', 102)).toThrow('ArcGisServiceRequestDedupeCoordinator is disposed');
  });
});
