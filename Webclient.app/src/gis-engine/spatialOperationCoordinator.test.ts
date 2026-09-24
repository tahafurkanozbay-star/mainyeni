import { describe, expect, it, vi } from 'vitest';
import { SpatialOperationCoordinator } from './spatialOperationCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('SpatialOperationCoordinator', () => {
  it('deduplicates identical in-flight operations', async () => {
    const gate = deferred<number>();
    const executor = vi.fn(() => gate.promise);
    const coordinator = new SpatialOperationCoordinator<number, number>();
    const first = coordinator.execute({ key: 'same', kind: 'buffer', input: 1 }, executor);
    const second = coordinator.execute({ key: 'same', kind: 'buffer', input: 999 }, executor);
    await tick();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().dedupedSubscribers).toBe(1);
    gate.resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
  });

  it('runs interactive queued work before normal and background work', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const starts: string[] = [];
    const executor = (value: string) => {
      starts.push(value);
      const gate = deferred<string>();
      gates.set(value, gate);
      return gate.promise;
    };
    const coordinator = new SpatialOperationCoordinator<string, string>({ maxConcurrent: 1 });
    const first = coordinator.execute({ key: 'first', kind: 'project', input: 'first' }, executor);
    await tick();
    const background = coordinator.execute({ key: 'background', kind: 'project', input: 'background', priority: 'background' }, executor);
    const normal = coordinator.execute({ key: 'normal', kind: 'project', input: 'normal' }, executor);
    const interactive = coordinator.execute({ key: 'interactive', kind: 'project', input: 'interactive', priority: 'interactive' }, executor);
    expect(starts).toEqual(['first']);
    gates.get('first')!.resolve('first');
    await first;
    await tick();
    expect(starts).toEqual(['first', 'interactive']);
    gates.get('interactive')!.resolve('interactive');
    await interactive;
    await tick();
    expect(starts.at(-1)).toBe('normal');
    gates.get('normal')!.resolve('normal');
    await normal;
    await tick();
    gates.get('background')!.resolve('background');
    await expect(background).resolves.toBe('background');
  });

  it('cancels only one subscriber while shared work still has consumers', async () => {
    const gate = deferred<number>();
    let transportSignal: AbortSignal | undefined;
    const executor = (_value: number, context: { signal: AbortSignal }) => {
      transportSignal = context.signal;
      return gate.promise;
    };
    const coordinator = new SpatialOperationCoordinator<number, number>();
    const aborter = new AbortController();
    const cancelled = coordinator.execute({ key: 'shared', kind: 'nearest', input: 1, signal: aborter.signal }, executor);
    const survivor = coordinator.execute({ key: 'shared', kind: 'nearest', input: 1 }, executor);
    await tick();
    aborter.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(false);
    gate.resolve(42);
    await expect(survivor).resolves.toBe(42);
  });

  it('aborts transport when the last subscriber cancels', async () => {
    let observed: AbortSignal | undefined;
    const executor = (_value: number, context: { signal: AbortSignal }) => new Promise<number>((_resolve, reject) => {
      observed = context.signal;
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    });
    const coordinator = new SpatialOperationCoordinator<number, number>();
    const aborter = new AbortController();
    const promise = coordinator.execute({ key: 'only', kind: 'union', input: 1, signal: aborter.signal }, executor);
    await tick();
    aborter.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed?.aborted).toBe(true);
    expect(coordinator.snapshot().running).toBe(0);
  });

  it('serves successful results from bounded TTL cache', async () => {
    let now = 100;
    const executor = vi.fn(async (value: number) => value * 2);
    const coordinator = new SpatialOperationCoordinator<number, number>({ cacheTtlMs: 10, now: () => now });
    await expect(coordinator.execute({ key: 'cache', kind: 'simplify', input: 3 }, executor)).resolves.toBe(6);
    await expect(coordinator.execute({ key: 'cache', kind: 'simplify', input: 99 }, executor)).resolves.toBe(6);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().cacheHits).toBe(1);
    now = 111;
    await expect(coordinator.execute({ key: 'cache', kind: 'simplify', input: 4 }, executor)).resolves.toBe(8);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('evicts least recently used cache entries deterministically', async () => {
    let now = 1;
    const coordinator = new SpatialOperationCoordinator<string, string>({ maxCacheEntries: 2, cacheTtlMs: 100, now: () => now });
    const executor = vi.fn(async (value: string) => value);
    await coordinator.execute({ key: 'a', kind: 'buffer', input: 'a' }, executor);
    now = 2;
    await coordinator.execute({ key: 'b', kind: 'buffer', input: 'b' }, executor);
    now = 3;
    await coordinator.execute({ key: 'a', kind: 'buffer', input: 'ignored' }, executor);
    now = 4;
    await coordinator.execute({ key: 'c', kind: 'buffer', input: 'c' }, executor);
    expect(coordinator.snapshot().evictions).toBe(1);
    await coordinator.execute({ key: 'b', kind: 'buffer', input: 'b2' }, executor);
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it('supports kind and exact-key cache invalidation', async () => {
    const coordinator = new SpatialOperationCoordinator<number, number>();
    const executor = vi.fn(async (value: number) => value);
    await coordinator.execute({ key: 'a', kind: 'buffer', input: 1 }, executor);
    await coordinator.execute({ key: 'b', kind: 'buffer', input: 2 }, executor);
    await coordinator.execute({ key: 'a', kind: 'project', input: 3 }, executor);
    expect(coordinator.invalidate('buffer', 'a')).toBe(1);
    expect(coordinator.invalidate('buffer')).toBe(1);
    expect(coordinator.snapshot().cached).toBe(1);
    expect(coordinator.invalidate()).toBe(1);
  });

  it('rejects overflow instead of growing an unbounded queue', async () => {
    const gate = deferred<number>();
    const coordinator = new SpatialOperationCoordinator<number, number>({ maxConcurrent: 1, maxQueued: 1 });
    const executor = () => gate.promise;
    const running = coordinator.execute({ key: 'running', kind: 'intersect', input: 1 }, executor);
    await tick();
    const queued = coordinator.execute({ key: 'queued', kind: 'intersect', input: 2 }, executor);
    await expect(coordinator.execute({ key: 'overflow', kind: 'intersect', input: 3 }, executor)).rejects.toThrow('capacity exceeded');
    coordinator.dispose();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not cache failures and tracks them separately', async () => {
    const coordinator = new SpatialOperationCoordinator<number, number>();
    const executor = vi.fn(async () => { throw new Error('geometry failed'); });
    await expect(coordinator.execute({ key: 'bad', kind: 'project', input: 1 }, executor)).rejects.toThrow('geometry failed');
    expect(coordinator.snapshot()).toMatchObject({ failed: 1, cached: 0, completed: 0 });
    await expect(coordinator.execute({ key: 'bad', kind: 'project', input: 1 }, executor)).rejects.toThrow();
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('validates budgets and keys fail closed', () => {
    expect(() => new SpatialOperationCoordinator({ maxConcurrent: 0 })).toThrow('maxConcurrent');
    expect(() => new SpatialOperationCoordinator({ maxQueued: Number.NaN })).toThrow('maxQueued');
    expect(() => new SpatialOperationCoordinator({ cacheTtlMs: -1 })).toThrow('cacheTtlMs');
    const coordinator = new SpatialOperationCoordinator<number, number>();
    expect(() => coordinator.execute({ key: '   ', kind: 'buffer', input: 1 }, async (value) => value)).toThrow('must not be empty');
    expect(() => coordinator.invalidate(undefined, 'key')).toThrow('kind is required');
  });

  it('rejects new work and clears resources after disposal', async () => {
    const coordinator = new SpatialOperationCoordinator<number, number>();
    coordinator.dispose();
    await expect(coordinator.execute({ key: 'late', kind: 'buffer', input: 1 }, async (value) => value)).rejects.toThrow('disposed');
    expect(coordinator.snapshot()).toMatchObject({ running: 0, queued: 0, cached: 0 });
  });
});
