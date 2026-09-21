import { vi as jest } from 'vitest';
import {
  createResourceScopeRegistry,
  ResourceScopeRegistryError,
  type ResourceScopeRegistryClock,
} from './resourceScopeRegistry';

const createClock = (startAt = 10_000) => {
  let now = startAt;
  const clock: ResourceScopeRegistryClock & {
    advance(milliseconds: number): void;
    rewind(milliseconds: number): void;
  } = {
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    rewind: (milliseconds) => { now -= milliseconds; },
  };
  return clock;
};

describe('ResourceScopeRegistry creation and lookup', () => {
  test('starts empty with immutable bounded counters', () => {
    const registry = createResourceScopeRegistry();
    const snapshot = registry.snapshot();

    expect(snapshot).toEqual(expect.objectContaining({
      disposed: false,
      activeScopes: 0,
      activeOwners: 0,
      created: 0,
      closed: 0,
      rejected: 0,
      cleanupFailures: 0,
      staleScopes: 0,
    }));
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.history).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  test('creates and retrieves a named scope', () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'route:map', owner: 'router' });

    expect(registry.has('route:map')).toBe(true);
    expect(registry.get('route:map')).toBe(scope);
    expect(registry.snapshot()).toEqual(expect.objectContaining({
      activeScopes: 1,
      activeOwners: 1,
      created: 1,
    }));
  });

  test('tracks multiple owners independently', () => {
    const registry = createResourceScopeRegistry();
    registry.create({ name: 'map', owner: 'gis' });
    registry.create({ name: 'search', owner: 'search' });
    registry.create({ name: 'layers', owner: 'gis' });

    expect(registry.snapshot()).toEqual(expect.objectContaining({
      activeScopes: 3,
      activeOwners: 2,
      created: 3,
    }));
  });

  test('passes scoped policy options to created scopes', () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({
      name: 'small',
      owner: 'owner',
      scopeOptions: { maxResources: 1, maxOwnerResources: 1 },
    });
    scope.register({ owner: 'resource-owner', key: 'first', cleanup: jest.fn() });

    expect(() => scope.register({
      owner: 'resource-owner',
      key: 'second',
      cleanup: jest.fn(),
    })).toThrow(expect.objectContaining({ code: 'RESOURCE_CAPACITY_EXCEEDED' }));
  });

  test('sanitizes registry metadata and redacts secrets', () => {
    const registry = createResourceScopeRegistry();
    registry.create({
      name: 'map',
      owner: 'gis',
      metadata: {
        route: '/map',
        token: 'secret-token',
        attempts: 2,
        enabled: true,
        optional: null,
        unsupported: { nested: true },
      },
    });

    expect(registry.snapshot().entries[0]?.metadata).toEqual({
      route: '/map',
      token: '[redacted]',
      attempts: 2,
      enabled: true,
      optional: null,
    });
  });

  test.each([
    'authorization',
    'password',
    'secret',
    'apiKey',
    'sessionId',
    'credential',
  ])('redacts sensitive registry metadata key %s', (key) => {
    const registry = createResourceScopeRegistry();
    registry.create({
      name: 'scope-' + key,
      owner: 'owner',
      metadata: { [key]: 'private' },
    });
    expect(registry.snapshot().entries[0]?.metadata[key]).toBe('[redacted]');
  });

  test('bounds registry metadata to sixteen entries', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => ['key' + index, index]),
    );
    const registry = createResourceScopeRegistry();
    registry.create({ name: 'scope', owner: 'owner', metadata });

    expect(Object.keys(registry.snapshot().entries[0]?.metadata ?? {})).toHaveLength(16);
  });
});

describe('ResourceScopeRegistry admission controls', () => {
  test('rejects duplicate active scope names', () => {
    const registry = createResourceScopeRegistry();
    registry.create({ name: 'map', owner: 'gis' });

    expect(() => registry.create({ name: 'map', owner: 'other' }))
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_SCOPE' }));
    expect(registry.snapshot().rejected).toBe(1);
  });

  test('enforces global scope capacity', () => {
    const registry = createResourceScopeRegistry({
      maxScopes: 2,
      maxOwnerScopes: 2,
    });
    registry.create({ name: 'one', owner: 'a' });
    registry.create({ name: 'two', owner: 'b' });

    expect(() => registry.create({ name: 'three', owner: 'c' }))
      .toThrow(expect.objectContaining({ code: 'SCOPE_CAPACITY_EXCEEDED' }));
  });

  test('enforces owner scope capacity', () => {
    const registry = createResourceScopeRegistry({
      maxScopes: 4,
      maxOwnerScopes: 1,
    });
    registry.create({ name: 'one', owner: 'same' });

    expect(() => registry.create({ name: 'two', owner: 'same' }))
      .toThrow(expect.objectContaining({ code: 'OWNER_CAPACITY_EXCEEDED' }));
  });

  test('owner capacity becomes available after close', async () => {
    const registry = createResourceScopeRegistry({
      maxScopes: 2,
      maxOwnerScopes: 1,
    });
    registry.create({ name: 'one', owner: 'same' });
    await registry.close('one');

    expect(() => registry.create({ name: 'two', owner: 'same' })).not.toThrow();
  });

  test.each([
    ['', 'owner'],
    [' ', 'owner'],
    ['scope', ''],
    ['scope', ' '],
  ])('rejects invalid name/owner pair %#', (name, owner) => {
    const registry = createResourceScopeRegistry();
    expect(() => registry.create({ name, owner }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects control characters in scope identity', () => {
    const registry = createResourceScopeRegistry();
    expect(() => registry.create({ name: 'map\nroute', owner: 'router' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects owner capacity larger than global capacity', () => {
    expect(() => createResourceScopeRegistry({
      maxScopes: 2,
      maxOwnerScopes: 3,
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects invalid structural policy values', () => {
    expect(() => createResourceScopeRegistry({ maxScopes: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScopeRegistry({ maxOwnerScopes: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScopeRegistry({ historyLimit: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScopeRegistry({ staleAfterMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('ResourceScopeRegistry close semantics', () => {
  test('closes one named scope and removes it from lookup', async () => {
    const cleanup = jest.fn();
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'map', owner: 'gis' });
    scope.register({ owner: 'map', key: 'watch', cleanup });

    await expect(registry.close('map', 'route-change')).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.has('map')).toBe(false);
    expect(registry.get('map')).toBeUndefined();
    expect(registry.snapshot()).toEqual(expect.objectContaining({
      activeScopes: 0,
      activeOwners: 0,
      closed: 1,
    }));
  });

  test('closing an unknown scope is a no-op', async () => {
    const registry = createResourceScopeRegistry();
    await expect(registry.close('missing')).resolves.toBe(false);
    expect(registry.snapshot().closed).toBe(0);
  });

  test('records bounded privacy-safe close history', async () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({}, clock);
    registry.create({ name: 'map', owner: 'gis' });
    clock.advance(250);

    await registry.close('map', new Error('internal detail'));
    expect(registry.snapshot().history[0]).toEqual({
      name: 'map',
      owner: 'gis',
      createdAt: 10_000,
      closedAt: 10_250,
      lifetimeMs: 250,
      reason: 'Error',
      cleanupFailed: false,
    });
    expect(JSON.stringify(registry.snapshot())).not.toContain('internal detail');
  });

  test('bounds close history to configured capacity', async () => {
    const registry = createResourceScopeRegistry({
      historyLimit: 2,
      maxScopes: 3,
      maxOwnerScopes: 3,
    });
    for (const name of ['one', 'two', 'three']) {
      registry.create({ name, owner: 'owner' });
      await registry.close(name);
    }

    expect(registry.snapshot().history).toHaveLength(2);
    expect(registry.snapshot().history.map((entry) => entry.name)).toEqual(['two', 'three']);
  });

  test('closeOwner closes only scopes owned by the requested owner', async () => {
    const calls: string[] = [];
    const clock = createClock();
    const registry = createResourceScopeRegistry({
      maxScopes: 4,
      maxOwnerScopes: 3,
    }, clock);
    const map = registry.create({ name: 'map', owner: 'gis' });
    clock.advance(1);
    const layers = registry.create({ name: 'layers', owner: 'gis' });
    registry.create({ name: 'search', owner: 'search' });
    map.register({ owner: 'map', key: 'watch', cleanup: () => { calls.push('map'); } });
    layers.register({ owner: 'layers', key: 'watch', cleanup: () => { calls.push('layers'); } });

    await expect(registry.closeOwner('gis')).resolves.toBe(2);
    expect(calls).toEqual(['layers', 'map']);
    expect(registry.has('search')).toBe(true);
    expect(registry.snapshot().activeOwners).toBe(1);
  });

  test('closeAll closes every active scope', async () => {
    const registry = createResourceScopeRegistry({
      maxScopes: 4,
      maxOwnerScopes: 4,
    });
    registry.create({ name: 'a', owner: 'one' });
    registry.create({ name: 'b', owner: 'two' });
    registry.create({ name: 'c', owner: 'three' });

    await expect(registry.closeAll()).resolves.toBe(3);
    expect(registry.snapshot()).toEqual(expect.objectContaining({
      activeScopes: 0,
      activeOwners: 0,
      closed: 3,
    }));
  });

  test('cleanup failure is recorded and wrapped with scope identity', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'bad-scope', owner: 'owner' });
    scope.register({
      owner: 'resource-owner',
      key: 'bad',
      cleanup: () => { throw new Error('cleanup failed'); },
    });

    await expect(registry.close('bad-scope'))
      .rejects.toMatchObject({ code: 'SCOPE_CLOSE_FAILED' });
    expect(registry.snapshot()).toEqual(expect.objectContaining({
      activeScopes: 0,
      cleanupFailures: 1,
      closed: 1,
    }));
    expect(registry.snapshot().history[0]?.cleanupFailed).toBe(true);
  });

  test('closeOwner attempts sibling scopes when one cleanup fails', async () => {
    const successful = jest.fn();
    const registry = createResourceScopeRegistry({
      maxScopes: 3,
      maxOwnerScopes: 3,
    });
    const bad = registry.create({ name: 'bad', owner: 'same' });
    const good = registry.create({ name: 'good', owner: 'same' });
    bad.register({
      owner: 'resource',
      key: 'bad',
      cleanup: () => { throw new Error('failure'); },
    });
    good.register({ owner: 'resource', key: 'good', cleanup: successful });

    await expect(registry.closeOwner('same')).rejects.toBeInstanceOf(AggregateError);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().activeScopes).toBe(0);
  });

  test('closeAll attempts every scope when cleanup failures occur', async () => {
    const successful = jest.fn();
    const registry = createResourceScopeRegistry({
      maxScopes: 3,
      maxOwnerScopes: 3,
    });
    const bad = registry.create({ name: 'bad', owner: 'one' });
    const good = registry.create({ name: 'good', owner: 'two' });
    bad.register({
      owner: 'resource',
      key: 'bad',
      cleanup: () => { throw new Error('failure'); },
    });
    good.register({ owner: 'resource', key: 'good', cleanup: successful });

    await expect(registry.closeAll()).rejects.toBeInstanceOf(AggregateError);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().activeScopes).toBe(0);
  });
});

describe('ResourceScopeRegistry stale visibility and self-closed scopes', () => {
  test('reports only scopes older than stale threshold', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({
      staleAfterMs: 1_000,
      maxScopes: 3,
      maxOwnerScopes: 3,
    }, clock);
    registry.create({ name: 'old', owner: 'owner' });
    clock.advance(800);
    registry.create({ name: 'young', owner: 'owner' });
    clock.advance(300);

    const stale = registry.stale();
    expect(stale).toEqual([
      expect.objectContaining({
        name: 'old',
        owner: 'owner',
        ageMs: 1_100,
      }),
    ]);
    expect(registry.snapshot().staleScopes).toBe(1);
  });

  test('stale snapshot includes active resource and child counts', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({ staleAfterMs: 100 }, clock);
    const scope = registry.create({ name: 'map', owner: 'gis' });
    scope.register({ owner: 'map', key: 'watch', cleanup: jest.fn() });
    scope.child('popup');
    clock.advance(100);

    expect(registry.stale()).toEqual([
      expect.objectContaining({
        name: 'map',
        activeResources: 1,
        childScopes: 1,
      }),
    ]);
  });

  test('supports explicit stale threshold query', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({ staleAfterMs: 5_000 }, clock);
    registry.create({ name: 'scope', owner: 'owner' });
    clock.advance(500);

    expect(registry.stale()).toEqual([]);
    expect(registry.stale(400)).toHaveLength(1);
  });

  test('sweeps directly closed scopes on the next registry read', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'self-close', owner: 'owner' });
    await scope.close();

    expect(registry.has('self-close')).toBe(false);
    expect(registry.snapshot().closed).toBe(1);
    expect(registry.snapshot().history[0]?.reason).toBe('scope-self-closed');
  });

  test('sweeps directly disposed scopes on the next registry read', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'self-dispose', owner: 'owner' });
    await scope.dispose();

    expect(registry.get('self-dispose')).toBeUndefined();
    expect(registry.snapshot().activeScopes).toBe(0);
  });

  test('snapshot entries are deterministic and immutable', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({
      maxScopes: 3,
      maxOwnerScopes: 3,
    }, clock);
    registry.create({ name: 'b', owner: 'owner' });
    clock.advance(1);
    registry.create({ name: 'a', owner: 'owner' });

    const entries = registry.snapshot().entries;
    expect(entries.map((entry) => entry.name)).toEqual(['b', 'a']);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
  });
});

describe('ResourceScopeRegistry disposal and clock invariants', () => {
  test('dispose closes all scopes and enters terminal state', async () => {
    const cleanup = jest.fn();
    const registry = createResourceScopeRegistry({
      maxScopes: 2,
      maxOwnerScopes: 2,
    });
    const scope = registry.create({ name: 'scope', owner: 'owner' });
    scope.register({ owner: 'resource', key: 'watch', cleanup });

    await registry.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().disposed).toBe(true);
  });

  test('dispose is idempotent', async () => {
    const registry = createResourceScopeRegistry();
    registry.create({ name: 'scope', owner: 'owner' });

    await registry.dispose();
    await registry.dispose();
    expect(registry.snapshot().closed).toBe(1);
  });

  test('rejects new operations after disposal', async () => {
    const registry = createResourceScopeRegistry();
    await registry.dispose();

    expect(() => registry.create({ name: 'new', owner: 'owner' }))
      .toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSED' }));
    expect(() => registry.get('new'))
      .toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSED' }));
    expect(() => registry.has('new'))
      .toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSED' }));
    expect(() => registry.stale())
      .toThrow(expect.objectContaining({ code: 'REGISTRY_DISPOSED' }));
  });

  test('dispose attempts every scope even when one cleanup fails', async () => {
    const successful = jest.fn();
    const registry = createResourceScopeRegistry({
      maxScopes: 2,
      maxOwnerScopes: 2,
    });
    const bad = registry.create({ name: 'bad', owner: 'a' });
    const good = registry.create({ name: 'good', owner: 'b' });
    bad.register({
      owner: 'resource',
      key: 'bad',
      cleanup: () => { throw new Error('failure'); },
    });
    good.register({ owner: 'resource', key: 'good', cleanup: successful });

    await expect(registry.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().disposed).toBe(true);
  });

  test('rejects non-finite clock values', () => {
    const registry = createResourceScopeRegistry({}, { now: () => Number.POSITIVE_INFINITY });
    expect(() => registry.create({ name: 'scope', owner: 'owner' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects a backward-moving registry clock', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({}, clock);
    registry.create({ name: 'scope', owner: 'owner' });
    clock.advance(10);
    registry.snapshot();
    clock.rewind(20);

    expect(() => registry.snapshot())
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('does not schedule polling to discover stale scopes', () => {
    const clock = createClock();
    const registry = createResourceScopeRegistry({}, clock);
    registry.create({ name: 'scope', owner: 'owner' });

    expect(registry.stale()).toEqual([]);
    expect('setInterval' in clock).toBe(false);
  });

  test('typed registry errors retain the original cleanup cause without exposing it in snapshots', async () => {
    const registry = createResourceScopeRegistry();
    const scope = registry.create({ name: 'scope', owner: 'owner' });
    scope.register({
      owner: 'resource',
      key: 'bad',
      cleanup: () => { throw new RangeError('private implementation detail'); },
    });

    try {
      await registry.close('scope');
      throw new Error('expected close failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceScopeRegistryError);
      expect((error as ResourceScopeRegistryError).reason).toBeDefined();
    }
    expect(JSON.stringify(registry.snapshot())).not.toContain('private implementation detail');
  });
});
