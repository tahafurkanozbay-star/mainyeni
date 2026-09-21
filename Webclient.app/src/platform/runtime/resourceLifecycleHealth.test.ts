import { vi } from 'vitest';
import {
  createResourceLifecycleHealthMonitor,
  evaluateResourceLifecycleHealth,
  lifecycleHealthFromStaleEntries,
  type ResourceLifecycleHealthPolicy,
} from './resourceLifecycleHealth';
import { createResourceScopeRegistry } from './resourceScopeRegistry';
import type {
  ResourceScopeClock,
  ResourceScopeSnapshot,
} from './resourceScope';

const createClock = (startAt = 1_000) => {
  let now = startAt;
  let timerSequence = 0;
  const timers = new Map<number, () => void>();
  const clock: ResourceScopeClock & {
    advance(milliseconds: number): void;
    rewind(milliseconds: number): void;
    fireAll(): void;
  } = {
    now: () => now,
    setTimeout: (callback) => {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(Number(handle));
    },
    advance: (milliseconds) => { now += milliseconds; },
    rewind: (milliseconds) => { now -= milliseconds; },
    fireAll: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
  return clock;
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const defaultPolicy = (): Partial<ResourceLifecycleHealthPolicy> => ({
  staleScopeWarningCount: 1,
  staleScopeCriticalCount: 3,
  activeResourceWarningCount: 3,
  activeResourceCriticalCount: 6,
  cleanupFailureWarningCount: 1,
  cleanupFailureCriticalCount: 3,
  cleanupTimeoutWarningCount: 1,
  cleanupTimeoutCriticalCount: 2,
  observerFailureWarningCount: 2,
  observerFailureCriticalCount: 4,
  maxRiskEntries: 16,
});

const syntheticSnapshot = (
  overrides: Partial<ReturnType<ReturnType<typeof createResourceScopeRegistry>['snapshot']>> = {},
) => Object.freeze({
  disposed: false,
  activeScopes: 0,
  activeOwners: 0,
  created: 0,
  closed: 0,
  rejected: 0,
  cleanupFailures: 0,
  staleScopes: 0,
  entries: Object.freeze([]),
  history: Object.freeze([]),
  ...overrides,
});

const syntheticScopeSnapshot = (
  overrides: Partial<ResourceScopeSnapshot> = {},
): ResourceScopeSnapshot => Object.freeze({
  name: 'scope',
  state: 'open',
  createdAt: 1_000,
  activeResources: 0,
  activeOwners: 0,
  childScopes: 0,
  counters: Object.freeze({
    registered: 0,
    released: 0,
    failed: 0,
    timedOut: 0,
    rejected: 0,
    observerFailures: 0,
  }),
  resources: Object.freeze([]),
  history: Object.freeze([]),
  events: Object.freeze([]),
  ...overrides,
});

describe('evaluateResourceLifecycleHealth baseline', () => {
  test('classifies an empty registry as healthy', () => {
    const registry = createResourceScopeRegistry();
    const health = evaluateResourceLifecycleHealth(registry.snapshot(), defaultPolicy());

    expect(health).toEqual({
      status: 'healthy',
      activeScopes: 0,
      activeOwners: 0,
      activeResources: 0,
      childScopes: 0,
      staleScopes: 0,
      closingScopes: 0,
      failedCleanups: 0,
      timedOutCleanups: 0,
      observerFailures: 0,
      registryCleanupFailures: 0,
      disposed: false,
      risks: [],
    });
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.risks)).toBe(true);
  });

  test('counts active scopes, owners, resources and children', () => {
    const registry = createResourceScopeRegistry({
      maxScopes: 3,
      maxOwnerScopes: 3,
      staleAfterMs: 10_000,
    });
    const first = registry.create({ name: 'map', owner: 'gis' });
    const second = registry.create({ name: 'search', owner: 'search' });
    first.register({ owner: 'map', key: 'watch', cleanup: vi.fn() });
    first.register({ owner: 'map', key: 'listener', cleanup: vi.fn() });
    second.register({ owner: 'search', key: 'subscription', cleanup: vi.fn() });
    first.child('popup');

    const health = evaluateResourceLifecycleHealth(registry.snapshot(), {
      ...defaultPolicy(),
      activeResourceWarningCount: 4,
      activeResourceCriticalCount: 8,
    });

    expect(health).toEqual(expect.objectContaining({
      status: 'healthy',
      activeScopes: 2,
      activeOwners: 2,
      activeResources: 3,
      childScopes: 1,
    }));
  });

  test('does not expose resource labels, metadata or cleanup error messages', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({
      name: 'map-runtime',
      owner: 'gis',
      metadata: { token: 'private-token' },
    });
    const handle = scope.register({
      owner: 'map',
      key: 'secret-resource',
      metadata: { password: 'private-password' },
      cleanup: () => { throw new Error('private cleanup detail'); },
    });
    await expect(handle.release()).rejects.toBeDefined();

    const serialized = JSON.stringify(
      evaluateResourceLifecycleHealth(registry.snapshot(), defaultPolicy()),
    );
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-password');
    expect(serialized).not.toContain('private cleanup detail');
    expect(serialized).not.toContain('secret-resource');
  });
});

describe('evaluateResourceLifecycleHealth pressure signals', () => {
  test('degrades when stale scope count reaches warning threshold', () => {
    const snapshot = syntheticSnapshot({ staleScopes: 1 });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.status).toBe('degraded');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'stale-scope',
      status: 'degraded',
      count: 1,
      threshold: 1,
    }));
  });

  test('becomes critical when stale scope count reaches critical threshold', () => {
    const snapshot = syntheticSnapshot({ staleScopes: 3 });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.status).toBe('critical');
    expect(health.risks[0]).toEqual(expect.objectContaining({
      code: 'stale-scope',
      status: 'critical',
      count: 3,
      threshold: 3,
    }));
  });

  test('degrades under active resource pressure', () => {
    const snapshot = syntheticSnapshot({
      activeScopes: 1,
      activeOwners: 1,
      entries: Object.freeze([Object.freeze({
        name: 'map',
        owner: 'gis',
        createdAt: 1_000,
        ageMs: 10,
        metadata: Object.freeze({}),
        scope: syntheticScopeSnapshot({ activeResources: 3 }),
      })]),
    });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.status).toBe('degraded');
    expect(health.activeResources).toBe(3);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'active-resource-pressure',
      scopeCount: 1,
      status: 'degraded',
    }));
  });

  test('becomes critical under active resource pressure', () => {
    const snapshot = syntheticSnapshot({
      activeScopes: 2,
      activeOwners: 1,
      entries: Object.freeze([
        Object.freeze({
          name: 'map',
          owner: 'gis',
          createdAt: 1_000,
          ageMs: 10,
          metadata: Object.freeze({}),
          scope: syntheticScopeSnapshot({ activeResources: 4 }),
        }),
        Object.freeze({
          name: 'layers',
          owner: 'gis',
          createdAt: 1_000,
          ageMs: 10,
          metadata: Object.freeze({}),
          scope: syntheticScopeSnapshot({ activeResources: 2 }),
        }),
      ]),
    });

    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());
    expect(health.status).toBe('critical');
    expect(health.activeResources).toBe(6);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'active-resource-pressure',
      status: 'critical',
      scopeCount: 2,
    }));
  });

  test('elevates combined stale scope and resource pressure to critical', () => {
    const snapshot = syntheticSnapshot({
      staleScopes: 3,
      activeScopes: 1,
      activeOwners: 1,
      entries: Object.freeze([Object.freeze({
        name: 'map',
        owner: 'gis',
        createdAt: 1_000,
        ageMs: 5_000,
        metadata: Object.freeze({}),
        scope: syntheticScopeSnapshot({ activeResources: 3 }),
      })]),
    });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'stale-scope-pressure',
      status: 'critical',
    }));
  });

  test('reports closing scopes as degraded lifecycle work', () => {
    const snapshot = syntheticSnapshot({
      activeScopes: 1,
      activeOwners: 1,
      entries: Object.freeze([Object.freeze({
        name: 'closing',
        owner: 'owner',
        createdAt: 1_000,
        ageMs: 10,
        metadata: Object.freeze({}),
        scope: syntheticScopeSnapshot({ state: 'closing' }),
      })]),
    });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.closingScopes).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'closing-scope',
      status: 'degraded',
    }));
  });

  test('flags disposed registry with active scopes as critical invariant break', () => {
    const snapshot = syntheticSnapshot({
      disposed: true,
      activeScopes: 2,
      activeOwners: 1,
    });
    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());

    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'registry-disposed-with-active-scopes',
      count: 2,
    }));
  });
});

describe('evaluateResourceLifecycleHealth cleanup evidence', () => {
  test('degrades after a scoped cleanup failure', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'scope', owner: 'owner' });
    const handle = scope.register({
      owner: 'resource',
      key: 'bad',
      cleanup: () => { throw new Error('failed'); },
    });
    await expect(handle.release()).rejects.toBeDefined();

    const health = evaluateResourceLifecycleHealth(registry.snapshot(), defaultPolicy());
    expect(health.failedCleanups).toBe(1);
    expect(health.status).toBe('degraded');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'cleanup-failure',
      count: 1,
    }));
  });

  test('includes registry-level cleanup failures', () => {
    const health = evaluateResourceLifecycleHealth(
      syntheticSnapshot({ cleanupFailures: 2 }),
      {
        ...defaultPolicy(),
        cleanupFailureCriticalCount: 2,
      },
    );
    expect(health.registryCleanupFailures).toBe(2);
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'cleanup-failure',
      count: 2,
      status: 'critical',
    }));
  });

  test('degrades after a cleanup timeout', async () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry();
    const scope = registry.create({
      name: 'scope',
      owner: 'owner',
      scopeOptions: {
        clock,
        defaultCleanupTimeoutMs: 10,
        maxCleanupTimeoutMs: 100,
      },
    });
    const handle = scope.register({
      owner: 'resource',
      key: 'stuck',
      cleanup: () => new Promise<void>(() => undefined),
    });

    const release = handle.release();
    await flush();
    clock.advance(10);
    clock.fireAll();
    await expect(release).rejects.toBeDefined();

    const health = evaluateResourceLifecycleHealth(registry.snapshot(), defaultPolicy());
    expect(health.timedOutCleanups).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'cleanup-timeout',
      status: 'degraded',
    }));
  });

  test('reports observer failure pressure without breaking scope behavior', async () => {
    const scopeEvents = vi.fn(() => { throw new Error('observer failed'); });
    const registry = createResourceScopeRegistry();
    const scope = registry.create({
      name: 'scope',
      owner: 'owner',
      scopeOptions: { onEvent: scopeEvents },
    });
    const handle = scope.register({
      owner: 'resource',
      key: 'one',
      cleanup: vi.fn(),
    });
    await handle.release();

    const health = evaluateResourceLifecycleHealth(registry.snapshot(), {
      ...defaultPolicy(),
      observerFailureWarningCount: 1,
      observerFailureCriticalCount: 4,
    });
    expect(health.observerFailures).toBeGreaterThanOrEqual(2);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'observer-failure',
    }));
  });
});

describe('evaluateResourceLifecycleHealth policy validation', () => {
  test.each([
    ['staleScopeWarningCount', -1],
    ['activeResourceWarningCount', -1],
    ['cleanupFailureWarningCount', -1],
    ['cleanupTimeoutWarningCount', -1],
    ['observerFailureWarningCount', -1],
    ['maxRiskEntries', 0],
  ] as const)('rejects invalid %s value', (key, value) => {
    expect(() => evaluateResourceLifecycleHealth(
      syntheticSnapshot(),
      { [key]: value },
    )).toThrow(RangeError);
  });

  test('rejects critical threshold below warning threshold', () => {
    expect(() => evaluateResourceLifecycleHealth(syntheticSnapshot(), {
      staleScopeWarningCount: 4,
      staleScopeCriticalCount: 3,
    })).toThrow(RangeError);
  });

  test('bounds retained risk entries', () => {
    const snapshot = syntheticSnapshot({
      disposed: true,
      activeScopes: 10,
      activeOwners: 2,
      staleScopes: 10,
      cleanupFailures: 10,
      entries: Object.freeze([Object.freeze({
        name: 'scope',
        owner: 'owner',
        createdAt: 1,
        ageMs: 100,
        metadata: Object.freeze({}),
        scope: syntheticScopeSnapshot({
          state: 'closing',
          activeResources: 20,
          counters: Object.freeze({
            registered: 20,
            released: 0,
            failed: 10,
            timedOut: 10,
            rejected: 0,
            observerFailures: 10,
          }),
        }),
      })]),
    });

    const health = evaluateResourceLifecycleHealth(snapshot, {
      ...defaultPolicy(),
      maxRiskEntries: 3,
    });
    expect(health.status).toBe('critical');
    expect(health.risks).toHaveLength(3);
    expect(health.risks.every((item) => Object.isFrozen(item))).toBe(true);
  });

  test('orders critical risks before degraded risks', () => {
    const snapshot = syntheticSnapshot({
      staleScopes: 3,
      activeScopes: 1,
      activeOwners: 1,
      entries: Object.freeze([Object.freeze({
        name: 'scope',
        owner: 'owner',
        createdAt: 1,
        ageMs: 100,
        metadata: Object.freeze({}),
        scope: syntheticScopeSnapshot({ state: 'closing' }),
      })]),
    });

    const health = evaluateResourceLifecycleHealth(snapshot, defaultPolicy());
    expect(health.risks[0]?.status).toBe('critical');
    expect(health.risks.at(-1)?.status).toBe('degraded');
  });
});

describe('ResourceLifecycleHealthMonitor sampling', () => {
  test('samples on demand without scheduling background work', () => {
    let now = 10;
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({ now: () => now });

    const first = monitor.sample(registry.snapshot());
    now = 20;
    const second = monitor.sample(registry.snapshot());

    expect(first.sequence).toBe(1);
    expect(first.sampledAt).toBe(10);
    expect(second.sequence).toBe(2);
    expect(second.sampledAt).toBe(20);
    expect(monitor.snapshot().samples).toBe(2);
    expect('setInterval' in monitor).toBe(false);
  });

  test('retains immutable bounded history', () => {
    let now = 100;
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({
      historyLimit: 2,
      now: () => now,
    });

    monitor.sample(registry.snapshot());
    now += 1;
    monitor.sample(registry.snapshot());
    now += 1;
    monitor.sample(registry.snapshot());

    const snapshot = monitor.snapshot();
    expect(snapshot.samples).toBe(3);
    expect(snapshot.history.map((sample) => sample.sequence)).toEqual([2, 3]);
    expect(snapshot.current?.sequence).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.current)).toBe(true);
  });

  test('supports disabling history while retaining current sample', () => {
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({ historyLimit: 0 });

    const sample = monitor.sample(registry.snapshot());
    expect(sample.sequence).toBe(1);
    expect(monitor.snapshot().history).toEqual([]);
    expect(monitor.snapshot().current?.sequence).toBe(1);
  });

  test('reset clears current sample, sequence and monotonic baseline', () => {
    let now = 100;
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({ now: () => now });

    monitor.sample(registry.snapshot());
    monitor.reset();
    now = 50;
    const afterReset = monitor.sample(registry.snapshot());

    expect(afterReset.sequence).toBe(1);
    expect(afterReset.sampledAt).toBe(50);
    expect(monitor.snapshot().history).toHaveLength(1);
  });

  test('rejects non-finite monitor timestamps', () => {
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({
      now: () => Number.NaN,
    });

    expect(() => monitor.sample(registry.snapshot())).toThrow(RangeError);
  });

  test('rejects backward-moving monitor time', () => {
    let now = 100;
    const registry = createResourceScopeRegistry();
    const monitor = createResourceLifecycleHealthMonitor({ now: () => now });
    monitor.sample(registry.snapshot());
    now = 99;

    expect(() => monitor.sample(registry.snapshot())).toThrow(RangeError);
  });

  test('uses fixed policy created at monitor construction', () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'scope', owner: 'owner' });
    scope.register({ owner: 'resource', key: 'one', cleanup: vi.fn() });
    const monitor = createResourceLifecycleHealthMonitor({
      policy: {
        activeResourceWarningCount: 1,
        activeResourceCriticalCount: 2,
      },
    });

    expect(monitor.sample(registry.snapshot()).status).toBe('degraded');
  });
});

describe('lifecycleHealthFromStaleEntries', () => {
  test('summarizes stale entries without retaining identity data', () => {
    const summary = lifecycleHealthFromStaleEntries([
      Object.freeze({
        name: 'map',
        owner: 'gis',
        createdAt: 1,
        ageMs: 500,
        activeResources: 3,
        childScopes: 1,
      }),
      Object.freeze({
        name: 'search',
        owner: 'search',
        createdAt: 2,
        ageMs: 300,
        activeResources: 2,
        childScopes: 0,
      }),
    ]);

    expect(summary).toEqual({
      staleScopes: 2,
      activeResources: 5,
      childScopes: 1,
      oldestAgeMs: 500,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('map');
    expect(JSON.stringify(summary)).not.toContain('gis');
  });

  test('returns zero summary for no stale entries', () => {
    expect(lifecycleHealthFromStaleEntries([])).toEqual({
      staleScopes: 0,
      activeResources: 0,
      childScopes: 0,
      oldestAgeMs: 0,
    });
  });

  test('uses maximum age independent of input ordering', () => {
    const summary = lifecycleHealthFromStaleEntries([
      { name: 'a', owner: 'a', createdAt: 1, ageMs: 10, activeResources: 0, childScopes: 0 },
      { name: 'b', owner: 'b', createdAt: 1, ageMs: 50, activeResources: 0, childScopes: 0 },
      { name: 'c', owner: 'c', createdAt: 1, ageMs: 20, activeResources: 0, childScopes: 0 },
    ]);
    expect(summary.oldestAgeMs).toBe(50);
  });
});
