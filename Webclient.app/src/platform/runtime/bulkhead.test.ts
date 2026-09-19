import { describe, expect, it, vi } from 'vitest';
import { BoundedBulkhead, BulkheadRejectedError } from './bulkhead';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('BoundedBulkhead', () => {
  it('bounds global concurrency and drains queued work', async () => {
    const gate = deferred<number>();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 2 });
    const first = bulkhead.run(() => gate.promise);
    const second = bulkhead.run(async () => 2);
    expect(bulkhead.snapshot()).toMatchObject({ active: 1, queued: 1 });
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(bulkhead.snapshot()).toMatchObject({ active: 0, queued: 0, totalStarted: 2, totalCompleted: 2 });
  });

  it('isolates owners while allowing another owner to use free capacity', async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 2, maxConcurrentPerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2 });
    const a1 = bulkhead.run(() => a.promise, { owner: 'a' });
    const a2 = bulkhead.run(async () => 2, { owner: 'a' });
    const b1 = bulkhead.run(() => b.promise, { owner: 'b' });
    expect(bulkhead.snapshot()).toMatchObject({ active: 2, queued: 1 });
    b.resolve();
    await b1;
    expect(bulkhead.snapshot()).toMatchObject({ active: 1, queued: 1 });
    a.resolve();
    await a1;
    await expect(a2).resolves.toBe(2);
  });

  it('rejects beyond global queue capacity', async () => {
    const gate = deferred<void>();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 1, maxQueuedPerOwner: 1 });
    const running = bulkhead.run(() => gate.promise);
    const queued = bulkhead.run(async () => undefined);
    await expect(bulkhead.run(async () => undefined)).rejects.toMatchObject({ reason: 'queue-capacity' });
    gate.resolve();
    await running;
    await queued;
  });

  it('rejects one noisy owner without consuming all queue slots', async () => {
    const gate = deferred<void>();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 4, maxQueuedPerOwner: 1 });
    const running = bulkhead.run(() => gate.promise, { owner: 'a' });
    const queuedA = bulkhead.run(async () => 1, { owner: 'a' });
    await expect(bulkhead.run(async () => 2, { owner: 'a' })).rejects.toMatchObject({ reason: 'owner-capacity' });
    const queuedB = bulkhead.run(async () => 3, { owner: 'b' });
    expect(bulkhead.snapshot().queued).toBe(2);
    gate.resolve();
    await running;
    await expect(queuedA).resolves.toBe(1);
    await expect(queuedB).resolves.toBe(3);
  });

  it('removes an aborted queued entry and its listener', async () => {
    const gate = deferred<void>();
    const controller = new AbortController();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 2 });
    const running = bulkhead.run(() => gate.promise);
    const queued = bulkhead.run(async () => 2, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toEqual(new BulkheadRejectedError('aborted'));
    expect(bulkhead.snapshot().queued).toBe(0);
    gate.resolve();
    await running;
  });

  it('fails fast when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const bulkhead = new BoundedBulkhead();
    await expect(bulkhead.run(async () => 1, { signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted' });
    expect(bulkhead.snapshot().totalStarted).toBe(0);
  });

  it('expires queued work after its bounded wait budget', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<void>();
      const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 100 });
      const running = bulkhead.run(() => gate.promise);
      const queued = bulkhead.run(async () => 2, { queueWaitMs: 20 });
      const assertion = expect(queued).rejects.toMatchObject({ reason: 'queue-timeout' });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(bulkhead.snapshot().queued).toBe(0);
      gate.resolve();
      await running;
    } finally { vi.useRealTimers(); }
  });

  it('disposes queued work and rejects future admission', async () => {
    const gate = deferred<void>();
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1, maxQueued: 2 });
    const running = bulkhead.run(() => gate.promise);
    const queued = bulkhead.run(async () => 2);
    bulkhead.dispose();
    await expect(queued).rejects.toMatchObject({ reason: 'disposed' });
    await expect(bulkhead.run(async () => 3)).rejects.toMatchObject({ reason: 'disposed' });
    gate.resolve();
    await running;
    expect(bulkhead.snapshot().disposed).toBe(true);
  });

  it('contains synchronous operation throws and frees capacity', async () => {
    const bulkhead = new BoundedBulkhead({ maxConcurrent: 1 });
    await expect(bulkhead.run(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(bulkhead.run(async () => 4)).resolves.toBe(4);
    expect(bulkhead.snapshot()).toMatchObject({ active: 0, totalStarted: 2, totalCompleted: 2 });
  });

  it('keeps immutable bounded history', async () => {
    let now = 0;
    const bulkhead = new BoundedBulkhead({ historyLimit: 2, clock: () => ++now });
    await bulkhead.run(async () => 1);
    const history = bulkhead.history();
    expect(history).toHaveLength(2);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('validates configuration and owner boundaries', async () => {
    expect(() => new BoundedBulkhead({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new BoundedBulkhead({ maxConcurrent: 2, maxConcurrentPerOwner: 3 })).toThrow(RangeError);
    expect(() => new BoundedBulkhead({ maxQueued: 1, maxQueuedPerOwner: 2 })).toThrow(RangeError);
    const bulkhead = new BoundedBulkhead();
    await expect(bulkhead.run(async () => 1, { owner: 'x'.repeat(129) })).rejects.toThrow(RangeError);
  });
});
