import { describe, expect, it, vi } from 'vitest';
import { createArcgisModuleLoadGovernor } from './arcgisModuleLoadGovernor';

const baseConfiguration = {
  maxConcurrent: 1,
  maxQueued: 4,
  maxHistory: 4,
  maxBatchModules: 8,
  defaultTimeoutMs: 0,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('arcgisModuleLoadGovernor', () => {
  it('bounds concurrency and prioritizes queued critical work over prefetch work', async () => {
    const firstGate = deferred<readonly unknown[]>();
    const order: string[] = [];
    const loader = vi.fn(async (moduleIds: readonly string[]) => {
      order.push(moduleIds[0]!);
      if (moduleIds[0] === 'first') return firstGate.promise;
      return moduleIds.map((moduleId) => ({ moduleId }));
    });
    const governor = createArcgisModuleLoadGovernor(baseConfiguration, loader);

    const first = governor.submit(['first'], { priority: 'interactive' });
    const prefetch = governor.submit(['prefetch'], { priority: 'prefetch' });
    const critical = governor.submit(['critical'], { priority: 'critical' });

    await Promise.resolve();
    expect(governor.snapshot()).toMatchObject({ running: 1, queued: 2 });

    firstGate.resolve([{ moduleId: 'first' }]);
    await expect(first).resolves.toHaveLength(1);
    await expect(critical).resolves.toEqual([{ moduleId: 'critical' }]);
    await expect(prefetch).resolves.toEqual([{ moduleId: 'prefetch' }]);
    expect(order).toEqual(['first', 'critical', 'prefetch']);
  });

  it('deduplicates active jobs and isolates subscriber cancellation', async () => {
    const gate = deferred<readonly unknown[]>();
    const loader = vi.fn(() => gate.promise);
    const governor = createArcgisModuleLoadGovernor(baseConfiguration, loader);
    const firstController = new AbortController();

    const first = governor.submit(['esri/Map'], {
      dedupeKey: 'map-core',
      signal: firstController.signal,
    });
    const second = governor.submit(['esri/Map'], { dedupeKey: 'map-core' });

    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(governor.snapshot().deduped).toBe(1);

    firstController.abort(new Error('first consumer left'));
    await expect(first).rejects.toThrow('first consumer left');

    gate.resolve([{ kind: 'Map' }]);
    await expect(second).resolves.toEqual([{ kind: 'Map' }]);
    expect(governor.snapshot().cancelled).toBe(0);
  });

  it('cancels the shared job when every subscriber leaves', async () => {
    let sharedSignal: AbortSignal | undefined;
    const loader = vi.fn((_moduleIds: readonly string[], signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<readonly unknown[]>(() => undefined);
    });
    const governor = createArcgisModuleLoadGovernor(baseConfiguration, loader);
    const a = new AbortController();
    const b = new AbortController();

    const first = governor.submit(['esri/views/SceneView'], {
      dedupeKey: 'scene',
      signal: a.signal,
    });
    const second = governor.submit(['esri/views/SceneView'], {
      dedupeKey: 'scene',
      signal: b.signal,
    });
    await Promise.resolve();

    a.abort();
    b.abort();
    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
    expect(sharedSignal?.aborted).toBe(true);
    expect(governor.snapshot().cancelled).toBe(1);
  });

  it('rejects new work when the bounded queue is full', async () => {
    const gate = deferred<readonly unknown[]>();
    const governor = createArcgisModuleLoadGovernor(
      { ...baseConfiguration, maxQueued: 1 },
      async (moduleIds) => moduleIds[0] === 'first' ? gate.promise : moduleIds,
    );

    const first = governor.submit(['first']);
    const queued = governor.submit(['second']);
    await expect(governor.submit(['third'])).rejects.toMatchObject({ code: 'QUEUE_FULL' });

    gate.resolve(['first']);
    await expect(first).resolves.toEqual(['first']);
    await expect(queued).resolves.toEqual(['second']);
  });

  it('enforces batch budgets before invoking the loader', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const governor = createArcgisModuleLoadGovernor(
      { ...baseConfiguration, maxBatchModules: 2 },
      loader,
    );

    await expect(governor.submit(['a', 'b', 'c'])).rejects.toMatchObject({
      code: 'BATCH_TOO_LARGE',
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('times out cooperative work and records a bounded history entry', async () => {
    vi.useFakeTimers();
    try {
      const governor = createArcgisModuleLoadGovernor(
        { ...baseConfiguration, defaultTimeoutMs: 20, maxHistory: 2 },
        async (_moduleIds, signal) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      );
      const result = governor.submit(['slow']);
      await vi.advanceTimersByTimeAsync(21);
      await expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(governor.snapshot()).toMatchObject({ timedOut: 1, retainedHistory: 1 });
      expect(governor.listHistory()[0]).toMatchObject({
        status: 'timed-out',
        errorCode: 'TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed loader payloads and allows a later retry', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce([{ only: 'one' }])
      .mockResolvedValueOnce([{ one: 1 }, { two: 2 }]);
    const governor = createArcgisModuleLoadGovernor(baseConfiguration, loader);

    await expect(governor.submit(['one', 'two'])).rejects.toMatchObject({
      code: 'PAYLOAD_MISMATCH',
    });
    await expect(governor.submit(['one', 'two'])).resolves.toHaveLength(2);
    expect(governor.snapshot()).toMatchObject({ failed: 1, completed: 1 });
  });

  it('records loaded module identities, cancel operations and bounded disposal', async () => {
    const gate = deferred<readonly unknown[]>();
    const governor = createArcgisModuleLoadGovernor(baseConfiguration, async (moduleIds) => (
      moduleIds[0] === 'hold' ? gate.promise : moduleIds
    ));

    await expect(governor.submit(['esri/Map', 'esri/Map'])).resolves.toEqual(['esri/Map']);
    expect(governor.hasLoaded('esri/Map')).toBe(true);

    const held = governor.submit(['hold'], { dedupeKey: 'hold-key' });
    await Promise.resolve();
    expect(governor.cancelByDedupeKey('hold-key')).toBe(true);
    await expect(held).rejects.toMatchObject({ code: 'CANCELLED' });

    governor.dispose();
    expect(governor.snapshot().disposed).toBe(true);
    await expect(governor.submit(['later'])).rejects.toMatchObject({
      code: 'GOVERNOR_DISPOSED',
    });
    gate.resolve(['hold']);
  });

  it('validates configuration eagerly', () => {
    expect(() => createArcgisModuleLoadGovernor(
      { ...baseConfiguration, maxConcurrent: 0 },
      async (moduleIds) => moduleIds,
    )).toThrow(/maxConcurrent/);
    expect(() => createArcgisModuleLoadGovernor(
      baseConfiguration,
      null as unknown as (moduleIds: readonly string[], signal: AbortSignal) => Promise<readonly unknown[]>,
    )).toThrow(/loader/);
  });
});
