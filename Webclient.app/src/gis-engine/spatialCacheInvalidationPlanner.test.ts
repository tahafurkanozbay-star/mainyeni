import { describe, expect, it } from 'vitest';
import { createSpatialCacheInvalidationPlanner, normalizeSpatialCacheInvalidationPlannerPolicy } from './spatialCacheInvalidationPlanner';

const envelope = (xmin: number, ymin: number, xmax: number, ymax: number, wkid = 3857) => ({
  xmin,
  ymin,
  xmax,
  ymax,
  spatialReferenceWkid: wkid,
});

const dependency = (cacheKey: string, xmin: number, xmax: number, objectIds: readonly number[] = []) => ({
  cacheKey,
  serviceId: 'parks',
  layerId: 2,
  envelope: envelope(xmin, 0, xmax, 10),
  objectIds,
  tags: ['service:parks', 'layer:2'],
});

describe('normalizeSpatialCacheInvalidationPlannerPolicy', () => {
  it('returns bounded immutable defaults', () => {
    const policy = normalizeSpatialCacheInvalidationPlannerPolicy();
    expect(policy.maxTrackedEntries).toBeGreaterThan(0);
    expect(policy.maxObjectIdsPerEntry).toBeGreaterThan(0);
    expect(policy.maxInvalidationKeys).toBeGreaterThan(0);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('rejects zero, fractional and excessive budgets', () => {
    expect(() => normalizeSpatialCacheInvalidationPlannerPolicy({ maxTrackedEntries: 0 })).toThrow();
    expect(() => normalizeSpatialCacheInvalidationPlannerPolicy({ maxObjectIdsPerEntry: 1.5 })).toThrow();
    expect(() => normalizeSpatialCacheInvalidationPlannerPolicy({ maxInvalidationKeys: 100_001 })).toThrow();
  });
});

describe('createSpatialCacheInvalidationPlanner', () => {
  it('plans only dependencies whose extents intersect a mutation extent', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('west', 0, 10));
    planner.register(dependency('east', 20, 30));
    const plan = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      envelope: envelope(5, 5, 15, 8),
    });
    expect(plan).toMatchObject({ keys: ['west'], reason: 'extent-overlap', truncated: false, examined: 2 });
  });

  it('treats touching extent boundaries as overlapping', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('touching', 0, 10));
    const plan = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      envelope: envelope(10, 2, 20, 4),
    });
    expect(plan.keys).toEqual(['touching']);
  });

  it('does not intersect envelopes with different explicit spatial references', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('mercator', 0, 10));
    const plan = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      envelope: envelope(0, 0, 10, 10, 4326),
    });
    expect(plan.keys).toEqual([]);
    expect(plan.reason).toBe('none');
  });

  it('matches stable object identities independently of extent overlap', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('contains-42', 0, 10, [41, 42]));
    planner.register(dependency('contains-7', 0, 10, [7]));
    const plan = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      objectIds: [42],
    });
    expect(plan).toMatchObject({ keys: ['contains-42'], reason: 'object-id-overlap' });
  });

  it('uses layer-wide invalidation when a mutation has no narrower evidence', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 20, 30));
    const plan = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'unknown' });
    expect(plan.keys).toEqual(['a', 'b']);
    expect(plan.reason).toBe('layer-wide');
  });

  it('invalidates the entire layer for schema changes even with spatial evidence', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 20, 30));
    const plan = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'schema',
      envelope: envelope(0, 0, 1, 1),
    });
    expect(plan.keys).toEqual(['a', 'b']);
    expect(plan.reason).toBe('schema');
  });

  it('keeps services and layers isolated', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('parks-2', 0, 10));
    planner.register({ ...dependency('parks-3', 0, 10), layerId: 3 });
    planner.register({ ...dependency('roads-2', 0, 10), serviceId: 'roads' });
    const plan = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'delete' });
    expect(plan.keys).toEqual(['parks-2']);
  });

  it('normalizes and deduplicates tags for deterministic tag invalidation', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register({ ...dependency('a', 0, 10), tags: [' selected ', 'selected', 'layer:2'] });
    planner.register({ ...dependency('b', 20, 30), tags: ['layer:2'] });
    const plan = planner.invalidateTag('selected');
    expect(plan.keys).toEqual(['a']);
    expect(plan.reason).toBe('layer-wide');
  });

  it('returns an empty deterministic plan for a blank tag', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    expect(planner.invalidateTag('   ')).toMatchObject({ keys: [], reason: 'none', examined: 0 });
  });

  it('replaces an existing cache key without growing tracked entries', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('same', 0, 10));
    planner.register(dependency('same', 20, 30));
    expect(planner.snapshot()).toMatchObject({ trackedEntries: 1, registrations: 2, replacements: 1 });
    const west = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      envelope: envelope(0, 0, 10, 10),
    });
    const east = planner.plan({
      serviceId: 'parks',
      layerId: 2,
      mutation: 'update',
      envelope: envelope(20, 0, 30, 10),
    });
    expect(west.keys).toEqual([]);
    expect(east.keys).toEqual(['same']);
  });

  it('evicts the oldest registration when the tracking budget is exceeded', () => {
    const planner = createSpatialCacheInvalidationPlanner({ maxTrackedEntries: 2 });
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 20, 30));
    planner.register(dependency('c', 40, 50));
    expect(planner.snapshot()).toMatchObject({ trackedEntries: 2, evictions: 1 });
    const plan = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'schema' });
    expect(plan.keys).toEqual(['b', 'c']);
  });

  it('caps invalidation output and reports truncation instead of allocating without bound', () => {
    const planner = createSpatialCacheInvalidationPlanner({ maxInvalidationKeys: 2 });
    planner.register(dependency('c', 0, 10));
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 0, 10));
    const plan = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'schema' });
    expect(plan.keys).toEqual(['a', 'c']);
    expect(plan.truncated).toBe(true);
    expect(planner.snapshot().truncatedPlans).toBe(1);
  });

  it('rejects dependencies with invalid coordinates and inverted envelopes', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    expect(() => planner.register({ ...dependency('nan', 0, 10), envelope: envelope(Number.NaN, 0, 10, 10) })).toThrow();
    expect(() => planner.register({ ...dependency('inverted', 0, 10), envelope: envelope(10, 0, 1, 10) })).toThrow();
  });

  it('rejects negative and non-integer object identities', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    expect(() => planner.register({ ...dependency('negative', 0, 10), objectIds: [-1] })).toThrow();
    expect(() => planner.register({ ...dependency('fractional', 0, 10), objectIds: [1.5] })).toThrow();
  });

  it('rejects object identity lists beyond the configured memory budget', () => {
    const planner = createSpatialCacheInvalidationPlanner({ maxObjectIdsPerEntry: 2 });
    expect(() => planner.register({ ...dependency('too-many', 0, 10), objectIds: [1, 2, 3] })).toThrow();
  });

  it('unregisters entries idempotently and updates generation only on mutation', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    const before = planner.snapshot().generation;
    expect(planner.unregister('a')).toBe(true);
    const after = planner.snapshot().generation;
    expect(after).toBe(before + 1);
    expect(planner.unregister('a')).toBe(false);
    expect(planner.snapshot().generation).toBe(after);
  });

  it('clears tracked dependencies without resetting bounded diagnostics', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 20, 30));
    planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'schema' });
    planner.clear();
    expect(planner.snapshot()).toMatchObject({ trackedEntries: 0, registrations: 2, plans: 1, plannedKeys: 2 });
  });

  it('sorts returned keys so invalidation order does not depend on registration order', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('z', 0, 10));
    planner.register(dependency('m', 0, 10));
    planner.register(dependency('a', 0, 10));
    const plan = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'schema' });
    expect(plan.keys).toEqual(['a', 'm', 'z']);
  });

  it('records examined dependencies and cumulative planned-key diagnostics', () => {
    const planner = createSpatialCacheInvalidationPlanner();
    planner.register(dependency('a', 0, 10));
    planner.register(dependency('b', 20, 30));
    const first = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'schema' });
    const second = planner.plan({ serviceId: 'parks', layerId: 2, mutation: 'delete', objectIds: [999] });
    expect(first.examined).toBe(2);
    expect(second.examined).toBe(2);
    expect(planner.snapshot()).toMatchObject({ plans: 2, plannedKeys: 2 });
  });
});
