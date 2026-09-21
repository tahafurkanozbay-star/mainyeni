import { vi } from 'vitest';
import {
  createResourceScope,
  ResourceScopeError,
  type ResourceScopeClock,
} from './resourceScope';

interface TestClock extends ResourceScopeClock {
  readonly advance: (milliseconds: number) => void;
  readonly fireAll: () => void;
  readonly pending: () => number;
  readonly rewind: (milliseconds: number) => void;
}

const createClock = (startAt = 1_000): TestClock => {
  let now = startAt;
  let sequence = 0;
  const callbacks = new Map<number, () => void>();
  return {
    now: () => now,
    setTimeout: (callback) => {
      const id = ++sequence;
      callbacks.set(id, callback);
      return id as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      callbacks.delete(Number(handle));
    },
    advance: (milliseconds) => {
      now += milliseconds;
    },
    rewind: (milliseconds) => {
      now -= milliseconds;
    },
    fireAll: () => {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of entries) callback();
    },
    pending: () => callbacks.size,
  };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('ResourceScope registration and snapshots', () => {
  test('starts open with a bounded immutable empty snapshot', () => {
    const clock = createClock();
    const scope = createResourceScope('application', { clock });
    const snapshot = scope.snapshot();

    expect(scope.name).toBe('application');
    expect(scope.state).toBe('open');
    expect(scope.signal.aborted).toBe(false);
    expect(snapshot).toEqual(expect.objectContaining({
      name: 'application',
      state: 'open',
      createdAt: 1_000,
      activeResources: 0,
      activeOwners: 0,
      childScopes: 0,
    }));
    expect(snapshot.counters).toEqual({
      registered: 0,
      released: 0,
      failed: 0,
      timedOut: 0,
      rejected: 0,
      observerFailures: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  test('registers one resource with immutable sanitized metadata', () => {
    const scope = createResourceScope('application');
    const handle = scope.register({
      owner: 'map',
      key: 'view-watch',
      label: 'Map view watcher',
      metadata: {
        layer: 'basemap',
        retries: 2,
        enabled: true,
        optional: null,
      },
      cleanup: vi.fn(),
    });

    const snapshot = scope.snapshot();
    expect(snapshot.activeResources).toBe(1);
    expect(snapshot.activeOwners).toBe(1);
    expect(snapshot.counters.registered).toBe(1);
    expect(snapshot.resources).toEqual([
      expect.objectContaining({
        id: handle.id,
        owner: 'map',
        key: 'view-watch',
        label: 'Map view watcher',
        metadata: {
          layer: 'basemap',
          retries: 2,
          enabled: true,
          optional: null,
        },
      }),
    ]);
    expect(Object.isFrozen(snapshot.resources[0])).toBe(true);
    expect(Object.isFrozen(snapshot.resources[0]?.metadata)).toBe(true);
  });

  test('uses the resource key as the default label', () => {
    const scope = createResourceScope('application');
    const handle = scope.register({
      owner: 'search',
      key: 'subscription',
      cleanup: vi.fn(),
    });
    expect(handle.label).toBe('subscription');
    expect(handle.snapshot()?.label).toBe('subscription');
  });

  test.each([
    'authorization',
    'Authorization',
    'cookie',
    'password',
    'clientSecret',
    'accessToken',
    'api_key',
    'sessionId',
    'credential',
  ])('redacts sensitive metadata key %s', (key) => {
    const scope = createResourceScope('application');
    scope.register({
      owner: 'owner',
      key: 'resource',
      metadata: { [key]: 'private-value' },
      cleanup: vi.fn(),
    });
    expect(scope.snapshot().resources[0]?.metadata[key]).toBe('[redacted]');
  });

  test('drops unsupported metadata and non-finite numeric values', () => {
    const scope = createResourceScope('application');
    scope.register({
      owner: 'owner',
      key: 'resource',
      metadata: {
        valid: 7,
        infinity: Number.POSITIVE_INFINITY,
        object: { nested: true },
        array: [1, 2],
        function: () => undefined,
      },
      cleanup: vi.fn(),
    });
    expect(scope.snapshot().resources[0]?.metadata).toEqual({ valid: 7 });
  });

  test('bounds metadata strings and removes control whitespace', () => {
    const scope = createResourceScope('application');
    scope.register({
      owner: 'owner',
      key: 'resource',
      metadata: {
        message: 'a\n\tb'.repeat(100),
      },
      cleanup: vi.fn(),
    });
    const message = scope.snapshot().resources[0]?.metadata.message;
    expect(typeof message).toBe('string');
    expect(String(message).length).toBeLessThanOrEqual(200);
    expect(String(message)).not.toMatch(/[\r\n\t]/);
  });

  test('limits metadata entry count deterministically', () => {
    const scope = createResourceScope('application', { maxMetadataEntries: 3 });
    scope.register({
      owner: 'owner',
      key: 'resource',
      metadata: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      cleanup: vi.fn(),
    });
    expect(scope.snapshot().resources[0]?.metadata).toEqual({ a: 1, b: 2, c: 3 });
  });

  test('returns a frozen resource handle', () => {
    const scope = createResourceScope('application');
    const handle = scope.register({
      owner: 'owner',
      key: 'resource',
      cleanup: vi.fn(),
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle.released).toBe(false);
  });

  test('handle snapshot disappears after release', async () => {
    const cleanup = vi.fn();
    const scope = createResourceScope('application');
    const handle = scope.register({ owner: 'owner', key: 'resource', cleanup });

    expect(handle.snapshot()).toBeDefined();
    await handle.release('manual');
    expect(handle.snapshot()).toBeUndefined();
    expect(handle.released).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceScope request validation and admission', () => {
  test.each([
    ['', 'owner'],
    [' ', 'owner'],
    ['owner', ''],
    ['owner', ' '],
  ])('rejects empty owner/key pair %#', (owner, key) => {
    const scope = createResourceScope('application');
    expect(() => scope.register({ owner, key, cleanup: vi.fn() }))
      .toThrow(ResourceScopeError);
  });

  test('rejects control characters in resource identity', () => {
    const scope = createResourceScope('application');
    expect(() => scope.register({
      owner: 'map\nmanager',
      key: 'watch',
      cleanup: vi.fn(),
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects a missing cleanup function at runtime', () => {
    const scope = createResourceScope('application');
    expect(() => scope.register({
      owner: 'owner',
      key: 'resource',
      cleanup: null as unknown as () => void,
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(scope.snapshot().counters.rejected).toBe(1);
  });

  test('enforces total active resource capacity', () => {
    const scope = createResourceScope('application', {
      maxResources: 2,
      maxOwnerResources: 2,
    });
    scope.register({ owner: 'a', key: '1', cleanup: vi.fn() });
    scope.register({ owner: 'b', key: '2', cleanup: vi.fn() });

    expect(() => scope.register({ owner: 'c', key: '3', cleanup: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'RESOURCE_CAPACITY_EXCEEDED' }));
    expect(scope.snapshot().counters.rejected).toBe(1);
  });

  test('enforces per-owner active resource capacity', () => {
    const scope = createResourceScope('application', {
      maxResources: 4,
      maxOwnerResources: 1,
    });
    scope.register({ owner: 'same', key: '1', cleanup: vi.fn() });

    expect(() => scope.register({ owner: 'same', key: '2', cleanup: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'OWNER_CAPACITY_EXCEEDED' }));
    expect(scope.snapshot().activeResources).toBe(1);
  });

  test('capacity becomes available again after manual release', async () => {
    const scope = createResourceScope('application', {
      maxResources: 1,
      maxOwnerResources: 1,
    });
    const first = scope.register({ owner: 'same', key: '1', cleanup: vi.fn() });
    await first.release();

    expect(() => scope.register({ owner: 'same', key: '2', cleanup: vi.fn() }))
      .not.toThrow();
  });

  test('rejects resource registration after close', async () => {
    const scope = createResourceScope('application');
    await scope.close();
    expect(() => scope.register({ owner: 'owner', key: 'late', cleanup: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'SCOPE_NOT_OPEN' }));
  });

  test('validates structural policy options fail closed', () => {
    expect(() => createResourceScope('application', { maxResources: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScope('application', {
      maxResources: 2,
      maxOwnerResources: 3,
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScope('application', { maxChildren: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => createResourceScope('application', { maxCleanupTimeoutMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('ResourceScope cleanup ordering and ownership', () => {
  test('manual release is idempotent', async () => {
    const cleanup = vi.fn();
    const scope = createResourceScope('application');
    const handle = scope.register({ owner: 'owner', key: 'resource', cleanup });

    await expect(handle.release()).resolves.toBe(true);
    await expect(handle.release()).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().counters.released).toBe(1);
  });

  test('close releases resources in reverse registration order', async () => {
    const calls: string[] = [];
    const scope = createResourceScope('application');
    scope.register({ owner: 'a', key: 'first', cleanup: () => { calls.push('first'); } });
    scope.register({ owner: 'a', key: 'second', cleanup: () => { calls.push('second'); } });
    scope.register({ owner: 'b', key: 'third', cleanup: () => { calls.push('third'); } });

    await scope.close();
    expect(calls).toEqual(['third', 'second', 'first']);
    expect(scope.state).toBe('closed');
    expect(scope.snapshot().activeResources).toBe(0);
  });

  test('releaseOwner only releases resources for the selected owner', async () => {
    const calls: string[] = [];
    const scope = createResourceScope('application');
    scope.register({ owner: 'map', key: 'a', cleanup: () => { calls.push('map-a'); } });
    scope.register({ owner: 'search', key: 'b', cleanup: () => { calls.push('search-b'); } });
    scope.register({ owner: 'map', key: 'c', cleanup: () => { calls.push('map-c'); } });

    await expect(scope.releaseOwner('map')).resolves.toBe(2);
    expect(calls).toEqual(['map-c', 'map-a']);
    expect(scope.snapshot().resources).toEqual([
      expect.objectContaining({ owner: 'search', key: 'b' }),
    ]);
  });

  test('releaseOwner surfaces aggregate cleanup failures after attempting siblings', async () => {
    const goodCleanup = vi.fn();
    const scope = createResourceScope('application');
    scope.register({
      owner: 'map',
      key: 'bad',
      cleanup: () => { throw new Error('cleanup failed'); },
    });
    scope.register({ owner: 'map', key: 'good', cleanup: goodCleanup });

    await expect(scope.releaseOwner('map')).rejects.toBeInstanceOf(AggregateError);
    expect(goodCleanup).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().activeResources).toBe(0);
  });

  test('registerDisposable owns an async disposable', async () => {
    const dispose = vi.fn(async () => undefined);
    const scope = createResourceScope('application');
    const handle = scope.registerDisposable('map', 'worker', { dispose }, {
      label: 'Map worker',
      metadata: { kind: 'worker' },
    });

    await handle.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().history[0]).toEqual(expect.objectContaining({
      owner: 'map',
      key: 'worker',
      outcome: 'released',
    }));
  });

  test('scope abort signal becomes aborted when close begins', async () => {
    const scope = createResourceScope('application');
    expect(scope.signal.aborted).toBe(false);
    await scope.close({ reason: 'route-change' });
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe('route-change');
  });

  test('close is idempotent after resources are gone', async () => {
    const cleanup = vi.fn();
    const scope = createResourceScope('application');
    scope.register({ owner: 'owner', key: 'resource', cleanup });

    await scope.close();
    await scope.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.state).toBe('closed');
  });

  test('dispose is idempotent and leaves terminal disposed state', async () => {
    const cleanup = vi.fn();
    const scope = createResourceScope('application');
    scope.register({ owner: 'owner', key: 'resource', cleanup });

    await scope.dispose('application-dispose');
    await scope.dispose('second-dispose');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.state).toBe('disposed');
    expect(scope.signal.aborted).toBe(true);
  });
});

describe('ResourceScope cleanup failures and timeouts', () => {
  test('manual release converts cleanup exceptions into a typed error', async () => {
    const scope = createResourceScope('application');
    const handle = scope.register({
      owner: 'owner',
      key: 'resource',
      cleanup: () => { throw new RangeError('internal detail'); },
    });

    await expect(handle.release('manual'))
      .rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    const snapshot = scope.snapshot();
    expect(snapshot.counters.failed).toBe(1);
    expect(snapshot.history[0]).toEqual(expect.objectContaining({
      outcome: 'failed',
      errorName: 'RangeError',
    }));
    expect(JSON.stringify(snapshot)).not.toContain('internal detail');
  });

  test('close attempts every cleanup before reporting aggregate failure', async () => {
    const calls: string[] = [];
    const scope = createResourceScope('application');
    scope.register({
      owner: 'owner',
      key: 'first',
      cleanup: () => { calls.push('first'); },
    });
    scope.register({
      owner: 'owner',
      key: 'bad',
      cleanup: () => {
        calls.push('bad');
        throw new Error('bad cleanup');
      },
    });
    scope.register({
      owner: 'owner',
      key: 'last',
      cleanup: () => { calls.push('last'); },
    });

    await expect(scope.close()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['last', 'bad', 'first']);
    expect(scope.state).toBe('closed');
    expect(scope.snapshot().activeResources).toBe(0);
  });

  test('close can contain cleanup failures when explicitly requested', async () => {
    const scope = createResourceScope('application');
    scope.register({
      owner: 'owner',
      key: 'bad',
      cleanup: () => { throw new Error('bad cleanup'); },
    });

    await expect(scope.close({ throwOnCleanupError: false })).resolves.toBeUndefined();
    expect(scope.state).toBe('closed');
    expect(scope.snapshot().counters.failed).toBe(1);
  });

  test('cleanup timeout fails closed and removes the timed-out resource', async () => {
    const clock = createClock();
    const scope = createResourceScope('application', {
      clock,
      defaultCleanupTimeoutMs: 100,
      maxCleanupTimeoutMs: 1_000,
    });
    const handle = scope.register({
      owner: 'owner',
      key: 'never-settles',
      cleanup: () => new Promise<void>(() => undefined),
    });

    const release = handle.release('manual');
    await flush();
    expect(clock.pending()).toBe(1);
    clock.advance(100);
    clock.fireAll();

    await expect(release).rejects.toMatchObject({ code: 'CLEANUP_TIMEOUT' });
    expect(scope.snapshot().counters.timedOut).toBe(1);
    expect(scope.snapshot().activeResources).toBe(0);
    expect(scope.snapshot().history[0]?.outcome).toBe('timed-out');
  });

  test('cleanup timeout can be overridden per release within configured maximum', async () => {
    const clock = createClock();
    const scope = createResourceScope('application', {
      clock,
      defaultCleanupTimeoutMs: 100,
      maxCleanupTimeoutMs: 500,
    });
    const handle = scope.register({
      owner: 'owner',
      key: 'never-settles',
      cleanup: () => new Promise<void>(() => undefined),
    });

    const release = handle.release('manual', 400);
    await flush();
    clock.advance(400);
    clock.fireAll();
    await expect(release).rejects.toMatchObject({ code: 'CLEANUP_TIMEOUT' });
  });

  test('rejects cleanup timeout larger than the configured maximum', async () => {
    const scope = createResourceScope('application', {
      defaultCleanupTimeoutMs: 100,
      maxCleanupTimeoutMs: 500,
    });
    const handle = scope.register({
      owner: 'owner',
      key: 'resource',
      cleanup: vi.fn(),
    });
    await expect(handle.release('manual', 501))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('aborted close signal rejects before teardown starts', async () => {
    const controller = new AbortController();
    controller.abort('cancel-close');
    const cleanup = vi.fn();
    const scope = createResourceScope('application');
    scope.register({ owner: 'owner', key: 'resource', cleanup });

    await expect(scope.close({ signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CLOSE_CANCELLED' });
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('ResourceScope diagnostic safety', () => {
  test('sanitizes control characters from external cleanup reasons', async () => {
    const scope = createResourceScope('application');
    const handle = scope.register({
      owner: 'router',
      key: 'route-listener',
      cleanup: vi.fn(),
    });

    await handle.release('route\n\tchange\rcompleted');

    const entry = scope.snapshot().history[0];
    expect(entry?.reason).toBe('route  change completed');
    expect(entry?.reason).not.toMatch(/[\r\n\t]/);
  });
});

describe('ResourceScope child lifecycle', () => {
  test('creates bounded child scopes with hierarchical names', () => {
    const scope = createResourceScope('application');
    const child = scope.child('map');

    expect(child.name).toBe('application/map');
    expect(scope.snapshot().childScopes).toBe(1);
  });

  test('parent close closes child resources before parent resources', async () => {
    const calls: string[] = [];
    const parent = createResourceScope('application');
    const child = parent.child('map');
    parent.register({
      owner: 'parent',
      key: 'resource',
      cleanup: () => { calls.push('parent'); },
    });
    child.register({
      owner: 'child',
      key: 'resource',
      cleanup: () => { calls.push('child'); },
    });

    await parent.close();
    expect(calls).toEqual(['child', 'parent']);
    expect(['closed', 'disposed']).toContain(child.state);
    expect(parent.snapshot().childScopes).toBe(0);
  });

  test('closing child directly removes it from parent ownership', async () => {
    const parent = createResourceScope('application');
    const child = parent.child('map');
    expect(parent.snapshot().childScopes).toBe(1);

    await child.close();
    expect(parent.snapshot().childScopes).toBe(0);
  });

  test('parent dispose propagates abort and cleanup to children', async () => {
    const cleanup = vi.fn();
    const parent = createResourceScope('application');
    const child = parent.child('map');
    child.register({ owner: 'map', key: 'watch', cleanup });

    await parent.dispose('route-unmounted');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(child.signal.aborted).toBe(true);
    expect(child.state === 'closed' || child.state === 'disposed').toBe(true);
  });

  test('enforces maximum child scope count', () => {
    const parent = createResourceScope('application', { maxChildren: 1 });
    parent.child('first');
    expect(() => parent.child('second'))
      .toThrow(expect.objectContaining({ code: 'CHILD_CAPACITY_EXCEEDED' }));
  });

  test('cannot create children after parent starts closing', async () => {
    const parent = createResourceScope('application');
    await parent.close();
    expect(() => parent.child('late'))
      .toThrow(expect.objectContaining({ code: 'SCOPE_NOT_OPEN' }));
  });
});

describe('ResourceScope retention, observers and clock invariants', () => {
  test('bounds cleanup history to configured capacity', async () => {
    const scope = createResourceScope('application', { historyLimit: 2 });
    for (const key of ['a', 'b', 'c']) {
      const handle = scope.register({ owner: 'owner', key, cleanup: vi.fn() });
      await handle.release(key);
    }
    expect(scope.snapshot().history).toHaveLength(2);
    expect(scope.snapshot().history.map((entry) => entry.key)).toEqual(['b', 'c']);
  });

  test('supports disabling cleanup history', async () => {
    const scope = createResourceScope('application', { historyLimit: 0 });
    const handle = scope.register({ owner: 'owner', key: 'resource', cleanup: vi.fn() });
    await handle.release();
    expect(scope.snapshot().history).toEqual([]);
  });

  test('emits lifecycle events without exposing cleanup error messages', async () => {
    const events: unknown[] = [];
    const scope = createResourceScope('application', {
      onEvent: (event) => events.push(event),
    });
    const handle = scope.register({
      owner: 'owner',
      key: 'resource',
      cleanup: () => { throw new Error('secret internal cleanup detail'); },
    });

    await expect(handle.release()).rejects.toBeDefined();
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('cleanup-failed');
    expect(serialized).toContain('Error');
    expect(serialized).not.toContain('secret internal cleanup detail');
  });

  test('observer failures never break registration or cleanup', async () => {
    const cleanup = vi.fn();
    const scope = createResourceScope('application', {
      onEvent: () => { throw new Error('observer failed'); },
    });
    const handle = scope.register({ owner: 'owner', key: 'resource', cleanup });

    await expect(handle.release()).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().counters.observerFailures).toBeGreaterThanOrEqual(2);
  });

  test('snapshot collections are defensive immutable copies', async () => {
    const scope = createResourceScope('application');
    const handle = scope.register({ owner: 'owner', key: 'resource', cleanup: vi.fn() });
    const active = scope.snapshot();
    await handle.release();
    const released = scope.snapshot();

    expect(active.resources).toHaveLength(1);
    expect(released.resources).toHaveLength(0);
    expect(active.history).toHaveLength(0);
    expect(released.history).toHaveLength(1);
    expect(Object.isFrozen(released.history[0])).toBe(true);
  });

  test('rejects an invalid clock timestamp during construction', () => {
    expect(() => createResourceScope('application', {
      clock: {
        now: () => Number.NaN,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('rejects a backward-moving clock', () => {
    const clock = createClock();
    const scope = createResourceScope('application', { clock });
    clock.advance(10);
    scope.register({ owner: 'owner', key: 'first', cleanup: vi.fn() });
    clock.rewind(20);

    expect(() => scope.register({ owner: 'owner', key: 'second', cleanup: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  test('does not create recurring timers or background polling', () => {
    const setTimeoutSpy = vi.fn(globalThis.setTimeout);
    const clock: ResourceScopeClock = {
      now: () => Date.now(),
      setTimeout: setTimeoutSpy,
      clearTimeout: globalThis.clearTimeout,
    };
    const scope = createResourceScope('application', { clock });
    scope.register({ owner: 'owner', key: 'resource', cleanup: vi.fn() });

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
