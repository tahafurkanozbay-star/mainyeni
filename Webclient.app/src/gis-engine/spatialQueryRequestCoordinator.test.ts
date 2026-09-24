import { describe, expect, it, vi } from 'vitest';
import { SpatialQueryRequestCoordinator } from './spatialQueryRequestCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('SpatialQueryRequestCoordinator', () => {
  it('dedupes identical in-flight work while preserving subscribers', async () => {
    const gate = deferred<number>();
    const execute = vi.fn(() => gate.promise);
    const coordinator = new SpatialQueryRequestCoordinator({ maxConcurrent: 2 });
    const first = coordinator.request({ key: 'layer:1:extent:a', execute });
    const second = coordinator.request({ key: 'layer:1:extent:a', execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().dedupedSubscribers).toBe(1);
    gate.resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
  });

  it('enforces bounded concurrency and priority for queued work', async () => {
    const firstGate = deferred<string>();
    const order: string[] = [];
    const coordinator = new SpatialQueryRequestCoordinator({ maxConcurrent: 1, maxQueued: 4 });
    const first = coordinator.request({ key: 'first', execute: async () => { order.push('first'); return firstGate.promise; } });
    const background = coordinator.request({ key: 'background', priority: 'background', execute: async () => { order.push('background'); return 'b'; } });
    const interactive = coordinator.request({ key: 'interactive', priority: 'interactive', execute: async () => { order.push('interactive'); return 'i'; } });
    expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 2 });
    firstGate.resolve('a');
    await expect(first).resolves.toBe('a');
    await expect(interactive).resolves.toBe('i');
    await expect(background).resolves.toBe('b');
    expect(order).toEqual(['first', 'interactive', 'background']);
  });

  it('cancels one subscriber without cancelling shared work', async () => {
    const gate = deferred<number>();
    let transportSignal: AbortSignal | undefined;
    const execute = (signal: AbortSignal) => { transportSignal = signal; return gate.promise; };
    const coordinator = new SpatialQueryRequestCoordinator();
    const controller = new AbortController();
    const cancelled = coordinator.request({ key: 'shared', signal: controller.signal, execute });
    const survivor = coordinator.request({ key: 'shared', execute });
    controller.abort(new Error('caller left'));
    await expect(cancelled).rejects.toThrow('caller left');
    expect(transportSignal?.aborted).toBe(false);
    gate.resolve(11);
    await expect(survivor).resolves.toBe(11);
  });

  it('aborts transport when the last subscriber leaves', async () => {
    const gate = deferred<number>();
    let transportSignal: AbortSignal | undefined;
    const coordinator = new SpatialQueryRequestCoordinator();
    const controller = new AbortController();
    const result = coordinator.request({ key: 'alone', signal: controller.signal, execute: signal => { transportSignal = signal; return gate.promise; } });
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(transportSignal?.aborted).toBe(true);
    gate.reject(new Error('aborted transport'));
  });

  it('uses and invalidates the bounded settled cache', async () => {
    const coordinator = new SpatialQueryRequestCoordinator({ maxSettledCache: 2, cacheTtlMs: 60_000 });
    const execute = vi.fn(async () => 5);
    await coordinator.request({ key: 'cached', execute });
    await expect(coordinator.request({ key: 'cached', execute })).resolves.toBe(5);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.invalidate('cached')).toBe(true);
    await coordinator.request({ key: 'cached', execute });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest settled cache entry deterministically', async () => {
    const coordinator = new SpatialQueryRequestCoordinator({ maxSettledCache: 2, cacheTtlMs: 60_000 });
    const counts = new Map<string, number>();
    const load = (key: string) => coordinator.request({ key, execute: async () => { counts.set(key, (counts.get(key) ?? 0) + 1); return key; } });
    await load('a'); await load('b'); await load('c');
    expect(coordinator.snapshot().cached).toBe(2);
    await load('a');
    expect(counts.get('a')).toBe(2);
    await load('c');
    expect(counts.get('c')).toBe(1);
  });

  it('fails closed when queue capacity is exhausted', async () => {
    const gate = deferred<number>();
    const coordinator = new SpatialQueryRequestCoordinator({ maxConcurrent: 1, maxQueued: 1 });
    const first = coordinator.request({ key: 'one', execute: () => gate.promise });
    const second = coordinator.request({ key: 'two', execute: async () => 2 });
    await expect(coordinator.request({ key: 'three', execute: async () => 3 })).rejects.toThrow('queue capacity exhausted');
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('disposes active and queued subscribers deterministically', async () => {
    const gate = deferred<number>();
    const coordinator = new SpatialQueryRequestCoordinator({ maxConcurrent: 1 });
    const first = coordinator.request({ key: 'active', execute: () => gate.promise });
    const second = coordinator.request({ key: 'queued', execute: async () => 2 });
    coordinator.dispose(new Error('shutdown'));
    await expect(first).rejects.toThrow('shutdown');
    await expect(second).rejects.toThrow('shutdown');
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0, cached: 0 });
    await expect(coordinator.request({ key: 'late', execute: async () => 1 })).rejects.toThrow('disposed');
    gate.reject(new Error('transport ended'));
  });

  it('validates configuration and request identity', async () => {
    expect(() => new SpatialQueryRequestCoordinator({ maxConcurrent: 0 })).toThrow('maxConcurrent');
    expect(() => new SpatialQueryRequestCoordinator({ cacheTtlMs: -1 })).toThrow('cacheTtlMs');
    const coordinator = new SpatialQueryRequestCoordinator();
    await expect(coordinator.request({ key: '   ', execute: async () => 1 })).rejects.toThrow('key must not be empty');
  });
});
