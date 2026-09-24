import { describe, expect, it } from 'vitest';
import { SearchWorkloadGovernor } from './searchWorkloadGovernor';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('SearchWorkloadGovernor production contract', () => {
  it('enforces the global concurrency cap', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 2, maxConcurrentPerLane: 2 });
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let active = 0;
    let peak = 0;
    const tasks = gates.map((gate, index) => governor.run({ key: `k${index}` }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      const value = await gate.promise;
      active -= 1;
      return value;
    }));

    await nextTurn();
    expect(governor.getSnapshot().active).toBe(2);
    expect(governor.getSnapshot().queued).toBe(1);
    gates[0]?.resolve(0);
    await nextTurn();
    expect(governor.getSnapshot().active).toBe(2);
    gates[1]?.resolve(1);
    gates[2]?.resolve(2);
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2]);
    expect(peak).toBe(2);
  });

  it('enforces per-lane concurrency while allowing other lanes to progress', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 3, maxConcurrentPerLane: 1 });
    const first = deferred<string>();
    const second = deferred<string>();
    const other = deferred<string>();
    const a1 = governor.run({ key: 'a1', lane: 'geocode' }, () => first.promise);
    const a2 = governor.run({ key: 'a2', lane: 'geocode' }, () => second.promise);
    const b1 = governor.run({ key: 'b1', lane: 'local-index' }, () => other.promise);

    await nextTurn();
    const snapshot = governor.getSnapshot();
    expect(snapshot.active).toBe(2);
    expect(snapshot.lanes.geocode).toEqual({ active: 1, queued: 1 });
    expect(snapshot.lanes['local-index']).toEqual({ active: 1, queued: 0 });
    first.resolve('a1');
    await nextTurn();
    expect(governor.getSnapshot().lanes.geocode).toEqual({ active: 1, queued: 0 });
    second.resolve('a2');
    other.resolve('b1');
    await expect(Promise.all([a1, a2, b1])).resolves.toEqual(['a1', 'a2', 'b1']);
  });

  it('deduplicates identical inflight work and fans out one result', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 2 });
    const gate = deferred<number>();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      return gate.promise;
    };
    const first = governor.run({ key: 'same', dedupe: true }, operation);
    const second = governor.run({ key: 'same', dedupe: true }, operation);

    await nextTurn();
    expect(executions).toBe(1);
    expect(governor.getSnapshot().dedupeHits).toBe(1);
    gate.resolve(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
  });

  it('does not deduplicate when explicitly disabled', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 2 });
    let executions = 0;
    const operation = async () => ++executions;
    const values = await Promise.all([
      governor.run({ key: 'same', dedupe: false }, operation),
      governor.run({ key: 'same', dedupe: false }, operation),
    ]);
    expect(values.sort()).toEqual([1, 2]);
    expect(governor.getSnapshot().dedupeHits).toBe(0);
  });

  it('uses priority then FIFO sequence for queued work', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const order: string[] = [];
    const first = governor.run({ key: 'blocker', priority: 'normal' }, async () => {
      order.push('blocker');
      await blocker.promise;
    });
    const low = governor.run({ key: 'low', priority: 'low' }, async () => { order.push('low'); });
    const criticalA = governor.run({ key: 'critical-a', priority: 'critical' }, async () => { order.push('critical-a'); });
    const criticalB = governor.run({ key: 'critical-b', priority: 'critical' }, async () => { order.push('critical-b'); });
    const high = governor.run({ key: 'high', priority: 'high' }, async () => { order.push('high'); });

    await nextTurn();
    blocker.resolve();
    await Promise.all([first, low, criticalA, criticalB, high]);
    expect(order).toEqual(['blocker', 'critical-a', 'critical-b', 'high', 'low']);
  });

  it('aborts one deduplicated subscriber without cancelling remaining subscribers', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const gate = deferred<string>();
    const firstController = new AbortController();
    const first = governor.run({ key: 'shared', signal: firstController.signal }, () => gate.promise);
    const second = governor.run({ key: 'shared' }, () => gate.promise);

    await nextTurn();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(governor.getSnapshot().active).toBe(1);
    gate.resolve('ok');
    await expect(second).resolves.toBe('ok');
  });

  it('cancels active work when its last subscriber aborts', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const controller = new AbortController();
    let observedAbort = false;
    const task = governor.run({ key: 'solo', signal: controller.signal }, context => new Promise<string>((resolve, reject) => {
      context.signal.addEventListener('abort', () => {
        observedAbort = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
      void resolve;
    }));

    await nextTurn();
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await nextTurn();
    expect(observedAbort).toBe(true);
  });

  it('removes queued work when all subscribers abort before admission', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const active = governor.run({ key: 'active' }, () => blocker.promise);
    const controller = new AbortController();
    let executed = false;
    const queued = governor.run({ key: 'queued', signal: controller.signal }, () => {
      executed = true;
      return 'unexpected';
    });

    await nextTurn();
    expect(governor.getSnapshot().queued).toBe(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(governor.getSnapshot().queued).toBe(0);
    blocker.resolve();
    await active;
    expect(executed).toBe(false);
  });

  it('times out queued work independently from execution time', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1, maxQueueWaitMs: 25 });
    const blocker = deferred<void>();
    const active = governor.run({ key: 'active' }, () => blocker.promise);
    const queued = governor.run({ key: 'queued', maxQueueWaitMs: 20 }, () => 'unexpected');

    await expect(queued).rejects.toMatchObject({ name: 'SearchWorkQueueTimeoutError' });
    expect(governor.getSnapshot().queueTimeouts).toBe(1);
    blocker.resolve();
    await active;
  });

  it('rejects excess queue entries with bounded capacity', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1, maxQueueSize: 1 });
    const blocker = deferred<void>();
    const active = governor.run({ key: 'active' }, () => blocker.promise);
    const queued = governor.run({ key: 'queued' }, async () => 'queued');
    const rejected = governor.run({ key: 'rejected' }, async () => 'rejected');

    await expect(rejected).rejects.toMatchObject({ name: 'SearchWorkloadQueueFullError' });
    blocker.resolve();
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, 'queued']);
    expect(governor.getSnapshot().rejected).toBe(1);
  });

  it('records bounded outcome history without request contents', async () => {
    let now = 1_000;
    const governor = new SearchWorkloadGovernor({
      maxConcurrent: 1,
      historySize: 2,
      clock: () => now,
    });
    await governor.run({ key: 'secret-query-1', lane: 'search' }, () => { now += 5; return 1; });
    await governor.run({ key: 'secret-query-2', lane: 'search' }, () => { now += 5; return 2; });
    await governor.run({ key: 'secret-query-3', lane: 'search' }, () => { now += 5; return 3; });

    const snapshot = governor.getSnapshot();
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history.every(item => item.keyFingerprint.startsWith('fnv1a-'))).toBe(true);
    expect(JSON.stringify(snapshot.history)).not.toContain('secret-query');
  });

  it('captures failed operations and continues draining', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const failed = governor.run({ key: 'fail' }, async () => { throw new Error('boom'); });
    const succeeded = governor.run({ key: 'success' }, async () => 7);
    await expect(failed).rejects.toThrow('boom');
    await expect(succeeded).resolves.toBe(7);
    const snapshot = governor.getSnapshot();
    expect(snapshot.failed).toBe(1);
    expect(snapshot.completed).toBe(1);
  });

  it('disposes queued work and aborts active work', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    const active = governor.run({ key: 'active' }, context => new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const queued = governor.run({ key: 'queued' }, async () => undefined);
    await nextTurn();
    governor.dispose();

    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'SearchWorkloadDisposedError' });
    expect(governor.getSnapshot().disposed).toBe(true);
    await expect(governor.run({ key: 'later' }, async () => 1)).rejects.toMatchObject({
      name: 'SearchWorkloadDisposedError',
    });
  });

  it('normalizes lane names for deterministic diagnostics', async () => {
    const governor = new SearchWorkloadGovernor({ maxConcurrent: 1 });
    await governor.run({ key: 'one', lane: '  GEOCODE Primary  ' }, async () => 1);
    expect(governor.getSnapshot().history[0]?.lane).toBe('geocode-primary');
  });

  it('rejects blank keys before queueing', async () => {
    const governor = new SearchWorkloadGovernor();
    await expect(governor.run({ key: '   ' }, async () => 1)).rejects.toBeInstanceOf(TypeError);
    expect(governor.getSnapshot().submitted).toBe(0);
    expect(governor.getSnapshot().rejected).toBe(1);
  });
});
