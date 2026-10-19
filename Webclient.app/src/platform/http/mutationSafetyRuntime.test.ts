import { describe, expect, test, vi } from 'vitest';
import { AppError } from '../errors/appError';
import { normalizeRequestConfig } from './requestPolicy';
import {
  createMutationSafetyRuntime,
  type MutationSafetyEvent,
} from './mutationSafetyRuntime';
import type { NormalizedRequestConfig } from './contracts';

const protectedPost = (
  overrides: Record<string, unknown> = {},
): NormalizedRequestConfig => normalizeRequestConfig({
  method: 'post',
  url: '/items',
  idempotencyKey: 'mutation-runtime-0001',
  idempotencyPolicy: 'server-enforced',
  retryUnsafe: true,
  maxRetries: 2,
  ...overrides,
});

const unprotectedPost = (
  overrides: Record<string, unknown> = {},
): NormalizedRequestConfig => normalizeRequestConfig({
  method: 'post',
  url: '/items',
  maxRetries: 0,
  ...overrides,
});

const safeGet = (
  overrides: Record<string, unknown> = {},
): NormalizedRequestConfig => normalizeRequestConfig({
  method: 'get',
  url: '/items',
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

const createClock = (startAt = 1_000) => {
  let current = startAt;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    rewind: (milliseconds: number) => {
      current -= milliseconds;
    },
  };
};

describe('MutationSafetyRuntime bypass behavior', () => {
  test('bypasses safe GET requests without creating registry state', async () => {
    const runtime = createMutationSafetyRuntime();
    const operation = vi.fn(async () => 'ok');

    await expect(runtime.run(safeGet(), operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({
      protectedExecutions: 0,
      bypassedExecutions: 1,
      registry: {
        entries: 0,
        inFlight: 0,
      },
    });
  });

  test('bypasses ordinary POST requests that do not claim idempotency protection', async () => {
    const runtime = createMutationSafetyRuntime();
    const operation = vi.fn(async ({ markAttempt }) => {
      markAttempt(0);
      return 'saved';
    });

    await expect(runtime.run(unprotectedPost(), operation)).resolves.toBe('saved');
    expect(runtime.snapshot()).toMatchObject({
      protectedExecutions: 0,
      bypassedExecutions: 1,
      registry: {
        counters: {
          admitted: 0,
        },
      },
    });
  });

  test('bypass markAttempt is intentionally a no-op', async () => {
    const runtime = createMutationSafetyRuntime();
    await runtime.run(safeGet(), async ({ markAttempt }) => {
      markAttempt(0);
      markAttempt(1);
      return undefined;
    });

    expect(runtime.snapshot().registry.counters.admitted).toBe(0);
  });
});

describe('MutationSafetyRuntime protected execution', () => {
  test('admits protected POST and records one attempt', async () => {
    const runtime = createMutationSafetyRuntime();
    const operation = vi.fn(async ({ markAttempt }) => {
      markAttempt(0);
      return { saved: true };
    });

    await expect(runtime.run(protectedPost(), operation)).resolves.toEqual({ saved: true });

    expect(runtime.snapshot()).toMatchObject({
      protectedExecutions: 1,
      completedExecutions: 1,
      failedExecutions: 0,
      cancelledExecutions: 0,
      registry: {
        inFlight: 0,
        retained: 1,
        counters: {
          admitted: 1,
          completed: 1,
        },
      },
    });
    expect(runtime.snapshot().registry.history[0]).toMatchObject({
      method: 'post',
      logicalAttempts: 1,
      state: 'completed',
    });
  });

  test('records multiple retry attempts under one protected lease', async () => {
    const runtime = createMutationSafetyRuntime();

    await runtime.run(protectedPost(), async ({ markAttempt }) => {
      markAttempt(0);
      markAttempt(1);
      markAttempt(2);
      return 'ok';
    });

    expect(runtime.snapshot().registry.history[0]).toMatchObject({
      logicalAttempts: 3,
      state: 'completed',
    });
    expect(runtime.snapshot().registry.counters.admitted).toBe(1);
  });

  test('blocks a concurrent duplicate before second operation starts', async () => {
    const gate = deferred<string>();
    const runtime = createMutationSafetyRuntime();
    const firstOperation = vi.fn(async ({ markAttempt }) => {
      markAttempt(0);
      return gate.promise;
    });
    const secondOperation = vi.fn(async () => 'second');

    const first = runtime.run(protectedPost(), firstOperation);
    await Promise.resolve();

    await expect(runtime.run(
      protectedPost(),
      secondOperation,
    )).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    });
    expect(secondOperation).not.toHaveBeenCalled();

    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    expect(runtime.snapshot()).toMatchObject({
      protectedExecutions: 1,
      rejectedExecutions: 1,
      registry: {
        counters: {
          inFlightConflicts: 1,
        },
      },
    });
  });

  test('blocks replay after successful completion', async () => {
    const runtime = createMutationSafetyRuntime();
    const config = protectedPost({
      idempotencyKey: 'mutation-replay-success-0001',
    });

    await runtime.run(config, async () => 'first');

    await expect(runtime.run(
      config,
      async () => 'second',
    )).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(runtime.snapshot()).toMatchObject({
      protectedExecutions: 1,
      completedExecutions: 1,
      rejectedExecutions: 1,
    });
  });

  test('blocks replay after an ambiguous mutation failure', async () => {
    const runtime = createMutationSafetyRuntime();
    const config = protectedPost({
      idempotencyKey: 'mutation-replay-failure-0001',
    });
    const error = new AppError('upstream private detail', {
      code: 'SERVER_ERROR',
      status: 503,
      retryable: true,
    });

    await expect(runtime.run(config, async ({ markAttempt }) => {
      markAttempt(0);
      throw error;
    })).rejects.toBe(error);

    await expect(runtime.run(config, async () => 'retry-later')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(runtime.snapshot().registry.history[0]).toMatchObject({
      state: 'failed',
      errorName: 'AppError',
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain('upstream private detail');
  });

  test('blocks replay after caller cancellation because server outcome may be ambiguous', async () => {
    const runtime = createMutationSafetyRuntime();
    const controller = new AbortController();
    const config = protectedPost({
      idempotencyKey: 'mutation-replay-cancel-0001',
      signal: controller.signal,
    });
    const gate = deferred<string>();

    const running = runtime.run(config, async ({ markAttempt }) => {
      markAttempt(0);
      return gate.promise;
    });
    await Promise.resolve();

    controller.abort(new Error('route left'));
    gate.reject(new AppError('cancelled', {
      code: 'ABORTED',
      retryable: false,
    }));

    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-replay-cancel-0001',
      }),
      async () => 'late',
    )).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(runtime.snapshot()).toMatchObject({
      cancelledExecutions: 1,
      registry: {
        history: [
          expect.objectContaining({
            state: 'cancelled',
          }),
        ],
      },
    });
  });
});

describe('MutationSafetyRuntime failure classification', () => {
  test.each([
    'ABORTED',
    'TASK_CANCELLED',
    'subscriber-aborted',
    'operation-cancelled',
    'MUTATION_ABORTED',
  ])('classifies %s as cancellation', async (code) => {
    const runtime = createMutationSafetyRuntime();
    const error = new AppError('private cancellation detail', {
      code,
      retryable: false,
    });

    await expect(runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-cancel-code-' + code.replace(/[^a-z0-9]/gi, ''),
      }),
      async () => {
        throw error;
      },
    )).rejects.toBe(error);

    expect(runtime.snapshot()).toMatchObject({
      cancelledExecutions: 1,
      failedExecutions: 0,
    });
  });

  test('classifies ordinary AppError as failure', async () => {
    const runtime = createMutationSafetyRuntime();
    const error = new AppError('private validation detail', {
      code: 'BAD_REQUEST',
      status: 400,
      retryable: false,
    });

    await expect(runtime.run(
      protectedPost({ idempotencyKey: 'mutation-failure-class-0001' }),
      async () => {
        throw error;
      },
    )).rejects.toBe(error);

    expect(runtime.snapshot()).toMatchObject({
      failedExecutions: 1,
      cancelledExecutions: 0,
    });
  });

  test('active aborted signal classifies even an ordinary rejection as cancellation', async () => {
    const controller = new AbortController();
    const runtime = createMutationSafetyRuntime();
    const config = protectedPost({
      idempotencyKey: 'mutation-abort-signal-0001',
      signal: controller.signal,
    });

    await expect(runtime.run(config, async () => {
      controller.abort('route-left');
      throw new TypeError('transport closed');
    })).rejects.toBeInstanceOf(TypeError);

    expect(runtime.snapshot()).toMatchObject({
      cancelledExecutions: 1,
      failedExecutions: 0,
    });
  });
});

describe('MutationSafetyRuntime capacity and retention', () => {
  test('honors registry global capacity', async () => {
    const runtime = createMutationSafetyRuntime({
      registryOptions: {
        maxEntries: 1,
        maxEntriesPerOwner: 1,
      },
    });
    const gate = deferred<string>();
    const first = runtime.run(
      protectedPost({ idempotencyKey: 'mutation-capacity-runtime-0001' }),
      async () => gate.promise,
    );
    await Promise.resolve();

    await expect(runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-capacity-runtime-0002',
        url: '/other',
      }),
      async () => 'second',
    )).rejects.toMatchObject({
      code: 'REGISTRY_CAPACITY_EXCEEDED',
    });

    gate.resolve('first');
    await first;
  });

  test('honors per-owner capacity based on scheduler group', async () => {
    const runtime = createMutationSafetyRuntime({
      registryOptions: {
        maxEntries: 4,
        maxEntriesPerOwner: 1,
      },
    });
    const gate = deferred<string>();
    const first = runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-owner-runtime-0001',
        schedulerGroup: 'catalog',
      }),
      async () => gate.promise,
    );
    await Promise.resolve();

    await expect(runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-owner-runtime-0002',
        schedulerGroup: 'catalog',
      }),
      async () => 'blocked',
    )).rejects.toMatchObject({
      code: 'OWNER_CAPACITY_EXCEEDED',
    });

    await expect(runtime.run(
      protectedPost({
        idempotencyKey: 'mutation-owner-runtime-0003',
        schedulerGroup: 'search',
      }),
      async () => 'independent',
    )).resolves.toBe('independent');

    gate.resolve('first');
    await first;
  });

  test('allows key reuse after retention expiration', async () => {
    const clock = createClock();
    const runtime = createMutationSafetyRuntime({
      clock: clock.now,
      registryOptions: {
        retentionMs: 1_000,
      },
    });
    const config = protectedPost({
      idempotencyKey: 'mutation-runtime-expire-0001',
    });

    await runtime.run(config, async () => 'first');
    clock.advance(1_000);
    await expect(runtime.run(config, async () => 'second')).resolves.toBe('second');

    expect(runtime.snapshot().registry.counters).toMatchObject({
      admitted: 2,
      pruned: 1,
    });
  });

  test('manual prune exposes reclaimed count', async () => {
    const clock = createClock();
    const runtime = createMutationSafetyRuntime({
      clock: clock.now,
      registryOptions: {
        retentionMs: 1_000,
      },
    });
    await runtime.run(
      protectedPost({ idempotencyKey: 'mutation-runtime-prune-0001' }),
      async () => 'ok',
    );

    clock.advance(1_000);
    expect(runtime.prune()).toBe(1);
    expect(runtime.snapshot().registry.entries).toBe(0);
  });
});

describe('MutationSafetyRuntime event privacy', () => {
  test('emits lifecycle events without raw idempotency key or payload data', async () => {
    const events: MutationSafetyEvent[] = [];
    const secretKey = 'mutation-runtime-secret-0001';
    const runtime = createMutationSafetyRuntime({
      onEvent: (event) => events.push(event),
    });

    await runtime.run(
      protectedPost({
        idempotencyKey: secretKey,
        data: {
          password: 'private-password',
          note: 'private-body',
        },
      }),
      async ({ markAttempt }) => {
        markAttempt(0);
        return 'ok';
      },
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain('private-password');
    expect(serialized).not.toContain('private-body');
    expect(serialized).toContain('/items');
  });

  test('failure event retains error code/class but not message', async () => {
    const events: MutationSafetyEvent[] = [];
    const runtime = createMutationSafetyRuntime({
      onEvent: (event) => events.push(event),
    });
    const error = new AppError('private server response', {
      code: 'SERVER_ERROR',
      status: 503,
      retryable: true,
    });

    await expect(runtime.run(
      protectedPost({ idempotencyKey: 'mutation-event-failure-0001' }),
      async () => {
        throw error;
      },
    )).rejects.toBe(error);

    const serialized = JSON.stringify(events);
    expect(serialized).toContain('SERVER_ERROR');
    expect(serialized).toContain('AppError');
    expect(serialized).not.toContain('private server response');
  });

  test('observer failure never changes mutation result', async () => {
    const observer = vi.fn(() => {
      throw new Error('observer failed');
    });
    const runtime = createMutationSafetyRuntime({ onEvent: observer });

    await expect(runtime.run(
      protectedPost({ idempotencyKey: 'mutation-event-observer-0001' }),
      async () => 'ok',
    )).resolves.toBe('ok');

    expect(runtime.snapshot().observerFailures).toBeGreaterThanOrEqual(2);
  });

  test('bypass event remains privacy safe for safe requests', async () => {
    const events: MutationSafetyEvent[] = [];
    const runtime = createMutationSafetyRuntime({
      onEvent: (event) => events.push(event),
    });

    await runtime.run(
      safeGet({
        url: '/search',
        params: { q: 'private-search-term' },
      }),
      async () => 'ok',
    );

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'bypassed',
      method: 'get',
      route: '/search',
    }));
    expect(JSON.stringify(events)).not.toContain('private-search-term');
  });
});

describe('MutationSafetyRuntime snapshot', () => {
  test('returns immutable aggregate state', async () => {
    const runtime = createMutationSafetyRuntime();
    await runtime.run(
      protectedPost({ idempotencyKey: 'mutation-snapshot-0001' }),
      async () => 'ok',
    );

    const snapshot = runtime.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.registry)).toBe(true);
    expect(snapshot).toMatchObject({
      disposed: false,
      protectedExecutions: 1,
      completedExecutions: 1,
    });
  });

  test('reports stale protected mutation through registry snapshot', async () => {
    const clock = createClock();
    const runtime = createMutationSafetyRuntime({
      clock: clock.now,
      registryOptions: {
        staleInFlightAfterMs: 1_000,
      },
    });
    const gate = deferred<string>();
    const running = runtime.run(
      protectedPost({ idempotencyKey: 'mutation-stale-runtime-0001' }),
      async () => gate.promise,
    );
    await Promise.resolve();

    clock.advance(1_000);
    expect(runtime.snapshot().registry).toMatchObject({
      inFlight: 1,
      staleInFlight: 1,
      oldestInFlightAgeMs: 1_000,
    });

    gate.resolve('done');
    await running;
  });
});

describe('MutationSafetyRuntime disposal', () => {
  test('rejects new protected work after disposal', async () => {
    const runtime = createMutationSafetyRuntime();
    runtime.dispose();

    await expect(runtime.run(
      protectedPost({ idempotencyKey: 'mutation-disposed-runtime-0001' }),
      async () => 'late',
    )).rejects.toMatchObject({
      code: 'REGISTRY_DISPOSED',
    });
    expect(runtime.snapshot().rejectedExecutions).toBe(1);
  });

  test('dispose is idempotent', () => {
    const runtime = createMutationSafetyRuntime();
    runtime.dispose('first');
    expect(() => runtime.dispose('second')).not.toThrow();
    expect(runtime.snapshot().disposed).toBe(true);
  });

  test('dispose cancels currently registered mutation leases', async () => {
    const runtime = createMutationSafetyRuntime();
    const gate = deferred<string>();
    const running = runtime.run(
      protectedPost({ idempotencyKey: 'mutation-dispose-active-0001' }),
      async () => gate.promise,
    );
    await Promise.resolve();

    runtime.dispose(new Error('application shutdown'));
    expect(runtime.snapshot()).toMatchObject({
      disposed: true,
      registry: {
        inFlight: 0,
        counters: {
          cancelled: 1,
        },
      },
    });

    gate.resolve('operation-finished-after-dispose');
    await expect(running).resolves.toBe('operation-finished-after-dispose');
    expect(runtime.snapshot().registry.counters.cancelled).toBe(1);
  });
});

describe('MutationSafetyRuntime clock safety', () => {
  test('rejects non-finite timestamps when observer emission needs time', async () => {
    const runtime = createMutationSafetyRuntime({
      clock: () => Number.NaN,
      onEvent: vi.fn(),
    });

    await expect(runtime.run(safeGet(), async () => 'ok')).rejects.toMatchObject({
      code: 'INVALID_CLOCK',
    });
  });

  test('rejects backward moving runtime clock', async () => {
    const clock = createClock();
    const runtime = createMutationSafetyRuntime({
      clock: clock.now,
      onEvent: vi.fn(),
    });

    await runtime.run(safeGet(), async () => 'ok');
    clock.rewind(1);

    await expect(runtime.run(safeGet(), async () => 'late')).rejects.toMatchObject({
      code: 'INVALID_CLOCK',
    });
  });
});
