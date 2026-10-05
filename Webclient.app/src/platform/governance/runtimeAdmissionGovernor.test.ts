import { describe, expect, it } from 'vitest';
import { RuntimeAdmissionGovernor, type RuntimeAdmissionTicket } from './runtimeAdmissionGovernor';

function clock(initial = 0) {
  let now = initial;
  return { now: () => now, set: (value: number) => { now = value; }, advance: (value: number) => { now += value; } };
}

describe('RuntimeAdmissionGovernor', () => {
  it('admits and releases bounded units', () => {
    const time = clock();
    const governor = new RuntimeAdmissionGovernor({ criticalReserveUnits: 0 }, time.now);
    const ticket = governor.admit({ scope: 'map', priority: 'interactive', resource: 'cpu', units: 4 })!;
    expect(governor.snapshot()).toMatchObject({ tickets: 1, units: 4, cpuUnits: 4, admitted: 1 });
    expect(governor.release(ticket)).toBe(true);
    expect(governor.snapshot()).toMatchObject({ tickets: 0, units: 0, released: 1 });
  });

  it('reserves global units for critical work', () => {
    const governor = new RuntimeAdmissionGovernor({ maxUnitsGlobal: 10, maxUnitsPerScope: 10, maxUnitsPerTicket: 10, criticalReserveUnits: 2 });
    expect(governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units: 8 })).not.toBeNull();
    expect(governor.admit({ scope: 'b', priority: 'interactive', resource: 'cpu', units: 1 })).toBeNull();
    expect(governor.admit({ scope: 'b', priority: 'critical', resource: 'cpu', units: 2 })).not.toBeNull();
  });

  it('bounds per-scope units', () => {
    const governor = new RuntimeAdmissionGovernor({ maxUnitsGlobal: 20, maxUnitsPerScope: 5, maxUnitsPerTicket: 5, criticalReserveUnits: 0 });
    expect(governor.admit({ scope: 'map', priority: 'critical', resource: 'gpu', units: 5 })).not.toBeNull();
    expect(governor.admit({ scope: 'map', priority: 'critical', resource: 'gpu', units: 1 })).toBeNull();
  });

  it('bounds global ticket cardinality', () => {
    const governor = new RuntimeAdmissionGovernor({ maxTicketsGlobal: 1, maxTicketsPerScope: 1, criticalReserveUnits: 0 });
    expect(governor.admit({ scope: 'a', priority: 'interactive', resource: 'network', units: 1 })).not.toBeNull();
    expect(governor.admit({ scope: 'b', priority: 'interactive', resource: 'network', units: 1 })).toBeNull();
  });

  it('bounds per-scope ticket cardinality', () => {
    const governor = new RuntimeAdmissionGovernor({ maxTicketsGlobal: 4, maxTicketsPerScope: 1, criticalReserveUnits: 0 });
    expect(governor.admit({ scope: 'a', priority: 'interactive', resource: 'network', units: 1 })).not.toBeNull();
    expect(governor.admit({ scope: 'a', priority: 'interactive', resource: 'network', units: 1 })).toBeNull();
  });

  it('expires tickets deterministically', () => {
    const time = clock();
    const governor = new RuntimeAdmissionGovernor({ ticketTtlMs: 10, criticalReserveUnits: 0 }, time.now);
    const ticket = governor.admit({ scope: 'a', priority: 'background', resource: 'memory', units: 3 })!;
    time.set(9); expect(governor.isActive(ticket)).toBe(true);
    time.set(10); expect(governor.isActive(ticket)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ expired: 1, units: 0 });
  });

  it('renews a live ticket with detached identity', () => {
    const time = clock();
    const governor = new RuntimeAdmissionGovernor({ ticketTtlMs: 10 }, time.now);
    const ticket = governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units: 1 })!;
    time.set(5); const renewed = governor.renew(ticket)!;
    expect(renewed.expiresAt).toBe(15);
    expect(renewed).not.toBe(ticket);
    expect(Object.isFrozen(renewed)).toBe(true);
    expect(governor.release(ticket)).toBe(false);
    expect(governor.release(renewed)).toBe(true);
  });

  it('rejects forged tickets', () => {
    const governor = new RuntimeAdmissionGovernor();
    const ticket = governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units: 1 })!;
    expect(governor.release({ ...ticket, units: 2 })).toBe(false);
    expect(governor.release({ ...ticket, resource: 'gpu' })).toBe(false);
    expect(governor.release({ ...ticket, scope: 'b' })).toBe(false);
    expect(governor.isActive(ticket)).toBe(true);
  });

  it('rejects stale tickets after scope reset', () => {
    const governor = new RuntimeAdmissionGovernor();
    const ticket = governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units: 1 })!;
    expect(governor.resetScope('a')).toBe(1);
    expect(governor.release(ticket)).toBe(false);
    expect(governor.snapshot()).toMatchObject({ tickets: 0, units: 0, released: 1, generation: 2 });
  });

  it('invalidates tickets in other scopes when generation advances', () => {
    const governor = new RuntimeAdmissionGovernor();
    governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units: 1 });
    const other = governor.admit({ scope: 'b', priority: 'interactive', resource: 'cpu', units: 1 })!;
    governor.resetScope('a');
    expect(governor.release(other)).toBe(false);
  });

  it('evicts the least recently touched idle scope', () => {
    const time = clock();
    const governor = new RuntimeAdmissionGovernor({ maxScopes: 2, idleScopeTtlMs: 1000 }, time.now);
    const a = governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })!;
    governor.release(a);
    time.advance(1);
    const b = governor.admit({ scope: 'b', priority: 'critical', resource: 'cpu', units: 1 })!;
    governor.release(b);
    expect(governor.admit({ scope: 'c', priority: 'critical', resource: 'cpu', units: 1 })).not.toBeNull();
    expect(governor.snapshot().scopes).toBe(2);
  });

  it('does not evict active scopes to admit a new scope', () => {
    const governor = new RuntimeAdmissionGovernor({ maxScopes: 1 });
    expect(governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })).not.toBeNull();
    expect(governor.admit({ scope: 'b', priority: 'critical', resource: 'cpu', units: 1 })).toBeNull();
  });

  it('removes idle scopes after ttl', () => {
    const time = clock();
    const governor = new RuntimeAdmissionGovernor({ idleScopeTtlMs: 10 }, time.now);
    const ticket = governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })!;
    governor.release(ticket);
    time.set(9); governor.sweep(); expect(governor.snapshot().scopes).toBe(1);
    time.set(10); governor.sweep(); expect(governor.snapshot().scopes).toBe(0);
  });

  it('reports aggregate resource and priority diagnostics only', () => {
    const governor = new RuntimeAdmissionGovernor({ criticalReserveUnits: 0 });
    governor.admit({ scope: 'secret-free-a', priority: 'critical', resource: 'gpu', units: 2 });
    governor.admit({ scope: 'secret-free-b', priority: 'background', resource: 'network', units: 3 });
    const snapshot = governor.snapshot();
    expect(snapshot).toMatchObject({ criticalUnits: 2, backgroundUnits: 3, gpuUnits: 2, networkUnits: 3, units: 5 });
    expect(JSON.stringify(snapshot)).not.toContain('secret-free-a');
  });

  it.each(['', ' bad', 'x'.repeat(97), 'a/b'])('rejects unsafe scope %j', (scope) => {
    const governor = new RuntimeAdmissionGovernor();
    expect(() => governor.admit({ scope, priority: 'interactive', resource: 'cpu', units: 1 })).toThrow(TypeError);
  });

  it('rejects malformed units', () => {
    const governor = new RuntimeAdmissionGovernor();
    for (const units of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => governor.admit({ scope: 'a', priority: 'interactive', resource: 'cpu', units })).toThrow();
    }
  });

  it('rejects units above the per-ticket bound', () => {
    const governor = new RuntimeAdmissionGovernor({ maxUnitsPerTicket: 2 });
    expect(() => governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 3 })).toThrow(RangeError);
  });

  it('rejects malformed priorities and resources at runtime', () => {
    const governor = new RuntimeAdmissionGovernor();
    expect(() => governor.admit({ scope: 'a', priority: 'urgent' as never, resource: 'cpu', units: 1 })).toThrow(TypeError);
    expect(() => governor.admit({ scope: 'a', priority: 'critical', resource: 'disk' as never, units: 1 })).toThrow(TypeError);
  });

  it('rejects inconsistent policies', () => {
    expect(() => new RuntimeAdmissionGovernor({ maxTicketsGlobal: 1, maxTicketsPerScope: 2 })).toThrow(RangeError);
    expect(() => new RuntimeAdmissionGovernor({ maxUnitsGlobal: 5, maxUnitsPerScope: 6 })).toThrow(RangeError);
    expect(() => new RuntimeAdmissionGovernor({ maxUnitsPerScope: 5, maxUnitsPerTicket: 6 })).toThrow(RangeError);
    expect(() => new RuntimeAdmissionGovernor({ maxUnitsGlobal: 5, criticalReserveUnits: 5 })).toThrow(RangeError);
  });

  it('tolerates bounded clock rollback without extending time', () => {
    const time = clock(100);
    const governor = new RuntimeAdmissionGovernor({ maxClockSkewMs: 5 }, time.now);
    const ticket = governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })!;
    time.set(97);
    expect(governor.isActive(ticket)).toBe(true);
    expect(governor.renew(ticket)!.expiresAt).toBe(ticket.expiresAt);
  });

  it('fails closed on excessive clock rollback', () => {
    const time = clock(100);
    const governor = new RuntimeAdmissionGovernor({ maxClockSkewMs: 2 }, time.now);
    governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 });
    time.set(90);
    expect(() => governor.sweep()).toThrow('clock moved backwards');
  });

  it('fails closed on invalid clock values', () => {
    expect(() => new RuntimeAdmissionGovernor({}, () => Number.NaN)).toThrow('finite non-negative');
    expect(() => new RuntimeAdmissionGovernor({}, () => -1)).toThrow('finite non-negative');
  });

  it('dispose is terminal and idempotent', () => {
    const governor = new RuntimeAdmissionGovernor();
    const ticket = governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })!;
    governor.dispose(); governor.dispose();
    expect(governor.snapshot()).toMatchObject({ tickets: 0, scopes: 0, units: 0, disposed: true });
    expect(governor.release(ticket)).toBe(false);
    expect(governor.isActive(ticket)).toBe(false);
    expect(() => governor.admit({ scope: 'b', priority: 'critical', resource: 'cpu', units: 1 })).toThrow('disposed');
  });

  it('does not expose mutable internal ticket state', () => {
    const governor = new RuntimeAdmissionGovernor();
    const ticket = governor.admit({ scope: 'a', priority: 'critical', resource: 'cpu', units: 1 })!;
    expect(Object.isFrozen(ticket)).toBe(true);
    const forged = { ...ticket, expiresAt: ticket.expiresAt + 1 } as RuntimeAdmissionTicket;
    expect(governor.release(forged)).toBe(false);
    expect(governor.release(ticket)).toBe(true);
  });
});
