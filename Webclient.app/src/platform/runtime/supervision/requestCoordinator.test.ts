import { describe, expect, test, vi } from 'vitest';
import {
  RequestCoordinatorDisposedError,
  RequestQueueOverflowError,
} from './contracts';
import { RequestCoordinator } from './requestCoordinator';

const deferred = <TValue>() => {
  let resolve!: (value: TValue) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RequestCoordinator concurrency', () => {
  test('enforces global concurrency and drains queued work', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 2, defaultLaneConcurrency: 2 });
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const starts: string[] = [];

    const p1 = coordinator.submit(async () => {
      starts.push('a');
      return first.promise;
    }, { key: 'a' });
    const p2 = coordinator.submit(async () => {
      starts.push('b');
      return second.promise;
    }, { key: 'b' });
    const p3 = coordinator.submit(async () => {
      starts.push('c');
      return third.promise;
    }, { key: 'c' });

    await flush();
    expect(starts).toEqual(['a', 'b']);
    expect(coordinator.snapshot()).toMatchObject({ active: 2, queued: 1 });

    first.resolve('A');
    await expect(p1).resolves.toBe('A');
    await flush();
    expect(starts).toEqual(['a', 'b', 'c']);

    second.resolve('B');
    third.resolve('C');
    await expect(Promise.all([p2, p3])).resolves.toEqual(['B', 'C']);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 3 });
  });

  test('enforces lane concurrency independently of global capacity', async () => {
    const coordinator = new RequestCoordinator({
      concurrency: 4,
      defaultLaneConcurrency: 4,
      lanes: { search: { concurrency: 1 }, tiles: { concurrency: 2 } },
    });
    const searchA = deferred<void>();
    const searchB = deferred<void>();
    const tile = deferred<void>();
    const starts: string[] = [];

    const a = coordinator.submit(async () => { starts.push('search-a'); await searchA.promise; }, {
      key: 'search-a', lane: 'search',
    });
    const b = coordinator.submit(async () => { starts.push('search-b'); await searchB.promise; }, {
      key: 'search-b', lane: 'search',
    });
    const c = coordinator.submit(async () => { starts.push('tile'); await tile.promise; }, {
      key: 'tile', lane: 'tiles',
    });

    await flush();
    expect(starts).toEqual(['search-a', 'tile']);
    expect(coordinator.snapshot().lanes.search).toEqual({ active: 1, queued: 1 });

    searchA.resolve();
    await a;
    await flush();
    expect(starts).toEqual(['search-a', 'tile', 'search-b']);
    searchB.resolve();
    tile.resolve();
    await Promise.all([b, c]);
  });

  test('higher priority queued work starts first without preempting active work', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 1 });
    const blocker = deferred<void>();
    const order: string[] = [];
    const active = coordinator.submit(async () => { order.push('active'); await blocker.promise; }, {
      key: 'active', priority: 0,
    });
    const low = coordinator.submit(async () => { order.push('low'); return 'low'; }, {
      key: 'low', priority: 1,
    });
    const high = coordinator.submit(async () => { order.push('high'); return 'high'; }, {
      key: 'high', priority: 10,
    });
    await flush();
    expect(order).toEqual(['active']);
    expect(coordinator.snapshot().queueKeys).toEqual(['high', 'low']);

    blocker.resolve();
    await active;
    await expect(high).resolves.toBe('high');
    await expect(low).resolves.toBe('low');
    expect(order).toEqual(['active', 'high', 'low']);
  });

  test('runtime lane policy can be tightened and relaxed dynamically', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 3, defaultLaneConcurrency: 3 });
    coordinator.configureLane('search', { concurrency: 1, queueLimit: 5 });
    const one = deferred<void>();
    const two = deferred<void>();
    const starts: string[] = [];
    const p1 = coordinator.submit(async () => { starts.push('one'); await one.promise; }, {
      key: 'one', lane: 'search',
    });
    const p2 = coordinator.submit(async () => { starts.push('two'); await two.promise; }, {
      key: 'two', lane: 'search',
    });
    await flush();
    expect(starts).toEqual(['one']);

    coordinator.configureLane('search', { concurrency: 2, queueLimit: 5 });
    await flush();
    expect(starts).toEqual(['one', 'two']);
    one.resolve();
    two.resolve();
    await Promise.all([p1, p2]);
  });
});

describe('RequestCoordinator deduplication and cancellation', () => {
  test('deduplicates same-key work while preserving separate subscribers', async () => {
    const coordinator = new RequestCoordinator();
    const work = deferred<string>();
    const operation = vi.fn(async () => work.promise);
    const first = coordinator.submit(operation, { key: 'address:ankara', lane: 'search' });
    const second = coordinator.submit(operation, { key: 'address:ankara', lane: 'search' });
    await flush();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().deduplicated).toBe(1);

    work.resolve('result');
    await expect(Promise.all([first, second])).resolves.toEqual(['result', 'result']);
  });

  test('one subscriber can cancel without cancelling work needed by another', async () => {
    const coordinator = new RequestCoordinator();
    const work = deferred<string>();
    const controller = new AbortController();
    const operation = vi.fn(async () => work.promise);
    const cancelled = coordinator.submit(operation, { key: 'shared', signal: controller.signal });
    const survivor = coordinator.submit(operation, { key: 'shared' });
    await flush();

    const reason = new DOMException('view closed', 'AbortError');
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect(operation).toHaveBeenCalledTimes(1);

    work.resolve('ok');
    await expect(survivor).resolves.toBe('ok');
    expect(coordinator.snapshot().completed).toBe(1);
  });

  test('all-subscriber cancellation aborts the active operation signal', async () => {
    const coordinator = new RequestCoordinator();
    const observed = deferred<unknown>();
    const handle = coordinator.submitHandle(async ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observed.resolve(signal.reason);
        reject(signal.reason);
      }, { once: true });
    }), { key: 'abortable' });
    await flush();
    handle.cancel('no listeners');
    await expect(observed.promise).resolves.toBe('no listeners');
    await expect(handle.promise).rejects.toBe('no listeners');
    await flush();
    expect(coordinator.snapshot().cancelled).toBe(1);
  });

  test('queued task is removed when its only subscriber cancels', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 1 });
    const blocker = deferred<void>();
    const active = coordinator.submit(async () => blocker.promise, { key: 'active' });
    const queued = coordinator.submitHandle(async () => 'never', { key: 'queued' });
    await flush();
    expect(coordinator.snapshot().queued).toBe(1);
    queued.cancel();
    await expect(queued.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshot().queueKeys).toEqual([]);
    blocker.resolve();
    await active;
  });

  test('cancel by key rejects all subscribers with the same reason', async () => {
    const coordinator = new RequestCoordinator();
    const first = coordinator.submit(async ({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { key: 'shared-cancel' });
    const second = coordinator.submit(async () => undefined, { key: 'shared-cancel' });
    await flush();
    const reason = new Error('navigation changed');
    expect(coordinator.cancel('shared-cancel', reason)).toBe(true);
    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
  });

  test('cancelLane cancels matching work and leaves other lanes alone', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 3 });
    const makeAbortable = (key: string, lane: string) => coordinator.submit(async ({ signal }) => (
      new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    ), { key, lane });
    const searchA = makeAbortable('search-a', 'search');
    const searchB = makeAbortable('search-b', 'search');
    const tile = makeAbortable('tile', 'tiles');
    await flush();
    expect(coordinator.cancelLane('search')).toBe(2);
    await expect(searchA).rejects.toMatchObject({ name: 'AbortError' });
    await expect(searchB).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshot().inFlightKeys).toEqual(['tile']);
    coordinator.cancel('tile');
    await expect(tile).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('same key cannot be submitted without deduplication while active', async () => {
    const coordinator = new RequestCoordinator();
    const work = deferred<void>();
    const first = coordinator.submit(async () => work.promise, { key: 'key' });
    expect(() => coordinator.submit(async () => undefined, {
      key: 'key', deduplicate: false,
    })).toThrow(/already active/);
    work.resolve();
    await first;
  });
});

describe('RequestCoordinator capacity and disposal', () => {
  test('rejects work when global queue capacity is exhausted', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 1, queueLimit: 1 });
    const blocker = deferred<void>();
    const active = coordinator.submit(async () => blocker.promise, { key: 'active' });
    const queued = coordinator.submit(async () => 'queued', { key: 'queued' });
    expect(() => coordinator.submit(async () => 'overflow', { key: 'overflow' }))
      .toThrow(RequestQueueOverflowError);
    expect(coordinator.snapshot().rejected).toBe(1);
    blocker.resolve();
    await active;
    await queued;
  });

  test('rejects work when lane queue capacity is exhausted', async () => {
    const coordinator = new RequestCoordinator({
      concurrency: 2,
      lanes: { search: { concurrency: 1, queueLimit: 1 } },
    });
    const blocker = deferred<void>();
    const active = coordinator.submit(async () => blocker.promise, { key: 'a', lane: 'search' });
    const queued = coordinator.submit(async () => 'b', { key: 'b', lane: 'search' });
    expect(() => coordinator.submit(async () => 'c', { key: 'c', lane: 'search' }))
      .toThrow(RequestQueueOverflowError);
    blocker.resolve();
    await active;
    await queued;
  });

  test('snapshot reports deterministic lane and metric state', async () => {
    const coordinator = new RequestCoordinator({
      concurrency: 1,
      lanes: { search: { concurrency: 1 }, tiles: { concurrency: 1 } },
    });
    const blocker = deferred<void>();
    const active = coordinator.submit(async () => blocker.promise, { key: 'a', lane: 'search' });
    const queued = coordinator.submit(async () => 'b', { key: 'b', lane: 'tiles' });
    await flush();
    expect(coordinator.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      inFlightKeys: ['a'],
      queueKeys: ['b'],
      accepted: 2,
      lanes: {
        search: { active: 1, queued: 0 },
        tiles: { active: 0, queued: 1 },
      },
    });
    blocker.resolve();
    await active;
    await queued;
  });

  test('dispose aborts active and queued subscribers and blocks new work', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 1 });
    const active = coordinator.submit(async ({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { key: 'active' });
    const queued = coordinator.submit(async () => undefined, { key: 'queued' });
    await flush();
    coordinator.dispose('shutdown');
    await expect(active).rejects.toBe('shutdown');
    await expect(queued).rejects.toBe('shutdown');
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0 });
    expect(() => coordinator.submit(async () => undefined, { key: 'new' }))
      .toThrow(RequestCoordinatorDisposedError);
  });

  test('dispose is idempotent', () => {
    const coordinator = new RequestCoordinator();
    coordinator.dispose();
    expect(() => coordinator.dispose()).not.toThrow();
  });

  test('onChange observer failures are isolated', async () => {
    const observer = vi.fn(() => { throw new Error('observer failed'); });
    const coordinator = new RequestCoordinator({ onChange: observer });
    await expect(coordinator.submit(async () => 'ok', { key: 'ok' })).resolves.toBe('ok');
    expect(observer).toHaveBeenCalled();
  });
});
