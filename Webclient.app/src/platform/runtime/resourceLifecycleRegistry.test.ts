import { describe, expect, it } from 'vitest';
import { ResourceCapacityError, createResourceLifecycleRegistry } from './resourceLifecycleRegistry';

const clock = () => { let value = 1_000; return { now: () => value, advance: (delta: number) => { value += delta; } }; };

describe('resourceLifecycleRegistry', () => {
  it('tracks lifecycle transitions without exposing metadata', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({ maxResources: 4, maxWeight: 10, maxIdleMs: 100, maxLeaseMs: 1_000 }, time.now);
    const lease = registry.reserve({ key: ' map-view ', scope: ' map ', priority: 'interactive', weight: 3, metadata: { token: 'private', revision: 2 } });
    expect(lease.key).toBe('map-view'); expect(lease.scope).toBe('map');
    expect(registry.snapshot()).toMatchObject({ reserved: 1, active: 0, totalWeight: 3, admitted: 1 });
    expect(registry.snapshot().resources[0]).not.toHaveProperty('metadata');
    time.advance(10); expect(lease.activate()).toBe(true);
    time.advance(10); expect(lease.touch()).toBe(true);
    time.advance(10); expect(lease.idle()).toBe(true);
    expect(lease.retire()).toBe(true); expect(lease.release()).toBe(true); expect(lease.release()).toBe(false);
    expect(registry.snapshot()).toMatchObject({ retiring: 0, retired: 1, totalWeight: 0 });
  });

  it('expires idle and stale active resources', () => {
    const time = clock();
    const registry = createResourceLifecycleRegistry({ maxResources: 3, maxWeight: 6, maxIdleMs: 50, maxLeaseMs: 100 }, time.now);
    const idle = registry.reserve({ key: 'labels', weight: 2 }); idle.activate(); idle.idle(); time.advance(51);
    expect(registry.sweep()).toBe(1); expect(idle.touch()).toBe(false);
    const active = registry.reserve({ key: 'camera' }); active.activate(); time.advance(101);
    expect(registry.sweep()).toBe(1); expect(registry.snapshot().expired).toBe(2);
  });

  it('evicts low-priority idle resources but protects critical resources', () => {
    const registry = createResourceLifecycleRegistry({ maxResources: 2, maxWeight: 4, maxIdleMs: 10_000, maxLeaseMs: 20_000 });
    const first = registry.reserve({ key: 'prefetch', priority: 'background', weight: 2 }); first.idle();
    const second = registry.reserve({ key: 'selection', priority: 'normal', weight: 2 }); second.idle();
    registry.reserve({ key: 'interaction', priority: 'interactive', weight: 2 });
    expect(registry.snapshot().resources.map((resource) => resource.key)).toEqual(['selection', 'interaction']);
    expect(registry.snapshot().evicted).toBe(1);
    const protectedRegistry = createResourceLifecycleRegistry({ maxResources: 1, maxWeight: 2, maxIdleMs: 10_000, maxLeaseMs: 20_000 });
    protectedRegistry.reserve({ key: 'shell', priority: 'critical', weight: 2 }).idle();
    expect(() => protectedRegistry.reserve({ key: 'background' })).toThrow(ResourceCapacityError);
  });

  it('enforces scope and weight capacity independently', () => {
    const registry = createResourceLifecycleRegistry({ maxResources: 5, maxWeight: 4, maxIdleMs: 10_000, maxLeaseMs: 20_000, maxPerScope: { scene: 1 } });
    const scene = registry.reserve({ key: 'scene-a', scope: 'scene', priority: 'background', weight: 2 }); scene.idle();
    registry.reserve({ key: 'scene-b', scope: 'scene', weight: 2 });
    expect(scene.touch()).toBe(false);
    const current = registry.snapshot(); expect(current.resources.map((resource) => resource.key)).toEqual(['scene-b']);
  });

  it('retires scope and normalized key deterministically', () => {
    const registry = createResourceLifecycleRegistry({ maxResources: 8, maxWeight: 8, maxIdleMs: 1_000, maxLeaseMs: 2_000 });
    registry.reserve({ key: 'a', scope: 'map' }); registry.reserve({ key: 'b', scope: 'map' }); registry.reserve({ key: 'c', scope: 'scene' });
    expect(registry.retireScope(' map ')).toBe(2); expect(registry.snapshot().resources.map((resource) => resource.key)).toEqual(['c']);
    const first = registry.reserve({ key: 'shared', scope: 'map' }); const second = registry.reserve({ key: ' shared ', scope: 'scene' });
    expect(second.generation).toBe(2); expect(registry.retireKey(' shared ')).toBe(2); expect(first.activate()).toBe(false);
  });

  it('bounds identifiers, normalizes invalid numeric policy, and makes disposal terminal', () => {
    const registry = createResourceLifecycleRegistry({ maxResources: Number.NaN, maxWeight: Number.POSITIVE_INFINITY, maxIdleMs: -1, maxLeaseMs: 0 });
    const lease = registry.reserve({ key: `  ${'k'.repeat(300)}  `, scope: ` ${'s'.repeat(200)} `, weight: Number.NaN });
    const resource = registry.snapshot().resources[0]; expect(resource?.key).toHaveLength(160); expect(resource?.scope).toHaveLength(80);
    expect(Object.isFrozen(registry.snapshot())).toBe(true); registry.dispose(); registry.dispose();
    expect(lease.activate()).toBe(false); expect(() => registry.reserve({ key: 'late' })).toThrow('Resource registry is disposed.');
  });

  it('rejects empty normalized keys without consuming capacity', () => {
    const registry = createResourceLifecycleRegistry({ maxResources: 2, maxWeight: 2, maxIdleMs: 1_000, maxLeaseMs: 2_000 });
    expect(() => registry.reserve({ key: '   ' })).toThrow('Resource key is required.');
    expect(registry.snapshot()).toMatchObject({ admitted: 0, rejected: 0, totalWeight: 0 });
  });
});
