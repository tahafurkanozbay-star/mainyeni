import { describe, expect, it } from 'vitest';
import {
  ResourceCapacityError,
  createResourceLifecycleRegistry,
} from './resourceLifecycleRegistry';

const clock = () => {
  let value = 1_000;
  return {
    now: () => value,
    advance: (delta: number) => { value += delta; },
  };
};

describe('resourceLifecycleRegistry', () => {
  it('tracks deterministic lifecycle transitions without retaining metadata in snapshots', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({
      maxResources: 4,
      maxWeight: 10,
      maxIdleMs: 100,
      maxLeaseMs: 1_000,
    }, time.now);

    const lease = registry.reserve({
      key: ' map-view ',
      scope: ' map ',
      priority: 'interactive',
      weight: 3,
      metadata: { token: 'must-not-be-exposed', revision: 2 },
    });

    expect(lease.key).toBe('map-view');
    expect(lease.scope).toBe('map');
    expect(registry.snapshot()).toMatchObject({ reserved: 1, active: 0, totalWeight: 3, admitted: 1 });
    expect(registry.snapshot().resources[0]).not.toHaveProperty('metadata');

    time.advance(10);
    expect(lease.activate()).toBe(true);
    expect(registry.snapshot().resources[0]).toMatchObject({ state: 'active', touchedAt: 1_010 });

    time.advance(10);
    expect(lease.touch()).toBe(true);
    expect(registry.snapshot().resources[0]?.touchedAt).toBe(1_020);

    time.advance(10);
    expect(lease.idle()).toBe(true);
    expect(registry.snapshot()).toMatchObject({ idle: 1, active: 0 });

    expect(lease.retire()).toBe(true);
    expect(registry.snapshot()).toMatchObject({ retiring: 1 });
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(registry.snapshot()).toMatchObject({ retiring: 0, retired: 1, totalWeight: 0 });
  });

  it('expires idle resources after bounded inactivity', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({
      maxResources: 3,
      maxWeight: 6,
      maxIdleMs: 50,
      maxLeaseMs: 1_000,
    }, time.now);
    const lease = registry.reserve({ key: 'labels', weight: 2 });
    lease.activate();
    lease.idle();
    time.advance(51);

    expect(registry.sweep()).toBe(1);
    expect(registry.snapshot()).toMatchObject({ idle: 0, expired: 1, totalWeight: 0 });
    expect(lease.touch()).toBe(false);
  });

  it('expires active resources when the renewable lease deadline passes', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({
      maxResources: 3,
      maxWeight: 6,
      maxIdleMs: 500,
      maxLeaseMs: 100,
    }, time.now);
    const lease = registry.reserve({ key: 'camera' });
    lease.activate();
    time.advance(80);
    expect(lease.touch()).toBe(true);
    time.advance(99);
    expect(registry.sweep()).toBe(0);
    time.advance(2);
    expect(registry.sweep()).toBe(1);
    expect(registry.snapshot().expired).toBe(1);
  });

  it('evicts oldest lowest-priority idle resources before rejecting capacity', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({
      maxResources: 2,
      maxWeight: 4,
      maxIdleMs: 10_000,
      maxLeaseMs: 20_000,
    }, time.now);

    const first = registry.reserve({ key: 'prefetch', priority: 'background', weight: 2 });
    first.idle();
    time.advance(1);
    const second = registry.reserve({ key: 'selection', priority: 'normal', weight: 2 });
    second.idle();
    time.advance(1);

    const third = registry.reserve({ key: 'interaction', priority: 'interactive', weight: 2 });
    expect(third.activate()).toBe(true);
    const snapshot = registry.snapshot();
    expect(snapshot.resources.map((resource) => resource.key)).toEqual(['selection', 'interaction']);
    expect(snapshot.evicted).toBe(1);
    expect(first.touch()).toBe(false);
    expect(second.touch()).toBe(true);
  });

  it('never evicts critical idle resources', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 1,
      maxWeight: 2,
      maxIdleMs: 10_000,
      maxLeaseMs: 20_000,
    });
    const critical = registry.reserve({ key: 'shell', priority: 'critical', weight: 2 });
    critical.idle();

    expect(() => registry.reserve({ key: 'background', weight: 1 })).toThrow(ResourceCapacityError);
    expect(registry.snapshot()).toMatchObject({ rejected: 1, evicted: 0, idle: 1 });
  });

  it('enforces scope cardinality and evicts only a repairable scope when global capacity is free', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 5,
      maxWeight: 10,
      maxIdleMs: 10_000,
      maxLeaseMs: 20_000,
      maxPerScope: { scene: 1 },
    });
    const scene = registry.reserve({ key: 'scene-a', scope: 'scene', priority: 'background' });
    scene.idle();
    const map = registry.reserve({ key: 'map-a', scope: 'map', priority: 'background' });
    map.idle();

    registry.reserve({ key: 'scene-b', scope: 'scene' });
    const snapshot = registry.snapshot();
    expect(snapshot.resources.map((resource) => resource.key).sort()).toEqual(['map-a', 'scene-b']);
    expect(snapshot.evicted).toBe(1);
    expect(map.touch()).toBe(true);
    expect(scene.touch()).toBe(false);
  });

  it('rejects scope overflow when the existing scoped resource cannot be evicted', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 5,
      maxWeight: 10,
      maxIdleMs: 10_000,
      maxLeaseMs: 20_000,
      maxPerScope: { shell: 1 },
    });
    registry.reserve({ key: 'shell-a', scope: 'shell', priority: 'critical' }).activate();
    expect(() => registry.reserve({ key: 'shell-b', scope: 'shell' })).toThrowError(
      'Runtime resource capacity is exhausted.',
    );
    expect(registry.snapshot().rejected).toBe(1);
  });

  it('uses weight pressure as an independent capacity boundary', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 10,
      maxWeight: 4,
      maxIdleMs: 10_000,
      maxLeaseMs: 20_000,
    });
    const heavy = registry.reserve({ key: 'tiles', weight: 3, priority: 'background' });
    heavy.idle();
    registry.reserve({ key: 'labels', weight: 3 });
    const snapshot = registry.snapshot();
    expect(snapshot.resources.map((resource) => resource.key)).toEqual(['labels']);
    expect(snapshot.totalWeight).toBe(3);
    expect(snapshot.evicted).toBe(1);
  });

  it('retires a complete scope deterministically', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 8,
      maxWeight: 8,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    registry.reserve({ key: 'a', scope: 'map' });
    registry.reserve({ key: 'b', scope: 'map' });
    registry.reserve({ key: 'c', scope: 'scene' });

    expect(registry.retireScope(' map ')).toBe(2);
    expect(registry.snapshot().resources.map((resource) => resource.key)).toEqual(['c']);
    expect(registry.snapshot().retired).toBe(2);
  });

  it('retires all generations sharing a normalized key', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 8,
      maxWeight: 8,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    const first = registry.reserve({ key: 'shared', scope: 'map' });
    const second = registry.reserve({ key: ' shared ', scope: 'scene' });
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(registry.retireKey(' shared ')).toBe(2);
    expect(registry.snapshot()).toMatchObject({ retired: 2, totalWeight: 0 });
    expect(first.activate()).toBe(false);
    expect(second.activate()).toBe(false);
  });

  it('isolates stale handles from newer generations', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 4,
      maxWeight: 4,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    const first = registry.reserve({ key: 'view' });
    expect(first.release()).toBe(true);
    const second = registry.reserve({ key: 'view' });
    expect(second.generation).toBe(2);
    expect(first.touch()).toBe(false);
    expect(first.release()).toBe(false);
    expect(second.activate()).toBe(true);
    expect(registry.snapshot().resources[0]).toMatchObject({ generation: 2, state: 'active' });
  });

  it('normalizes invalid positive policy and weight values to safe finite defaults', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: Number.NaN,
      maxWeight: Number.POSITIVE_INFINITY,
      maxIdleMs: -1,
      maxLeaseMs: 0,
    });
    const lease = registry.reserve({ key: 'safe', weight: Number.NaN });
    expect(registry.snapshot()).toMatchObject({ totalWeight: 1, reserved: 1 });
    expect(lease.release()).toBe(true);
  });

  it('bounds resource keys and scopes before storing authority state', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 2,
      maxWeight: 2,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    registry.reserve({ key: `  ${'k'.repeat(300)}  `, scope: ` ${'s'.repeat(200)} ` });
    const resource = registry.snapshot().resources[0];
    expect(resource?.key).toHaveLength(160);
    expect(resource?.scope).toHaveLength(80);
  });

  it('rejects empty normalized keys without mutating capacity counters', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 2,
      maxWeight: 2,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    expect(() => registry.reserve({ key: '   ' })).toThrow('Resource key is required.');
    expect(registry.snapshot()).toMatchObject({ admitted: 0, rejected: 0, totalWeight: 0 });
  });

  it('makes disposal terminal and invalidates outstanding leases', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 2,
      maxWeight: 2,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    const lease = registry.reserve({ key: 'runtime' });
    registry.dispose();
    registry.dispose();
    expect(lease.activate()).toBe(false);
    expect(lease.release()).toBe(false);
    expect(registry.snapshot()).toMatchObject({ admitted: 1, retired: 1, totalWeight: 0 });
    expect(() => registry.reserve({ key: 'late' })).toThrow('Resource registry is disposed.');
  });

  it('returns immutable snapshot containers', () => {
    const registry = createResourceLifecycleRegistry({
      maxResources: 2,
      maxWeight: 2,
      maxIdleMs: 1_000,
      maxLeaseMs: 2_000,
    });
    registry.reserve({ key: 'immutable' });
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
    expect(Object.isFrozen(snapshot.resources[0])).toBe(true);
  });
});
