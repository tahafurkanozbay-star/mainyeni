import { describe, expect, it, vi } from 'vitest';
import {
  QueryLifecycleCoordinator,
  QueryLifecycleError,
  normalizeQueryLifecyclePolicy,
} from './queryLifecycle';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('normalizeQueryLifecyclePolicy', () => {
  it('uses bounded production defaults', () => {
    expect(normalizeQueryLifecyclePolicy()).toEqual({
      maxConcurrent: 6,
      maxQueued: 128,
      timeoutMs: 30_000,
      dedupeTtlMs: 250,
      maxRecentEntries: 256,
      maxSubscribersPerQuery: 64,
      maxKeyLength: 512,
    });
  });

  it('falls back when invalid values attempt to widen resource bounds', () => {
    expect(normalizeQueryLifecyclePolicy({
      maxConcurrent: 0,
      maxQueued: Number.MAX_SAFE_INTEGER,
      timeoutMs: -1,
      dedupeTtlMs: -1,
      maxRecentEntries: 0,
      maxSubscribersPerQuery: 0,
      maxKeyLength: 100_000,
    })).toEqual({
      maxConcurrent: 6,
      maxQueued: 128,
      timeoutMs: 30_000,
      dedupeTtlMs: 250,
      maxRecentEntries: 256,
      maxSubscribersPerQuery: 64,
      maxKeyLength: 512,
    });
  });

  it('accepts safe explicit limits', () => {
    expect(normalizeQueryLifecyclePolicy({
      maxConcurrent: 2,
      maxQueued: 4,
      timeoutMs: 1250,
      dedupeTtlMs: 0,
      maxRecentEntries: 8,
      maxSubscribersPerQuery: 3,
      maxKeyLength: 96,
    })).toEqual({
      maxConcurrent: 2,
      maxQueued: 4,
      timeoutMs: 1250,
      dedupeTtlMs: 0,
      maxRecentEntries: 8,
      maxSubscribersPerQuery: 3,
      maxKeyLength: 96,
    });
  });
});

describe('QueryLifecycleCoordinator', () => {
  it('deduplicates concurrent work while preserving subscriber results', async () => {
    const gate = deferred<number>();
    const execute = vi.fn(() => gate.promise);
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 2,
      dedupeTtlMs: 0,
    });

    const first = coordinator.execute({
      key: 'layer:1',
      priority: 'foreground',
      execute,
    });
    const second = coordinator.execute({
      key: 'layer:1',
      priority: 'interactive',
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      inflight: 1,
      active: 1,
      dedupedSubscribers: 1,
      activeSubscribers: 2,
    });

    gate.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(coordinator.snapshot()).toMatchObject({
      completed: 1,
      inflight: 0,
      activeSubscribers: 0,
    });
  });

  it('orders queued work by priority without preempting active work', async () => {
    const firstGate = deferred<string>();
    const order: string[] = [];
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      dedupeTtlMs: 0,
    });

    const first = coordinator.execute({
      key: 'first',
      priority: 'background',
      execute: async () => {
        order.push('first');
        return firstGate.promise;
      },
    });
    const background = coordinator.execute({
      key: 'background',
      priority: 'background',
      execute: async () => {
        order.push('background');
        return 'background';
      },
    });
    const interactive = coordinator.execute({
      key: 'interactive',
      priority: 'interactive',
      execute: async () => {
        order.push('interactive');
        return 'interactive';
      },
    });

    firstGate.resolve('first');
    await first;
    await interactive;
    await background;
    expect(order).toEqual(['first', 'interactive', 'background']);
  });

  it('promotes a deduplicated queued request when a higher priority subscriber arrives', async () => {
    const activeGate = deferred<void>();
    const order: string[] = [];
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      maxQueued: 4,
      dedupeTtlMs: 0,
    });

    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => activeGate.promise,
    });
    const promotedFirst = coordinator.execute({
      key: 'shared',
      priority: 'background',
      execute: async () => {
        order.push('shared');
        return 7;
      },
    });
    const normal = coordinator.execute({
      key: 'normal',
      priority: 'foreground',
      execute: async () => {
        order.push('normal');
        return 8;
      },
    });
    const promotedSecond = coordinator.execute({
      key: 'shared',
      priority: 'interactive',
      execute: async () => 999,
    });

    expect(coordinator.snapshot()).toMatchObject({
      queued: 2,
      priorityPromotions: 1,
      dedupedSubscribers: 1,
    });

    activeGate.resolve();
    await active;
    await expect(promotedFirst).resolves.toBe(7);
    await expect(promotedSecond).resolves.toBe(7);
    await expect(normal).resolves.toBe(8);
    expect(order).toEqual(['shared', 'normal']);
  });

  it('rejects admission when active and bounded queue capacity are saturated', async () => {
    const gate = deferred<void>();
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      maxQueued: 1,
      dedupeTtlMs: 0,
    });

    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => gate.promise,
    });
    const queued = coordinator.execute({
      key: 'queued',
      priority: 'foreground',
      execute: async () => undefined,
    });

    await expect(coordinator.execute({
      key: 'overflow',
      priority: 'foreground',
      execute: async () => undefined,
    })).rejects.toMatchObject({ code: 'queue-full' });

    gate.resolve();
    await active;
    await queued;
    expect(coordinator.snapshot().rejected).toBe(1);
  });

  it('bounds subscribers on a shared request', async () => {
    const gate = deferred<number>();
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      maxSubscribersPerQuery: 2,
      dedupeTtlMs: 0,
    });

    const first = coordinator.execute({
      key: 'shared',
      priority: 'foreground',
      execute: () => gate.promise,
    });
    const second = coordinator.execute({
      key: 'shared',
      priority: 'foreground',
      execute: async () => 9,
    });

    await expect(coordinator.execute({
      key: 'shared',
      priority: 'interactive',
      execute: async () => 10,
    })).rejects.toMatchObject({ code: 'subscriber-limit' });

    expect(coordinator.snapshot()).toMatchObject({
      activeSubscribers: 2,
      dedupedSubscribers: 1,
      rejected: 1,
    });

    gate.resolve(5);
    await expect(first).resolves.toBe(5);
    await expect(second).resolves.toBe(5);
  });

  it('cancels one subscriber without cancelling shared work needed by another', async () => {
    const gate = deferred<number>();
    const controller = new AbortController();
    const coordinator = new QueryLifecycleCoordinator({ dedupeTtlMs: 0 });
    const execute = vi.fn(() => gate.promise);

    const cancelled = coordinator.execute({
      key: 'shared',
      priority: 'foreground',
      execute,
      signal: controller.signal,
    });
    const survivor = coordinator.execute({
      key: 'shared',
      priority: 'foreground',
      execute,
    });

    controller.abort('no-longer-needed');

    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(coordinator.snapshot()).toMatchObject({
      cancelledSubscribers: 1,
      cancelledQueries: 0,
      activeSubscribers: 1,
    });

    gate.resolve(7);
    await expect(survivor).resolves.toBe(7);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('removes a queued request when its final subscriber cancels', async () => {
    const activeGate = deferred<void>();
    const controller = new AbortController();
    const queuedExecute = vi.fn(async () => 'should-not-run');
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      dedupeTtlMs: 0,
    });

    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => activeGate.promise,
    });
    const queued = coordinator.execute({
      key: 'queued',
      priority: 'background',
      execute: queuedExecute,
      signal: controller.signal,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(coordinator.snapshot()).toMatchObject({
      queued: 0,
      inflight: 1,
      cancelledSubscribers: 1,
      cancelledQueries: 1,
    });

    activeGate.resolve();
    await active;
    expect(queuedExecute).not.toHaveBeenCalled();
  });

  it('aborts an active request when its final subscriber cancels', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      dedupeTtlMs: 0,
    });

    const result = coordinator.execute({
      key: 'active-cancel',
      priority: 'foreground',
      signal: controller.signal,
      execute: (signal) => {
        operationSignal = signal;
        return new Promise<number>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    controller.abort('view-changed');
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await flush();
    expect(operationSignal?.aborted).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      cancelledSubscribers: 1,
      cancelledQueries: 1,
      inflight: 0,
      active: 0,
    });
  });

  it('enforces hard timeout and aborts the transport signal', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const coordinator = new QueryLifecycleCoordinator({
        timeoutMs: 25,
        dedupeTtlMs: 0,
      });

      const result = coordinator.execute({
        key: 'slow',
        priority: 'foreground',
        execute: (signal) => {
          observedSignal = signal;
          return new Promise<number>(() => undefined);
        },
      });

      await vi.advanceTimersByTimeAsync(26);
      await expect(result).rejects.toMatchObject({ code: 'timeout' });
      expect(observedSignal?.aborted).toBe(true);
      expect(coordinator.snapshot()).toMatchObject({
        timedOut: 1,
        active: 0,
        inflight: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a successful value for the configured short TTL', async () => {
    let now = 1000;
    const execute = vi.fn(async () => 17);
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 100,
      maxRecentEntries: 4,
    }, () => now);

    await expect(coordinator.execute({
      key: 'cached',
      priority: 'foreground',
      execute,
    })).resolves.toBe(17);
    await expect(coordinator.execute({
      key: 'cached',
      priority: 'interactive',
      execute,
    })).resolves.toBe(17);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      cacheHits: 1,
      recentEntries: 1,
    });

    now = 1101;
    await expect(coordinator.execute({
      key: 'cached',
      priority: 'foreground',
      execute,
    })).resolves.toBe(17);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('bounds recent result memory with oldest-entry eviction', async () => {
    let now = 1;
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 10_000,
      maxRecentEntries: 2,
    }, () => now);

    for (const key of ['a', 'b', 'c']) {
      await coordinator.execute({
        key,
        priority: 'foreground',
        execute: async () => key,
      });
      now += 1;
    }

    expect(coordinator.snapshot()).toMatchObject({
      recentEntries: 2,
      cacheEvictions: 1,
    });

    const executeA = vi.fn(async () => 'a2');
    await expect(coordinator.execute({
      key: 'a',
      priority: 'foreground',
      execute: executeA,
    })).resolves.toBe('a2');
    expect(executeA).toHaveBeenCalledTimes(1);
  });

  it('supports explicit recent-result invalidation without touching active work', async () => {
    const gate = deferred<number>();
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 500,
      maxConcurrent: 2,
    });

    await coordinator.execute({
      key: 'cached',
      priority: 'foreground',
      execute: async () => 1,
    });
    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => gate.promise,
    });

    expect(coordinator.invalidate('cached')).toBe(1);
    expect(coordinator.snapshot()).toMatchObject({
      recentEntries: 0,
      active: 1,
      inflight: 1,
    });

    gate.resolve(2);
    await active;
  });

  it('cancels a queued request explicitly by key', async () => {
    const gate = deferred<void>();
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      dedupeTtlMs: 0,
    });

    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => gate.promise,
    });
    const queued = coordinator.execute({
      key: 'queued',
      priority: 'background',
      execute: async () => 2,
    });

    expect(coordinator.cancel('queued', 'layer invalidated')).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(coordinator.snapshot()).toMatchObject({
      queued: 0,
      cancelledQueries: 1,
    });

    gate.resolve();
    await active;
  });

  it('cancels an active request explicitly by key', async () => {
    let signal: AbortSignal | undefined;
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 0,
    });

    const result = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: (nextSignal) => {
        signal = nextSignal;
        return new Promise<number>((_, reject) => {
          nextSignal.addEventListener(
            'abort',
            () => reject(nextSignal.reason),
            { once: true },
          );
        });
      },
    });

    expect(coordinator.cancel('active', 'service invalidated')).toBe(true);
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(coordinator.snapshot().cancelledQueries).toBe(1);
  });

  it('rejects empty and overlong keys without invoking work', async () => {
    const execute = vi.fn(async () => 1);
    const coordinator = new QueryLifecycleCoordinator({
      maxKeyLength: 8,
    });

    await expect(coordinator.execute({
      key: '   ',
      priority: 'foreground',
      execute,
    })).rejects.toMatchObject({ code: 'invalid-key' });

    await expect(coordinator.execute({
      key: '123456789',
      priority: 'foreground',
      execute,
    })).rejects.toMatchObject({ code: 'invalid-key' });

    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.snapshot().rejected).toBe(2);
  });

  it('rejects subscribers that were already aborted', async () => {
    const controller = new AbortController();
    controller.abort('stale');
    const execute = vi.fn(async () => 1);
    const coordinator = new QueryLifecycleCoordinator();

    await expect(coordinator.execute({
      key: 'aborted',
      priority: 'foreground',
      execute,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });

    expect(execute).not.toHaveBeenCalled();
    expect(coordinator.snapshot().cancelledSubscribers).toBe(1);
  });

  it('tracks operation failures separately from cancellation and timeout', async () => {
    const coordinator = new QueryLifecycleCoordinator({ dedupeTtlMs: 0 });
    const failure = new Error('transport failed');

    await expect(coordinator.execute({
      key: 'failure',
      priority: 'foreground',
      execute: async () => {
        throw failure;
      },
    })).rejects.toBe(failure);

    expect(coordinator.snapshot()).toMatchObject({
      failed: 1,
      cancelledQueries: 0,
      timedOut: 0,
    });
  });

  it('does not cache failed operations', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(2);
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 1000,
    });

    await expect(coordinator.execute({
      key: 'retry',
      priority: 'foreground',
      execute,
    })).rejects.toThrow('first');

    await expect(coordinator.execute({
      key: 'retry',
      priority: 'foreground',
      execute,
    })).resolves.toBe(2);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).toMatchObject({
      failed: 1,
      completed: 1,
      recentEntries: 1,
    });
  });

  it('does not cache cancelled operations', async () => {
    const controller = new AbortController();
    const execute = vi.fn((signal: AbortSignal) => new Promise<number>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 1000,
    });

    const result = coordinator.execute({
      key: 'cancelled',
      priority: 'foreground',
      execute,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });

    expect(coordinator.snapshot().recentEntries).toBe(0);
  });

  it('clears every recent result with global invalidation', async () => {
    const coordinator = new QueryLifecycleCoordinator({
      dedupeTtlMs: 1000,
      maxRecentEntries: 10,
    });

    await coordinator.execute({
      key: 'one',
      priority: 'foreground',
      execute: async () => 1,
    });
    await coordinator.execute({
      key: 'two',
      priority: 'foreground',
      execute: async () => 2,
    });

    expect(coordinator.invalidate()).toBe(2);
    expect(coordinator.snapshot().recentEntries).toBe(0);
  });

  it('disposes queued and active subscribers deterministically', async () => {
    const activeGate = deferred<number>();
    const coordinator = new QueryLifecycleCoordinator({
      maxConcurrent: 1,
      dedupeTtlMs: 500,
    });

    const active = coordinator.execute({
      key: 'active',
      priority: 'foreground',
      execute: () => activeGate.promise,
    });
    const queued = coordinator.execute({
      key: 'queued',
      priority: 'background',
      execute: async () => 2,
    });

    coordinator.dispose('shutdown');

    await expect(active).rejects.toMatchObject({ code: 'disposed' });
    await expect(queued).rejects.toMatchObject({ code: 'disposed' });
    expect(coordinator.snapshot()).toMatchObject({
      disposed: true,
      active: 0,
      queued: 0,
      inflight: 0,
      recentEntries: 0,
      activeSubscribers: 0,
      cancelledQueries: 2,
    });
  });

  it('makes disposal idempotent', () => {
    const coordinator = new QueryLifecycleCoordinator();
    coordinator.dispose();
    const first = coordinator.snapshot();
    coordinator.dispose();
    expect(coordinator.snapshot()).toEqual(first);
  });

  it('rejects new work after disposal', async () => {
    const execute = vi.fn(async () => 1);
    const coordinator = new QueryLifecycleCoordinator();
    coordinator.dispose();

    await expect(coordinator.execute({
      key: 'late',
      priority: 'foreground',
      execute,
    })).rejects.toMatchObject({ code: 'disposed' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('exposes QueryLifecycleError metadata for callers', () => {
    const error = new QueryLifecycleError('queue-full', 'full');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('QueryLifecycleError');
    expect(error.code).toBe('queue-full');
    expect(error.message).toBe('full');
  });
});
