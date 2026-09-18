import { describe, expect, it, vi } from 'vitest';
import { createSpatialAnalysisJobRuntime } from './spatialAnalysisJobRuntime';

const configuration = {
  maxConcurrent: 1,
  maxQueued: 4,
  maxHistory: 4,
  defaultTimeoutMs: 0,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('spatialAnalysisJobRuntime', () => {
  it('enforces concurrency and priority while preserving FIFO within a priority', async () => {
    const runtime = createSpatialAnalysisJobRuntime(configuration);
    const firstGate = deferred<number>();
    const order: string[] = [];

    const first = runtime.submit(async () => {
      order.push('first');
      return firstGate.promise;
    }, { priority: 'normal' });
    const background = runtime.submit(() => {
      order.push('background');
      return 2;
    }, { priority: 'background' });
    const interactive = runtime.submit(() => {
      order.push('interactive');
      return 3;
    }, { priority: 'interactive' });

    await Promise.resolve();
    expect(runtime.snapshot()).toMatchObject({ running: 1, queued: 2 });
    firstGate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(interactive).resolves.toBe(3);
    await expect(background).resolves.toBe(2);
    expect(order).toEqual(['first', 'interactive', 'background']);
  });

  it('deduplicates active jobs while isolating subscriber cancellation', async () => {
    const runtime = createSpatialAnalysisJobRuntime(configuration);
    const gate = deferred<number>();
    const executor = vi.fn(() => gate.promise);
    const controller = new AbortController();
    const first = runtime.submit(executor, { dedupeKey: 'layer:parks', signal: controller.signal });
    const second = runtime.submit(executor, { dedupeKey: 'layer:parks' });

    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().deduped).toBe(1);
    controller.abort(new Error('consumer left'));
    await expect(first).rejects.toThrow('consumer left');
    gate.resolve(42);
    await expect(second).resolves.toBe(42);
    expect(runtime.snapshot().cancelled).toBe(0);
  });

  it('aborts the shared job when every subscriber leaves', async () => {
    const runtime = createSpatialAnalysisJobRuntime(configuration);
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const executor = vi.fn(({ signal }: { signal: AbortSignal }) => {
      sharedSignal = signal;
      return new Promise<number>(() => undefined);
    });
    const first = runtime.submit(executor, { dedupeKey: 'shared', signal: controllerA.signal });
    const second = runtime.submit(executor, { dedupeKey: 'shared', signal: controllerB.signal });
    await Promise.resolve();
    controllerA.abort();
    controllerB.abort();
    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
    expect(sharedSignal?.aborted).toBe(true);
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('rejects work when the bounded queue is full', async () => {
    const runtime = createSpatialAnalysisJobRuntime({ ...configuration, maxQueued: 1 });
    const gate = deferred<number>();
    const first = runtime.submit(() => gate.promise);
    const second = runtime.submit(() => 2);
    const third = runtime.submit(() => 3);
    await expect(third).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('times out a cooperative job and records bounded history', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createSpatialAnalysisJobRuntime({ ...configuration, defaultTimeoutMs: 10, maxHistory: 2 });
      const result = runtime.submit(({ signal }) => new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      await vi.advanceTimersByTimeAsync(11);
      await expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(runtime.snapshot()).toMatchObject({ timedOut: 1, retainedHistory: 1 });
      expect(runtime.listHistory()[0]).toMatchObject({ status: 'timed-out', errorCode: 'TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels queued work by id and disposes remaining jobs', async () => {
    const runtime = createSpatialAnalysisJobRuntime(configuration);
    const gate = deferred<number>();
    const first = runtime.submit(() => gate.promise);
    const second = runtime.submit(() => 2, { dedupeKey: 'queued' });
    const queued = runtime.snapshot();
    expect(queued.queued).toBe(1);
    expect(runtime.cancelByDedupeKey('queued')).toBe(true);
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    runtime.dispose();
    await expect(first).rejects.toMatchObject({ code: 'RUNTIME_DISPOSED' });
    expect(runtime.snapshot().disposed).toBe(true);
    await expect(runtime.submit(() => 9)).rejects.toMatchObject({ code: 'RUNTIME_DISPOSED' });
    gate.resolve(1);
  });
});
