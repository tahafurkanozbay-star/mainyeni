import { describe, expect, test } from 'vitest';
import { RequestCoordinator } from './requestCoordinator';

const deferred = <TValue>() => {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RequestCoordinator fairness regressions', () => {
  test('a saturated lane does not consume capacity reserved by another runnable lane', async () => {
    const coordinator = new RequestCoordinator({
      concurrency: 2,
      defaultLaneConcurrency: 1,
      lanes: {
        search: { concurrency: 1, queueLimit: 8 },
        tiles: { concurrency: 1, queueLimit: 8 },
      },
    });
    const searchA = deferred<void>();
    const searchB = deferred<void>();
    const tile = deferred<void>();
    const starts: string[] = [];

    const first = coordinator.submit(async () => {
      starts.push('search-a');
      await searchA.promise;
    }, { key: 'search-a', lane: 'search', priority: 100 });
    const second = coordinator.submit(async () => {
      starts.push('search-b');
      await searchB.promise;
    }, { key: 'search-b', lane: 'search', priority: 90 });
    const third = coordinator.submit(async () => {
      starts.push('tile');
      await tile.promise;
    }, { key: 'tile', lane: 'tiles', priority: 1 });

    await flush();
    expect(starts).toEqual(['search-a', 'tile']);
    expect(coordinator.snapshot()).toMatchObject({
      active: 2,
      queued: 1,
      queueKeys: ['search-b'],
      lanes: {
        search: { active: 1, queued: 1 },
        tiles: { active: 1, queued: 0 },
      },
    });

    tile.resolve();
    await third;
    await flush();
    expect(starts).toEqual(['search-a', 'tile']);

    searchA.resolve();
    await first;
    await flush();
    expect(starts).toEqual(['search-a', 'tile', 'search-b']);
    searchB.resolve();
    await second;
  });

  test('equal-priority queued work preserves submission order deterministically', async () => {
    const coordinator = new RequestCoordinator({ concurrency: 1, queueLimit: 8 });
    const blocker = deferred<void>();
    const order: string[] = [];
    const active = coordinator.submit(async () => blocker.promise, { key: 'active' });
    const first = coordinator.submit(async () => { order.push('first'); }, { key: 'first', priority: 5 });
    const second = coordinator.submit(async () => { order.push('second'); }, { key: 'second', priority: 5 });
    const third = coordinator.submit(async () => { order.push('third'); }, { key: 'third', priority: 5 });

    await flush();
    expect(coordinator.snapshot().queueKeys).toEqual(['first', 'second', 'third']);
    blocker.resolve();
    await active;
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  });
});
