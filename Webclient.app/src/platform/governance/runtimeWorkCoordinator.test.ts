import { describe, expect, it } from 'vitest';
import {
  RuntimeWorkCoordinator,
  createRuntimeWorkCoordinator,
  type RuntimeWorkCoordinatorPolicy,
  type RuntimeWorkPermit,
  type RuntimeWorkRequest,
} from './runtimeWorkCoordinator';

function clock(initial = 0) {
  let now = initial;
  return {
    now: () => now,
    set: (value: number) => { now = value; },
    advance: (value: number) => { now += value; },
  };
}

function request(overrides: Partial<RuntimeWorkRequest> = {}): RuntimeWorkRequest {
  return {
    scope: 'map',
    priority: 'interactive',
    resource: 'cpu',
    units: 4,
    deadlineMs: 1_000,
    ...overrides,
  };
}

function boundedPolicy(overrides: Partial<RuntimeWorkCoordinatorPolicy> = {}): Partial<RuntimeWorkCoordinatorPolicy> {
  return {
    maxActiveGlobal: 8,
    maxActivePerScope: 4,
    maxUnitsGlobal: 64,
    maxUnitsPerScope: 32,
    maxUnitsPerWork: 16,
    criticalReserveUnits: 8,
    criticalReserveSlots: 1,
    maxWorkMs: 2_000,
    minWorkMs: 10,
    maxScopes: 8,
    idleScopeTtlMs: 10_000,
    maxClockSkewMs: 100,
    ...overrides,
  };
}

function admitted(coordinator: RuntimeWorkCoordinator, input: Partial<RuntimeWorkRequest> = {}): RuntimeWorkPermit {
  const decision = coordinator.admit(request(input));
  expect(decision.status).toBe('admitted');
  expect(decision.reason).toBeNull();
  expect(decision.permit).not.toBeNull();
  return decision.permit!;
}

describe('RuntimeWorkCoordinator core lifecycle', () => {
  it('admits work through every child authority and completes atomically', () => {
    const time = clock();
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), time.now);
    const permit = admitted(coordinator);

    expect(coordinator.snapshot()).toMatchObject({
      active: 1,
      scopes: 1,
      units: 4,
      interactive: 1,
      admitted: 1,
      completed: 0,
    });
    expect(coordinator.snapshot().admission.tickets).toBe(1);
    expect(coordinator.snapshot().deadline.active).toBe(1);
    expect(coordinator.snapshot().backpressure.inflight).toBe(1);

    expect(coordinator.complete(permit)).toBe(true);
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({ active: 0, scopes: 0, units: 0, completed: 1 });
    expect(snapshot.admission.tickets).toBe(0);
    expect(snapshot.deadline.active).toBe(0);
    expect(snapshot.backpressure.inflight).toBe(0);
  });

  it('cancels work and releases all child leases', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator, { resource: 'network' });

    expect(coordinator.cancel(permit)).toBe(true);
    expect(coordinator.cancel(permit)).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, cancelled: 1 });
    expect(coordinator.snapshot().admission.tickets).toBe(0);
    expect(coordinator.snapshot().deadline.active).toBe(0);
    expect(coordinator.snapshot().backpressure.inflight).toBe(0);
  });

  it('returns detached frozen decisions and permits', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const decision = coordinator.admit(request());

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.permit)).toBe(true);
    expect(decision.permit).not.toBeNull();
    expect(decision.permit).not.toBe(decision);
  });

  it('tracks resource units without retaining work payloads', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ criticalReserveSlots: 0 }), () => 0);
    const cpu = admitted(coordinator, { scope: 'cpu', resource: 'cpu', units: 3 });
    const gpu = admitted(coordinator, { scope: 'gpu', resource: 'gpu', units: 5 });
    const network = admitted(coordinator, { scope: 'network', resource: 'network', units: 7 });

    const snapshot = coordinator.snapshot();
    expect(snapshot.units).toBe(15);
    expect(snapshot.admission.cpuUnits).toBe(3);
    expect(snapshot.admission.gpuUnits).toBe(5);
    expect(snapshot.admission.networkUnits).toBe(7);

    coordinator.complete(cpu);
    coordinator.complete(gpu);
    coordinator.complete(network);
    expect(coordinator.snapshot().units).toBe(0);
  });

  it('counts priorities independently', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ criticalReserveSlots: 0 }), () => 0);
    const critical = admitted(coordinator, { scope: 'a', priority: 'critical' });
    const interactive = admitted(coordinator, { scope: 'b', priority: 'interactive' });
    const background = admitted(coordinator, { scope: 'c', priority: 'background' });

    expect(coordinator.snapshot()).toMatchObject({ critical: 1, interactive: 1, background: 1 });
    coordinator.complete(critical);
    coordinator.complete(interactive);
    coordinator.complete(background);
  });

  it('reports bounded remaining time', () => {
    const time = clock(100);
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), time.now);
    const permit = admitted(coordinator, { deadlineMs: 500 });

    expect(coordinator.remainingMs(permit)).toBe(500);
    time.advance(125);
    expect(coordinator.remainingMs(permit)).toBe(375);
  });

  it('expires deadline-bounded work and releases longer child leases', () => {
    const time = clock();
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxWorkMs: 1_000 }), time.now);
    const permit = admitted(coordinator, { deadlineMs: 25 });

    time.set(25);
    expect(coordinator.sweep()).toBe(1);
    expect(coordinator.isActive(permit)).toBe(false);
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({ active: 0, expired: 1 });
    expect(snapshot.admission.tickets).toBe(0);
    expect(snapshot.backpressure.inflight).toBe(0);
  });

  it('expires work at the coordinator maximum even when callers never finish it', () => {
    const time = clock();
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxWorkMs: 100, minWorkMs: 10 }), time.now);
    const permit = admitted(coordinator, { deadlineMs: 100 });

    time.set(100);
    expect(coordinator.isActive(permit)).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, expired: 1 });
    expect(coordinator.complete(permit)).toBe(false);
  });

  it('isActive performs deterministic expiry cleanup', () => {
    const time = clock();
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), time.now);
    const permit = admitted(coordinator, { deadlineMs: 50 });

    time.set(49);
    expect(coordinator.isActive(permit)).toBe(true);
    time.set(50);
    expect(coordinator.isActive(permit)).toBe(false);
    expect(coordinator.snapshot().expired).toBe(1);
  });

  it('remainingMs returns null after completion', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    coordinator.complete(permit);
    expect(coordinator.remainingMs(permit)).toBeNull();
  });
});

describe('RuntimeWorkCoordinator capacity and reserves', () => {
  it('bounds global active work', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxActiveGlobal: 2,
      maxActivePerScope: 2,
      criticalReserveSlots: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'a' });
    admitted(coordinator, { scope: 'b' });

    const decision = coordinator.admit(request({ scope: 'c' }));
    expect(decision).toMatchObject({ status: 'rejected', reason: 'capacity', permit: null });
    expect(coordinator.snapshot()).toMatchObject({ active: 2, rejected: 1 });
  });

  it('bounds active work per scope', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxActiveGlobal: 4,
      maxActivePerScope: 1,
      criticalReserveSlots: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'map' });

    const decision = coordinator.admit(request({ scope: 'map' }));
    expect(decision).toMatchObject({ status: 'rejected', reason: 'capacity' });
    expect(coordinator.snapshot().active).toBe(1);
  });

  it('preserves critical inflight reserve from interactive work', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxActiveGlobal: 3,
      maxActivePerScope: 3,
      criticalReserveSlots: 1,
      criticalReserveUnits: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'a', priority: 'interactive' });
    admitted(coordinator, { scope: 'b', priority: 'interactive' });

    const deferred = coordinator.admit(request({ scope: 'c', priority: 'interactive' }));
    expect(deferred).toMatchObject({ status: 'deferred', reason: 'backpressure-defer' });

    const critical = coordinator.admit(request({ scope: 'c', priority: 'critical' }));
    expect(critical.status).toBe('admitted');
    expect(coordinator.snapshot()).toMatchObject({ active: 3, deferred: 1, critical: 1 });
  });

  it('preserves critical unit reserve from interactive work', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxActiveGlobal: 5,
      maxActivePerScope: 5,
      maxUnitsGlobal: 10,
      maxUnitsPerScope: 10,
      maxUnitsPerWork: 10,
      criticalReserveUnits: 2,
      criticalReserveSlots: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'a', units: 8, priority: 'interactive' });

    const rejected = coordinator.admit(request({ scope: 'b', units: 1, priority: 'interactive' }));
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'admission' });
    expect(coordinator.snapshot().backpressure.inflight).toBe(1);

    const critical = coordinator.admit(request({ scope: 'b', units: 2, priority: 'critical' }));
    expect(critical.status).toBe('admitted');
  });

  it('rolls back backpressure when resource admission fails', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxActiveGlobal: 6,
      maxActivePerScope: 6,
      maxUnitsGlobal: 12,
      maxUnitsPerScope: 12,
      maxUnitsPerWork: 12,
      criticalReserveUnits: 4,
      criticalReserveSlots: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'a', units: 8 });
    const before = coordinator.snapshot().backpressure.inflight;

    const rejected = coordinator.admit(request({ scope: 'b', units: 1 }));
    expect(rejected.reason).toBe('admission');
    expect(coordinator.snapshot().backpressure.inflight).toBe(before);
    expect(coordinator.snapshot().admission.tickets).toBe(1);
  });

  it('fails closed when active scopes exhaust bounded scope capacity', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxScopes: 1,
      maxActiveGlobal: 4,
      maxActivePerScope: 4,
      criticalReserveSlots: 0,
    }), () => 0);
    admitted(coordinator, { scope: 'first' });

    const decision = coordinator.admit(request({ scope: 'second' }));
    expect(decision).toMatchObject({ status: 'rejected', reason: 'capacity' });
    expect(coordinator.snapshot().backpressure.scopes).toBe(1);
  });

  it('reuses scope capacity after the old scope becomes idle', () => {
    const time = clock();
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({
      maxScopes: 1,
      maxActiveGlobal: 2,
      maxActivePerScope: 2,
      criticalReserveSlots: 0,
      idleScopeTtlMs: 10,
    }), time.now);
    const first = admitted(coordinator, { scope: 'first' });
    coordinator.complete(first);
    time.advance(10);
    coordinator.sweep();

    expect(coordinator.admit(request({ scope: 'second' })).status).toBe('admitted');
  });
});

describe('RuntimeWorkCoordinator load shedding', () => {
  it('sheds background work under elevated pressure', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    expect(coordinator.recordLoad('map', { cpu: 0.8, memory: 0.2, network: 0.1 })).toBe('elevated');

    const decision = coordinator.admit(request({ priority: 'background' }));
    expect(decision).toMatchObject({ status: 'shed', reason: 'load-shed', pressureBand: 'elevated' });
    expect(coordinator.snapshot()).toMatchObject({ active: 0, shed: 1 });
  });

  it('admits interactive work under elevated pressure', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.75, memory: 0.2, network: 0.1 });
    expect(coordinator.admit(request({ priority: 'interactive' })).status).toBe('admitted');
  });

  it('sheds interactive work under severe pressure', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.95, memory: 0.1, network: 0.1 });
    const decision = coordinator.admit(request({ priority: 'interactive' }));
    expect(decision).toMatchObject({ status: 'shed', reason: 'load-shed', pressureBand: 'severe' });
  });

  it('keeps critical work admissible under severe pressure', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.99, memory: 0.99, network: 0.99 });
    const decision = coordinator.admit(request({ priority: 'critical' }));
    expect(decision.status).toBe('admitted');
    expect(decision.pressureBand).toBe('severe');
  });

  it('clears scope pressure on reset', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.95, memory: 0.1, network: 0.1 });
    expect(coordinator.admit(request({ priority: 'background' })).status).toBe('shed');
    expect(coordinator.resetScope('map')).toBe(0);
    expect(coordinator.admit(request({ priority: 'background' })).status).toBe('admitted');
  });
});

describe('RuntimeWorkCoordinator scope reset', () => {
  it('cancels every permit in the target scope only', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ criticalReserveSlots: 0 }), () => 0);
    admitted(coordinator, { scope: 'map' });
    admitted(coordinator, { scope: 'map', resource: 'gpu' });
    const search = admitted(coordinator, { scope: 'search' });

    expect(coordinator.resetScope('map')).toBe(2);
    expect(coordinator.snapshot()).toMatchObject({ active: 1, scopes: 1, cancelled: 2 });
    expect(coordinator.isActive(search)).toBe(true);
  });

  it('returns zero for a missing scope without disturbing live permits', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator, { scope: 'map' });
    expect(coordinator.resetScope('missing')).toBe(0);
    expect(coordinator.isActive(permit)).toBe(true);
  });

  it('allows fresh work after a scope reset', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxActivePerScope: 1 }), () => 0);
    admitted(coordinator, { scope: 'map' });
    coordinator.resetScope('map');
    expect(coordinator.admit(request({ scope: 'map' })).status).toBe('admitted');
  });
});

describe('RuntimeWorkCoordinator permit integrity', () => {
  it('rejects a forged scope', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    const forged = { ...permit, scope: 'other' };
    expect(coordinator.complete(forged)).toBe(false);
    expect(coordinator.isActive(permit)).toBe(true);
  });

  it('rejects forged units', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    expect(coordinator.cancel({ ...permit, units: permit.units + 1 })).toBe(false);
    expect(coordinator.isActive(permit)).toBe(true);
  });

  it('rejects forged priority', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    const forged = { ...permit, priority: 'critical' as const };
    expect(coordinator.complete(forged)).toBe(false);
  });

  it('rejects forged resource', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    const forged = { ...permit, resource: 'gpu' as const };
    expect(coordinator.complete(forged)).toBe(false);
  });

  it('rejects forged expiry', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    expect(coordinator.complete({ ...permit, expiresAt: permit.expiresAt + 1 })).toBe(false);
  });

  it('makes completion idempotent', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    expect(coordinator.complete(permit)).toBe(true);
    expect(coordinator.complete(permit)).toBe(false);
    expect(coordinator.cancel(permit)).toBe(false);
    expect(coordinator.snapshot().completed).toBe(1);
  });
});

describe('RuntimeWorkCoordinator policy validation', () => {
  it.each([
    [{ maxActiveGlobal: 0 }, 'maxActiveGlobal'],
    [{ maxActivePerScope: 0 }, 'maxActivePerScope'],
    [{ maxUnitsGlobal: 0 }, 'maxUnitsGlobal'],
    [{ maxUnitsPerScope: 0 }, 'maxUnitsPerScope'],
    [{ maxUnitsPerWork: 0 }, 'maxUnitsPerWork'],
    [{ maxWorkMs: 0 }, 'maxWorkMs'],
    [{ minWorkMs: 0 }, 'minWorkMs'],
    [{ maxScopes: 0 }, 'maxScopes'],
    [{ idleScopeTtlMs: 0 }, 'idleScopeTtlMs'],
    [{ maxClockSkewMs: -1 }, 'maxClockSkewMs'],
  ] as const)('rejects invalid scalar policy %o', (policy, expected) => {
    expect(() => new RuntimeWorkCoordinator(policy)).toThrow(expected);
  });

  it('rejects per-scope active capacity above global capacity', () => {
    expect(() => new RuntimeWorkCoordinator({ maxActiveGlobal: 2, maxActivePerScope: 3, criticalReserveSlots: 0 })).toThrow('maxActivePerScope');
  });

  it('rejects per-scope units above global units', () => {
    expect(() => new RuntimeWorkCoordinator({ maxUnitsGlobal: 10, maxUnitsPerScope: 11, maxUnitsPerWork: 10, criticalReserveUnits: 0 })).toThrow('maxUnitsPerScope');
  });

  it('rejects per-work units above per-scope units', () => {
    expect(() => new RuntimeWorkCoordinator({ maxUnitsGlobal: 20, maxUnitsPerScope: 10, maxUnitsPerWork: 11, criticalReserveUnits: 0 })).toThrow('maxUnitsPerWork');
  });

  it('rejects critical unit reserve that consumes all units', () => {
    expect(() => new RuntimeWorkCoordinator({ maxUnitsGlobal: 10, maxUnitsPerScope: 10, maxUnitsPerWork: 10, criticalReserveUnits: 10 })).toThrow('criticalReserveUnits');
  });

  it('rejects critical slot reserve that consumes all slots', () => {
    expect(() => new RuntimeWorkCoordinator({ maxActiveGlobal: 2, maxActivePerScope: 2, criticalReserveSlots: 2 })).toThrow('criticalReserveSlots');
  });

  it('rejects a minimum duration above the maximum duration', () => {
    expect(() => new RuntimeWorkCoordinator({ minWorkMs: 101, maxWorkMs: 100 })).toThrow('minWorkMs');
  });
});

describe('RuntimeWorkCoordinator request validation', () => {
  it.each(['', ' map', 'map ', 'a/b', 'a?b', 'x'.repeat(97)])('rejects unsafe scope %j', (scope) => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    expect(() => coordinator.admit(request({ scope }))).toThrow('scope');
    expect(coordinator.snapshot().active).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid units %s', (units) => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    expect(() => coordinator.admit(request({ units }))).toThrow('units');
  });

  it('rejects units above the per-work maximum before mutating child authorities', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxUnitsPerWork: 5 }), () => 0);
    expect(() => coordinator.admit(request({ units: 6 }))).toThrow('per-work maximum');
    expect(coordinator.snapshot()).toMatchObject({ active: 0, admitted: 0 });
    expect(coordinator.snapshot().backpressure.inflight).toBe(0);
  });

  it('rejects deadlines below the minimum', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ minWorkMs: 25 }), () => 0);
    expect(() => coordinator.admit(request({ deadlineMs: 24 }))).toThrow('deadlineMs');
  });

  it('rejects deadlines above the coordinator maximum before mutation', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxWorkMs: 100 }), () => 0);
    expect(() => coordinator.admit(request({ deadlineMs: 101 }))).toThrow('coordinator maximum');
    expect(coordinator.snapshot().active).toBe(0);
  });

  it('rejects invalid load samples through the underlying bounded policy', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    expect(() => coordinator.recordLoad('map', { cpu: 1.1, memory: 0, network: 0 })).toThrow('cpu');
  });
});

describe('RuntimeWorkCoordinator clock behavior', () => {
  it('tolerates bounded clock rollback monotonically', () => {
    const time = clock(1_000);
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxClockSkewMs: 100 }), time.now);
    const permit = admitted(coordinator, { deadlineMs: 500 });
    time.set(950);
    expect(coordinator.isActive(permit)).toBe(true);
    expect(coordinator.remainingMs(permit)).toBe(500);
  });

  it('rejects clock rollback beyond policy', () => {
    const time = clock(1_000);
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ maxClockSkewMs: 10 }), time.now);
    admitted(coordinator);
    time.set(989);
    expect(() => coordinator.sweep()).toThrow('clock moved backwards');
  });

  it('rejects non-finite clocks at construction', () => {
    expect(() => new RuntimeWorkCoordinator(boundedPolicy(), () => Number.NaN)).toThrow('finite non-negative');
  });

  it('rejects negative clocks at construction', () => {
    expect(() => new RuntimeWorkCoordinator(boundedPolicy(), () => -1)).toThrow('finite non-negative');
  });
});

describe('RuntimeWorkCoordinator disposal', () => {
  it('settles every live permit before disposing children', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy({ criticalReserveSlots: 0 }), () => 0);
    admitted(coordinator, { scope: 'a' });
    admitted(coordinator, { scope: 'b' });
    coordinator.dispose();

    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({ active: 0, scopes: 0, cancelled: 2, disposed: true });
    expect(snapshot.admission.disposed).toBe(true);
    expect(snapshot.deadline.disposed).toBe(true);
    expect(snapshot.backpressure.disposed).toBe(true);
    expect(snapshot.loadShed.disposed).toBe(true);
  });

  it('is idempotent', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.dispose();
    coordinator.dispose();
    expect(coordinator.snapshot().disposed).toBe(true);
  });

  it('returns false/null for permit queries after disposal', () => {
    const coordinator = new RuntimeWorkCoordinator(boundedPolicy(), () => 0);
    const permit = admitted(coordinator);
    coordinator.dispose();
    expect(coordinator.isActive(permit)).toBe(false);
    expect(coordinator.remainingMs(permit)).toBeNull();
    expect(coordinator.complete(permit)).toBe(false);
    expect(coordinator.cancel(permit)).toBe(false);
  });

  it('rejects new mutations after disposal', () => {
    const coordinator = createRuntimeWorkCoordinator(boundedPolicy(), () => 0);
    coordinator.dispose();
    expect(() => coordinator.admit(request())).toThrow('disposed');
    expect(() => coordinator.recordLoad('map', { cpu: 0, memory: 0, network: 0 })).toThrow('disposed');
    expect(() => coordinator.resetScope('map')).toThrow('disposed');
    expect(() => coordinator.sweep()).toThrow('disposed');
  });
});
