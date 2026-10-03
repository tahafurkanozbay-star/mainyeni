import { describe, expect, it } from 'vitest';
import {
  RuntimeAdmissionLedger,
  createRuntimeAdmissionLedger,
  type RuntimeAdmissionLease,
} from './runtimeAdmissionLedger';

function harness(
  policy: ConstructorParameters<typeof RuntimeAdmissionLedger>[0]['policy'] = {},
) {
  let now = 0;
  const ledger = new RuntimeAdmissionLedger({ policy, now: () => now });
  return {
    ledger,
    now: () => now,
    setNow: (value: number) => { now = value; },
    advance: (value: number) => { now += value; },
  };
}

function leaseOf(
  decision: ReturnType<RuntimeAdmissionLedger['admit']>,
): RuntimeAdmissionLease {
  expect(decision.accepted).toBe(true);
  expect(decision.lease).not.toBeNull();
  return decision.lease!;
}

describe('RuntimeAdmissionLedger', () => {
  it('admits normalized scalar work without retaining request identity', () => {
    const { ledger } = harness();
    const request = { scope: ' Map:Primary ', key: ' Query-1 ', lane: 'critical' as const };
    const admitted = ledger.admit(request);
    expect(admitted.reason).toBe('admitted');
    expect(admitted.lease).toEqual({
      scope: 'map:primary',
      key: 'query-1',
      lane: 'critical',
      generation: 1,
      admittedAt: 0,
      expiresAt: 30_000,
    });
    expect(admitted.lease).not.toBe(request);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.lease)).toBe(true);
  });

  it('uses interactive as the safe default lane', () => {
    const { ledger } = harness();
    expect(leaseOf(ledger.admit({ scope: 'map', key: 'a' })).lane).toBe('interactive');
    expect(leaseOf(ledger.admit({ scope: 'map', key: 'b', lane: 'unknown' as never })).lane)
      .toBe('interactive');
  });

  it('rejects empty, malformed and oversized identifiers', () => {
    const { ledger } = harness({ maxIdentifierLength: 8 });
    expect(ledger.admit({ scope: '', key: 'a' }).reason).toBe('invalid');
    expect(ledger.admit({ scope: 'map', key: '' }).reason).toBe('invalid');
    expect(ledger.admit({ scope: 'map!', key: 'a' }).reason).toBe('invalid');
    expect(ledger.admit({ scope: 'map', key: 'a b' }).reason).toBe('invalid');
    expect(ledger.admit({ scope: '123456789', key: 'a' }).reason).toBe('invalid');
    expect(ledger.snapshot().scopeCount).toBe(0);
  });

  it('rejects duplicate active keys within a scope', () => {
    const { ledger } = harness();
    leaseOf(ledger.admit({ scope: 'map', key: 'same' }));
    expect(ledger.admit({ scope: 'map', key: 'same' })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
      lease: null,
    });
  });

  it('allows equal keys in independent scopes', () => {
    const { ledger } = harness();
    expect(ledger.admit({ scope: 'a', key: 'same' }).accepted).toBe(true);
    expect(ledger.admit({ scope: 'b', key: 'same' }).accepted).toBe(true);
    expect(ledger.snapshot().active).toBe(2);
  });

  it('enforces global active capacity', () => {
    const { ledger } = harness({
      maxActiveGlobal: 2,
      maxActivePerScope: 2,
      maxActiveBackground: 2,
      maxActiveInteractive: 2,
      maxActiveCritical: 2,
    });
    leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    leaseOf(ledger.admit({ scope: 'b', key: '2' }));
    expect(ledger.admit({ scope: 'c', key: '3' }).reason).toBe('global-capacity');
  });

  it('enforces per-scope active capacity', () => {
    const { ledger } = harness({ maxActivePerScope: 1 });
    leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.admit({ scope: 'map', key: '2' }).reason).toBe('scope-capacity');
    expect(ledger.admit({ scope: 'other', key: '2' }).accepted).toBe(true);
  });

  it('enforces background lane capacity independently', () => {
    const { ledger } = harness({ maxActiveBackground: 1 });
    leaseOf(ledger.admit({ scope: 'a', key: '1', lane: 'background' }));
    expect(ledger.admit({ scope: 'b', key: '2', lane: 'background' }).reason)
      .toBe('lane-capacity');
    expect(ledger.admit({ scope: 'b', key: '3', lane: 'interactive' }).accepted).toBe(true);
  });

  it('enforces interactive lane capacity independently', () => {
    const { ledger } = harness({ maxActiveInteractive: 1 });
    leaseOf(ledger.admit({ scope: 'a', key: '1', lane: 'interactive' }));
    expect(ledger.admit({ scope: 'b', key: '2', lane: 'interactive' }).reason)
      .toBe('lane-capacity');
    expect(ledger.admit({ scope: 'b', key: '3', lane: 'critical' }).accepted).toBe(true);
  });

  it('enforces critical lane capacity independently', () => {
    const { ledger } = harness({ maxActiveCritical: 1 });
    leaseOf(ledger.admit({ scope: 'a', key: '1', lane: 'critical' }));
    expect(ledger.admit({ scope: 'b', key: '2', lane: 'critical' }).reason)
      .toBe('lane-capacity');
    expect(ledger.admit({ scope: 'b', key: '3', lane: 'interactive' }).accepted).toBe(true);
  });

  it('releases capacity after successful settlement', () => {
    const { ledger } = harness({ maxActiveGlobal: 1 });
    const first = leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    expect(ledger.admit({ scope: 'b', key: '2' }).accepted).toBe(false);
    expect(ledger.settle(first, 'success')).toBe(true);
    expect(ledger.admit({ scope: 'b', key: '2' }).accepted).toBe(true);
  });

  it('treats cancellation as health-neutral settlement', () => {
    const { ledger } = harness({ maxFailuresInWindow: 1 });
    const active = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.settle(active, 'cancelled')).toBe(true);
    const snapshot = ledger.snapshot().scopes[0]!;
    expect(snapshot.failuresInWindow).toBe(0);
    expect(snapshot.cooldownUntil).toBe(0);
  });

  it('records failures in the rolling failure window', () => {
    const { ledger, advance } = harness({ maxFailuresInWindow: 3 });
    const first = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(first, 'failure');
    advance(10);
    const second = leaseOf(ledger.admit({ scope: 'map', key: '2' }));
    ledger.settle(second, 'timeout');
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(2);
  });

  it('opens cooldown after the configured failure threshold', () => {
    const { ledger, advance } = harness({
      maxFailuresInWindow: 2,
      failureWindowMs: 100,
      cooldownMs: 50,
    });
    const first = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(first, 'failure');
    advance(1);
    const second = leaseOf(ledger.admit({ scope: 'map', key: '2' }));
    ledger.settle(second, 'timeout');
    expect(ledger.snapshot().scopes[0]!.cooldownUntil).toBe(51);
    expect(ledger.admit({ scope: 'map', key: '3' }).reason).toBe('cooldown');
  });

  it('allows critical recovery work through cooldown by default', () => {
    const { ledger } = harness({ maxFailuresInWindow: 1, cooldownMs: 100 });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    expect(ledger.admit({ scope: 'map', key: 'normal' }).reason).toBe('cooldown');
    expect(ledger.admit({ scope: 'map', key: 'recovery', lane: 'critical' }).accepted)
      .toBe(true);
  });

  it('can disable critical cooldown bypass', () => {
    const { ledger } = harness({
      maxFailuresInWindow: 1,
      cooldownMs: 100,
      criticalBypassesCooldown: false,
    });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    expect(ledger.admit({ scope: 'map', key: 'recovery', lane: 'critical' }).reason)
      .toBe('cooldown');
  });

  it('expires cooldown independently from the failure retention window', () => {
    const { ledger, setNow } = harness({
      maxFailuresInWindow: 1,
      failureWindowMs: 1_000,
      cooldownMs: 50,
    });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    setNow(50);
    expect(ledger.admit({ scope: 'map', key: '2' }).accepted).toBe(true);
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(1);
  });

  it('prunes failures at the rolling-window boundary', () => {
    const { ledger, setNow } = harness({
      maxFailuresInWindow: 2,
      failureWindowMs: 100,
      cooldownMs: 10,
    });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    setNow(100);
    ledger.sweep();
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(0);
  });

  it('expires abandoned leases and reclaims active capacity', () => {
    const { ledger, setNow } = harness({ maxLeaseAgeMs: 25, maxActiveGlobal: 1 });
    leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    setNow(25);
    expect(ledger.sweep()).toBe(1);
    expect(ledger.snapshot().active).toBe(0);
    expect(ledger.admit({ scope: 'b', key: '2' }).accepted).toBe(true);
  });

  it('rejects settlement of an expired lease', () => {
    const { ledger, setNow } = harness({ maxLeaseAgeMs: 10 });
    const expired = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    setNow(10);
    expect(ledger.settle(expired, 'success')).toBe(false);
    expect(ledger.snapshot().active).toBe(0);
  });

  it('renews a live lease with a new time boundary', () => {
    const { ledger, setNow } = harness({ maxLeaseAgeMs: 20 });
    const first = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    setNow(5);
    const renewed = ledger.renew(first)!;
    expect(renewed.admittedAt).toBe(5);
    expect(renewed.expiresAt).toBe(25);
    expect(renewed.generation).toBe(first.generation);
    expect(ledger.settle(first, 'success')).toBe(false);
    expect(ledger.settle(renewed, 'success')).toBe(true);
  });

  it('does not renew expired work', () => {
    const { ledger, setNow } = harness({ maxLeaseAgeMs: 20 });
    const first = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    setNow(20);
    expect(ledger.renew(first)).toBeNull();
  });

  it('rejects forged lease timing metadata', () => {
    const { ledger } = harness();
    const lease = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.settle({ ...lease, expiresAt: lease.expiresAt + 1 }, 'success')).toBe(false);
    expect(ledger.settle({ ...lease, admittedAt: lease.admittedAt + 1 }, 'success')).toBe(false);
    expect(ledger.snapshot().active).toBe(1);
  });

  it('rejects forged lease lane metadata', () => {
    const { ledger } = harness();
    const lease = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.settle({ ...lease, lane: 'critical' }, 'success')).toBe(false);
    expect(ledger.snapshot().active).toBe(1);
  });

  it('invalidates old leases after scope reset', () => {
    const { ledger } = harness();
    const stale = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.resetScope('map')).toBe(true);
    const fresh = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(fresh.generation).toBe(stale.generation + 1);
    expect(ledger.settle(stale, 'success')).toBe(false);
    expect(ledger.settle(fresh, 'success')).toBe(true);
  });

  it('normalizes reset and retire identifiers', () => {
    const { ledger } = harness();
    leaseOf(ledger.admit({ scope: 'Map:Primary', key: '1' }));
    expect(ledger.resetScope(' MAP:PRIMARY ')).toBe(true);
    expect(ledger.retireScope(' map:PRIMARY ')).toBe(true);
    expect(ledger.snapshot().scopeCount).toBe(0);
  });

  it('returns false for reset and retire of unknown scopes', () => {
    const { ledger } = harness();
    expect(ledger.resetScope('unknown')).toBe(false);
    expect(ledger.retireScope('unknown')).toBe(false);
  });

  it('evicts the least-recently-touched inactive scope at capacity', () => {
    const { ledger, advance } = harness({ maxScopes: 2 });
    const a = leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    ledger.settle(a, 'success');
    advance(1);
    const b = leaseOf(ledger.admit({ scope: 'b', key: '1' }));
    ledger.settle(b, 'success');
    advance(1);
    expect(ledger.admit({ scope: 'c', key: '1' }).accepted).toBe(true);
    expect(ledger.snapshot().scopes.map((scope) => scope.scope)).toEqual(['b', 'c']);
  });

  it('uses lexical scope order to break inactive eviction ties', () => {
    const { ledger } = harness({ maxScopes: 2 });
    const b = leaseOf(ledger.admit({ scope: 'b', key: '1' }));
    ledger.settle(b, 'success');
    const a = leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    ledger.settle(a, 'success');
    expect(ledger.admit({ scope: 'c', key: '1' }).accepted).toBe(true);
    expect(ledger.snapshot().scopes.map((scope) => scope.scope)).toEqual(['b', 'c']);
  });

  it('does not evict active scopes to admit a new scope', () => {
    const { ledger } = harness({ maxScopes: 2 });
    leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    leaseOf(ledger.admit({ scope: 'b', key: '1' }));
    expect(ledger.admit({ scope: 'c', key: '1' }).reason).toBe('scope-capacity');
    expect(ledger.snapshot().scopes.map((scope) => scope.scope)).toEqual(['a', 'b']);
  });

  it('does not evict a scope carrying retained failure history', () => {
    const { ledger } = harness({ maxScopes: 1, maxFailuresInWindow: 2 });
    const failed = leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    ledger.settle(failed, 'failure');
    expect(ledger.admit({ scope: 'b', key: '1' }).reason).toBe('scope-capacity');
  });

  it('removes idle empty scopes after their retention age', () => {
    const { ledger, setNow } = harness({ maxIdleScopeAgeMs: 50 });
    const active = leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    ledger.settle(active, 'success');
    setNow(49);
    expect(ledger.sweep()).toBe(0);
    expect(ledger.snapshot().scopeCount).toBe(1);
    setNow(50);
    expect(ledger.sweep()).toBe(1);
    expect(ledger.snapshot().scopeCount).toBe(0);
  });

  it('retains an active scope past idle retention age', () => {
    const { ledger, setNow } = harness({ maxIdleScopeAgeMs: 10, maxLeaseAgeMs: 100 });
    leaseOf(ledger.admit({ scope: 'a', key: '1' }));
    setNow(20);
    expect(ledger.sweep()).toBe(0);
    expect(ledger.snapshot().scopeCount).toBe(1);
  });

  it('snapshot is sorted, frozen and payload-free', () => {
    const { ledger } = harness();
    leaseOf(ledger.admit({ scope: 'z', key: '1', lane: 'critical' }));
    leaseOf(ledger.admit({ scope: 'a', key: '2', lane: 'background' }));
    leaseOf(ledger.admit({ scope: 'a', key: '3', lane: 'interactive' }));
    const snapshot = ledger.snapshot();
    expect(snapshot.scopes.map((scope) => scope.scope)).toEqual(['a', 'z']);
    expect(snapshot).toMatchObject({
      disposed: false,
      scopeCount: 2,
      active: 3,
      background: 1,
      interactive: 1,
      critical: 1,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes)).toBe(true);
    expect(snapshot.scopes.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|callback|payload|credential|url/i);
  });

  it('reports per-scope lane accounting', () => {
    const { ledger } = harness();
    leaseOf(ledger.admit({ scope: 'map', key: 'a', lane: 'background' }));
    leaseOf(ledger.admit({ scope: 'map', key: 'b', lane: 'interactive' }));
    leaseOf(ledger.admit({ scope: 'map', key: 'c', lane: 'critical' }));
    expect(ledger.snapshot().scopes[0]).toMatchObject({
      active: 3,
      background: 1,
      interactive: 1,
      critical: 1,
    });
  });

  it('clamps lane and scope capacities to global capacity', () => {
    const { ledger } = harness({
      maxActiveGlobal: 2,
      maxActivePerScope: 100,
      maxActiveBackground: 100,
      maxActiveInteractive: 100,
      maxActiveCritical: 100,
    });
    expect(ledger.policy.maxActivePerScope).toBe(2);
    expect(ledger.policy.maxActiveBackground).toBe(2);
    expect(ledger.policy.maxActiveInteractive).toBe(2);
    expect(ledger.policy.maxActiveCritical).toBe(2);
  });

  it('falls back from invalid numeric policy values', () => {
    const ledger = new RuntimeAdmissionLedger({
      policy: {
        maxScopes: 0,
        maxActiveGlobal: Number.NaN,
        maxLeaseAgeMs: -1,
        cooldownMs: Number.POSITIVE_INFINITY,
      },
    });
    expect(ledger.policy.maxScopes).toBe(64);
    expect(ledger.policy.maxActiveGlobal).toBe(128);
    expect(ledger.policy.maxLeaseAgeMs).toBe(30_000);
    expect(ledger.policy.cooldownMs).toBe(10_000);
  });

  it('sanitizes a non-finite clock to zero', () => {
    const ledger = new RuntimeAdmissionLedger({ now: () => Number.NaN });
    expect(leaseOf(ledger.admit({ scope: 'map', key: '1' })).admittedAt).toBe(0);
  });

  it('sanitizes a negative clock to zero', () => {
    const ledger = new RuntimeAdmissionLedger({ now: () => -100 });
    expect(leaseOf(ledger.admit({ scope: 'map', key: '1' })).admittedAt).toBe(0);
  });

  it('factory creates an independent ledger', () => {
    const first = createRuntimeAdmissionLedger();
    const second = createRuntimeAdmissionLedger();
    leaseOf(first.admit({ scope: 'map', key: '1' }));
    expect(first.snapshot().active).toBe(1);
    expect(second.snapshot().active).toBe(0);
  });

  it('dispose clears state and is idempotent', () => {
    const { ledger } = harness();
    leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.dispose();
    ledger.dispose();
    expect(ledger.snapshot()).toMatchObject({ disposed: true, scopeCount: 0, active: 0 });
  });

  it('rejects all mutating operations after disposal', () => {
    const { ledger } = harness();
    const lease = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.dispose();
    expect(ledger.admit({ scope: 'map', key: '2' }).reason).toBe('disposed');
    expect(ledger.settle(lease, 'success')).toBe(false);
    expect(ledger.renew(lease)).toBeNull();
    expect(ledger.resetScope('map')).toBe(false);
    expect(ledger.retireScope('map')).toBe(false);
    expect(ledger.sweep()).toBe(0);
  });

  it('does not allow a retired lease to affect a recreated scope', () => {
    const { ledger } = harness();
    const stale = leaseOf(ledger.admit({ scope: 'map', key: 'same' }));
    expect(ledger.retireScope('map')).toBe(true);
    const fresh = leaseOf(ledger.admit({ scope: 'map', key: 'same' }));
    expect(fresh.generation).toBe(stale.generation + 1);
    expect(ledger.settle(stale, 'failure')).toBe(false);
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(0);
    expect(ledger.settle(fresh, 'success')).toBe(true);
  });

  it('does not count success as a new failure', () => {
    const { ledger } = harness({ maxFailuresInWindow: 3 });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    const success = leaseOf(ledger.admit({ scope: 'map', key: '2' }));
    ledger.settle(success, 'success');
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(1);
  });

  it('does not count cancellation as a new failure after a failure', () => {
    const { ledger } = harness({ maxFailuresInWindow: 3 });
    const failed = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(failed, 'failure');
    const cancelled = leaseOf(ledger.admit({ scope: 'map', key: '2' }));
    ledger.settle(cancelled, 'cancelled');
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(1);
  });

  it('extends cooldown when failures continue through critical recovery work', () => {
    const { ledger, setNow } = harness({
      maxFailuresInWindow: 1,
      cooldownMs: 100,
      failureWindowMs: 1_000,
    });
    const first = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.settle(first, 'failure');
    setNow(50);
    const recovery = leaseOf(ledger.admit({ scope: 'map', key: '2', lane: 'critical' }));
    ledger.settle(recovery, 'failure');
    expect(ledger.snapshot().scopes[0]!.cooldownUntil).toBe(150);
  });

  it('sweep accepts an explicit deterministic timestamp', () => {
    const { ledger } = harness({ maxLeaseAgeMs: 10 });
    leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.sweep(9)).toBe(0);
    expect(ledger.sweep(10)).toBe(1);
  });

  it('sweep sanitizes invalid explicit timestamps', () => {
    const { ledger } = harness({ maxLeaseAgeMs: 10 });
    leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    expect(ledger.sweep(Number.NaN)).toBe(0);
    expect(ledger.snapshot().active).toBe(1);
  });

  it('preserves active accounting when a forged settlement is rejected', () => {
    const { ledger } = harness();
    const lease = leaseOf(ledger.admit({ scope: 'map', key: '1', lane: 'background' }));
    expect(ledger.settle({ ...lease, generation: 999 }, 'failure')).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ active: 1, background: 1 });
    expect(ledger.snapshot().scopes[0]!.failuresInWindow).toBe(0);
  });

  it('keeps generations monotonic across repeated retirement', () => {
    const { ledger } = harness();
    const one = leaseOf(ledger.admit({ scope: 'map', key: '1' }));
    ledger.retireScope('map');
    const two = leaseOf(ledger.admit({ scope: 'map', key: '2' }));
    ledger.retireScope('map');
    const three = leaseOf(ledger.admit({ scope: 'map', key: '3' }));
    expect([one.generation, two.generation, three.generation]).toEqual([1, 2, 3]);
  });
});
