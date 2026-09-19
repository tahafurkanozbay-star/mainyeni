import { describe, expect, it, vi } from 'vitest';
import { BoundedResilienceCoordinator, ResilienceCoordinatorError } from './resilienceCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const coordinator = (overrides: ConstructorParameters<typeof BoundedResilienceCoordinator>[0] = {}) =>
  new BoundedResilienceCoordinator({
    historyLimit: 8,
    bulkhead: { maxConcurrent: 2, maxQueued: 2, maxConcurrentPerOwner: 2, maxQueuedPerOwner: 2, maxQueueWaitMs: 1_000 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxElapsedMs: 1_000 },
    circuitBreaker: { failureThreshold: 3, recoveryTimeoutMs: 1_000 },
    failureBudget: { windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2 },
    ...overrides,
  });

describe('BoundedResilienceCoordinator', () => {
  it('executes admitted work and records bounded success evidence', async () => {
    const runtime = coordinator();
    await expect(runtime.execute({ owner: 'map', key: 'query:1', operation: async (_signal, attempt) => `ok-${attempt}` })).resolves.toBe('ok-1');
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({ active: 0, owners: 0, keys: 0, accepted: 1, succeeded: 1, failed: 0, rejected: 0, cancelled: 0, budgetState: 'healthy' });
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({ owner: 'map', key: 'query:1', outcome: 'success', attempts: 1 });
  });

  it('normalizes owner and key identities before accounting', async () => {
    const runtime = coordinator();
    await runtime.execute({ owner: ' map ', key: ' query ', operation: async () => 1 });
    expect(runtime.snapshot().history[0]).toMatchObject({ owner: 'map', key: 'query' });
  });

  it('rejects empty and oversized identities fail closed', async () => {
    const runtime = coordinator();
    await expect(runtime.execute({ owner: ' ', key: 'x', operation: async () => 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(runtime.execute({ owner: 'x', key: 'k'.repeat(161), operation: async () => 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(runtime.snapshot().accepted).toBe(0);
  });

  it('rejects an already-aborted request before operation admission', async () => {
    const runtime = coordinator();
    const controller = new AbortController(); controller.abort('route-left');
    const operation = vi.fn(async () => 1);
    await expect(runtime.execute({ owner: 'map', key: 'q', signal: controller.signal, operation })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(operation).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ accepted: 0, cancelled: 1, active: 0 });
  });

  it('propagates caller cancellation into active operation ownership', async () => {
    const runtime = coordinator();
    const controller = new AbortController();
    const started = deferred<void>();
    const run = runtime.execute({
      owner: 'map', key: 'q', signal: controller.signal,
      operation: async (signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        return 1;
      },
    });
    await started.promise;
    expect(runtime.snapshot().active).toBe(1);
    controller.abort('route-left');
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot()).toMatchObject({ active: 0, owners: 0, keys: 0, cancelled: 1 });
  });

  it('aborts active operations during deterministic disposal', async () => {
    const runtime = coordinator();
    const started = deferred<void>();
    const run = runtime.execute({ owner: 'map', key: 'q', operation: async (signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      return 1;
    }});
    await started.promise;
    runtime.dispose();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot()).toMatchObject({ disposed: true, active: 0, cancelled: 1 });
    await expect(runtime.execute({ owner: 'x', key: 'y', operation: async () => 1 })).rejects.toMatchObject({ code: 'COORDINATOR_DISPOSED' });
  });

  it('contains operation failures and releases identity accounting', async () => {
    const runtime = coordinator();
    const error = new Error('upstream failed');
    await expect(runtime.execute({ owner: 'search', key: 'address', operation: async () => { throw error; } })).rejects.toBe(error);
    expect(runtime.snapshot()).toMatchObject({ active: 0, owners: 0, keys: 0, accepted: 1, failed: 1 });
    expect(runtime.snapshot().history[0]).toMatchObject({ outcome: 'failure', errorName: 'Error' });
  });

  it('opens the rolling failure budget and rejects optional work', async () => {
    const runtime = coordinator({ circuitBreaker: { failureThreshold: 100 }, failureBudget: { windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2 } });
    for (let index = 0; index < 2; index += 1) {
      await expect(runtime.execute({ owner: 'search', key: `fail:${index}`, operation: async () => { throw new Error('fail'); } })).rejects.toThrow('fail');
    }
    expect(runtime.snapshot().budgetState).toBe('exhausted');
    const optional = vi.fn(async () => 1);
    await expect(runtime.execute({ owner: 'search', key: 'optional', operation: optional })).rejects.toMatchObject({ code: 'FAILURE_BUDGET_EXHAUSTED' });
    expect(optional).not.toHaveBeenCalled();
  });

  it('allows critical work through an exhausted failure budget', async () => {
    const runtime = coordinator({ circuitBreaker: { failureThreshold: 100 }, failureBudget: { windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2 } });
    for (let index = 0; index < 2; index += 1) await runtime.execute({ owner: 'x', key: `seed:${index}`, operation: async () => { throw new Error('fail'); } }).catch(() => undefined);
    await expect(runtime.execute({ owner: 'x', key: 'critical', priority: 'critical', operation: async () => 'essential' })).resolves.toBe('essential');
  });

  it('enforces active owner cardinality', async () => {
    const runtime = coordinator({ maxOwners: 1, bulkhead: { maxConcurrent: 2, maxQueued: 0, maxConcurrentPerOwner: 2, maxQueuedPerOwner: 0, maxQueueWaitMs: 1_000 } });
    const gate = deferred<void>(); const started = deferred<void>();
    const first = runtime.execute({ owner: 'owner-a', key: 'a', operation: async () => { started.resolve(); await gate.promise; return 1; } });
    await started.promise;
    await expect(runtime.execute({ owner: 'owner-b', key: 'b', operation: async () => 2 })).rejects.toMatchObject({ code: 'OWNER_LIMIT_EXCEEDED' });
    gate.resolve(); await expect(first).resolves.toBe(1);
  });

  it('enforces active key cardinality independently from owner cardinality', async () => {
    const runtime = coordinator({ maxKeys: 1, bulkhead: { maxConcurrent: 2, maxQueued: 0, maxConcurrentPerOwner: 2, maxQueuedPerOwner: 0, maxQueueWaitMs: 1_000 } });
    const gate = deferred<void>(); const started = deferred<void>();
    const first = runtime.execute({ owner: 'same', key: 'a', operation: async () => { started.resolve(); await gate.promise; return 1; } });
    await started.promise;
    await expect(runtime.execute({ owner: 'same', key: 'b', operation: async () => 2 })).rejects.toMatchObject({ code: 'KEY_LIMIT_EXCEEDED' });
    gate.resolve(); await first;
  });

  it('permits concurrent reuse of an already-accounted owner and key', async () => {
    const runtime = coordinator({ maxOwners: 1, maxKeys: 1 });
    const gate = deferred<void>(); let started = 0; const both = deferred<void>();
    const operation = async () => { started += 1; if (started === 2) both.resolve(); await gate.promise; return started; };
    const a = runtime.execute({ owner: 'same', key: 'same', operation });
    const b = runtime.execute({ owner: 'same', key: 'same', operation });
    await both.promise;
    expect(runtime.snapshot()).toMatchObject({ active: 2, owners: 1, keys: 1 });
    gate.resolve(); await Promise.all([a, b]);
  });

  it('bounds retained event history', async () => {
    const runtime = coordinator({ historyLimit: 2 });
    for (let index = 0; index < 4; index += 1) await runtime.execute({ owner: 'x', key: `${index}`, operation: async () => index });
    const history = runtime.snapshot().history;
    expect(history).toHaveLength(2);
    expect(history.map((event) => event.key)).toEqual(['2', '3']);
    expect(history[0]!.sequence).toBe(3);
  });

  it('supports disabling event retention', async () => {
    const runtime = coordinator({ historyLimit: 0 });
    await runtime.execute({ owner: 'x', key: 'y', operation: async () => 1 });
    expect(runtime.snapshot().history).toEqual([]);
  });

  it('does not allow reset while operations are active', async () => {
    const runtime = coordinator(); const gate = deferred<void>(); const started = deferred<void>();
    const run = runtime.execute({ owner: 'x', key: 'y', operation: async () => { started.resolve(); await gate.promise; return 1; } });
    await started.promise;
    expect(() => runtime.resetHealth()).toThrow(ResilienceCoordinatorError);
    gate.resolve(); await run;
    expect(() => runtime.resetHealth()).not.toThrow();
  });

  it('validates coordinator resource bounds', () => {
    expect(() => coordinator({ historyLimit: -1 })).toThrow(RangeError);
    expect(() => coordinator({ maxOwners: 0 })).toThrow(RangeError);
    expect(() => coordinator({ maxKeys: 0 })).toThrow(RangeError);
  });

  it('rejects a non-monotonic coordinator clock', async () => {
    const values = [100, 100, 99];
    const runtime = coordinator({ clock: { now: () => values.shift() ?? 99 } });
    await expect(runtime.execute({ owner: 'x', key: 'y', operation: async () => 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
