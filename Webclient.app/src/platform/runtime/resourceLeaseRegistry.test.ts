import { describe, expect, it } from 'vitest';
import {
  ResourceLeaseError,
  ResourceLeaseRegistry,
  type ResourceLeaseClock,
} from './resourceLeaseRegistry';

class FakeClock implements ResourceLeaseClock {
  constructor(public value = 1_000) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

describe('ResourceLeaseRegistry', () => {
  it('acquires a bounded immutable lease snapshot', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({}, clock);
    const handle = registry.acquire({
      id: 'map-view',
      owner: 'map-shell',
      ttlMs: 2_000,
      metadata: { mode: '2d', priority: 3 },
    });

    expect(handle.snapshot()).toEqual({
      id: 'map-view',
      owner: 'map-shell',
      acquiredAt: 1_000,
      expiresAt: 3_000,
      metadata: { mode: '2d', priority: 3 },
    });
    expect(registry.snapshot().activeByOwner).toEqual({ 'map-shell': 1 });
  });

  it('trims identifiers and clamps ttl to the configured maximum', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({ maxLeaseMs: 100 }, clock);
    const handle = registry.acquire({ id: '  worker  ', owner: ' runtime ', ttlMs: 500 });
    expect(handle.id).toBe('worker');
    expect(handle.owner).toBe('runtime');
    expect(handle.snapshot()?.expiresAt).toBe(1_100);
  });

  it('rejects duplicate active identifiers', () => {
    const registry = new ResourceLeaseRegistry();
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 });
    expect(() => registry.acquire({ id: 'a', owner: 'two', ttlMs: 100 })).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_LEASE' }),
    );
  });

  it('enforces global capacity after sweeping expired leases', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({ maxActiveLeases: 1 }, clock);
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 50 });
    expect(() => registry.acquire({ id: 'b', owner: 'two', ttlMs: 50 })).toThrowError(
      expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
    );
    clock.advance(50);
    expect(() => registry.acquire({ id: 'b', owner: 'two', ttlMs: 50 })).not.toThrow();
  });

  it('enforces per-owner capacity independently from global capacity', () => {
    const registry = new ResourceLeaseRegistry(
      { maxActiveLeases: 4, maxOwnerLeases: 1 },
      new FakeClock(),
    );
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 50 });
    expect(() => registry.acquire({ id: 'b', owner: 'one', ttlMs: 50 })).toThrowError(
      expect.objectContaining({ code: 'OWNER_CAPACITY_EXCEEDED' }),
    );
    expect(() => registry.acquire({ id: 'c', owner: 'two', ttlMs: 50 })).not.toThrow();
  });

  it('renews from current time without changing acquisition time', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({ maxLeaseMs: 500 }, clock);
    const handle = registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 });
    clock.advance(25);
    expect(handle.renew(300)).toEqual(
      expect.objectContaining({ acquiredAt: 1_000, expiresAt: 1_325 }),
    );
  });

  it('expires leases deterministically and records bounded history', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({ historyLimit: 2 }, clock);
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 10 });
    registry.acquire({ id: 'b', owner: 'two', ttlMs: 20 });
    clock.advance(10);
    expect(registry.sweepExpired()).toBe(1);
    registry.release('b');
    registry.acquire({ id: 'c', owner: 'three', ttlMs: 10 });
    registry.release('c');
    expect(registry.snapshot().history.map(({ id, reason }) => [id, reason])).toEqual([
      ['b', 'released'],
      ['c', 'released'],
    ]);
  });

  it('releases all leases for one owner without disturbing others', () => {
    const registry = new ResourceLeaseRegistry({}, new FakeClock());
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 });
    registry.acquire({ id: 'b', owner: 'one', ttlMs: 100 });
    registry.acquire({ id: 'c', owner: 'two', ttlMs: 100 });
    expect(registry.releaseOwner('one')).toBe(2);
    expect(registry.snapshot().active.map(({ id }) => id)).toEqual(['c']);
  });

  it('replaces an existing lease and records the replacement reason', () => {
    const clock = new FakeClock();
    const registry = new ResourceLeaseRegistry({}, clock);
    registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 });
    clock.advance(5);
    const replacement = registry.replace({ id: 'a', owner: 'two', ttlMs: 200 });
    expect(replacement.owner).toBe('two');
    expect(registry.snapshot().history.at(-1)).toEqual(
      expect.objectContaining({ id: 'a', owner: 'one', reason: 'replaced', releasedAt: 1_005 }),
    );
  });

  it('dispose is idempotent and closes every active lease', () => {
    const registry = new ResourceLeaseRegistry({}, new FakeClock());
    const handle = registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 });
    registry.acquire({ id: 'b', owner: 'two', ttlMs: 100 });
    registry.dispose();
    registry.dispose();
    const snapshot = registry.snapshot();
    expect(snapshot.disposed).toBe(true);
    expect(snapshot.active).toEqual([]);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history.every(({ reason }) => reason === 'registry-disposed')).toBe(true);
    expect(handle.snapshot()).toBeUndefined();
    expect(handle.release()).toBe(false);
  });

  it('rejects operations after disposal', () => {
    const registry = new ResourceLeaseRegistry();
    registry.dispose();
    expect(() => registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 })).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_DISPOSED' }),
    );
    expect(() => registry.release('a')).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_DISPOSED' }),
    );
  });

  it.each([
    { id: '', owner: 'one', ttlMs: 10 },
    { id: 'a', owner: '', ttlMs: 10 },
    { id: 'a', owner: 'one', ttlMs: 0 },
    { id: 'a', owner: 'one', ttlMs: Number.NaN },
  ])('rejects malformed lease request %#', (request) => {
    const registry = new ResourceLeaseRegistry();
    expect(() => registry.acquire(request)).toThrowError(ResourceLeaseError);
  });

  it('rejects invalid policy bounds', () => {
    expect(() => new ResourceLeaseRegistry({ maxActiveLeases: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() => new ResourceLeaseRegistry({ maxOwnerLeases: Number.POSITIVE_INFINITY })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('rejects oversized and non-finite metadata', () => {
    const registry = new ResourceLeaseRegistry();
    const oversized = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`key-${index}`, index]),
    );
    expect(() =>
      registry.acquire({ id: 'a', owner: 'one', ttlMs: 100, metadata: oversized }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() =>
      registry.acquire({
        id: 'b',
        owner: 'one',
        ttlMs: 100,
        metadata: { invalid: Number.POSITIVE_INFINITY },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('fails closed when the clock returns an invalid timestamp', () => {
    const clock: ResourceLeaseClock = { now: () => Number.NaN };
    const registry = new ResourceLeaseRegistry({}, clock);
    expect(() => registry.acquire({ id: 'a', owner: 'one', ttlMs: 100 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('sorts active snapshots deterministically by expiry then id', () => {
    const registry = new ResourceLeaseRegistry({}, new FakeClock());
    registry.acquire({ id: 'z', owner: 'one', ttlMs: 100 });
    registry.acquire({ id: 'a', owner: 'two', ttlMs: 100 });
    registry.acquire({ id: 'm', owner: 'three', ttlMs: 50 });
    expect(registry.snapshot().active.map(({ id }) => id)).toEqual(['m', 'a', 'z']);
  });
});
