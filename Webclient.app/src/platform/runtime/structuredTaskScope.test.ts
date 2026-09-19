import { describe, expect, it, vi } from 'vitest';
import {
  createStructuredTaskScope,
  type TaskScopeClock,
} from './structuredTaskScope';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const manualClock = (start = 0) => {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const runDue = (): void => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };

  const clock: TaskScopeClock = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      sequence += 1;
      timers.set(sequence, { at: now + delayMs, callback });
      return sequence as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };

  return {
    clock,
    advance: (milliseconds: number) => {
      now += milliseconds;
      runDue();
    },
    set: (value: number) => {
      now = value;
      runDue();
    },
    pendingTimers: () => timers.size,
  };
};

describe('structuredTaskScope', () => {
  it('runs successful work and records a bounded immutable history event', async () => {
    const time = manualClock(10);
    const scope = createStructuredTaskScope('root', { clock: time.clock, historyLimit: 4 });
    const result = await scope.run({
      owner: 'map-shell',
      key: 'bootstrap',
      task: async signal => {
        expect(signal.aborted).toBe(false);
        time.advance(5);
        return 42;
      },
    });

    expect(result).toBe(42);
    const snapshot = scope.snapshot();
    expect(snapshot).toMatchObject({
      state: 'open',
      active: 0,
      owners: 0,
      started: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      rejected: 0,
    });
    expect(snapshot.history).toEqual([
      expect.objectContaining({
        sequence: 1,
        scope: 'root',
        owner: 'map-shell',
        key: 'bootstrap',
        label: 'bootstrap',
        outcome: 'success',
        durationMs: 5,
      }),
    ]);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
  });

  it('rejects work after close begins and resolves close after active work settles', async () => {
    const time = manualClock();
    const scope = createStructuredTaskScope('root', { clock: time.clock });
    const gate = deferred<string>();
    const running = scope.run({
      owner: 'owner-a',
      key: 'slow',
      task: async () => gate.promise,
    });
    await flush();

    let closed = false;
    const closing = scope.close().then(() => {
      closed = true;
    });
    expect(scope.snapshot().state).toBe('closing');
    await expect(scope.run({
      owner: 'owner-b',
      key: 'late',
      task: async () => 'never',
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_OPEN' });

    await flush();
    expect(closed).toBe(false);
    gate.resolve('done');
    await expect(running).resolves.toBe('done');
    await closing;
    expect(closed).toBe(true);
    expect(scope.snapshot().state).toBe('closed');
  });

  it('enforces global active capacity without queueing hidden work', async () => {
    const scope = createStructuredTaskScope('root', { maxActiveTasks: 1 });
    const gate = deferred<void>();
    const running = scope.run({
      owner: 'a',
      key: 'one',
      task: async () => gate.promise,
    });
    await flush();

    await expect(scope.run({
      owner: 'b',
      key: 'two',
      task: async () => undefined,
    })).rejects.toMatchObject({ code: 'TASK_CAPACITY_EXCEEDED' });

    gate.resolve();
    await running;
    expect(scope.snapshot().rejected).toBe(1);
  });

  it('enforces per-owner fairness even when global capacity remains', async () => {
    const scope = createStructuredTaskScope('root', {
      maxActiveTasks: 4,
      maxOwnerTasks: 1,
    });
    const firstGate = deferred<void>();
    const first = scope.run({
      owner: 'owner-a',
      key: 'first',
      task: async () => firstGate.promise,
    });
    await flush();

    await expect(scope.run({
      owner: 'owner-a',
      key: 'second',
      task: async () => undefined,
    })).rejects.toMatchObject({ code: 'OWNER_CAPACITY_EXCEEDED' });

    await expect(scope.run({
      owner: 'owner-b',
      key: 'other-owner',
      task: async () => 'ok',
    })).resolves.toBe('ok');

    firstGate.resolve();
    await first;
  });

  it('aborts a task when its bounded timeout expires', async () => {
    const time = manualClock(100);
    const scope = createStructuredTaskScope('root', {
      clock: time.clock,
      defaultTimeoutMs: 50,
      maxTimeoutMs: 1_000,
    });

    const task = scope.run({
      owner: 'owner',
      key: 'timeout',
      task: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await flush();
    expect(time.pendingTimers()).toBe(1);

    time.advance(50);
    await expect(task).rejects.toMatchObject({ code: 'TASK_TIMEOUT' });
    expect(scope.snapshot()).toMatchObject({ timedOut: 1, active: 0 });
    expect(time.pendingTimers()).toBe(0);
  });

  it('propagates caller cancellation and removes external listeners after settlement', async () => {
    const controller = new AbortController();
    const scope = createStructuredTaskScope('root');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const task = scope.run({
      owner: 'owner',
      key: 'cancel',
      signal: controller.signal,
      task: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await flush();
    controller.abort(new Error('route-left'));

    await expect(task).rejects.toThrow('route-left');
    expect(scope.snapshot()).toMatchObject({ cancelled: 1, active: 0 });
    expect(remove).toHaveBeenCalled();
  });

  it('fails closed when work is already externally aborted', async () => {
    const controller = new AbortController();
    controller.abort('gone');
    const scope = createStructuredTaskScope('root');
    const task = vi.fn(async () => 1);

    await expect(scope.run({
      owner: 'owner',
      key: 'cancelled-before-admission',
      signal: controller.signal,
      task,
    })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(task).not.toHaveBeenCalled();
    expect(scope.snapshot().rejected).toBe(1);
  });

  it('records ordinary task failures without treating them as cancellation', async () => {
    const scope = createStructuredTaskScope('root');

    await expect(scope.run({
      owner: 'owner',
      key: 'failure',
      task: async () => {
        throw new TypeError('bad-result');
      },
    })).rejects.toThrow('bad-result');

    const snapshot = scope.snapshot();
    expect(snapshot.failed).toBe(1);
    expect(snapshot.cancelled).toBe(0);
    expect(snapshot.history.at(-1)).toMatchObject({
      outcome: 'failure',
      errorName: 'TypeError',
    });
  });

  it('cancelActive close aborts work and still waits for ignoring tasks to settle', async () => {
    const scope = createStructuredTaskScope('root');
    const gate = deferred<void>();
    let observedAbort = false;
    const running = scope.run({
      owner: 'owner',
      key: 'ignores-abort-until-later',
      task: async signal => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
        }, { once: true });
        await gate.promise;
        return 'late';
      },
    });
    await flush();

    let closeResolved = false;
    const closing = scope.close({
      cancelActive: true,
      reason: new Error('shutdown'),
    }).then(() => {
      closeResolved = true;
    });
    await flush();
    expect(observedAbort).toBe(true);
    expect(closeResolved).toBe(false);

    gate.resolve();
    await expect(running).rejects.toThrow('shutdown');
    await closing;
    expect(closeResolved).toBe(true);
  });

  it('tracks child scopes as part of parent structured lifetime', async () => {
    const parent = createStructuredTaskScope('root');
    const child = parent.fork('search');
    const gate = deferred<void>();
    const running = child.run({
      owner: 'search',
      key: 'index-build',
      task: async () => gate.promise,
    });
    await flush();

    expect(parent.snapshot().children).toBe(1);
    let parentIdle = false;
    const waiting = parent.waitForIdle().then(() => {
      parentIdle = true;
    });
    await flush();
    expect(parentIdle).toBe(false);

    gate.resolve();
    await running;
    await child.close();
    await waiting;
    expect(parentIdle).toBe(true);
    expect(parent.snapshot().children).toBe(0);
  });

  it('propagates parent disposal to children and retains child until active work settles', async () => {
    const parent = createStructuredTaskScope('root');
    const child = parent.fork('child');
    const gate = deferred<void>();
    let childSignal: AbortSignal | undefined;

    const running = child.run({
      owner: 'owner',
      key: 'child-work',
      task: async signal => {
        childSignal = signal;
        await gate.promise;
        return 'late';
      },
    });
    await flush();

    parent.dispose(new Error('root-disposed'));
    expect(childSignal?.aborted).toBe(true);
    expect(parent.snapshot()).toMatchObject({ state: 'disposed', children: 1 });

    gate.resolve();
    await expect(running).rejects.toThrow('root-disposed');
    await parent.waitForIdle();
    expect(parent.snapshot().children).toBe(0);
  });

  it('enforces bounded child-scope cardinality', async () => {
    const parent = createStructuredTaskScope('root', { maxChildren: 1 });
    const first = parent.fork('one');

    expect(() => parent.fork('two')).toThrowError(
      expect.objectContaining({ code: 'CHILD_CAPACITY_EXCEEDED' }),
    );

    await first.close();
    expect(() => parent.fork('two')).not.toThrow();
  });

  it('bounds history to the most recent events', async () => {
    const scope = createStructuredTaskScope('root', { historyLimit: 2 });

    await scope.run({ owner: 'o', key: 'one', task: async () => 1 });
    await scope.run({ owner: 'o', key: 'two', task: async () => 2 });
    await scope.run({ owner: 'o', key: 'three', task: async () => 3 });

    expect(scope.snapshot().history.map(event => event.key)).toEqual(['two', 'three']);
  });

  it('supports history-free operation for hot paths', async () => {
    const scope = createStructuredTaskScope('root', { historyLimit: 0 });
    await scope.run({ owner: 'o', key: 'one', task: async () => 1 });
    expect(scope.snapshot().history).toEqual([]);
  });

  it('allows waitForIdle cancellation without cancelling scoped work', async () => {
    const scope = createStructuredTaskScope('root');
    const gate = deferred<void>();
    const running = scope.run({
      owner: 'o',
      key: 'active',
      task: async () => gate.promise,
    });
    await flush();

    const controller = new AbortController();
    const idle = scope.waitForIdle(controller.signal);
    controller.abort('stop-waiting');
    await expect(idle).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(scope.snapshot().active).toBe(1);

    gate.resolve();
    await running;
  });

  it('validates identities and task configuration before allocating work', async () => {
    const scope = createStructuredTaskScope('root', { maxTimeoutMs: 100 });

    await expect(scope.run({
      owner: ' ',
      key: 'key',
      task: async () => 1,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(scope.run({
      owner: 'owner',
      key: ' ',
      task: async () => 1,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(scope.run({
      owner: 'owner',
      key: 'key',
      timeoutMs: 101,
      task: async () => 1,
    })).rejects.toThrow('timeoutMs');
  });

  it('rejects control characters in public identities', async () => {
    const scope = createStructuredTaskScope('root');

    await expect(scope.run({
      owner: 'owner\nother',
      key: 'key',
      task: async () => 1,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects a backwards-moving clock', async () => {
    const time = manualClock(100);
    const scope = createStructuredTaskScope('root', { clock: time.clock });
    await scope.run({
      owner: 'owner',
      key: 'first',
      task: async () => {
        time.advance(1);
        return 1;
      },
    });

    time.set(50);
    await expect(scope.run({
      owner: 'owner',
      key: 'second',
      task: async () => 2,
    })).rejects.toThrow('monotonic');
  });

  it.each([
    [{ maxActiveTasks: 0 }, 'maxActiveTasks'],
    [{ maxOwnerTasks: 0 }, 'maxOwnerTasks'],
    [{ maxChildren: 0 }, 'maxChildren'],
    [{ historyLimit: -1 }, 'historyLimit'],
    [{ maxTimeoutMs: 0 }, 'maxTimeoutMs'],
    [{ defaultTimeoutMs: 101, maxTimeoutMs: 100 }, 'defaultTimeoutMs'],
  ] as const)('rejects unsafe scope configuration %#', (options, expected) => {
    expect(() => createStructuredTaskScope('root', options)).toThrow(expected);
  });

  it('is idempotent when disposed repeatedly and rejects new work', async () => {
    const scope = createStructuredTaskScope('root');
    scope.dispose();
    scope.dispose();

    expect(scope.snapshot().state).toBe('disposed');
    await expect(scope.run({
      owner: 'owner',
      key: 'late',
      task: async () => 1,
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_OPEN' });
    await expect(scope.close()).resolves.toBeUndefined();
  });
});
