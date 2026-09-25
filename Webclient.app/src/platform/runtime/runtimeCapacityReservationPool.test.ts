import { describe, expect, it } from 'vitest';
import { RuntimeCapacityReservationPool, type RuntimeCapacityReservationRequest } from './runtimeCapacityReservationPool';

const request = (id: string, at: number, overrides: Partial<RuntimeCapacityReservationRequest> = {}): RuntimeCapacityReservationRequest => ({
  id,
  lane: 'interactive',
  priority: 'standard',
  units: 1,
  leaseDurationMs: 100,
  at,
  ...overrides,
});

describe('RuntimeCapacityReservationPool', () => {
  it('reserves capacity immediately when lane reserve rules allow it', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 10, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    expect(pool.request(request('a', 1, { units: 4 })).disposition).toBe('reserved');
    expect(pool.snapshot()).toMatchObject({ activeReservations: 1, activeUnits: 4, availableUnits: 6, queuedReservations: 0 });
  });

  it('protects critical reserve from interactive work', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 10, maximumReservationUnits: 10, minimumCriticalReserve: 4, minimumInteractiveReserve: 0 });
    expect(pool.request(request('i', 1, { units: 7 })).disposition).toBe('queued');
    expect(pool.request(request('c', 2, { lane: 'critical', units: 4 })).disposition).toBe('queued');
    expect(pool.snapshot()).toMatchObject({ activeUnits: 0, queuedReservations: 2 });
  });

  it('protects interactive and critical reserves from background work', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 12, maximumReservationUnits: 12, minimumCriticalReserve: 3, minimumInteractiveReserve: 4 });
    expect(pool.request(request('b', 1, { lane: 'background', units: 6 })).disposition).toBe('queued');
    expect(pool.snapshot().lanes.background.queuedUnits).toBe(6);
  });

  it('allows critical work to consume otherwise reserved capacity', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 8, maximumReservationUnits: 8, minimumCriticalReserve: 4, minimumInteractiveReserve: 2 });
    expect(pool.request(request('critical', 1, { lane: 'critical', units: 8 })).disposition).toBe('reserved');
    expect(pool.snapshot().availableUnits).toBe(0);
  });

  it('releases active capacity and promotes queued work', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 4, maximumReservationUnits: 4, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 1, { units: 4 }));
    expect(pool.request(request('b', 2, { units: 2 })).disposition).toBe('queued');
    const promoted = pool.release('a', 3);
    expect(promoted.map((entry) => entry.id)).toEqual(['b']);
    expect(pool.snapshot()).toMatchObject({ activeUnits: 2, queuedReservations: 0 });
  });

  it('expires leases only when caller advances the monotonic clock', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 2, maximumReservationUnits: 2, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 10, { units: 2, leaseDurationMs: 20 }));
    expect(pool.snapshot().nextExpiryAt).toBe(30);
    expect(pool.sweep(29)).toEqual([]);
    expect(pool.snapshot().activeReservations).toBe(1);
    expect(pool.sweep(30)).toEqual([]);
    expect(pool.snapshot().activeReservations).toBe(0);
    expect(pool.history().at(-1)).toMatchObject({ id: 'a', disposition: 'expired', at: 30 });
  });

  it('promotes queued work after expiry', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 2, maximumReservationUnits: 2, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 1, { units: 2, leaseDurationMs: 10 }));
    pool.request(request('b', 2, { units: 2, leaseDurationMs: 10 }));
    const promoted = pool.sweep(11);
    expect(promoted.map((entry) => entry.id)).toEqual(['b']);
    expect(promoted[0]?.reservedAt).toBe(11);
    expect(promoted[0]?.expiresAt).toBe(21);
  });

  it('orders queued requests by priority and FIFO within priority', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('standard-1', 2));
    pool.request(request('urgent-1', 3, { priority: 'urgent' }));
    pool.request(request('urgent-2', 4, { priority: 'urgent' }));
    expect(pool.release('owner', 5).map((entry) => entry.id)).toEqual(['urgent-1']);
    expect(pool.release('urgent-1', 6).map((entry) => entry.id)).toEqual(['urgent-2']);
    expect(pool.release('urgent-2', 7).map((entry) => entry.id)).toEqual(['standard-1']);
  });

  it('uses deterministic lane order when multiple lanes can promote', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 3, maximumReservationUnits: 3, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1, { lane: 'critical', units: 3 }));
    pool.request(request('background', 2, { lane: 'background' }));
    pool.request(request('interactive', 3, { lane: 'interactive' }));
    pool.request(request('critical', 4, { lane: 'critical' }));
    expect(pool.release('owner', 5).map((entry) => entry.id)).toEqual(['critical', 'interactive', 'background']);
  });

  it('rejects duplicate active ids', () => {
    const pool = new RuntimeCapacityReservationPool({ minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('same', 1));
    expect(pool.request(request('same', 2))).toMatchObject({ disposition: 'rejected', reason: 'duplicate' });
  });

  it('rejects duplicate queued ids', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('same', 2));
    expect(pool.request(request('same', 3))).toMatchObject({ disposition: 'rejected', reason: 'duplicate' });
  });

  it('rejects oversized reservations without queueing them', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 10, maximumReservationUnits: 3, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    expect(pool.request(request('large', 1, { units: 4 }))).toMatchObject({ disposition: 'rejected', reason: 'oversized' });
    expect(pool.snapshot().queuedReservations).toBe(0);
  });

  it('enforces the global queue bound', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, maximumQueue: 2, maximumPerLaneQueue: 2, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('q1', 2));
    pool.request(request('q2', 3));
    expect(pool.request(request('q3', 4))).toMatchObject({ disposition: 'rejected', reason: 'queue-full' });
  });

  it('enforces the per-lane queue bound', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, maximumQueue: 4, maximumPerLaneQueue: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('q1', 2));
    expect(pool.request(request('q2', 3))).toMatchObject({ disposition: 'rejected', reason: 'lane-queue-full' });
    expect(pool.request(request('critical-q', 4, { lane: 'critical' })).disposition).toBe('queued');
  });

  it('supports zero-length queues as fail-closed admission', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, maximumQueue: 0, maximumPerLaneQueue: 0, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    expect(pool.request(request('other', 2))).toMatchObject({ disposition: 'rejected', reason: 'queue-full' });
  });

  it('cancels queued reservations', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('queued', 2));
    expect(pool.cancel('queued', 3)).toBe(true);
    expect(pool.cancel('queued', 4)).toBe(false);
    expect(pool.snapshot().queuedReservations).toBe(0);
    expect(pool.history().at(-1)).toMatchObject({ id: 'queued', disposition: 'cancelled' });
  });

  it('does not cancel active reservations through the queue cancellation API', () => {
    const pool = new RuntimeCapacityReservationPool({ minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('active', 1));
    expect(pool.cancel('active', 2)).toBe(false);
    expect(pool.snapshot().activeReservations).toBe(1);
  });

  it('returns an empty promotion set when releasing an unknown id', () => {
    const pool = new RuntimeCapacityReservationPool();
    expect(pool.release('missing', 1)).toEqual([]);
  });

  it('reports immutable active reservation copies', () => {
    const pool = new RuntimeCapacityReservationPool({ minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 1));
    const active = pool.active();
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active[0])).toBe(true);
  });

  it('reports immutable bounded history', () => {
    const pool = new RuntimeCapacityReservationPool({ maximumHistory: 2, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 1));
    pool.release('a', 2);
    pool.request(request('b', 3));
    expect(pool.history()).toHaveLength(2);
    expect(pool.history().map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(Object.isFrozen(pool.history())).toBe(true);
  });

  it('supports disabling decision history', () => {
    const pool = new RuntimeCapacityReservationPool({ maximumHistory: 0, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 1));
    pool.release('a', 2);
    expect(pool.history()).toEqual([]);
  });

  it('reports lane-level active and queued accounting', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 5, maximumReservationUnits: 5, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('critical', 1, { lane: 'critical', units: 3 }));
    pool.request(request('interactive', 2, { units: 2 }));
    pool.request(request('background', 3, { lane: 'background', units: 1 }));
    const snapshot = pool.snapshot();
    expect(snapshot.lanes.critical).toMatchObject({ activeReservations: 1, activeUnits: 3 });
    expect(snapshot.lanes.interactive).toMatchObject({ activeReservations: 1, activeUnits: 2 });
    expect(snapshot.lanes.background).toMatchObject({ queuedReservations: 1, queuedUnits: 1 });
  });

  it('allows snapshot to advance expiry processing explicitly', () => {
    const pool = new RuntimeCapacityReservationPool({ minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 10, { leaseDurationMs: 10 }));
    expect(pool.snapshot(20).activeReservations).toBe(0);
  });

  it('rejects time moving backwards across operations', () => {
    const pool = new RuntimeCapacityReservationPool();
    pool.request(request('a', 10));
    expect(() => pool.snapshot(9)).toThrow(/monotonic/);
    expect(() => pool.release('a', 9)).toThrow(/monotonic/);
    expect(() => pool.cancel('a', 9)).toThrow(/monotonic/);
    expect(() => pool.sweep(9)).toThrow(/monotonic/);
  });

  it('allows equal timestamps', () => {
    const pool = new RuntimeCapacityReservationPool({ minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 10));
    expect(() => pool.snapshot(10)).not.toThrow();
  });

  it('resets all state and clock globally', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('a', 100));
    pool.request(request('b', 101));
    pool.reset();
    expect(pool.snapshot()).toMatchObject({ activeReservations: 0, queuedReservations: 0, activeUnits: 0 });
    expect(pool.history()).toEqual([]);
    expect(() => pool.request(request('new', 1))).not.toThrow();
  });

  it('resets only the selected lane without erasing other lane ownership', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 4, maximumReservationUnits: 4, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('critical', 1, { lane: 'critical' }));
    pool.request(request('interactive', 2));
    pool.reset('critical');
    expect(pool.active().map((entry) => entry.id)).toEqual(['interactive']);
    expect(pool.snapshot().lanes.critical.activeReservations).toBe(0);
  });

  it('removes queued ids during lane reset so ids can be reused', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1, { lane: 'critical' }));
    pool.request(request('queued', 2));
    pool.reset('interactive');
    expect(pool.request(request('queued', 3))).toMatchObject({ disposition: 'queued', reason: 'queued' });
  });

  it('freezes normalized policy', () => {
    const pool = new RuntimeCapacityReservationPool();
    expect(Object.isFrozen(pool.policy())).toBe(true);
  });

  it.each([
    [{ capacity: 0 }, /capacity/],
    [{ capacity: 1.5 }, /capacity/],
    [{ maximumReservationUnits: 0 }, /maximumReservationUnits/],
    [{ maximumQueue: -1 }, /maximumQueue/],
    [{ maximumPerLaneQueue: -1 }, /maximumPerLaneQueue/],
    [{ maximumHistory: -1 }, /maximumHistory/],
    [{ maximumLeaseDurationMs: 0 }, /maximumLeaseDurationMs/],
    [{ minimumCriticalReserve: -1 }, /minimumCriticalReserve/],
    [{ minimumInteractiveReserve: -1 }, /minimumInteractiveReserve/],
  ] as const)('rejects malformed policy %o', (policy, pattern) => {
    expect(() => new RuntimeCapacityReservationPool(policy)).toThrow(pattern);
  });

  it('rejects a maximum reservation larger than capacity', () => {
    expect(() => new RuntimeCapacityReservationPool({ capacity: 2, maximumReservationUnits: 3 })).toThrow(/must not exceed capacity/);
  });

  it('rejects a per-lane queue larger than the global queue', () => {
    expect(() => new RuntimeCapacityReservationPool({ maximumQueue: 1, maximumPerLaneQueue: 2 })).toThrow(/must not exceed maximumQueue/);
  });

  it('rejects lane reserves larger than capacity', () => {
    expect(() => new RuntimeCapacityReservationPool({ capacity: 5, minimumCriticalReserve: 3, minimumInteractiveReserve: 3 })).toThrow(/lane reserves/);
  });

  it.each([
    [request('', 1), /reservation id/],
    [request('x'.repeat(257), 1), /reservation id/],
    [request('a', -1), /at/],
    [request('a', 1, { units: 0 }), /units/],
    [request('a', 1, { units: 1.5 }), /units/],
    [request('a', 1, { leaseDurationMs: 0 }), /leaseDurationMs/],
  ] as const)('rejects malformed request input', (input, pattern) => {
    const pool = new RuntimeCapacityReservationPool();
    expect(() => pool.request(input)).toThrow(pattern);
  });

  it('rejects unsupported lanes at runtime', () => {
    const pool = new RuntimeCapacityReservationPool();
    expect(() => pool.request(request('a', 1, { lane: 'other' as RuntimeCapacityReservationRequest['lane'] }))).toThrow(/unsupported reservation lane/);
  });

  it('rejects unsupported priorities at runtime', () => {
    const pool = new RuntimeCapacityReservationPool();
    expect(() => pool.request(request('a', 1, { priority: 'other' as RuntimeCapacityReservationRequest['priority'] }))).toThrow(/unsupported reservation priority/);
  });

  it('rejects lease durations above the configured ceiling', () => {
    const pool = new RuntimeCapacityReservationPool({ maximumLeaseDurationMs: 10 });
    expect(() => pool.request(request('a', 1, { leaseDurationMs: 11 }))).toThrow(/leaseDurationMs/);
  });

  it('rejects expiry arithmetic outside the safe integer range', () => {
    const pool = new RuntimeCapacityReservationPool({ maximumLeaseDurationMs: 100, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    expect(() => pool.request(request('a', Number.MAX_SAFE_INTEGER - 10, { leaseDurationMs: 100 }))).toThrow(/expiry exceeds/);
  });

  it('preserves reserve semantics as protected lanes acquire their minimums', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 12, maximumReservationUnits: 12, minimumCriticalReserve: 3, minimumInteractiveReserve: 4 });
    expect(pool.request(request('critical', 1, { lane: 'critical', units: 3 })).disposition).toBe('reserved');
    expect(pool.request(request('interactive', 2, { units: 4 })).disposition).toBe('reserved');
    expect(pool.request(request('background', 3, { lane: 'background', units: 5 })).disposition).toBe('reserved');
    expect(pool.snapshot().activeUnits).toBe(12);
  });

  it('does not silently bypass an older queued request with a new request', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 4, maximumReservationUnits: 4, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1, { units: 3 }));
    expect(pool.request(request('large', 2, { units: 2 })).disposition).toBe('queued');
    expect(pool.request(request('small', 3, { units: 1 })).disposition).toBe('queued');
    expect(pool.snapshot()).toMatchObject({ activeUnits: 3, queuedReservations: 2 });
  });

  it('keeps queued lease duration relative to actual promotion time', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 10, { leaseDurationMs: 100 }));
    pool.request(request('queued', 20, { leaseDurationMs: 25 }));
    const promoted = pool.release('owner', 30);
    expect(promoted[0]).toMatchObject({ id: 'queued', reservedAt: 30, expiresAt: 55 });
  });

  it('records release before promotion decisions', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1));
    pool.request(request('queued', 2));
    pool.release('owner', 3);
    expect(pool.history().slice(-2).map((entry) => entry.disposition)).toEqual(['released', 'reserved']);
  });

  it('records expiry before promotion decisions', () => {
    const pool = new RuntimeCapacityReservationPool({ capacity: 1, maximumReservationUnits: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    pool.request(request('owner', 1, { leaseDurationMs: 2 }));
    pool.request(request('queued', 2));
    pool.sweep(3);
    expect(pool.history().slice(-2).map((entry) => entry.disposition)).toEqual(['expired', 'reserved']);
  });
});
