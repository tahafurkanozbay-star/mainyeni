import { createRequestCoordinator, RequestCoordinatorError } from './requestCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('BoundedRequestCoordinator', () => {
  it('deduplicates concurrent requests with the same namespace, generation and key', async () => {
    const coordinator = createRequestCoordinator({ maxConcurrent: 2 });
    const gate = deferred<number>();
    let executions = 0;
    const work = async () => { executions += 1; return gate.promise; };
    const first = coordinator.run('extent:1', work, { namespace: 'layer:a', generation: 3 });
    const second = coordinator.run('extent:1', work, { namespace: 'layer:a', generation: 3 });
    gate.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(executions).toBe(1);
    expect(coordinator.snapshot().deduped).toBe(1);
  });

  it('does not dedupe different generations', async () => {
    const coordinator = createRequestCoordinator({ maxConcurrent: 2 });
    let executions = 0;
    const work = async () => ++executions;
    await coordinator.run('same', work, { namespace: 'a', generation: 1, cache: false });
    await coordinator.run('same', work, { namespace: 'a', generation: 2, cache: false });
    expect(executions).toBe(2);
  });

  it('caches bounded values and records hits without re-executing work', async () => {
    let now = 1000;
    const coordinator = createRequestCoordinator({ now: () => now, cacheEntries: 4, cacheBytes: 1024, defaultTtlMs: 100 });
    let executions = 0;
    const work = async () => ({ value: ++executions });
    await expect(coordinator.run('k', work)).resolves.toEqual({ value: 1 });
    await expect(coordinator.run('k', work)).resolves.toEqual({ value: 1 });
    expect(executions).toBe(1);
    expect(coordinator.snapshot().cacheHits).toBe(1);
    now += 101;
    await expect(coordinator.run('k', work)).resolves.toEqual({ value: 2 });
  });

  it('evicts least recently used cache entries under entry pressure', async () => {
    let now = 1;
    const coordinator = createRequestCoordinator({ now: () => now++, cacheEntries: 2, cacheBytes: 4096 });
    await coordinator.run('a', async () => 'A');
    await coordinator.run('b', async () => 'B');
    await coordinator.run('a', async () => 'A2');
    await coordinator.run('c', async () => 'C');
    let bExecutions = 0;
    await coordinator.run('b', async () => { bExecutions += 1; return 'B2'; });
    expect(bExecutions).toBe(1);
    expect(coordinator.snapshot().evicted).toBeGreaterThan(0);
  });

  it('aborting one deduped consumer does not cancel remaining consumers', async () => {
    const coordinator = createRequestCoordinator();
    const gate = deferred<string>();
    const firstController = new AbortController();
    const first = coordinator.run('shared', async () => gate.promise, { signal: firstController.signal });
    const second = coordinator.run('shared', async () => gate.promise);
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve('ok');
    await expect(second).resolves.toBe('ok');
  });

  it('aborts shared work after the final consumer leaves', async () => {
    const coordinator = createRequestCoordinator();
    const controller = new AbortController();
    const transportSignals: AbortSignal[] = [];
    const result = coordinator.run('x', ({ signal }) => new Promise((_resolve, reject) => {
      transportSignals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { signal: controller.signal });
    controller.abort('gone');
    await expect(result).rejects.toBeTruthy();
    expect(transportSignals[0]?.aborted).toBe(true);
  });

  it('prioritizes critical queued work ahead of background work', async () => {
    const coordinator = createRequestCoordinator({ maxConcurrent: 1, maxQueued: 8, cacheEntries: 0 });
    const gate = deferred<void>();
    const order: string[] = [];
    const blocker = coordinator.run('block', async () => { await gate.promise; order.push('block'); }, { cache: false });
    const background = coordinator.run('background', async () => { order.push('background'); }, { priority: 'background', cache: false });
    const critical = coordinator.run('critical', async () => { order.push('critical'); }, { priority: 'critical', cache: false });
    gate.resolve();
    await Promise.all([blocker, background, critical]);
    expect(order).toEqual(['block', 'critical', 'background']);
  });

  it('rejects requests when the bounded queue is saturated', async () => {
    const coordinator = createRequestCoordinator({ maxConcurrent: 1, maxQueued: 1, cacheEntries: 0 });
    const gate = deferred<void>();
    void coordinator.run('running', () => gate.promise, { cache: false });
    void coordinator.run('queued', () => gate.promise, { cache: false });
    await expect(coordinator.run('overflow', async () => 1, { cache: false })).rejects.toMatchObject({
      code: 'REQUEST_QUEUE_FULL',
    });
    gate.resolve();
  });

  it('suppresses results from superseded generations', async () => {
    const coordinator = createRequestCoordinator();
    const gate = deferred<number>();
    const pending = coordinator.run('k', async () => gate.promise, { namespace: 'search', generation: 1, cache: false });
    coordinator.advanceGeneration('search', 2);
    gate.resolve(10);
    await expect(pending).rejects.toBeTruthy();
    expect(coordinator.snapshot().cancelled + coordinator.snapshot().staleSuppressed).toBeGreaterThan(0);
  });

  it('invalidates cache by namespace without affecting sibling namespaces', async () => {
    const coordinator = createRequestCoordinator();
    let runs = 0;
    const work = async () => ++runs;
    await coordinator.run('k', work, { namespace: 'a' });
    await coordinator.run('k', work, { namespace: 'b' });
    expect(coordinator.invalidate(undefined, 'a')).toBe(1);
    await coordinator.run('k', work, { namespace: 'b' });
    expect(runs).toBe(2);
    await coordinator.run('k', work, { namespace: 'a' });
    expect(runs).toBe(3);
  });

  it('refuses work after destroy', async () => {
    const coordinator = createRequestCoordinator();
    coordinator.destroy();
    await expect(coordinator.run('x', async () => 1)).rejects.toBeInstanceOf(RequestCoordinatorError);
  });
});
