import {
  AdminRequestCoordinator,
  AdminRequestCoordinatorError,
} from './adminRequestCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('AdminRequestCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('bounds active concurrency and drains queued work in FIFO order', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 2,
      maxQueued: 4,
      historyLimit: 16,
    });
    const first = deferred<string>();
    const second = deferred<string>();
    const executionOrder: number[] = [];

    const p1 = coordinator.schedule(async () => {
      executionOrder.push(1);
      return first.promise;
    });
    const p2 = coordinator.schedule(async () => {
      executionOrder.push(2);
      return second.promise;
    });
    const p3 = coordinator.schedule(async () => {
      executionOrder.push(3);
      return 'three';
    });

    expect(coordinator.snapshot()).toMatchObject({
      active: 2,
      queued: 1,
      peakActive: 2,
      peakQueued: 1,
    });
    expect(executionOrder).toEqual([1, 2]);

    first.resolve('one');
    await expect(p1).resolves.toBe('one');
    await Promise.resolve();

    expect(executionOrder).toEqual([1, 2, 3]);
    await expect(p3).resolves.toBe('three');

    second.resolve('two');
    await expect(p2).resolves.toBe('two');

    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      completed: 3,
      failed: 0,
    });
  });

  test('single-flight joins duplicate keys without starting duplicate work', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 4,
    });
    const work = deferred<number>();
    const operation = vi.fn(async () => work.promise);

    const first = coordinator.schedule(operation, {
      singleFlightKey: 'GET:/api/items',
    });
    const second = coordinator.schedule(operation, {
      singleFlightKey: 'GET:/api/items',
    });
    const third = coordinator.schedule(operation, {
      singleFlightKey: 'GET:/api/items',
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().singleFlightJoined).toBe(2);

    work.resolve(42);

    await expect(Promise.all([first, second, third]))
      .resolves.toEqual([42, 42, 42]);
    expect(coordinator.snapshot().completed).toBe(1);
  });

  test('single-flight key is released after failure so a retry can start', async () => {
    const coordinator = new AdminRequestCoordinator();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('ok');

    await expect(coordinator.schedule(operation, {
      singleFlightKey: 'GET:/api/items',
    })).rejects.toThrow('first failure');

    await expect(coordinator.schedule(operation, {
      singleFlightKey: 'GET:/api/items',
    })).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('rejects work immediately when queue capacity is exhausted', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const active = deferred<void>();
    const queued = deferred<void>();

    const first = coordinator.schedule(async () => active.promise);
    const second = coordinator.schedule(async () => queued.promise);
    const third = coordinator.schedule(async () => 'never');

    await expect(third).rejects.toMatchObject({
      code: 'queue-full',
    });
    expect(coordinator.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      capacityRejected: 1,
    });

    active.resolve();
    queued.resolve();
    await Promise.all([first, second]);
  });

  test('cancels queued work when its AbortSignal fires', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
      maxQueued: 2,
    });
    const active = deferred<void>();
    const controller = new AbortController();

    const first = coordinator.schedule(async () => active.promise);
    const queued = coordinator.schedule(async () => 'never', {
      signal: controller.signal,
    });

    controller.abort('navigation');

    await expect(queued).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(coordinator.snapshot()).toMatchObject({
      queued: 0,
      cancelled: 1,
    });

    active.resolve();
    await first;
  });

  test('rejects already-aborted work before it consumes capacity', async () => {
    const coordinator = new AdminRequestCoordinator();
    const controller = new AbortController();
    controller.abort();

    await expect(coordinator.schedule(
      async () => 'never',
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(AdminRequestCoordinatorError);

    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      scheduled: 0,
      cancelled: 1,
    });
  });

  test('expires queued work after a bounded wait budget', async () => {
    vi.useFakeTimers();
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
      maxQueued: 2,
      defaultQueueTimeoutMs: 500,
    });
    const active = deferred<void>();

    const first = coordinator.schedule(async () => active.promise);
    const queued = coordinator.schedule(async () => 'late');

    await vi.advanceTimersByTimeAsync(500);

    await expect(queued).rejects.toMatchObject({
      code: 'queue-timeout',
    });
    expect(coordinator.snapshot()).toMatchObject({
      queued: 0,
      queueTimedOut: 1,
    });

    active.resolve();
    await first;
  });

  test('classifies active AbortSignal failure as cancelled', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
    });
    const controller = new AbortController();
    const running = coordinator.schedule(async () => {
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      return 'never';
    }, {
      signal: controller.signal,
    });

    controller.abort();

    await expect(running).rejects.toThrow();
    expect(coordinator.snapshot()).toMatchObject({
      cancelled: 1,
      failed: 0,
    });
  });

  test('bounds privacy-safe history without exposing single-flight keys', async () => {
    let now = 0;
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
      historyLimit: 2,
      now: () => now,
    });

    for (let index = 0; index < 3; index += 1) {
      now += 10;
      await coordinator.schedule(async () => {
        now += 5;
        return index;
      }, {
        singleFlightKey: `secret-query-${index}`,
      });
    }

    const snapshot = coordinator.snapshot();

    expect(snapshot.recent).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain('secret-query');
    expect(snapshot.recent.every((event) =>
      event.outcome === 'success'
      && event.queueMs >= 0
      && event.executionMs >= 0)).toBe(true);
  });

  test('reports failed operations and always releases active capacity', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 1,
    });

    await expect(coordinator.schedule(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      failed: 1,
      completed: 0,
    });

    await expect(coordinator.schedule(async () => 'next')).resolves.toBe('next');
  });

  test('clamps unsafe coordinator configuration values', async () => {
    const coordinator = new AdminRequestCoordinator({
      maxConcurrent: 999,
      maxQueued: -100,
      defaultQueueTimeoutMs: 1,
      historyLimit: 9999,
    });

    const operations = Array.from({ length: 17 }, (_, index) =>
      coordinator.schedule(async () => index));

    await Promise.all(operations.slice(0, 16));
    await expect(operations[16]).rejects.toMatchObject({
      code: 'queue-full',
    });

    expect(coordinator.snapshot().peakActive).toBeLessThanOrEqual(16);
  });
});
