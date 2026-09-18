import { describe, expect, it, vi } from 'vitest';
import { createLazyResourceRuntime } from './lazyResourceRuntime';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('createLazyResourceRuntime', () => {
  it('loads and caches successful resources', async () => {
    const loader = vi.fn(async () => ({ ok: true }));
    const runtime = createLazyResourceRuntime<{ ok: boolean }>();
    const first = await runtime.load('module', loader);
    const second = await runtime.load('module', loader);
    expect(first).toEqual({ ok: true });
    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({ totalLoads: 1, cacheHits: 1 });
  });

  it('deduplicates concurrent loads', async () => {
    const wait = deferred<string>();
    const loader = vi.fn(() => wait.promise);
    const runtime = createLazyResourceRuntime<string>();
    const first = runtime.load('module', loader);
    const second = runtime.load('module', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    wait.resolve('ready');
    await expect(first).resolves.toBe('ready');
    await expect(second).resolves.toBe('ready');
    expect(runtime.snapshot().dedupedLoads).toBe(1);
  });

  it('passes a shared AbortSignal to the loader', async () => {
    let observed: AbortSignal | null = null;
    const runtime = createLazyResourceRuntime<string>();
    await runtime.load('module', async (_key, context) => {
      observed = context.signal;
      return 'ok';
    });
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(false);
  });

  it('supports subscriber-local cancellation without cancelling shared work', async () => {
    const wait = deferred<string>();
    let sharedSignal: AbortSignal | null = null;
    const runtime = createLazyResourceRuntime<string>();
    const controller = new AbortController();
    const cancelled = runtime.load('module', async (_key, context) => {
      sharedSignal = context.signal;
      return wait.promise;
    }, { signal: controller.signal });
    const survivor = runtime.load('module', async () => 'should-not-run');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal?.aborted).toBe(false);
    wait.resolve('ready');
    await expect(survivor).resolves.toBe('ready');
  });

  it('rejects already-aborted subscribers immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = createLazyResourceRuntime<string>();
    await expect(runtime.load('x', async () => 'ok', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('expires cached entries by TTL', async () => {
    let now = 0;
    const loader = vi.fn(async () => 'ok');
    const runtime = createLazyResourceRuntime<string>({ now: () => now, defaultTtlMs: 250 });
    await runtime.load('x', loader);
    now = 249;
    expect(runtime.has('x')).toBe(true);
    now = 250;
    expect(runtime.has('x')).toBe(false);
    await runtime.load('x', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('supports persistent entries with null TTL', async () => {
    let now = 0;
    const runtime = createLazyResourceRuntime<string>({ now: () => now });
    await runtime.load('x', async () => 'ok', { ttlMs: null });
    now = 9_999_999;
    expect(runtime.has('x')).toBe(true);
  });

  it('supports per-load TTL override', async () => {
    let now = 0;
    const runtime = createLazyResourceRuntime<string>({ now: () => now, defaultTtlMs: 1000 });
    await runtime.load('x', async () => 'ok', { ttlMs: 250 });
    now = 250;
    expect(runtime.has('x')).toBe(false);
  });

  it('force refresh replaces cached value', async () => {
    let count = 0;
    const runtime = createLazyResourceRuntime<number>();
    expect(await runtime.load('x', async () => ++count)).toBe(1);
    expect(await runtime.load('x', async () => ++count, { forceRefresh: true })).toBe(2);
    expect(runtime.snapshot().totalLoads).toBe(2);
  });

  it('force refresh aborts prior in-flight work', async () => {
    const first = deferred<string>();
    let firstSignal: AbortSignal | null = null;
    const runtime = createLazyResourceRuntime<string>();
    const stale = runtime.load('x', async (_key, context) => {
      firstSignal = context.signal;
      return first.promise;
    });
    const fresh = runtime.load('x', async () => 'fresh', { forceRefresh: true });
    expect(firstSignal?.aborted).toBe(true);
    await expect(fresh).resolves.toBe('fresh');
    first.resolve('stale');
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes failed loads so retry can proceed', async () => {
    let attempts = 0;
    const runtime = createLazyResourceRuntime<string>();
    await expect(runtime.load('x', async () => {
      attempts += 1;
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(runtime.has('x')).toBe(false);
    await expect(runtime.load('x', async () => {
      attempts += 1;
      return 'ok';
    })).resolves.toBe('ok');
    expect(attempts).toBe(2);
    expect(runtime.snapshot().failures).toBe(1);
  });

  it('does not count aborts as loader failures', async () => {
    const wait = deferred<string>();
    const runtime = createLazyResourceRuntime<string>();
    const pending = runtime.load('x', async () => wait.promise);
    runtime.evict('x');
    wait.resolve('late');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().failures).toBe(0);
  });

  it('evicts ready resources explicitly', async () => {
    const runtime = createLazyResourceRuntime<string>();
    await runtime.load('x', async () => 'ok');
    expect(runtime.evict('x')).toBe(true);
    expect(runtime.evict('x')).toBe(false);
    expect(runtime.has('x')).toBe(false);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('clear aborts all in-flight work', async () => {
    const one = deferred<string>();
    const two = deferred<string>();
    let signalOne: AbortSignal | null = null;
    let signalTwo: AbortSignal | null = null;
    const runtime = createLazyResourceRuntime<string>();
    const a = runtime.load('a', async (_key, context) => {
      signalOne = context.signal;
      return one.promise;
    });
    const b = runtime.load('b', async (_key, context) => {
      signalTwo = context.signal;
      return two.promise;
    });
    expect(runtime.clear()).toBe(2);
    expect(signalOne?.aborted).toBe(true);
    expect(signalTwo?.aborted).toBe(true);
    one.resolve('a');
    two.resolve('b');
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('evicts least-recently-used ready entries when full', async () => {
    let now = 0;
    const runtime = createLazyResourceRuntime<string>({ capacity: 2, now: () => ++now, defaultTtlMs: null });
    await runtime.load('a', async () => 'a');
    await runtime.load('b', async () => 'b');
    await runtime.load('a', async () => 'a');
    await runtime.load('c', async () => 'c');
    expect(runtime.has('a')).toBe(true);
    expect(runtime.has('b')).toBe(false);
    expect(runtime.has('c')).toBe(true);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('fails closed when capacity is occupied only by in-flight work', async () => {
    const wait = deferred<string>();
    const runtime = createLazyResourceRuntime<string>({ capacity: 1 });
    const pending = runtime.load('a', async () => wait.promise);
    await expect(runtime.load('b', async () => 'b')).rejects.toThrow(/capacity exceeded/i);
    wait.resolve('a');
    await expect(pending).resolves.toBe('a');
  });

  it('clamps capacity', () => {
    expect(createLazyResourceRuntime({ capacity: 0 }).snapshot().capacity).toBe(1);
    expect(createLazyResourceRuntime({ capacity: 9999 }).snapshot().capacity).toBe(256);
  });

  it('rejects blank keys', async () => {
    const runtime = createLazyResourceRuntime();
    await expect(runtime.load('  ', async () => 'x')).rejects.toThrow(/empty/i);
  });

  it('rejects oversized keys', async () => {
    const runtime = createLazyResourceRuntime();
    await expect(runtime.load('x'.repeat(201), async () => 'x')).rejects.toThrow(/200/i);
  });

  it('rejects invalid loaders', async () => {
    const runtime = createLazyResourceRuntime();
    await expect(runtime.load('x', null as never)).rejects.toThrow(/loader/i);
  });

  it('fails closed on invalid clocks', async () => {
    const runtime = createLazyResourceRuntime({ now: () => Number.NaN });
    await expect(runtime.load('x', async () => 'x')).rejects.toThrow(/clock/i);
  });

  it('snapshot exposes deterministic sorted entry metadata', async () => {
    const runtime = createLazyResourceRuntime<string>({ defaultTtlMs: null });
    await runtime.load('z', async () => 'z');
    await runtime.load('a', async () => 'a');
    expect(runtime.snapshot().entries.map((entry) => entry.key)).toEqual(['a', 'z']);
  });

  it('snapshot arrays remain detached from later loads', async () => {
    const runtime = createLazyResourceRuntime<string>({ defaultTtlMs: null });
    await runtime.load('a', async () => 'a');
    const first = runtime.snapshot();
    await runtime.load('b', async () => 'b');
    expect(first.entries.map((entry) => entry.key)).toEqual(['a']);
  });

  it('destroy aborts in-flight work and blocks future operations', async () => {
    const wait = deferred<string>();
    let signal: AbortSignal | null = null;
    const runtime = createLazyResourceRuntime<string>();
    const pending = runtime.load('x', async (_key, context) => {
      signal = context.signal;
      return wait.promise;
    });
    runtime.destroy();
    expect(signal?.aborted).toBe(true);
    expect(() => runtime.snapshot()).toThrow(/destroyed/i);
    await expect(runtime.load('y', async () => 'y')).rejects.toThrow(/destroyed/i);
    wait.resolve('late');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('destroy is idempotent', () => {
    const runtime = createLazyResourceRuntime();
    runtime.destroy();
    expect(() => runtime.destroy()).not.toThrow();
  });
});
