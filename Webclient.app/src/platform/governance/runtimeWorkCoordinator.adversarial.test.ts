import { describe, expect, it } from 'vitest';
import {
  RuntimeWorkCoordinator,
  type RuntimeWorkCoordinatorPolicy,
  type RuntimeWorkPermit,
  type RuntimeWorkRequest,
} from './runtimeWorkCoordinator';

function manualClock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    set: (next: number) => { value = next; },
    advance: (delta: number) => { value += delta; },
  };
}

function policy(overrides: Partial<RuntimeWorkCoordinatorPolicy> = {}): Partial<RuntimeWorkCoordinatorPolicy> {
  return {
    maxActiveGlobal: 16,
    maxActivePerScope: 8,
    maxUnitsGlobal: 128,
    maxUnitsPerScope: 64,
    maxUnitsPerWork: 16,
    criticalReserveUnits: 16,
    criticalReserveSlots: 2,
    maxWorkMs: 1_000,
    minWorkMs: 10,
    maxScopes: 16,
    idleScopeTtlMs: 5_000,
    maxClockSkewMs: 50,
    ...overrides,
  };
}

function work(overrides: Partial<RuntimeWorkRequest> = {}): RuntimeWorkRequest {
  return {
    scope: 'map',
    priority: 'interactive',
    resource: 'cpu',
    units: 2,
    deadlineMs: 500,
    ...overrides,
  };
}

function mustAdmit(coordinator: RuntimeWorkCoordinator, overrides: Partial<RuntimeWorkRequest> = {}): RuntimeWorkPermit {
  const decision = coordinator.admit(work(overrides));
  expect(decision.status).toBe('admitted');
  return decision.permit!;
}

function expectNoChildLeak(coordinator: RuntimeWorkCoordinator) {
  const snapshot = coordinator.snapshot();
  expect(snapshot.active).toBe(0);
  expect(snapshot.units).toBe(0);
  expect(snapshot.admission.tickets).toBe(0);
  expect(snapshot.admission.units).toBe(0);
  expect(snapshot.deadline.active).toBe(0);
  expect(snapshot.backpressure.inflight).toBe(0);
}

describe('RuntimeWorkCoordinator adversarial accounting', () => {
  it('runs hundreds of complete cycles without leaking accounting', () => {
    const time = manualClock();
    const coordinator = new RuntimeWorkCoordinator(policy({ criticalReserveSlots: 0 }), time.now);

    for (let index = 0; index < 250; index += 1) {
      const permit = mustAdmit(coordinator, {
        scope: `scope-${index % 8}`,
        resource: index % 2 === 0 ? 'cpu' : 'gpu',
        units: (index % 8) + 1,
      });
      expect(coordinator.complete(permit)).toBe(true);
      time.advance(1);
    }

    expectNoChildLeak(coordinator);
    expect(coordinator.snapshot()).toMatchObject({ admitted: 250, completed: 250, cancelled: 0, expired: 0 });
  });

  it('runs mixed complete and cancel cycles without leaking accounting', () => {
    const time = manualClock();
    const coordinator = new RuntimeWorkCoordinator(policy({ criticalReserveSlots: 0 }), time.now);

    for (let index = 0; index < 120; index += 1) {
      const permit = mustAdmit(coordinator, { scope: `scope-${index % 6}` });
      if (index % 3 === 0) expect(coordinator.cancel(permit)).toBe(true);
      else expect(coordinator.complete(permit)).toBe(true);
      time.advance(1);
    }

    expectNoChildLeak(coordinator);
    expect(coordinator.snapshot().admitted).toBe(120);
    expect(coordinator.snapshot().completed).toBe(80);
    expect(coordinator.snapshot().cancelled).toBe(40);
  });

  it('cleans many expired permits in one sweep', () => {
    const time = manualClock();
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxActiveGlobal: 12,
      maxActivePerScope: 12,
      criticalReserveSlots: 0,
    }), time.now);

    for (let index = 0; index < 10; index += 1) {
      mustAdmit(coordinator, { scope: 'map', deadlineMs: 20 });
    }
    expect(coordinator.snapshot().active).toBe(10);
    time.set(20);
    expect(coordinator.sweep()).toBe(10);
    expectNoChildLeak(coordinator);
    expect(coordinator.snapshot().expired).toBe(10);
  });

  it('keeps aggregate units equal to child admission units', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({ criticalReserveSlots: 0 }), () => 0);
    const permits = [
      mustAdmit(coordinator, { scope: 'a', units: 1 }),
      mustAdmit(coordinator, { scope: 'b', units: 3 }),
      mustAdmit(coordinator, { scope: 'c', units: 5 }),
      mustAdmit(coordinator, { scope: 'd', units: 7 }),
    ];

    expect(coordinator.snapshot().units).toBe(16);
    expect(coordinator.snapshot().admission.units).toBe(16);
    for (const permit of permits) coordinator.complete(permit);
    expectNoChildLeak(coordinator);
  });

  it('never creates a permit for shed work', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.99, memory: 0.2, network: 0.1 });

    for (let index = 0; index < 20; index += 1) {
      const decision = coordinator.admit(work({ priority: 'background' }));
      expect(decision.status).toBe('shed');
      expect(decision.permit).toBeNull();
    }

    expectNoChildLeak(coordinator);
    expect(coordinator.snapshot().shed).toBe(20);
  });

  it('does not touch resource or deadline authorities when load shedding wins first', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.95, memory: 0, network: 0 });
    coordinator.admit(work({ priority: 'interactive' }));

    const snapshot = coordinator.snapshot();
    expect(snapshot.loadShed.shed).toBe(1);
    expect(snapshot.admission.admitted).toBe(0);
    expect(snapshot.deadline.active).toBe(0);
    expect(snapshot.backpressure.inflight).toBe(0);
  });

  it('does not acquire resource or deadline leases for deferred work', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxActiveGlobal: 3,
      maxActivePerScope: 3,
      criticalReserveSlots: 1,
      criticalReserveUnits: 0,
    }), () => 0);
    mustAdmit(coordinator, { scope: 'a' });
    mustAdmit(coordinator, { scope: 'b' });

    const admissionCount = coordinator.snapshot().admission.admitted;
    const decision = coordinator.admit(work({ scope: 'c' }));
    expect(decision.status).toBe('deferred');
    expect(coordinator.snapshot().admission.admitted).toBe(admissionCount);
    expect(coordinator.snapshot().deadline.active).toBe(2);
    expect(coordinator.snapshot().backpressure.inflight).toBe(2);
  });

  it('rolls back every transient backpressure lease after repeated admission rejection', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxUnitsGlobal: 20,
      maxUnitsPerScope: 20,
      maxUnitsPerWork: 20,
      criticalReserveUnits: 10,
      criticalReserveSlots: 0,
    }), () => 0);
    mustAdmit(coordinator, { scope: 'holder', units: 10 });

    for (let index = 0; index < 50; index += 1) {
      const decision = coordinator.admit(work({ scope: `reject-${index}`, units: 1 }));
      expect(decision).toMatchObject({ status: 'rejected', reason: 'admission' });
      expect(coordinator.snapshot().backpressure.inflight).toBe(1);
      expect(coordinator.snapshot().admission.tickets).toBe(1);
    }
  });

  it('keeps scope counts aligned after out-of-order settlement', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({ criticalReserveSlots: 0 }), () => 0);
    const first = mustAdmit(coordinator, { scope: 'map' });
    const second = mustAdmit(coordinator, { scope: 'map' });
    const third = mustAdmit(coordinator, { scope: 'map' });

    coordinator.complete(second);
    expect(coordinator.snapshot()).toMatchObject({ active: 2, scopes: 1 });
    coordinator.cancel(first);
    expect(coordinator.snapshot()).toMatchObject({ active: 1, scopes: 1 });
    coordinator.complete(third);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, scopes: 0 });
  });
});

describe('RuntimeWorkCoordinator stale and forged permit resistance', () => {
  it('old permits remain invalid after scope reset and fresh admission', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({ maxActivePerScope: 1 }), () => 0);
    const stale = mustAdmit(coordinator, { scope: 'map' });
    expect(coordinator.resetScope('map')).toBe(1);
    const fresh = mustAdmit(coordinator, { scope: 'map' });

    expect(coordinator.complete(stale)).toBe(false);
    expect(coordinator.cancel(stale)).toBe(false);
    expect(coordinator.isActive(fresh)).toBe(true);
    expect(coordinator.complete(fresh)).toBe(true);
  });

  it('a stale permit cannot settle a later permit with the same scope', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const first = mustAdmit(coordinator);
    coordinator.complete(first);
    const second = mustAdmit(coordinator);

    expect(first.id).not.toBe(second.id);
    expect(coordinator.cancel(first)).toBe(false);
    expect(coordinator.isActive(second)).toBe(true);
  });

  it('rejects compound forgery even if the id is valid', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const permit = mustAdmit(coordinator);
    const forged: RuntimeWorkPermit = {
      ...permit,
      priority: 'critical',
      resource: 'gpu',
      units: permit.units + 2,
      expiresAt: permit.expiresAt + 100,
    };

    expect(coordinator.complete(forged)).toBe(false);
    expect(coordinator.isActive(permit)).toBe(true);
  });

  it('does not trust an object that only copies the permit id', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const permit = mustAdmit(coordinator);
    const fake = {
      id: permit.id,
      scope: permit.scope,
      priority: permit.priority,
      resource: permit.resource,
      units: permit.units,
      generation: permit.generation + 1,
      startedAt: permit.startedAt,
      expiresAt: permit.expiresAt,
    };
    expect(coordinator.cancel(fake)).toBe(false);
  });

  it('expired permits cannot be resurrected', () => {
    const time = manualClock();
    const coordinator = new RuntimeWorkCoordinator(policy(), time.now);
    const permit = mustAdmit(coordinator, { deadlineMs: 10 });
    time.set(10);
    coordinator.sweep();

    time.set(9);
    expect(coordinator.isActive(permit)).toBe(false);
    expect(coordinator.complete(permit)).toBe(false);
  });
});

describe('RuntimeWorkCoordinator deterministic pressure recovery', () => {
  it('recovers from severe pressure after the severe sample expires', () => {
    const time = manualClock();
    const coordinator = new RuntimeWorkCoordinator(policy({
      loadShed: {
        sampleTtlMs: 20,
        recoverySamples: 1,
        recoveryThreshold: 0.5,
        elevatedThreshold: 0.7,
        severeThreshold: 0.9,
      },
    }), time.now);

    coordinator.recordLoad('map', { cpu: 0.95, memory: 0, network: 0 });
    expect(coordinator.admit(work({ priority: 'background' })).status).toBe('shed');
    time.set(20);
    coordinator.sweep();
    coordinator.recordLoad('map', { cpu: 0.1, memory: 0.1, network: 0.1 });
    expect(coordinator.admit(work({ priority: 'background' })).status).toBe('admitted');
  });

  it('pressure in one scope does not shed work in another scope', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({ criticalReserveSlots: 0 }), () => 0);
    coordinator.recordLoad('map', { cpu: 0.99, memory: 0.99, network: 0.99 });
    expect(coordinator.admit(work({ scope: 'map', priority: 'background' })).status).toBe('shed');
    expect(coordinator.admit(work({ scope: 'search', priority: 'background' })).status).toBe('admitted');
  });

  it('critical work still obeys hard resource capacity under pressure', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxUnitsGlobal: 10,
      maxUnitsPerScope: 10,
      maxUnitsPerWork: 10,
      criticalReserveUnits: 0,
      criticalReserveSlots: 0,
    }), () => 0);
    coordinator.recordLoad('map', { cpu: 1, memory: 1, network: 1 });
    mustAdmit(coordinator, { priority: 'critical', units: 10 });
    const rejected = coordinator.admit(work({ scope: 'other', priority: 'critical', units: 1 }));
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'admission' });
  });

  it('resetting a pressured scope does not reset another scope', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.95, memory: 0, network: 0 });
    coordinator.recordLoad('search', { cpu: 0.95, memory: 0, network: 0 });
    coordinator.resetScope('map');

    expect(coordinator.admit(work({ scope: 'map', priority: 'background' })).status).toBe('admitted');
    expect(coordinator.admit(work({ scope: 'search', priority: 'background' })).status).toBe('shed');
  });
});

describe('RuntimeWorkCoordinator monotonic time invariants', () => {
  it('uses monotonic evaluatedAt during tolerated rollback', () => {
    const time = manualClock(100);
    const coordinator = new RuntimeWorkCoordinator(policy({ maxClockSkewMs: 20 }), time.now);
    const first = coordinator.admit(work({ scope: 'a' }));
    expect(first.evaluatedAt).toBe(100);
    coordinator.complete(first.permit!);

    time.set(90);
    const second = coordinator.admit(work({ scope: 'b' }));
    expect(second.evaluatedAt).toBe(100);
  });

  it('does not extend permit expiry because the clock rolls back', () => {
    const time = manualClock(100);
    const coordinator = new RuntimeWorkCoordinator(policy({ maxClockSkewMs: 20 }), time.now);
    const permit = mustAdmit(coordinator, { deadlineMs: 100 });
    expect(permit.expiresAt).toBe(200);

    time.set(90);
    expect(coordinator.remainingMs(permit)).toBe(100);
    time.set(150);
    expect(coordinator.remainingMs(permit)).toBe(50);
  });

  it('fails before state mutation on excessive rollback', () => {
    const time = manualClock(100);
    const coordinator = new RuntimeWorkCoordinator(policy({ maxClockSkewMs: 5 }), time.now);
    const permit = mustAdmit(coordinator);
    const before = coordinator.snapshot().active;
    time.set(94);

    expect(() => coordinator.admit(work({ scope: 'other' }))).toThrow('clock moved backwards');
    time.set(100);
    expect(coordinator.snapshot().active).toBe(before);
    expect(coordinator.isActive(permit)).toBe(true);
  });
});

describe('RuntimeWorkCoordinator bounded identity behavior', () => {
  it('creates unique ids across sequential work', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const permit = mustAdmit(coordinator);
      expect(ids.has(permit.id)).toBe(false);
      ids.add(permit.id);
      coordinator.complete(permit);
    }
    expect(ids.size).toBe(100);
  });

  it('keeps identifiers bounded even with the longest legal scope', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const permit = mustAdmit(coordinator, { scope: `a${'x'.repeat(95)}` });
    expect(permit.id.length).toBeLessThan(140);
  });

  it('does not echo load sample values into decisions', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    coordinator.recordLoad('map', { cpu: 0.987654, memory: 0.876543, network: 0.765432 });
    const decision = coordinator.admit(work({ priority: 'background' }));
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain('0.987654');
    expect(serialized).not.toContain('0.876543');
    expect(serialized).not.toContain('0.765432');
  });

  it('freezes every externally returned decision', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    const admitted = coordinator.admit(work());
    expect(Object.isFrozen(admitted)).toBe(true);
    coordinator.complete(admitted.permit!);
    coordinator.recordLoad('map', { cpu: 0.99, memory: 0, network: 0 });
    const shed = coordinator.admit(work({ priority: 'background' }));
    expect(Object.isFrozen(shed)).toBe(true);
  });

  it('returns a frozen aggregate snapshot', () => {
    const coordinator = new RuntimeWorkCoordinator(policy(), () => 0);
    mustAdmit(coordinator);
    const snapshot = coordinator.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.admission)).toBe(true);
    expect(Object.isFrozen(snapshot.deadline)).toBe(true);
    expect(Object.isFrozen(snapshot.backpressure)).toBe(true);
    expect(Object.isFrozen(snapshot.loadShed)).toBe(true);
  });
});

describe('RuntimeWorkCoordinator policy isolation', () => {
  it('copies nested load-shed configuration instead of retaining the caller object', () => {
    const nested = { elevatedThreshold: 0.7, severeThreshold: 0.9, recoveryThreshold: 0.5 };
    const coordinator = new RuntimeWorkCoordinator(policy({ loadShed: nested }), () => 0);
    nested.elevatedThreshold = 0.99;
    nested.severeThreshold = 1;

    expect(coordinator.recordLoad('map', { cpu: 0.8, memory: 0, network: 0 })).toBe('elevated');
  });

  it('keeps exact-boundary work valid', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxUnitsPerWork: 16,
      maxWorkMs: 1_000,
      minWorkMs: 10,
    }), () => 0);
    const decision = coordinator.admit(work({ units: 16, deadlineMs: 1_000 }));
    expect(decision.status).toBe('admitted');
  });

  it('keeps exact critical reserves available', () => {
    const coordinator = new RuntimeWorkCoordinator(policy({
      maxActiveGlobal: 4,
      maxActivePerScope: 4,
      criticalReserveSlots: 1,
      maxUnitsGlobal: 40,
      maxUnitsPerScope: 40,
      maxUnitsPerWork: 10,
      criticalReserveUnits: 10,
    }), () => 0);
    mustAdmit(coordinator, { scope: 'a', units: 10 });
    mustAdmit(coordinator, { scope: 'b', units: 10 });
    mustAdmit(coordinator, { scope: 'c', units: 10 });
    expect(coordinator.admit(work({ scope: 'd', units: 1 })).status).toBe('deferred');
    expect(coordinator.admit(work({ scope: 'd', priority: 'critical', units: 10 })).status).toBe('admitted');
  });
});
