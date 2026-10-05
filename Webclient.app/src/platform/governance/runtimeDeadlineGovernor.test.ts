import { describe, expect, it } from 'vitest';
import {
  RuntimeDeadlineGovernor,
  createRuntimeDeadlineGovernor,
  type RuntimeDeadlineLease,
} from './runtimeDeadlineGovernor';

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    set: (value: number) => { now = value; },
  };
}

const policy = {
  maxScopes: 4,
  maxActiveGlobal: 4,
  maxActivePerScope: 2,
  minDeadlineMs: 10,
  maxDeadlineMs: 1_000,
  maxClockSkewMs: 5,
  idleScopeTtlMs: 100,
  criticalReserve: 1,
} as const;

describe('RuntimeDeadlineGovernor', () => {
  it('admits a bounded lease without retaining caller payloads', () => {
    const time = clock();
    const governor = new RuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'map.render', priority: 'interactive', deadlineMs: 100 });
    expect(lease).toEqual({
      id: '1:1:map.render',
      scope: 'map.render',
      priority: 'interactive',
      generation: 1,
      startedAt: 1_000,
      expiresAt: 1_100,
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(governor.snapshot()).toMatchObject({ active: 1, scopes: 1, interactive: 1 });
  });

  it('completes a lease exactly once', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'search', priority: 'interactive', deadlineMs: 50 });
    expect(lease).not.toBeNull();
    expect(governor.complete(lease!)).toBe(true);
    expect(governor.complete(lease!)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, completed: 1 });
  });

  it('cancels a lease exactly once', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'search', priority: 'background', deadlineMs: 50 })!;
    expect(governor.cancel(lease)).toBe(true);
    expect(governor.cancel(lease)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, cancelled: 1 });
  });

  it('expires work deterministically at its deadline', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'scene', priority: 'critical', deadlineMs: 20 })!;
    time.advance(19);
    expect(governor.isActive(lease)).toBe(true);
    time.advance(1);
    expect(governor.isActive(lease)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, expired: 1 });
  });

  it('reports bounded remaining time', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'scene', priority: 'interactive', deadlineMs: 100 })!;
    expect(governor.remainingMs(lease)).toBe(100);
    time.advance(35);
    expect(governor.remainingMs(lease)).toBe(65);
    time.advance(65);
    expect(governor.remainingMs(lease)).toBeNull();
  });

  it('renews active leases relative to current monotonic time', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'scene', priority: 'interactive', deadlineMs: 100 })!;
    time.advance(40);
    const renewed = governor.renew(lease, 200);
    expect(renewed?.expiresAt).toBe(1_240);
    expect(governor.isActive(lease)).toBe(false);
    expect(governor.isActive(renewed!)).toBe(true);
  });

  it('does not renew an expired lease', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'scene', priority: 'interactive', deadlineMs: 10 })!;
    time.advance(11);
    expect(governor.renew(lease, 20)).toBeNull();
    expect(governor.snapshot().expired).toBe(1);
  });

  it('reserves global capacity for critical work', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    expect(governor.acquire({ scope: 'a', priority: 'background', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'b', priority: 'interactive', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'c', priority: 'background', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'd', priority: 'interactive', deadlineMs: 100 })).toBeNull();
    expect(governor.acquire({ scope: 'd', priority: 'critical', deadlineMs: 100 })).not.toBeNull();
    expect(governor.snapshot()).toMatchObject({ active: 4, rejected: 1, critical: 1 });
  });

  it('enforces per-scope concurrency', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    expect(governor.acquire({ scope: 'same', priority: 'critical', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'same', priority: 'critical', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'same', priority: 'critical', deadlineMs: 100 })).toBeNull();
    expect(governor.snapshot().rejected).toBe(1);
  });

  it('rejects unsafe scope identifiers', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    for (const scope of ['', ' bad', '../secret', 'a/b', 'x'.repeat(97)]) {
      expect(() => governor.acquire({ scope, priority: 'interactive', deadlineMs: 100 })).toThrow(TypeError);
    }
  });

  it('rejects unsupported priorities at runtime', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    expect(() => governor.acquire({
      scope: 'safe',
      priority: 'urgent' as never,
      deadlineMs: 100,
    })).toThrow(TypeError);
  });

  it('rejects non-integer, short and oversized deadlines', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    for (const deadlineMs of [0, 9, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs })).toThrow();
    }
    expect(() => governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 1_001 })).toThrow(RangeError);
  });

  it('rejects malformed policy values', () => {
    expect(() => new RuntimeDeadlineGovernor({ maxScopes: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ maxActiveGlobal: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ maxActivePerScope: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ minDeadlineMs: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ maxDeadlineMs: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ idleScopeTtlMs: 0 })).toThrow(TypeError);
    expect(() => new RuntimeDeadlineGovernor({ criticalReserve: -1 })).toThrow(TypeError);
  });

  it('rejects contradictory policy values', () => {
    expect(() => new RuntimeDeadlineGovernor({ minDeadlineMs: 100, maxDeadlineMs: 10 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineGovernor({ maxActiveGlobal: 2, maxActivePerScope: 3 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineGovernor({ maxActiveGlobal: 2, criticalReserve: 2 })).toThrow(RangeError);
  });

  it('fails closed on an invalid clock', () => {
    expect(() => new RuntimeDeadlineGovernor(policy, () => Number.NaN)).toThrow();
    expect(() => new RuntimeDeadlineGovernor(policy, () => -1)).toThrow();
  });

  it('tolerates bounded clock skew without extending time', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    time.advance(20);
    expect(governor.remainingMs(lease)).toBe(80);
    time.set(1_017);
    expect(governor.remainingMs(lease)).toBe(80);
  });

  it('fails closed when clock skew exceeds policy', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 });
    time.advance(20);
    governor.sweep();
    time.set(1_010);
    expect(() => governor.sweep()).toThrow(/clock moved backwards/);
  });

  it('rejects forged lease ids', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    const forged = { ...lease, id: `${lease.id}:forged` };
    expect(governor.complete(forged)).toBe(false);
    expect(governor.isActive(lease)).toBe(true);
  });

  it('rejects forged scope metadata', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    expect(governor.cancel({ ...lease, scope: 'other' })).toBe(false);
    expect(governor.isActive(lease)).toBe(true);
  });

  it('rejects forged priority metadata', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    expect(governor.complete({ ...lease, priority: 'background' })).toBe(false);
  });

  it('rejects forged expiry metadata', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    expect(governor.complete({ ...lease, expiresAt: lease.expiresAt + 1 })).toBe(false);
  });

  it('rejects forged start metadata', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    expect(governor.complete({ ...lease, startedAt: lease.startedAt + 1 })).toBe(false);
  });

  it('invalidates stale leases after scope reset', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const first = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    const second = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    expect(governor.resetScope('safe')).toBe(2);
    expect(governor.isActive(first)).toBe(false);
    expect(governor.isActive(second)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, cancelled: 2, generation: 2 });
  });

  it('returns zero when resetting an absent scope', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    expect(governor.resetScope('absent')).toBe(0);
  });

  it('evicts idle scopes after retention TTL', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'old', priority: 'critical', deadlineMs: 50 })!;
    expect(governor.complete(lease)).toBe(true);
    expect(governor.snapshot().scopes).toBe(1);
    time.advance(100);
    expect(governor.sweep()).toBe(0);
    expect(governor.snapshot().scopes).toBe(0);
  });

  it('evicts the oldest empty scope to admit a new scope at cardinality', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor({ ...policy, maxScopes: 2 }, time.now);
    const a = governor.acquire({ scope: 'a', priority: 'critical', deadlineMs: 50 })!;
    governor.complete(a);
    time.advance(1);
    const b = governor.acquire({ scope: 'b', priority: 'critical', deadlineMs: 50 })!;
    governor.complete(b);
    time.advance(1);
    expect(governor.acquire({ scope: 'c', priority: 'critical', deadlineMs: 50 })).not.toBeNull();
    expect(governor.snapshot().scopes).toBe(2);
  });

  it('refuses a new scope when all scope slots are active', () => {
    const governor = createRuntimeDeadlineGovernor({ ...policy, maxScopes: 2 }, clock().now);
    expect(governor.acquire({ scope: 'a', priority: 'critical', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'b', priority: 'critical', deadlineMs: 100 })).not.toBeNull();
    expect(governor.acquire({ scope: 'c', priority: 'critical', deadlineMs: 100 })).toBeNull();
    expect(governor.snapshot().rejected).toBe(1);
  });

  it('sweeps multiple expired leases in one deterministic pass', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    governor.acquire({ scope: 'a', priority: 'critical', deadlineMs: 10 });
    governor.acquire({ scope: 'b', priority: 'critical', deadlineMs: 20 });
    governor.acquire({ scope: 'c', priority: 'critical', deadlineMs: 30 });
    time.advance(20);
    expect(governor.sweep()).toBe(2);
    expect(governor.snapshot()).toMatchObject({ active: 1, expired: 2 });
  });

  it('does not expose identifiers through aggregate diagnostics', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    governor.acquire({ scope: 'private.scope', priority: 'critical', deadlineMs: 100 });
    const serialized = JSON.stringify(governor.snapshot());
    expect(serialized).not.toContain('private.scope');
    expect(serialized).not.toContain('1:1:');
  });

  it('keeps outcome counters stable under stale handle replay', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    governor.complete(lease);
    for (let i = 0; i < 20; i += 1) {
      expect(governor.complete(lease)).toBe(false);
      expect(governor.cancel(lease)).toBe(false);
    }
    expect(governor.snapshot()).toMatchObject({ completed: 1, cancelled: 0 });
  });

  it('disposes terminally and clears retained state', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    governor.dispose();
    expect(governor.snapshot()).toMatchObject({ active: 0, scopes: 0, disposed: true, generation: 2 });
    expect(governor.isActive(lease)).toBe(false);
    expect(governor.remainingMs(lease)).toBeNull();
    expect(governor.complete(lease)).toBe(false);
    expect(governor.cancel(lease)).toBe(false);
    expect(() => governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })).toThrow(/disposed/);
  });

  it('makes repeated disposal idempotent', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    governor.dispose();
    const generation = governor.snapshot().generation;
    governor.dispose();
    expect(governor.snapshot().generation).toBe(generation);
  });

  it('keeps returned leases detached from internal renewal state', () => {
    const time = clock();
    const governor = createRuntimeDeadlineGovernor(policy, time.now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    time.advance(10);
    const renewed = governor.renew(lease, 200)!;
    expect(lease.expiresAt).toBe(1_100);
    expect(renewed.expiresAt).toBe(1_210);
    expect(Object.isFrozen(renewed)).toBe(true);
  });

  it('never mutates caller lease objects', () => {
    const governor = createRuntimeDeadlineGovernor(policy, clock().now);
    const lease = governor.acquire({ scope: 'safe', priority: 'critical', deadlineMs: 100 })!;
    const copy: RuntimeDeadlineLease = { ...lease };
    governor.complete(copy);
    expect(copy).toEqual(lease);
  });
});
