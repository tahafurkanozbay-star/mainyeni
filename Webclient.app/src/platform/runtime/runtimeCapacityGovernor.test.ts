import { describe, expect, it } from 'vitest';
import { RuntimeCapacityGovernor } from './runtimeCapacityGovernor';

function harness(policy: ConstructorParameters<typeof RuntimeCapacityGovernor>[0]['policy'] = {}) {
  let now = 0;
  const governor = new RuntimeCapacityGovernor({ now: () => now, policy: { maxScopes: 3, maxActivePerScope: 3, maxActiveGlobal: 4, maxUnitsGlobal: 8, maxBytesGlobal: 100, maxLeaseAgeMs: 50, maxIdentifierLength: 32, criticalReserve: 1, ...policy } });
  return { governor, setNow: (value: number) => { now = value; } };
}

describe('RuntimeCapacityGovernor', () => {
  it('admits normalized bounded scalar work', () => {
    const { governor } = harness();
    const decision = governor.admit({ scope: ' Map:View ', key: ' Query-1 ', units: 2, bytes: 10 });
    expect(decision.accepted).toBe(true);
    expect(decision.reason).toBe('admitted');
    expect(decision.lease).toEqual({ scope: 'map:view', key: 'query-1', priority: 'normal', generation: 1, units: 2, bytes: 10, admittedAt: 0, expiresAt: 50 });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.lease)).toBe(true);
  });

  it('rejects unsafe and empty identifiers without allocating scopes', () => {
    const { governor } = harness();
    expect(governor.admit({ scope: '', key: 'x' }).reason).toBe('invalid');
    expect(governor.admit({ scope: '<script>', key: 'x' }).reason).toBe('invalid');
    expect(governor.admit({ scope: 'safe', key: 'bad key' }).reason).toBe('invalid');
    expect(governor.snapshot().scopeCount).toBe(0);
  });

  it('rejects identifiers above configured length', () => {
    const { governor } = harness({ maxIdentifierLength: 4 });
    expect(governor.admit({ scope: 'abcde', key: 'x' }).reason).toBe('invalid');
    expect(governor.admit({ scope: 'abc', key: 'abcde' }).reason).toBe('invalid');
  });

  it('defaults malformed priority to normal', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'b', priority: 'wat' as never }).lease!;
    expect(lease.priority).toBe('normal');
  });

  it('defaults omitted accounting to one unit and zero bytes', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'b' }).lease!;
    expect(lease.units).toBe(1);
    expect(lease.bytes).toBe(0);
  });

  it('rejects a duplicate active key within a scope', () => {
    const { governor } = harness();
    expect(governor.admit({ scope: 'a', key: 'same' }).accepted).toBe(true);
    expect(governor.admit({ scope: 'a', key: 'same' }).reason).toBe('invalid');
    expect(governor.snapshot().active).toBe(1);
  });

  it('enforces per-scope active capacity', () => {
    const { governor } = harness({ maxActivePerScope: 2 });
    governor.admit({ scope: 'a', key: '1' });
    governor.admit({ scope: 'a', key: '2' });
    expect(governor.admit({ scope: 'a', key: '3' }).reason).toBe('scope-capacity');
    expect(governor.admit({ scope: 'b', key: '1' }).accepted).toBe(true);
  });

  it('reserves global slots for critical work', () => {
    const { governor } = harness({ maxActiveGlobal: 3, criticalReserve: 1 });
    governor.admit({ scope: 'a', key: '1' });
    governor.admit({ scope: 'a', key: '2' });
    expect(governor.admit({ scope: 'b', key: 'normal' }).reason).toBe('global-capacity');
    expect(governor.admit({ scope: 'b', key: 'critical', priority: 'critical' }).accepted).toBe(true);
    expect(governor.admit({ scope: 'c', key: 'critical', priority: 'critical' }).reason).toBe('global-capacity');
  });

  it('allows critical reserve to consume the whole global limit when configured', () => {
    const { governor } = harness({ maxActiveGlobal: 2, criticalReserve: 99 });
    expect(governor.admit({ scope: 'a', key: 'normal' }).reason).toBe('global-capacity');
    expect(governor.admit({ scope: 'a', key: 'c1', priority: 'critical' }).accepted).toBe(true);
    expect(governor.admit({ scope: 'a', key: 'c2', priority: 'critical' }).accepted).toBe(true);
  });

  it('enforces aggregate unit capacity', () => {
    const { governor } = harness({ maxUnitsGlobal: 3 });
    governor.admit({ scope: 'a', key: '1', units: 2 });
    expect(governor.admit({ scope: 'b', key: '2', units: 2 }).reason).toBe('unit-capacity');
    expect(governor.admit({ scope: 'b', key: '3', units: 1 }).accepted).toBe(true);
  });

  it('enforces aggregate byte capacity', () => {
    const { governor } = harness({ maxBytesGlobal: 10 });
    governor.admit({ scope: 'a', key: '1', bytes: 7 });
    expect(governor.admit({ scope: 'b', key: '2', bytes: 4 }).reason).toBe('byte-capacity');
    expect(governor.admit({ scope: 'b', key: '3', bytes: 3 }).accepted).toBe(true);
  });

  it('rejects a single request larger than total budgets as invalid', () => {
    const { governor } = harness({ maxUnitsGlobal: 4, maxBytesGlobal: 10 });
    expect(governor.admit({ scope: 'a', key: 'u', units: 5 }).reason).toBe('invalid');
    expect(governor.admit({ scope: 'a', key: 'b', bytes: 11 }).reason).toBe('invalid');
  });

  it('releases capacity exactly once', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'x', units: 2, bytes: 20 }).lease!;
    expect(governor.release(lease)).toBe(true);
    expect(governor.release(lease)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 0, units: 0, bytes: 0 });
  });

  it('cancels capacity exactly once', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'x' }).lease!;
    expect(governor.cancel(lease)).toBe(true);
    expect(governor.cancel(lease)).toBe(false);
  });

  it('expires leases at their deadline', () => {
    const { governor, setNow } = harness({ maxLeaseAgeMs: 10 });
    governor.admit({ scope: 'a', key: 'x' });
    setNow(9);
    expect(governor.sweep()).toBe(0);
    setNow(10);
    expect(governor.sweep()).toBe(1);
    expect(governor.snapshot().active).toBe(0);
  });

  it('sweep can use an explicit deterministic timestamp', () => {
    const { governor } = harness({ maxLeaseAgeMs: 10 });
    governor.admit({ scope: 'a', key: 'x' });
    expect(governor.sweep(10)).toBe(1);
  });

  it('rejects settlement after lease expiry', () => {
    const { governor, setNow } = harness({ maxLeaseAgeMs: 10 });
    const lease = governor.admit({ scope: 'a', key: 'x' }).lease!;
    setNow(10);
    expect(governor.release(lease)).toBe(false);
    expect(governor.snapshot().active).toBe(0);
  });

  it('renews a lease from the current clock', () => {
    const { governor, setNow } = harness({ maxLeaseAgeMs: 10 });
    const lease = governor.admit({ scope: 'a', key: 'x' }).lease!;
    setNow(5);
    const renewed = governor.renew(lease)!;
    expect(renewed.admittedAt).toBe(5);
    expect(renewed.expiresAt).toBe(15);
    expect(governor.release(renewed)).toBe(true);
  });

  it('invalidates the previous lease after renewal', () => {
    const { governor, setNow } = harness();
    const oldLease = governor.admit({ scope: 'a', key: 'x' }).lease!;
    setNow(1);
    const renewed = governor.renew(oldLease)!;
    expect(governor.release(oldLease)).toBe(false);
    expect(governor.release(renewed)).toBe(true);
  });

  it('rejects forged accounting fields during settlement', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'x', units: 2, bytes: 10 }).lease!;
    expect(governor.release({ ...lease, units: 1 })).toBe(false);
    expect(governor.release({ ...lease, bytes: 9 })).toBe(false);
    expect(governor.release(lease)).toBe(true);
  });

  it('rejects forged timing and priority fields during settlement', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'x', priority: 'critical' }).lease!;
    expect(governor.release({ ...lease, admittedAt: 1 })).toBe(false);
    expect(governor.release({ ...lease, expiresAt: 1 })).toBe(false);
    expect(governor.release({ ...lease, priority: 'normal' })).toBe(false);
  });

  it('reset invalidates outstanding generation leases', () => {
    const { governor } = harness();
    const stale = governor.admit({ scope: 'a', key: 'x' }).lease!;
    expect(governor.resetScope('a')).toBe(true);
    expect(governor.release(stale)).toBe(false);
    const fresh = governor.admit({ scope: 'a', key: 'x' }).lease!;
    expect(fresh.generation).toBeGreaterThan(stale.generation);
  });

  it('reset rejects unknown and unsafe scopes', () => {
    const { governor } = harness();
    expect(governor.resetScope('missing')).toBe(false);
    expect(governor.resetScope('bad scope')).toBe(false);
  });

  it('retire removes a scope and its leases', () => {
    const { governor } = harness();
    const stale = governor.admit({ scope: 'a', key: 'x' }).lease!;
    expect(governor.retireScope('a')).toBe(true);
    expect(governor.snapshot().scopeCount).toBe(0);
    expect(governor.release(stale)).toBe(false);
  });

  it('recreated retired scope advances generation', () => {
    const { governor } = harness();
    const first = governor.admit({ scope: 'a', key: 'x' }).lease!;
    governor.retireScope('a');
    const second = governor.admit({ scope: 'a', key: 'x' }).lease!;
    expect(second.generation).toBe(first.generation + 1);
  });

  it('evicts least-recently-touched empty scope at scope capacity', () => {
    const { governor, setNow } = harness({ maxScopes: 2 });
    const a = governor.admit({ scope: 'alpha', key: 'x' }).lease!;
    governor.release(a);
    setNow(2);
    const b = governor.admit({ scope: 'beta', key: 'x' }).lease!;
    governor.release(b);
    setNow(3);
    expect(governor.admit({ scope: 'gamma', key: 'x' }).accepted).toBe(true);
    expect(governor.snapshot().scopes.map(scope => scope.scope)).toEqual(['beta', 'gamma']);
  });

  it('uses lexical order to evict same-time empty scopes deterministically', () => {
    const { governor } = harness({ maxScopes: 2 });
    const beta = governor.admit({ scope: 'beta', key: 'x' }).lease!;
    governor.release(beta);
    const alpha = governor.admit({ scope: 'alpha', key: 'x' }).lease!;
    governor.release(alpha);
    governor.admit({ scope: 'gamma', key: 'x' });
    expect(governor.snapshot().scopes.map(scope => scope.scope)).toEqual(['beta', 'gamma']);
  });

  it('never evicts a scope with an active lease', () => {
    const { governor } = harness({ maxScopes: 2 });
    governor.admit({ scope: 'alpha', key: 'x' });
    governor.admit({ scope: 'beta', key: 'x' });
    expect(governor.admit({ scope: 'gamma', key: 'x' }).reason).toBe('scope-capacity');
    expect(governor.snapshot().scopeCount).toBe(2);
  });

  it('can reuse an expired scope slot after sweep', () => {
    const { governor, setNow } = harness({ maxScopes: 1, maxLeaseAgeMs: 10 });
    governor.admit({ scope: 'alpha', key: 'x' });
    setNow(10);
    expect(governor.admit({ scope: 'beta', key: 'x' }).accepted).toBe(true);
    expect(governor.snapshot().scopes[0]?.scope).toBe('beta');
  });

  it('reports deterministic frozen diagnostics', () => {
    const { governor } = harness();
    governor.admit({ scope: 'zeta', key: '1', priority: 'background', units: 2, bytes: 4 });
    governor.admit({ scope: 'alpha', key: '1', priority: 'critical', units: 3, bytes: 6 });
    const snapshot = governor.snapshot();
    expect(snapshot).toMatchObject({ scopeCount: 2, active: 2, units: 5, bytes: 10 });
    expect(snapshot.scopes.map(scope => scope.scope)).toEqual(['alpha', 'zeta']);
    expect(snapshot.scopes[0]).toMatchObject({ critical: 1, normal: 0, background: 0 });
    expect(snapshot.scopes[1]).toMatchObject({ critical: 0, normal: 0, background: 1 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes[0])).toBe(true);
  });

  it('does not retain request objects in diagnostics', () => {
    const { governor } = harness();
    const request = { scope: 'a', key: 'x', units: 1, bytes: 1, extra: { secret: 'never-retain' } };
    governor.admit(request);
    expect(JSON.stringify(governor.snapshot())).not.toContain('never-retain');
  });

  it('normalizes invalid clocks to zero', () => {
    const governor = new RuntimeCapacityGovernor({ now: () => Number.NaN });
    expect(governor.admit({ scope: 'a', key: 'x' }).lease?.admittedAt).toBe(0);
    expect(governor.snapshot().scopes[0]?.lastTouchedAt).toBe(0);
  });

  it('normalizes negative clocks to zero', () => {
    const governor = new RuntimeCapacityGovernor({ now: () => -100 });
    expect(governor.admit({ scope: 'a', key: 'x' }).lease?.admittedAt).toBe(0);
  });

  it('normalizes unsafe policy values to defaults', () => {
    const governor = new RuntimeCapacityGovernor({ policy: { maxScopes: 0, maxActivePerScope: Number.NaN, maxActiveGlobal: -1, maxUnitsGlobal: 0, maxBytesGlobal: -1, maxLeaseAgeMs: 0, maxIdentifierLength: 0, criticalReserve: -1 } });
    expect(governor.policy.maxScopes).toBeGreaterThan(0);
    expect(governor.policy.maxActivePerScope).toBeGreaterThan(0);
    expect(governor.policy.maxActiveGlobal).toBeGreaterThan(0);
    expect(governor.policy.maxUnitsGlobal).toBeGreaterThan(0);
    expect(governor.policy.maxBytesGlobal).toBeGreaterThan(0);
    expect(governor.policy.maxLeaseAgeMs).toBeGreaterThan(0);
    expect(governor.policy.maxIdentifierLength).toBeGreaterThan(0);
    expect(governor.policy.criticalReserve).toBeGreaterThanOrEqual(0);
  });

  it('dispose is terminal and idempotent', () => {
    const { governor } = harness();
    const lease = governor.admit({ scope: 'a', key: 'x' }).lease!;
    governor.dispose();
    governor.dispose();
    expect(governor.snapshot()).toEqual({ disposed: true, scopeCount: 0, active: 0, units: 0, bytes: 0, scopes: [] });
    expect(governor.admit({ scope: 'a', key: 'y' }).reason).toBe('disposed');
    expect(governor.release(lease)).toBe(false);
    expect(governor.renew(lease)).toBeNull();
    expect(governor.resetScope('a')).toBe(false);
    expect(governor.retireScope('a')).toBe(false);
    expect(governor.sweep()).toBe(0);
  });
});
