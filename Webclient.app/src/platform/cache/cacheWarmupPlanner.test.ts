import { describe, expect, it } from 'vitest';
import { CacheWarmupPlanner } from './cacheWarmupPlanner';

const pressure = {
  entries: 10,
  bytes: 1000,
  maxEntries: 100,
  maxBytes: 10000,
};

describe('CacheWarmupPlanner', () => {
  it('selects high-reuse candidates before low-value work', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 3, maxWarmupBytes: 10000 });
    const plan = planner.plan(pressure, [
      {
        key: 'low',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.1,
        loadCost: 0.1,
      },
      {
        key: 'high',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.95,
        loadCost: 0.8,
      },
      {
        key: 'medium',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.6,
        loadCost: 0.5,
      },
    ]);

    expect(plan.suppressed).toBe(false);
    expect(plan.selected.map((item) => item.key)).toEqual(['high', 'medium', 'low']);
    expect(plan.estimatedBytes).toBe(300);
  });

  it('suppresses all warmup when pressure is high', () => {
    const planner = new CacheWarmupPlanner();
    const plan = planner.plan({
      entries: 90,
      bytes: 9000,
      maxEntries: 100,
      maxBytes: 10000,
    }, [{
      key: 'high',
      namespace: 'catalog',
      estimatedBytes: 100,
      expectedReuse: 1,
      loadCost: 1,
    }]);

    expect(plan.suppressed).toBe(true);
    expect(plan.selected).toEqual([]);
    expect(plan.rejected).toBe(1);
    expect(plan.pressure.level).toBe('high');
  });

  it('honors a total warmup byte budget', () => {
    const planner = new CacheWarmupPlanner({
      maxSelected: 10,
      maxWarmupBytes: 500,
    });
    const plan = planner.plan(pressure, [
      {
        key: 'a',
        namespace: 'catalog',
        estimatedBytes: 300,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'b',
        namespace: 'catalog',
        estimatedBytes: 300,
        expectedReuse: 0.9,
        loadCost: 0.9,
      },
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.estimatedBytes).toBe(300);
    expect(plan.rejected).toBe(1);
  });

  it('caps selected entries per namespace', () => {
    const planner = new CacheWarmupPlanner({
      maxSelected: 4,
      maxPerNamespace: 1,
    });
    const plan = planner.plan(pressure, [
      {
        key: 'catalog-a',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'catalog-b',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.9,
        loadCost: 0.9,
      },
      {
        key: 'search-a',
        namespace: 'search',
        estimatedBytes: 100,
        expectedReuse: 0.8,
        loadCost: 0.8,
      },
    ]);

    expect(plan.selected.map((item) => item.namespace)).toEqual(['catalog', 'search']);
    expect(plan.rejected).toBe(1);
  });

  it('deduplicates the same namespace and key identity', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 4 });
    const plan = planner.plan(pressure, [
      {
        key: 'same',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'same',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.8,
        loadCost: 0.8,
      },
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.rejected).toBe(1);
  });

  it('allows the same key in different namespaces', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 4 });
    const plan = planner.plan(pressure, [
      {
        key: 'same',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'same',
        namespace: 'search',
        estimatedBytes: 100,
        expectedReuse: 0.9,
        loadCost: 0.9,
      },
    ]);

    expect(plan.selected).toHaveLength(2);
  });

  it('uses priority as a deterministic tie breaker', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 2 });
    const plan = planner.plan(pressure, [
      {
        key: 'normal',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.5,
        loadCost: 0.5,
        priority: 0,
      },
      {
        key: 'urgent',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.5,
        loadCost: 0.5,
        priority: 100,
      },
    ]);

    expect(plan.selected[0]?.key).toBe('urgent');
  });

  it('prefers smaller candidates when utility is otherwise identical', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 2 });
    const plan = planner.plan(pressure, [
      {
        key: 'large',
        namespace: 'catalog',
        estimatedBytes: 100000,
        expectedReuse: 0.8,
        loadCost: 0.8,
      },
      {
        key: 'small',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 0.8,
        loadCost: 0.8,
      },
    ]);

    expect(plan.selected[0]?.key).toBe('small');
  });

  it('stops admission at maxSelected', () => {
    const planner = new CacheWarmupPlanner({ maxSelected: 1 });
    const plan = planner.plan(pressure, [
      {
        key: 'a',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'b',
        namespace: 'search',
        estimatedBytes: 100,
        expectedReuse: 0.9,
        loadCost: 0.9,
      },
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.rejected).toBe(1);
  });

  it('returns immutable selected collections', () => {
    const planner = new CacheWarmupPlanner();
    const plan = planner.plan(pressure, [{
      key: 'a',
      namespace: 'catalog',
      estimatedBytes: 100,
      expectedReuse: 1,
      loadCost: 1,
    }]);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selected)).toBe(true);
    expect(Object.isFrozen(plan.selected[0])).toBe(true);
  });

  it('rejects too many candidates rather than silently truncating', () => {
    const planner = new CacheWarmupPlanner({ maxCandidates: 1 });
    expect(() => planner.plan(pressure, [
      {
        key: 'a',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
      {
        key: 'b',
        namespace: 'catalog',
        estimatedBytes: 100,
        expectedReuse: 1,
        loadCost: 1,
      },
    ])).toThrow('candidate capacity exceeded');
  });

  it('rejects invalid candidate bounds', () => {
    const planner = new CacheWarmupPlanner();
    expect(() => planner.plan(pressure, [{
      key: 'a',
      namespace: 'catalog',
      estimatedBytes: 0,
      expectedReuse: 1,
      loadCost: 1,
    }])).toThrow(RangeError);
    expect(() => planner.plan(pressure, [{
      key: 'a',
      namespace: 'catalog',
      estimatedBytes: 100,
      expectedReuse: 2,
      loadCost: 1,
    }])).toThrow(RangeError);
    expect(() => planner.plan(pressure, [{
      key: 'a',
      namespace: 'catalog',
      estimatedBytes: 100,
      expectedReuse: 1,
      loadCost: -1,
    }])).toThrow(RangeError);
    expect(() => planner.plan(pressure, [{
      key: 'a',
      namespace: 'catalog',
      estimatedBytes: 100,
      expectedReuse: 1,
      loadCost: 1,
      priority: 101,
    }])).toThrow(RangeError);
  });

  it('rejects unsafe planner configuration', () => {
    expect(() => new CacheWarmupPlanner({ maxCandidates: 0 })).toThrow(RangeError);
    expect(() => new CacheWarmupPlanner({ maxSelected: 0 })).toThrow(RangeError);
    expect(() => new CacheWarmupPlanner({ maxWarmupBytes: 0 })).toThrow(RangeError);
    expect(() => new CacheWarmupPlanner({ maxSelected: 2, maxPerNamespace: 3 }))
      .toThrow(RangeError);
  });
});
