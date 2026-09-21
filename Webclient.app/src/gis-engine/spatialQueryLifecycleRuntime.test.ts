import { describe, expect, it } from 'vitest';
import {
  createSpatialQueryLifecycleRuntime,
  normalizeSpatialQueryLifecycleConfig,
  type SpatialQueryLifecycleRegistration,
} from './spatialQueryLifecycleRuntime';

const registration = (
  overrides: Partial<SpatialQueryLifecycleRegistration> = {},
): SpatialQueryLifecycleRegistration => ({
  serviceId: 'parks-service',
  layerId: 4,
  ownerId: 'map-view',
  requestKey: 'parks:4:viewport',
  priority: 'normal',
  expectedFeatures: 500,
  expectedBytes: 32_000,
  now: 1_000,
  ...overrides,
});

describe('normalizeSpatialQueryLifecycleConfig', () => {
  it('provides immutable bounded defaults', () => {
    const config = normalizeSpatialQueryLifecycleConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.maxTrackedQueries).toBeGreaterThan(0);
    expect(config.maxEvents).toBeGreaterThan(0);
    expect(config.maxExecutionMs).toBeLessThanOrEqual(config.maxLifetimeMs);
  });

  it('accepts explicit safe bounds', () => {
    const config = normalizeSpatialQueryLifecycleConfig({
      maxTrackedQueries: 25,
      maxEvents: 50,
      maxPagesPerQuery: 16,
      maxFeaturesPerQuery: 25_000,
      maxLifetimeMs: 10_000,
      maxExecutionMs: 5_000,
      maxTerminalAgeMs: 100,
      maxRequestKeyLength: 64,
      maxOwnerIdLength: 32,
      maxServiceIdLength: 64,
    });

    expect(config).toMatchObject({
      maxTrackedQueries: 25,
      maxEvents: 50,
      maxPagesPerQuery: 16,
      maxFeaturesPerQuery: 25_000,
      maxExecutionMs: 5_000,
      maxTerminalAgeMs: 100,
    });
  });

  it('rejects invalid capacity values', () => {
    expect(() => normalizeSpatialQueryLifecycleConfig({ maxTrackedQueries: 0 })).toThrow();
    expect(() => normalizeSpatialQueryLifecycleConfig({ maxEvents: 0 })).toThrow();
    expect(() => normalizeSpatialQueryLifecycleConfig({ maxRequestKeyLength: 0 })).toThrow();
  });

  it('rejects invalid page and feature budgets', () => {
    expect(() => normalizeSpatialQueryLifecycleConfig({ maxPagesPerQuery: 0 })).toThrow();
    expect(() => normalizeSpatialQueryLifecycleConfig({ maxFeaturesPerQuery: 0 })).toThrow();
  });

  it('rejects an execution deadline larger than the lifecycle deadline', () => {
    expect(() => normalizeSpatialQueryLifecycleConfig({
      maxLifetimeMs: 1_000,
      maxExecutionMs: 1_001,
    })).toThrow();
  });

  it('allows terminal records to be eligible for immediate sweeping', () => {
    const config = normalizeSpatialQueryLifecycleConfig({ maxTerminalAgeMs: 0 });
    expect(config.maxTerminalAgeMs).toBe(0);
  });
});

describe('createSpatialQueryLifecycleRuntime', () => {
  it('registers an immutable normalized query record', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const record = runtime.register(registration({
      serviceId: '  parks-service  ',
      ownerId: '  map-view  ',
      requestKey: '  parks:4:viewport  ',
    }));

    expect(Object.isFrozen(record)).toBe(true);
    expect(record).toMatchObject({
      id: 1,
      serviceId: 'parks-service',
      ownerId: 'map-view',
      requestKey: 'parks:4:viewport',
      phase: 'registered',
      createdAt: 1_000,
      updatedAt: 1_000,
      executionDeadlineAt: null,
      terminalAt: null,
      version: 1,
    });
    expect(record.lifetimeDeadlineAt).toBeGreaterThan(record.createdAt);
  });

  it('defaults optional resource estimates to zero', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const record = runtime.register(registration({
      expectedFeatures: undefined,
      expectedBytes: undefined,
    }));
    expect(record.expectedFeatures).toBe(0);
    expect(record.expectedBytes).toBe(0);
  });

  it('moves a query through the successful lifecycle', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxLifetimeMs: 10_000,
      maxExecutionMs: 2_000,
    });
    const record = runtime.register(registration());
    const admitted = runtime.admit(record.id, 1_100);
    const executing = runtime.start(record.id, 1_200);
    const completed = runtime.complete(record.id, 1_500);

    expect(admitted.phase).toBe('admitted');
    expect(executing.phase).toBe('executing');
    expect(executing.executionDeadlineAt).toBe(3_200);
    expect(completed).toMatchObject({
      phase: 'completed',
      terminalAt: 1_500,
      version: 4,
    });
    expect(runtime.snapshot()).toMatchObject({
      active: 0,
      terminal: 1,
      completed: 1,
      transitionedTotal: 3,
    });
  });

  it('caps execution deadline at the lifetime deadline', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxLifetimeMs: 1_000,
      maxExecutionMs: 900,
    });
    const record = runtime.register(registration({ now: 100 }));
    runtime.admit(record.id, 900);
    const executing = runtime.start(record.id, 950);
    expect(executing.lifetimeDeadlineAt).toBe(1_100);
    expect(executing.executionDeadlineAt).toBe(1_100);
  });

  it('supports failure from registered, admitted, and executing states', () => {
    const runtime = createSpatialQueryLifecycleRuntime();

    const registered = runtime.register(registration({ requestKey: 'registered-failure' }));
    expect(runtime.fail(registered.id, 1_100).phase).toBe('failed');

    const admitted = runtime.register(registration({ requestKey: 'admitted-failure', now: 2_000 }));
    runtime.admit(admitted.id, 2_100);
    expect(runtime.fail(admitted.id, 2_200).phase).toBe('failed');

    const executing = runtime.register(registration({ requestKey: 'execution-failure', now: 3_000 }));
    runtime.admit(executing.id, 3_100);
    runtime.start(executing.id, 3_200);
    expect(runtime.fail(executing.id, 3_300).phase).toBe('failed');

    expect(runtime.snapshot().failed).toBe(3);
  });

  it('supports cancellation before and during execution', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const before = runtime.register(registration({ requestKey: 'cancel-before' }));
    expect(runtime.cancel(before.id, 1_100).phase).toBe('cancelled');

    const during = runtime.register(registration({ requestKey: 'cancel-during', now: 2_000 }));
    runtime.admit(during.id, 2_100);
    runtime.start(during.id, 2_200);
    expect(runtime.cancel(during.id, 2_300).phase).toBe('cancelled');

    expect(runtime.snapshot()).toMatchObject({ cancelled: 2, active: 0 });
  });

  it('rejects invalid state transitions', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const record = runtime.register(registration());
    expect(() => runtime.start(record.id, 1_100)).toThrow();
    runtime.admit(record.id, 1_100);
    expect(() => runtime.complete(record.id, 1_200)).toThrow();
  });

  it('rejects transitions from terminal states', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const record = runtime.register(registration());
    runtime.cancel(record.id, 1_100);
    expect(() => runtime.admit(record.id, 1_200)).toThrow();
    expect(() => runtime.fail(record.id, 1_200)).toThrow();
  });

  it('rejects backwards lifecycle timestamps', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const record = runtime.register(registration({ now: 5_000 }));
    expect(() => runtime.admit(record.id, 4_999)).toThrow();
  });

  it('rejects malformed registration identities', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxOwnerIdLength: 8,
      maxServiceIdLength: 8,
      maxRequestKeyLength: 8,
    });
    expect(() => runtime.register(registration({ serviceId: ' ' }))).toThrow();
    expect(() => runtime.register(registration({ ownerId: ' ' }))).toThrow();
    expect(() => runtime.register(registration({ requestKey: ' ' }))).toThrow();
    expect(() => runtime.register(registration({ serviceId: '123456789' }))).toThrow();
    expect(() => runtime.register(registration({ ownerId: '123456789' }))).toThrow();
    expect(() => runtime.register(registration({ requestKey: '123456789' }))).toThrow();
  });

  it('rejects malformed layer and resource estimates', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    expect(() => runtime.register(registration({ layerId: -1 }))).toThrow();
    expect(() => runtime.register(registration({ expectedFeatures: -1 }))).toThrow();
    expect(() => runtime.register(registration({ expectedBytes: Number.NaN }))).toThrow();
  });

  it('enforces explicit page and feature budgets at registration', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxPagesPerQuery: 4,
      maxFeaturesPerQuery: 1_000,
    });
    expect(() => runtime.register(registration({ expectedPages: 5 }))).toThrow();
    expect(() => runtime.register(registration({ expectedFeatures: 1_001 }))).toThrow();

    const accepted = runtime.register(registration({
      requestKey: 'bounded',
      expectedPages: 4,
      expectedFeatures: 1_000,
    }));
    expect(accepted).toMatchObject({ expectedPages: 4, expectedFeatures: 1_000 });
  });

  it('tracks active expected resource pressure', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const first = runtime.register(registration({
      requestKey: 'first',
      expectedFeatures: 100,
      expectedBytes: 1_000,
    }));
    runtime.register(registration({
      requestKey: 'second',
      expectedFeatures: 200,
      expectedBytes: 2_000,
      now: 1_100,
    }));

    expect(runtime.snapshot()).toMatchObject({
      active: 2,
      expectedFeaturesActive: 300,
      expectedBytesActive: 3_000,
    });

    runtime.cancel(first.id, 1_200);
    expect(runtime.snapshot()).toMatchObject({
      active: 1,
      expectedFeaturesActive: 200,
      expectedBytesActive: 2_000,
    });
  });

  it('cancels all active work owned by one consumer', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    runtime.register(registration({ requestKey: 'owner-a-1', ownerId: 'owner-a' }));
    const active = runtime.register(registration({
      requestKey: 'owner-a-2',
      ownerId: 'owner-a',
      now: 1_100,
    }));
    runtime.admit(active.id, 1_200);
    runtime.start(active.id, 1_300);
    runtime.register(registration({
      requestKey: 'owner-b-1',
      ownerId: 'owner-b',
      now: 1_400,
    }));

    expect(runtime.cancelOwner('owner-a', 1_500)).toBe(2);
    expect(runtime.snapshot()).toMatchObject({
      active: 1,
      cancelled: 2,
      owners: 1,
    });
  });

  it('returns zero when cancelling an owner with no active work', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    runtime.register(registration({ ownerId: 'owner-a' }));
    expect(runtime.cancelOwner('owner-b', 2_000)).toBe(0);
  });

  it('expires work at the lifecycle deadline before execution starts', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxLifetimeMs: 1_000,
      maxExecutionMs: 500,
    });
    runtime.register(registration({ now: 10_000 }));
    expect(runtime.expireDue(10_999)).toHaveLength(0);
    const expired = runtime.expireDue(11_000);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.phase).toBe('expired');
  });

  it('expires executing work at its execution deadline', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxLifetimeMs: 10_000,
      maxExecutionMs: 500,
    });
    const record = runtime.register(registration({ now: 1_000 }));
    runtime.admit(record.id, 1_100);
    runtime.start(record.id, 1_200);
    expect(runtime.expireDue(1_699)).toHaveLength(0);
    expect(runtime.expireDue(1_700)).toHaveLength(1);
    expect(runtime.snapshot().expired).toBe(1);
  });

  it('bounds how many due records are expired in one pass', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxTrackedQueries: 5,
      maxLifetimeMs: 100,
      maxExecutionMs: 100,
    });
    runtime.register(registration({ requestKey: 'a', now: 100 }));
    runtime.register(registration({ requestKey: 'b', now: 100 }));
    runtime.register(registration({ requestKey: 'c', now: 100 }));

    expect(runtime.expireDue(200, 2)).toHaveLength(2);
    expect(runtime.snapshot()).toMatchObject({ expired: 2, active: 1 });
  });

  it('keeps a bounded chronological event history', () => {
    const runtime = createSpatialQueryLifecycleRuntime({ maxEvents: 3 });
    const record = runtime.register(registration());
    runtime.admit(record.id, 1_100);
    runtime.start(record.id, 1_200);
    runtime.complete(record.id, 1_300);

    const events = runtime.events();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.to)).toEqual(['admitted', 'executing', 'completed']);
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(Object.isFrozen(events)).toBe(true);
  });

  it('can return only the newest requested event count', () => {
    const runtime = createSpatialQueryLifecycleRuntime({ maxEvents: 10 });
    const record = runtime.register(registration());
    runtime.admit(record.id, 1_100);
    runtime.start(record.id, 1_200);
    const latest = runtime.events(2);
    expect(latest.map((event) => event.to)).toEqual(['admitted', 'executing']);
  });

  it('sweeps terminal records only after the configured retention age', () => {
    const runtime = createSpatialQueryLifecycleRuntime({ maxTerminalAgeMs: 500 });
    const record = runtime.register(registration({ now: 1_000 }));
    runtime.cancel(record.id, 1_100);
    expect(runtime.sweepTerminal(1_599)).toBe(0);
    expect(runtime.sweepTerminal(1_600)).toBe(1);
    expect(runtime.get(record.id)).toBeUndefined();
  });

  it('reclaims terminal capacity before rejecting a new registration', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxTrackedQueries: 1,
      maxTerminalAgeMs: 0,
    });
    const first = runtime.register(registration({ requestKey: 'first', now: 1_000 }));
    runtime.complete(runtime.start(runtime.admit(first.id, 1_001).id, 1_002).id, 1_003);

    const second = runtime.register(registration({ requestKey: 'second', now: 1_004 }));
    expect(second.id).toBe(2);
    expect(runtime.snapshot()).toMatchObject({ tracked: 1, active: 1, removedTotal: 1 });
  });

  it('fails closed when active tracking capacity is exhausted', () => {
    const runtime = createSpatialQueryLifecycleRuntime({
      maxTrackedQueries: 1,
      maxTerminalAgeMs: 0,
    });
    runtime.register(registration({ requestKey: 'first' }));
    expect(() => runtime.register(registration({ requestKey: 'second', now: 1_001 }))).toThrow();
  });

  it('clears terminal records without removing active records', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    const terminal = runtime.register(registration({ requestKey: 'terminal' }));
    runtime.cancel(terminal.id, 1_100);
    const active = runtime.register(registration({ requestKey: 'active', now: 1_200 }));

    expect(runtime.clearTerminal()).toBe(1);
    expect(runtime.get(terminal.id)).toBeUndefined();
    expect(runtime.get(active.id)?.phase).toBe('registered');
  });

  it('reports stable service and owner cardinality', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    runtime.register(registration({ serviceId: 'service-a', ownerId: 'owner-a', requestKey: 'a' }));
    runtime.register(registration({
      serviceId: 'service-a',
      ownerId: 'owner-b',
      requestKey: 'b',
      now: 1_100,
    }));
    runtime.register(registration({
      serviceId: 'service-b',
      ownerId: 'owner-b',
      requestKey: 'c',
      now: 1_200,
    }));
    expect(runtime.snapshot()).toMatchObject({ services: 2, owners: 2, tracked: 3 });
  });

  it('returns undefined for malformed or unknown query identifiers', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    expect(runtime.get(-1)).toBeUndefined();
    expect(runtime.get(99)).toBeUndefined();
  });

  it('disposes deterministically and rejects subsequent mutations', () => {
    const runtime = createSpatialQueryLifecycleRuntime();
    runtime.register(registration({ requestKey: 'a' }));
    runtime.register(registration({ requestKey: 'b', now: 1_100 }));

    expect(runtime.dispose()).toBe(2);
    expect(runtime.dispose()).toBe(0);
    expect(runtime.snapshot().tracked).toBe(0);
    expect(runtime.events()).toHaveLength(0);
    expect(() => runtime.register(registration({ requestKey: 'c', now: 1_200 }))).toThrow();
  });
});
