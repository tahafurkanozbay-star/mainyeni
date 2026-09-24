import {
  ARCGIS_REQUEST_PRIORITY,
  ArcGisRequestSchedulerError,
  createArcGisRequestScheduler,
} from './arcgisRequestScheduler';

const FEATURE_URL = 'https://example.test/arcgis/rest/services/Kent/FeatureServer/0';
const OTHER_URL = 'https://other.test/arcgis/rest/services/Kent/FeatureServer/1';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('createArcGisRequestScheduler', () => {
  test('runs requests within the configured global concurrency budget', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 2,
      maxConcurrentPerOrigin: 2,
    });

    const requests = gates.map((gate, index) => scheduler.schedule({
      key: `request-${index}`,
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: async () => {
        started.push(index);
        return gate.promise;
      },
    }));

    await flush();
    expect(started).toEqual([0, 1]);
    expect(scheduler.getSnapshot().activeCount).toBe(2);
    expect(scheduler.getSnapshot().queueDepth).toBe(1);

    gates[0].resolve('first');
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve('second');
    gates[2].resolve('third');
    await expect(Promise.all(requests)).resolves.toEqual(['first', 'second', 'third']);
    scheduler.destroy();
  });

  test('honors per-origin concurrency while allowing another ArcGIS origin to progress', async () => {
    const first = deferred();
    const second = deferred();
    const other = deferred();
    const started = [];
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 3,
      maxConcurrentPerOrigin: 1,
    });

    const p1 = scheduler.schedule({
      key: 'same-origin-1',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => {
        started.push('first');
        return first.promise;
      },
    });
    const p2 = scheduler.schedule({
      key: 'same-origin-2',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => {
        started.push('second');
        return second.promise;
      },
    });
    const p3 = scheduler.schedule({
      key: 'other-origin',
      resourceUrl: OTHER_URL,
      cache: false,
      execute: () => {
        started.push('other');
        return other.promise;
      },
    });

    await flush();
    expect(started).toEqual(['first', 'other']);
    first.resolve(1);
    await flush();
    expect(started).toEqual(['first', 'other', 'second']);

    second.resolve(2);
    other.resolve(3);
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([1, 2, 3]);
    scheduler.destroy();
  });

  test('orders queued requests by priority and preserves FIFO within the same priority', async () => {
    const gate = deferred();
    const order = [];
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 1,
      maxConcurrentPerOrigin: 1,
    });

    const first = scheduler.schedule({
      key: 'running',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => gate.promise,
    });
    const background = scheduler.schedule({
      key: 'background',
      resourceUrl: FEATURE_URL,
      cache: false,
      priority: ARCGIS_REQUEST_PRIORITY.BACKGROUND,
      execute: () => {
        order.push('background');
        return 'background';
      },
    });
    const normalA = scheduler.schedule({
      key: 'normal-a',
      resourceUrl: FEATURE_URL,
      cache: false,
      priority: 'normal',
      execute: () => {
        order.push('normal-a');
        return 'normal-a';
      },
    });
    const interactive = scheduler.schedule({
      key: 'interactive',
      resourceUrl: FEATURE_URL,
      cache: false,
      priority: 'interactive',
      execute: () => {
        order.push('interactive');
        return 'interactive';
      },
    });
    const normalB = scheduler.schedule({
      key: 'normal-b',
      resourceUrl: FEATURE_URL,
      cache: false,
      priority: 'normal',
      execute: () => {
        order.push('normal-b');
        return 'normal-b';
      },
    });

    gate.resolve('running');
    await expect(first).resolves.toBe('running');
    await expect(Promise.all([background, normalA, interactive, normalB])).resolves.toEqual([
      'background',
      'normal-a',
      'interactive',
      'normal-b',
    ]);
    expect(order).toEqual(['interactive', 'normal-a', 'normal-b', 'background']);
    scheduler.destroy();
  });

  test('deduplicates matching in-flight requests without duplicating adapter execution', async () => {
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const scheduler = createArcGisRequestScheduler();

    const first = scheduler.schedule({
      key: 'shared',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute,
    });
    const second = scheduler.schedule({
      key: 'shared',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute,
    });

    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().metrics.deduped).toBe(1);

    gate.resolve({ features: [1, 2] });
    await expect(first).resolves.toEqual({ features: [1, 2] });
    await expect(second).resolves.toEqual({ features: [1, 2] });
    scheduler.destroy();
  });

  test('subscriber cancellation does not abort a deduplicated request that still has consumers', async () => {
    const gate = deferred();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let requestSignal;
    const scheduler = createArcGisRequestScheduler();

    const first = scheduler.schedule({
      key: 'subscriber-cancel',
      resourceUrl: FEATURE_URL,
      cache: false,
      signal: firstController.signal,
      execute: ({ signal }) => {
        requestSignal = signal;
        return gate.promise;
      },
    });
    const second = scheduler.schedule({
      key: 'subscriber-cancel',
      resourceUrl: FEATURE_URL,
      cache: false,
      signal: secondController.signal,
      execute: () => gate.promise,
    });

    await flush();
    firstController.abort('first view closed');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal.aborted).toBe(false);

    gate.resolve('kept-alive');
    await expect(second).resolves.toBe('kept-alive');
    scheduler.destroy();
  });

  test('aborts the underlying request once every subscriber cancels', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let underlyingSignal;
    const scheduler = createArcGisRequestScheduler();

    const execute = ({ signal }) => new Promise((resolve, reject) => {
      underlyingSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    });

    const first = scheduler.schedule({
      key: 'orphan',
      resourceUrl: FEATURE_URL,
      cache: false,
      signal: firstController.signal,
      execute,
    });
    const second = scheduler.schedule({
      key: 'orphan',
      resourceUrl: FEATURE_URL,
      cache: false,
      signal: secondController.signal,
      execute,
    });

    await flush();
    firstController.abort('first left');
    secondController.abort('second left');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(underlyingSignal.aborted).toBe(true);
    expect(scheduler.getSnapshot().metrics.cancelledJobs).toBe(1);
    scheduler.destroy();
  });

  test('serves fresh cache entries and avoids a second adapter execution', async () => {
    let now = 100;
    const execute = vi.fn(async () => ({ value: execute.mock.calls.length }));
    const scheduler = createArcGisRequestScheduler({
      now: () => now,
      cacheTtlMs: 50,
      staleTtlMs: 100,
    });

    await expect(scheduler.schedule({
      key: 'cached',
      resourceUrl: FEATURE_URL,
      execute,
    })).resolves.toEqual({ value: 1 });

    now = 125;
    await expect(scheduler.schedule({
      key: 'cached',
      resourceUrl: FEATURE_URL,
      execute,
    })).resolves.toEqual({ value: 1 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().metrics.cacheHits).toBe(1);
    scheduler.destroy();
  });

  test('can return a stale value when a refresh fails and stale fallback is explicitly enabled', async () => {
    let now = 0;
    const scheduler = createArcGisRequestScheduler({
      now: () => now,
      cacheTtlMs: 10,
      staleTtlMs: 100,
    });

    await scheduler.schedule({
      key: 'stale',
      resourceUrl: FEATURE_URL,
      execute: async () => 'stable-value',
    });

    now = 20;
    await expect(scheduler.schedule({
      key: 'stale',
      resourceUrl: FEATURE_URL,
      allowStaleOnError: true,
      execute: async () => {
        throw new Error('temporary transport failure');
      },
    })).resolves.toBe('stable-value');

    expect(scheduler.getSnapshot().metrics.staleHits).toBeGreaterThanOrEqual(1);
    scheduler.destroy();
  });

  test('invalidates cache entries by deterministic tags', async () => {
    const scheduler = createArcGisRequestScheduler();

    await scheduler.schedule({
      key: 'layer-1-a',
      resourceUrl: FEATURE_URL,
      tags: ['layer:1', 'query'],
      execute: async () => 1,
    });
    await scheduler.schedule({
      key: 'layer-1-b',
      resourceUrl: FEATURE_URL,
      tags: ['layer:1'],
      execute: async () => 2,
    });
    await scheduler.schedule({
      key: 'layer-2',
      resourceUrl: OTHER_URL,
      tags: ['layer:2'],
      execute: async () => 3,
    });

    expect(scheduler.invalidateTag('layer:1')).toBe(2);
    expect(scheduler.getSnapshot().cacheEntries).toBe(1);
    scheduler.destroy();
  });

  test('enforces queue backpressure instead of allowing unbounded pending work', async () => {
    const runningGate = deferred();
    const queuedGate = deferred();
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 1,
      maxQueueSize: 1,
    });

    const running = scheduler.schedule({
      key: 'running-capacity',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => runningGate.promise,
    });
    const queued = scheduler.schedule({
      key: 'queued-capacity',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => queuedGate.promise,
    });

    await expect(scheduler.schedule({
      key: 'rejected-capacity',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: async () => null,
    })).rejects.toMatchObject({
      name: 'ArcGisRequestSchedulerError',
      code: 'QUEUE_CAPACITY_EXCEEDED',
    });

    runningGate.resolve('a');
    queuedGate.resolve('b');
    await expect(Promise.all([running, queued])).resolves.toEqual(['a', 'b']);
    expect(scheduler.getSnapshot().metrics.rejectedByBackpressure).toBe(1);
    scheduler.destroy();
  });

  test('rejects WMS/WFS resources before any request adapter can run', () => {
    const scheduler = createArcGisRequestScheduler();
    const execute = vi.fn();

    expect(() => scheduler.schedule({
      key: 'forbidden',
      resourceUrl: 'https://example.test/geoserver/wms?service=WMS',
      execute,
    })).toThrow();

    expect(execute).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  test('reconfiguration shrinks cache deterministically and exposes bounded limits', async () => {
    const scheduler = createArcGisRequestScheduler({
      maxCacheEntries: 4,
      maxCacheBytes: 100000,
    });

    for (let index = 0; index < 4; index += 1) {
      await scheduler.schedule({
        key: `cache-${index}`,
        resourceUrl: FEATURE_URL,
        estimatedBytes: 100,
        execute: async () => ({ index }),
      });
    }

    expect(scheduler.getSnapshot().cacheEntries).toBe(4);
    scheduler.configure({
      maxConcurrent: 2,
      maxConcurrentPerOrigin: 1,
      maxCacheEntries: 2,
    });

    const snapshot = scheduler.getSnapshot();
    expect(snapshot.cacheEntries).toBe(2);
    expect(snapshot.limits.maxConcurrent).toBe(2);
    expect(snapshot.limits.maxConcurrentPerOrigin).toBe(1);
    expect(snapshot.metrics.evicted).toBe(2);
    scheduler.destroy();
  });

  test('destroy rejects pending work and makes future scheduling fail explicitly', async () => {
    const gate = deferred();
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 1,
    });

    const running = scheduler.schedule({
      key: 'destroy-running',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: () => gate.promise,
    });
    const queued = scheduler.schedule({
      key: 'destroy-queued',
      resourceUrl: FEATURE_URL,
      cache: false,
      execute: async () => 'never',
    });

    scheduler.destroy('runtime shutdown');
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(scheduler.schedule({
      key: 'after-destroy',
      resourceUrl: FEATURE_URL,
      execute: async () => null,
    })).rejects.toBeInstanceOf(ArcGisRequestSchedulerError);
  });
});
