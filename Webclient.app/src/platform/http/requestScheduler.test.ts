import { vi as jest } from 'vitest';
import {
  RequestScheduler,
  createRequestScheduler,
  getSchedulerGroupFromPath,
  RequestSchedulerPolicy
} from './requestScheduler';

interface SchedulerEventCapture {
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('RequestScheduler configuration', () => {
  test('creates bounded defaults', () => {
    const scheduler = createRequestScheduler();
    const snapshot = scheduler.snapshot();

    expect(scheduler).toBeInstanceOf(RequestScheduler);
    expect(snapshot.maxConcurrent).toBe(8);
    expect(snapshot.maxConcurrentPerGroup).toBe(4);
    expect(snapshot.maxQueued).toBe(160);
    expect(snapshot.running).toBe(0);
    expect(snapshot.queued).toBe(0);
  });

  test('clamps unsafe concurrency and queue configuration', () => {
    const scheduler = createRequestScheduler({
      maxConcurrent: 999,
      maxConcurrentPerGroup: 999,
      maxQueued: 99999,
      highPriorityReserve: 999,
      agingIntervalMs: 1,
      starvationThresholdMs: 1
    });

    expect(scheduler.maxConcurrent).toBe(32);
    expect(scheduler.maxConcurrentPerGroup).toBe(32);
    expect(scheduler.maxQueued).toBe(1000);
    expect(scheduler.highPriorityReserve).toBe(31);
    expect(scheduler.agingIntervalMs).toBe(100);
    expect(scheduler.starvationThresholdMs).toBeGreaterThanOrEqual(100);
  });

  test('exports the canonical priority list', () => {
    expect(RequestSchedulerPolicy.priorities).toEqual([
      'critical',
      'high',
      'normal',
      'low',
      'background'
    ]);
    expect(Object.isFrozen(RequestSchedulerPolicy.priorities)).toBe(true);
  });
});

describe('RequestScheduler concurrency', () => {
  test('never exceeds the global concurrency budget', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxConcurrentPerGroup: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;

    const promises = gates.map((gate, index) => scheduler.schedule(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return index;
    }, { groupKey: 'shared' }));

    await flushMicrotasks();
    expect(active).toBe(2);
    expect(scheduler.getRunningCount()).toBe(2);
    expect(scheduler.getQueuedCount()).toBe(2);

    gates[0]?.resolve();
    await flushMicrotasks();
    expect(active).toBe(2);
    expect(scheduler.getQueuedCount()).toBe(1);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await flushMicrotasks();
    gates[3]?.resolve();

    await expect(Promise.all(promises)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(scheduler.getRunningCount()).toBe(0);
    expect(scheduler.getQueuedCount()).toBe(0);
  });

  test('enforces per-group concurrency independently', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 3, maxConcurrentPerGroup: 1 });
    const a1 = deferred();
    const a2 = deferred();
    const b1 = deferred();
    const starts: string[] = [];

    const first = scheduler.schedule(async () => {
      starts.push('a1');
      await a1.promise;
      return 'a1';
    }, { groupKey: 'api/map' });
    const second = scheduler.schedule(async () => {
      starts.push('a2');
      await a2.promise;
      return 'a2';
    }, { groupKey: 'api/map' });
    const third = scheduler.schedule(async () => {
      starts.push('b1');
      await b1.promise;
      return 'b1';
    }, { groupKey: 'api/search' });

    await flushMicrotasks();
    expect(starts).toEqual(['a1', 'b1']);
    expect(scheduler.snapshot().groups['api/map']).toEqual({ running: 1, queued: 1 });
    expect(scheduler.snapshot().groups['api/search']).toEqual({ running: 1, queued: 0 });

    a1.resolve();
    await flushMicrotasks();
    expect(starts).toEqual(['a1', 'b1', 'a2']);

    a2.resolve();
    b1.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual(['a1', 'a2', 'b1']);
  });

  test('uses another group when the highest-priority group is saturated', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxConcurrentPerGroup: 1 });
    const gate = deferred();
    const starts: string[] = [];

    const running = scheduler.schedule(async () => {
      starts.push('map-running');
      await gate.promise;
    }, { groupKey: 'map', priority: 'normal' });

    const blockedCritical = scheduler.schedule(async () => {
      starts.push('map-critical');
    }, { groupKey: 'map', priority: 'critical' });

    const availableLow = scheduler.schedule(async () => {
      starts.push('search-low');
    }, { groupKey: 'search', priority: 'low' });

    await flushMicrotasks();
    expect(starts).toEqual(['map-running', 'search-low']);

    gate.resolve();
    await Promise.all([running, blockedCritical, availableLow]);
    expect(starts).toEqual(['map-running', 'search-low', 'map-critical']);
  });
});

describe('RequestScheduler priority and fairness', () => {
  test('runs higher priority queued work first', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1, highPriorityReserve: 0 });
    const gate = deferred();
    const order: string[] = [];

    const blocker = scheduler.schedule(async () => {
      order.push('blocker');
      await gate.promise;
    });
    const low = scheduler.schedule(() => {
      order.push('low');
      return 'low';
    }, { priority: 'low' });
    const high = scheduler.schedule(() => {
      order.push('high');
      return 'high';
    }, { priority: 'high' });
    const critical = scheduler.schedule(() => {
      order.push('critical');
      return 'critical';
    }, { priority: 'critical' });

    await flushMicrotasks();
    expect(order).toEqual(['blocker']);
    gate.resolve();

    await Promise.all([blocker, low, high, critical]);
    expect(order).toEqual(['blocker', 'critical', 'high', 'low']);
  });

  test('preserves FIFO ordering for equal priority and equal queue time', async () => {
    let clock = 100;
    const scheduler = createRequestScheduler({
      maxConcurrent: 1,
      highPriorityReserve: 0,
      clock: () => clock
    });
    const gate = deferred();
    const order: string[] = [];

    const blocker = scheduler.schedule(async () => {
      await gate.promise;
    });
    const first = scheduler.schedule(() => order.push('first'), { priority: 'normal' });
    const second = scheduler.schedule(() => order.push('second'), { priority: 'normal' });
    const third = scheduler.schedule(() => order.push('third'), { priority: 'normal' });

    clock = 101;
    gate.resolve();
    await Promise.all([blocker, first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('aging prevents old background work from starving forever', async () => {
    let clock = 0;
    const scheduler = createRequestScheduler({
      maxConcurrent: 1,
      highPriorityReserve: 0,
      clock: () => clock,
      agingIntervalMs: 1000,
      starvationThresholdMs: 6000
    });
    const gate = deferred();
    const order: string[] = [];

    const blocker = scheduler.schedule(async () => {
      await gate.promise;
    }, { priority: 'critical' });

    const oldBackground = scheduler.schedule(() => {
      order.push('background');
    }, { priority: 'background' });

    clock = 9000;
    const newNormal = scheduler.schedule(() => {
      order.push('normal');
    }, { priority: 'normal' });

    gate.resolve();
    await Promise.all([blocker, oldBackground, newNormal]);
    expect(order[0]).toBe('background');
    expect(order[1]).toBe('normal');
  });

  test('normalizes unknown priorities to normal', async () => {
    const events: SchedulerEventCapture[] = [];
    const scheduler = createRequestScheduler({
      onEvent: (name, metadata) => events.push({ name, metadata })
    });

    await scheduler.schedule(() => 'ok', { priority: 'ultra-super' });
    const queued = events.find((event) => event.name === 'network.scheduler.queued');
    expect(queued?.metadata.priority).toBe('normal');
  });
});

describe('RequestScheduler cancellation and bounded queue', () => {
  test('rejects pre-aborted requests without running task', async () => {
    const controller = new AbortController();
    controller.abort();
    const task = jest.fn();
    const scheduler = createRequestScheduler();

    await expect(scheduler.schedule(task, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(task).not.toHaveBeenCalled();
    expect(scheduler.snapshot().counters.cancelled).toBe(1);
  });

  test('removes queued task when caller aborts', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const gate = deferred();
    const controller = new AbortController();
    const task = jest.fn(() => 'never');

    const blocker = scheduler.schedule(() => gate.promise);
    const queued = scheduler.schedule(task, { signal: controller.signal });
    await flushMicrotasks();
    expect(scheduler.getQueuedCount()).toBe(1);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'ABORTED' });
    expect(scheduler.getQueuedCount()).toBe(0);
    expect(task).not.toHaveBeenCalled();

    gate.resolve();
    await blocker;
  });

  test('fails fast when bounded queue is full', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1, maxQueued: 1 });
    const gate = deferred();
    const blocker = scheduler.schedule(() => gate.promise);
    const queued = scheduler.schedule(() => 'queued');

    await expect(scheduler.schedule(() => 'overflow'))
      .rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_FULL' });
    expect(scheduler.getQueuedCount()).toBe(1);
    expect(scheduler.snapshot().counters.rejected).toBe(1);

    gate.resolve();
    await blocker;
    await expect(queued).resolves.toBe('queued');
  });

  test('rejects queued work after queue wait budget expires', async () => {
    jest.useFakeTimers();
    try {
      const scheduler = createRequestScheduler({ maxConcurrent: 1 });
      const gate = deferred();
      const blocker = scheduler.schedule(() => gate.promise);
      const queued = scheduler.schedule(() => 'late', { queueTimeoutMs: 250 });

      jest.advanceTimersByTime(251);
      await expect(queued).rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_TIMEOUT' });
      expect(scheduler.getQueuedCount()).toBe(0);

      gate.resolve();
      await blocker;
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancelQueued rejects all waiting work but not active work', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const gate = deferred<string>();
    const active = scheduler.schedule(() => gate.promise);
    const first = scheduler.schedule(() => 1);
    const second = scheduler.schedule(() => 2);

    expect(scheduler.cancelQueued('release reset')).toBe(2);
    await expect(first).rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_CANCELLED' });
    await expect(second).rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_CANCELLED' });
    expect(scheduler.getRunningCount()).toBe(1);

    gate.resolve('active');
    await expect(active).resolves.toBe('active');
  });
});

describe('RequestScheduler execution and observability', () => {
  test('bypass runs immediately outside normal concurrency budget', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise);
    let bypassRan = false;

    const bypassed = scheduler.schedule(() => {
      bypassRan = true;
      return 42;
    }, { bypass: true, priority: 'critical' });

    await expect(bypassed).resolves.toBe(42);
    expect(bypassRan).toBe(true);
    expect(scheduler.getRunningCount()).toBe(1);
    expect(scheduler.snapshot().counters.bypassed).toBe(1);

    gate.resolve();
    await active;
  });

  test('captures synchronous task failure and releases slot', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const error = new Error('boom');

    await expect(scheduler.schedule(() => {
      throw error;
    })).rejects.toBe(error);

    await expect(scheduler.schedule(() => 'recovered')).resolves.toBe('recovered');
    const snapshot = scheduler.snapshot();
    expect(snapshot.running).toBe(0);
    expect(snapshot.counters.failed).toBe(1);
    expect(snapshot.counters.completed).toBe(1);
  });

  test('captures asynchronous rejection and continues pumping queue', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const first = scheduler.schedule(() => Promise.reject(Object.assign(new Error('network'), {
      code: 'NETWORK_ERROR'
    })));
    const second = scheduler.schedule(() => 'second');

    await expect(first).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(second).resolves.toBe('second');
    expect(scheduler.snapshot().counters.failed).toBe(1);
  });

  test('diagnostic observer errors never break request execution', async () => {
    const scheduler = createRequestScheduler({
      onEvent: () => {
        throw new Error('observer failure');
      }
    });

    await expect(scheduler.schedule(() => 'safe')).resolves.toBe('safe');
    expect(scheduler.snapshot().counters.completed).toBe(1);
    expect(scheduler.getDiagnosticListenerFailureCount()).toBeGreaterThan(0);
  });

  test('snapshot is immutable and reports groups, priorities and peaks', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1, maxConcurrentPerGroup: 1 });
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise, { groupKey: 'map' });
    const high = scheduler.schedule(() => 'high', { groupKey: 'search', priority: 'high' });
    const low = scheduler.schedule(() => 'low', { groupKey: 'search', priority: 'low' });

    const snapshot = scheduler.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.groups)).toBe(true);
    expect(Object.isFrozen(snapshot.priorities)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(snapshot.running).toBe(1);
    expect(snapshot.queued).toBe(2);
    expect(snapshot.peakRunning).toBe(1);
    expect(snapshot.peakQueued).toBe(2);
    expect(snapshot.priorities.high).toBe(1);
    expect(snapshot.priorities.low).toBe(1);
    expect(snapshot.groups.search?.queued).toBe(2);

    gate.resolve();
    await Promise.all([active, high, low]);
  });

  test('event metadata never requires request payload data', async () => {
    const events: SchedulerEventCapture[] = [];
    const scheduler = createRequestScheduler({
      onEvent: (name, metadata) => events.push({ name, metadata })
    });

    await scheduler.schedule(() => 'ok', {
      groupKey: 'api/config',
      label: 'get:/ConfigService/List?token=must-not-be-passed'
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => !Object.prototype.hasOwnProperty.call(event.metadata, 'data'))).toBe(true);
    expect(events.every((event) => !Object.prototype.hasOwnProperty.call(event.metadata, 'body'))).toBe(true);
  });
});

describe('getSchedulerGroupFromPath', () => {
  test.each([
    ['/api/Map/Layer/List', 'api/map'],
    ['/api/Search?q=test', 'api/search'],
    ['/Gis/ConfigService/List#x', 'gis'],
    ['/', 'root'],
    ['', 'default'],
    [null, 'default']
  ])('normalizes %p into %p', (input, expected) => {
    expect(getSchedulerGroupFromPath(input)).toBe(expected);
  });

  test('normalizes unsafe group characters', () => {
    expect(getSchedulerGroupFromPath('/API/My Weird Controller/List')).toBe('api/my-weird-controller');
  });
});
