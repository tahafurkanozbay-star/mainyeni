import { describe, expect, it, vi } from 'vitest';
import { createSpatialRequestCoordinator, SpatialRequestCoordinatorError } from './spatialRequestCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('spatialRequestCoordinator', () => {
  it('deduplicates equal request keys into one underlying execution', async () => {
    const coordinator = createSpatialRequestCoordinator();
    const work = deferred<number>();
    const operation = vi.fn(() => work.promise);
    const first = coordinator.run('layer:1:extent:a', operation);
    const second = coordinator.run('layer:1:extent:a', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot('layer:1:extent:a')?.subscribers).toBe(2);
    work.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(coordinator.snapshot('layer:1:extent:a')).toBeNull();
  });

  it('keeps underlying work alive while another subscriber remains', async () => {
    const coordinator = createSpatialRequestCoordinator();
    const work = deferred<string>();
    let transportSignal: AbortSignal | null = null;
    const operation = vi.fn(({ signal }: { signal: AbortSignal }) => { transportSignal = signal; return work.promise; });
    const firstController = new AbortController();
    const first = coordinator.run('shared', operation, { signal: firstController.signal });
    const second = coordinator.run('shared', operation);
    firstController.abort('caller left');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(false);
    work.resolve('ok');
    await expect(second).resolves.toBe('ok');
  });

  it('aborts underlying work when the final subscriber leaves', async () => {
    const coordinator = createSpatialRequestCoordinator();
    const controller = new AbortController();
    let transportSignal: AbortSignal | null = null;
    const pending = coordinator.run('solo', async ({ signal }) => {
      transportSignal = signal;
      return new Promise<string>(() => undefined);
    }, { signal: controller.signal });
    controller.abort('navigation changed');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
    expect(coordinator.snapshot('solo')).toBeNull();
  });

  it('does not allocate a queued entry for a pre-aborted first subscriber', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1, maximumQueued: 1 });
    const controller = new AbortController();
    controller.abort('already stale');
    const operation = vi.fn(async () => 1);

    await expect(coordinator.run('pre-aborted', operation, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.snapshot('pre-aborted')).toBeNull();
    expect(coordinator.snapshots()).toHaveLength(0);
  });

  it('honors bounded concurrency and queues excess work', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1 });
    const firstWork = deferred<number>();
    const secondWork = deferred<number>();
    const firstOp = vi.fn(() => firstWork.promise);
    const secondOp = vi.fn(() => secondWork.promise);
    const first = coordinator.run('a', firstOp);
    const second = coordinator.run('b', secondOp);
    expect(firstOp).toHaveBeenCalledTimes(1);
    expect(secondOp).not.toHaveBeenCalled();
    expect(coordinator.snapshot('b')?.state).toBe('queued');
    firstWork.resolve(1);
    await expect(first).resolves.toBe(1);
    await tick();
    expect(secondOp).toHaveBeenCalledTimes(1);
    secondWork.resolve(2);
    await expect(second).resolves.toBe(2);
  });

  it('prioritizes interactive work ahead of queued visible and prefetch work', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1 });
    const blocker = deferred<string>();
    const order: string[] = [];
    const first = coordinator.run('blocker', async () => { order.push('blocker'); return blocker.promise; });
    const prefetch = coordinator.run('prefetch', async () => { order.push('prefetch'); return 'p'; }, { priority: 'prefetch' });
    const visible = coordinator.run('visible', async () => { order.push('visible'); return 'v'; }, { priority: 'visible' });
    const interactive = coordinator.run('interactive', async () => { order.push('interactive'); return 'i'; }, { priority: 'interactive' });
    blocker.resolve('done');
    await first;
    await Promise.all([prefetch, visible, interactive]);
    expect(order).toEqual(['blocker', 'interactive', 'visible', 'prefetch']);
  });

  it('promotes a deduplicated queued request when a higher priority subscriber arrives', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1 });
    const blocker = deferred<void>();
    const order: string[] = [];
    const first = coordinator.run('blocker', async () => blocker.promise);
    const low = coordinator.run('same', async () => { order.push('same'); return 7; }, { priority: 'prefetch' });
    const other = coordinator.run('other', async () => { order.push('other'); return 8; }, { priority: 'visible' });
    const promoted = coordinator.run('same', async () => 99, { priority: 'interactive' });
    expect(coordinator.snapshot('same')?.priority).toBe('interactive');
    blocker.resolve();
    await first;
    await Promise.all([low, promoted, other]);
    expect(order).toEqual(['same', 'other']);
    await expect(promoted).resolves.toBe(7);
  });

  it('rejects new queued work once queue cardinality budget is exhausted', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1, maximumQueued: 1 });
    const blocker = deferred<void>();
    const running = coordinator.run('running', async () => blocker.promise);
    const queued = coordinator.run('queued', async () => 1);
    await expect(coordinator.run('overflow', async () => 2)).rejects.toMatchObject({ code: 'QUEUE_BUDGET_EXCEEDED' });
    blocker.resolve();
    await running;
    await expect(queued).resolves.toBe(1);
  });

  it('cancels a queued request without executing its operation', async () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1 });
    const blocker = deferred<void>();
    const running = coordinator.run('running', async () => blocker.promise);
    const operation = vi.fn(async () => 5);
    const queued = coordinator.run('queued', operation);
    expect(coordinator.cancel('queued', 'extent superseded')).toBe(true);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.snapshot('queued')).toBeNull();
    blocker.resolve();
    await running;
  });

  it('cancels running work through its transport-neutral AbortSignal', async () => {
    const coordinator = createSpatialRequestCoordinator();
    let signal: AbortSignal | null = null;
    const work = deferred<number>();
    const pending = coordinator.run('running', async (context) => { signal = context.signal; return work.promise; });
    expect(coordinator.cancel('running', 'layer hidden')).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(coordinator.snapshot('running')).toBeNull();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    work.resolve(1);
  });

  it('settles subscribers immediately when cancelling abort-insensitive running work', async () => {
    const coordinator = createSpatialRequestCoordinator();
    const operation = vi.fn(async () => new Promise<number>(() => undefined));
    const pending = coordinator.run('insensitive-running', operation);

    expect(coordinator.cancel('insensitive-running', 'view disposed')).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshot('insensitive-running')).toBeNull();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not cache results unless a positive TTL is requested', async () => {
    let calls = 0;
    const coordinator = createSpatialRequestCoordinator();
    await expect(coordinator.run('no-cache', async () => ++calls)).resolves.toBe(1);
    await expect(coordinator.run('no-cache', async () => ++calls)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('serves a fulfilled value from bounded TTL cache', async () => {
    let timestamp = 100;
    let calls = 0;
    const coordinator = createSpatialRequestCoordinator({ now: () => timestamp });
    await expect(coordinator.run('cached', async () => ++calls, { cacheTtlMs: 50 })).resolves.toBe(1);
    timestamp = 120;
    await expect(coordinator.run('cached', async () => ++calls, { cacheTtlMs: 50 })).resolves.toBe(1);
    expect(calls).toBe(1);
  });

  it('expires cached values deterministically', async () => {
    let timestamp = 100;
    let calls = 0;
    const coordinator = createSpatialRequestCoordinator({ now: () => timestamp });
    await coordinator.run('cached', async () => ++calls, { cacheTtlMs: 10 });
    timestamp = 111;
    await expect(coordinator.run('cached', async () => ++calls, { cacheTtlMs: 10 })).resolves.toBe(2);
  });

  it('invalidates one cache key without evicting unrelated entries', async () => {
    let callsA = 0;
    let callsB = 0;
    const coordinator = createSpatialRequestCoordinator();
    await coordinator.run('a', async () => ++callsA, { cacheTtlMs: 1000 });
    await coordinator.run('b', async () => ++callsB, { cacheTtlMs: 1000 });
    expect(coordinator.invalidate('a')).toBe(1);
    await coordinator.run('a', async () => ++callsA, { cacheTtlMs: 1000 });
    await coordinator.run('b', async () => ++callsB, { cacheTtlMs: 1000 });
    expect(callsA).toBe(2);
    expect(callsB).toBe(1);
  });

  it('invalidates all cached values and reports the removed count', async () => {
    const coordinator = createSpatialRequestCoordinator();
    await coordinator.run('a', async () => 1, { cacheTtlMs: 1000 });
    await coordinator.run('b', async () => 2, { cacheTtlMs: 1000 });
    expect(coordinator.invalidate()).toBe(2);
    expect(coordinator.invalidate()).toBe(0);
  });

  it('bounds cache cardinality and evicts oldest insertion first', async () => {
    let callsA = 0;
    const coordinator = createSpatialRequestCoordinator({ maximumCacheEntries: 2 });
    await coordinator.run('a', async () => ++callsA, { cacheTtlMs: 1000 });
    await coordinator.run('b', async () => 2, { cacheTtlMs: 1000 });
    await coordinator.run('c', async () => 3, { cacheTtlMs: 1000 });
    await coordinator.run('a', async () => ++callsA, { cacheTtlMs: 1000 });
    expect(callsA).toBe(2);
  });

  it('does not cache rejected operations', async () => {
    const coordinator = createSpatialRequestCoordinator();
    let calls = 0;
    await expect(coordinator.run('failure', async () => { calls += 1; throw new Error('boom'); }, { cacheTtlMs: 1000 })).rejects.toThrow('boom');
    await expect(coordinator.run('failure', async () => { calls += 1; return 'ok'; }, { cacheTtlMs: 1000 })).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('exposes bounded lifecycle snapshots without result payloads', async () => {
    let timestamp = 10;
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1, now: () => timestamp });
    const work = deferred<number>();
    const pending = coordinator.run('inspect', async () => work.promise, { priority: 'interactive' });
    const snapshot = coordinator.snapshot('inspect');
    expect(snapshot).toMatchObject({ key: 'inspect', priority: 'interactive', state: 'running', subscribers: 1, createdAt: 10, startedAt: 10 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    timestamp = 20;
    work.resolve(9);
    await pending;
    expect(coordinator.snapshot('inspect')).toBeNull();
  });

  it('returns frozen snapshot collections', () => {
    const coordinator = createSpatialRequestCoordinator({ concurrency: 1 });
    void coordinator.run('a', async () => new Promise<number>(() => undefined));
    const snapshots = coordinator.snapshots();
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(snapshots).toHaveLength(1);
  });

  it('validates request keys before allocating ownership', async () => {
    const coordinator = createSpatialRequestCoordinator();
    await expect(coordinator.run('   ', async () => 1)).rejects.toBeInstanceOf(SpatialRequestCoordinatorError);
    expect(coordinator.snapshots()).toHaveLength(0);
  });

  it('rejects operations after disposal', async () => {
    const coordinator = createSpatialRequestCoordinator();
    coordinator.dispose();
    await expect(coordinator.run('later', async () => 1)).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('disposal rejects subscribers and aborts running work', async () => {
    const coordinator = createSpatialRequestCoordinator();
    let signal: AbortSignal | null = null;
    const pending = coordinator.run('active', async (context) => {
      signal = context.signal;
      return new Promise<number>(() => undefined);
    });
    coordinator.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshots()).toHaveLength(0);
  });

  it('makes disposal idempotent', () => {
    const coordinator = createSpatialRequestCoordinator();
    expect(() => { coordinator.dispose(); coordinator.dispose(); }).not.toThrow();
  });

  it('preserves numeric zero and other values without transformation', async () => {
    const coordinator = createSpatialRequestCoordinator();
    await expect(coordinator.run('zero', async () => 0, { cacheTtlMs: 100 })).resolves.toBe(0);
    await expect(coordinator.run('zero', async () => 99, { cacheTtlMs: 100 })).resolves.toBe(0);
  });
});
