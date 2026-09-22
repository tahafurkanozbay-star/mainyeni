import { describe, expect, it, vi } from 'vitest';
import {
  SceneLayerResourceBudgetError,
  createSceneLayerLifecycleRuntime,
  type SceneLayerAdapter,
} from './sceneLayerLifecycleRuntime';

type Resource = { id: string };

const adapter = (
  overrides: Partial<SceneLayerAdapter<Resource>> = {},
): SceneLayerAdapter<Resource> => ({
  load: async ({ descriptor }) => ({ id: descriptor.id }),
  ...overrides,
});

const deferred = <TValue>() => {
  let resolve!: (value: TValue) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('scene layer registration and viewport lifecycle', () => {
  it('registers a deterministic idle snapshot', () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    const snapshot = runtime.register({
      id: ' buildings ',
      priority: 'high',
      resourceEstimate: {
        cpuBytes: 100,
        gpuBytes: 200,
        featureCount: 10,
        drawCalls: 2,
      },
    }, adapter());

    expect(snapshot).toEqual(expect.objectContaining({
      id: 'buildings',
      phase: 'idle',
      priority: 'high',
      generation: 0,
      visible: true,
      requested: false,
      estimate: {
        cpuBytes: 100,
        gpuBytes: 200,
        featureCount: 10,
        drawCalls: 2,
      },
    }));
  });

  it('rejects empty and duplicate layer identities', () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    expect(() => runtime.register({ id: ' ' }, adapter())).toThrow('Scene layer id is required');

    runtime.register({ id: 'roads' }, adapter());
    expect(() => runtime.register({ id: 'roads' }, adapter()))
      .toThrow('Scene layer already registered: roads');
  });

  it('loads and activates a manually requested layer', async () => {
    const activate = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ id: 'roads' }));
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'roads' }, adapter({ load, activate }));

    const snapshot = await runtime.request('roads', 'tool-open');

    expect(snapshot).toMatchObject({
      phase: 'ready',
      requested: true,
      generation: 1,
      retries: 0,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toMatchObject({
      activeLoads: 0,
      queuedLoads: 0,
      loadedLayers: 1,
    });
  });

  it('suspends an out-of-scale layer and resumes it without reloading', async () => {
    const load = vi.fn(async () => ({ id: 'zoning' }));
    const suspend = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({
      id: 'zoning',
      minScale: 50_000,
      maxScale: 1_000,
    }, adapter({ load, suspend, activate }));

    await runtime.setViewport({ scale: 10_000 });
    await vi.waitFor(() => expect(runtime.getLayerSnapshot('zoning')?.phase).toBe('ready'));

    await runtime.setViewport({ scale: 100_000 });
    expect(runtime.getLayerSnapshot('zoning')?.phase).toBe('suspended');
    expect(suspend).toHaveBeenCalledTimes(1);

    await runtime.setViewport({ scale: 5_000 });
    expect(runtime.getLayerSnapshot('zoning')?.phase).toBe('ready');
    expect(load).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('respects zoom bounds independently from scale bounds', async () => {
    const load = vi.fn(async () => ({ id: 'detail' }));
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'detail', minZoom: 10, maxZoom: 16 }, adapter({ load }));

    await runtime.setViewport({ zoom: 8 });
    expect(runtime.getLayerSnapshot('detail')?.requested).toBe(false);
    expect(load).not.toHaveBeenCalled();

    await runtime.setViewport({ zoom: 12 });
    await runtime.reconcile();
    await vi.waitFor(() => expect(runtime.getLayerSnapshot('detail')?.phase).toBe('ready'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight load when the layer leaves the viewport', async () => {
    let observedSignal: AbortSignal | null = null;
    const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      return new Promise<Resource>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'terrain', minZoom: 10 }, adapter({ load }));

    const visible = runtime.setViewport({ zoom: 12 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await runtime.setViewport({ zoom: 4 });
    await visible;

    expect(observedSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(runtime.getLayerSnapshot('terrain')?.phase).toBe('idle'));
  });

  it('updates visibility and reconciles asynchronously', async () => {
    const suspend = vi.fn(async () => undefined);
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'labels' }, adapter({ suspend }));
    await runtime.request('labels');

    const immediate = runtime.setVisibility('labels', false);
    expect(immediate.visible).toBe(false);
    await runtime.reconcile();

    expect(runtime.getLayerSnapshot('labels')?.phase).toBe('suspended');
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});

describe('scene layer concurrency, retry, and failure isolation', () => {
  it('enforces maximum concurrent loads and drains queued work', async () => {
    const first = deferred<Resource>();
    const second = deferred<Resource>();
    const loads: string[] = [];
    const runtime = createSceneLayerLifecycleRuntime<Resource>({ maxConcurrentLoads: 1 });

    runtime.register({ id: 'one' }, adapter({
      load: async () => {
        loads.push('one');
        return first.promise;
      },
    }));
    runtime.register({ id: 'two' }, adapter({
      load: async () => {
        loads.push('two');
        return second.promise;
      },
    }));

    const one = runtime.request('one');
    const two = runtime.request('two');
    await vi.waitFor(() => expect(loads).toEqual(['one']));
    expect(runtime.getSnapshot()).toMatchObject({ activeLoads: 1, queuedLoads: 1 });

    first.resolve({ id: 'one' });
    await one;
    await vi.waitFor(() => expect(loads).toEqual(['one', 'two']));
    second.resolve({ id: 'two' });
    await two;

    expect(runtime.getSnapshot()).toMatchObject({ activeLoads: 0, loadedLayers: 2 });
  });

  it('prioritizes critical queued work over lower priority work', async () => {
    const blocker = deferred<Resource>();
    const order: string[] = [];
    const runtime = createSceneLayerLifecycleRuntime<Resource>({ maxConcurrentLoads: 1 });

    runtime.register({ id: 'blocker', priority: 'normal' }, adapter({
      load: async () => {
        order.push('blocker');
        return blocker.promise;
      },
    }));
    runtime.register({ id: 'low', priority: 'low' }, adapter({
      load: async () => {
        order.push('low');
        return { id: 'low' };
      },
    }));
    runtime.register({ id: 'critical', priority: 'critical' }, adapter({
      load: async () => {
        order.push('critical');
        return { id: 'critical' };
      },
    }));

    const first = runtime.request('blocker');
    const low = runtime.request('low');
    const critical = runtime.request('critical');
    await vi.waitFor(() => expect(order).toEqual(['blocker']));

    blocker.resolve({ id: 'blocker' });
    await first;
    await Promise.all([low, critical]);

    expect(order).toEqual(['blocker', 'critical', 'low']);
  });

  it('retries a transient load failure using bounded backoff', async () => {
    const delays: number[] = [];
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ id: 'retry' });
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      retryLimit: 1,
      retryBaseDelayMs: 25,
      retryJitterRatio: 0,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    runtime.register({ id: 'retry' }, adapter({ load }));

    const snapshot = await runtime.request('retry');

    expect(snapshot.phase).toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([25]);
  });

  it('adds deterministic jitter, caps exponential backoff, and emits retry telemetry', async () => {
    const delays: number[] = [];
    const events: Array<{ type: string; retryAttempt?: number; delayMs?: number }> = [];
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockResolvedValueOnce({ id: 'jittered' });
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      retryLimit: 2,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 150,
      retryJitterRatio: 0.2,
      random: () => 0.75,
      sleep: async (delay) => {
        delays.push(delay);
      },
      onEvent: (event) => {
        if (event.type === 'retry-scheduled') events.push(event);
      },
    });
    runtime.register({ id: 'jittered' }, adapter({ load }));

    const snapshot = await runtime.request('jittered');

    expect(snapshot.phase).toBe('ready');
    expect(load).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([110, 150]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'retry-scheduled', retryAttempt: 1, delayMs: 110 }),
      expect.objectContaining({ type: 'retry-scheduled', retryAttempt: 2, delayMs: 150 }),
    ]);
  });

  it('treats abort during retry sleep as cancellation instead of a rejected request', async () => {
    const sleepStarted = deferred<void>();
    let retrySignal: AbortSignal | null = null;
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      retryLimit: 2,
      retryBaseDelayMs: 50,
      retryJitterRatio: 0,
      sleep: async (_delay, signal) => {
        retrySignal = signal;
        sleepStarted.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('retry cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });
    runtime.register({ id: 'cancel-retry' }, adapter({
      load: async () => {
        throw new Error('temporary');
      },
    }));

    const pending = runtime.request('cancel-retry');
    await sleepStarted.promise;
    await runtime.suspend('cancel-retry', 'viewport-left');

    expect(retrySignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({
      phase: 'idle',
      requested: false,
    });
  });

  it('marks the layer failed after the retry budget is exhausted', async () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      retryLimit: 1,
      sleep: async () => undefined,
    });
    runtime.register({ id: 'broken' }, adapter({
      load: async () => {
        throw new Error('service unavailable');
      },
    }));

    const snapshot = await runtime.request('broken');
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.lastError).toEqual(expect.objectContaining({ message: 'service unavailable' }));
  });

  it('restores the full retry budget for a later load generation', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('first generation failed'))
      .mockRejectedValueOnce(new Error('first generation retry failed'))
      .mockRejectedValueOnce(new Error('second generation transient'))
      .mockResolvedValueOnce({ id: 'recoverable' });
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      retryLimit: 1,
      sleep: async () => undefined,
    });
    runtime.register({ id: 'recoverable' }, adapter({ load }));

    const first = await runtime.request('recoverable');
    expect(first.phase).toBe('failed');
    expect(load).toHaveBeenCalledTimes(2);

    const second = await runtime.request('recoverable');
    expect(second.phase).toBe('ready');
    expect(second.retries).toBe(0);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('disposes a resource when activation fails instead of leaking it into a retry', async () => {
    const dispose = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ id: 'activation-failure' }));
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'activation-failure' }, adapter({
      load,
      activate: async () => {
        throw new Error('GPU attach failed');
      },
      dispose,
    }));

    const snapshot = await runtime.request('activation-failure');

    expect(snapshot.phase).toBe('failed');
    expect(snapshot.lastError).toEqual(expect.objectContaining({ message: 'GPU attach failed' }));
    expect(dispose).toHaveBeenCalledWith(
      { id: 'activation-failure' },
      'activation-failed',
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().loadedLayers).toBe(0);
  });

  it('isolates event observer failures from lifecycle transitions', async () => {
    const onObserverError = vi.fn();
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      onEvent: () => {
        throw new Error('telemetry sink failed');
      },
      onObserverError,
    });
    runtime.register({ id: 'safe' }, adapter());

    await expect(runtime.request('safe')).resolves.toMatchObject({ phase: 'ready' });
    expect(onObserverError).toHaveBeenCalled();
  });

  it('reports failures from the observer-error callback through the host error channel', async () => {
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    try {
      const runtime = createSceneLayerLifecycleRuntime<Resource>({
        onEvent: () => {
          throw new Error('observer failed');
        },
        onObserverError: () => {
          throw new Error('secondary observer failed');
        },
      });
      runtime.register({ id: 'safe' }, adapter());

      await expect(runtime.request('safe')).resolves.toMatchObject({ phase: 'ready' });
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
        message: 'secondary observer failed',
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps lifecycle outcomes intact when no host error channel exists', async () => {
    vi.stubGlobal('reportError', undefined);
    try {
      const runtime = createSceneLayerLifecycleRuntime<Resource>({
        onEvent: () => {
          throw new Error('observer failed');
        },
        onObserverError: () => {
          throw new Error('secondary observer failed');
        },
      });
      runtime.register({ id: 'safe-without-report-error' }, adapter());

      await expect(runtime.request('safe-without-report-error'))
        .resolves.toMatchObject({ phase: 'ready' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('scene layer resource budgets', () => {
  it('rejects a single layer that exceeds the CPU budget and disposes its resource', async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      maxCpuBytes: 100,
    });
    runtime.register({
      id: 'heavy',
      resourceEstimate: { cpuBytes: 101 },
    }, adapter({ dispose }));

    const snapshot = await runtime.request('heavy');

    expect(snapshot.phase).toBe('failed');
    expect(snapshot.lastError).toBeInstanceOf(SceneLayerResourceBudgetError);
    expect(dispose).toHaveBeenCalledWith({ id: 'heavy' }, 'resource-budget');
    expect(runtime.getSnapshot().totalCpuBytes).toBe(0);
  });

  it('enforces GPU, feature, draw-call, and loaded-layer admission budgets', async () => {
    const cases = [
      { options: { maxGpuBytes: 10 }, estimate: { gpuBytes: 11 } },
      { options: { maxFeatures: 10 }, estimate: { featureCount: 11 } },
      { options: { maxDrawCalls: 10 }, estimate: { drawCalls: 11 } },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const runtime = createSceneLayerLifecycleRuntime<Resource>(testCase.options);
      runtime.register({
        id: `layer-${index}`,
        resourceEstimate: testCase.estimate,
      }, adapter());
      const snapshot = await runtime.request(`layer-${index}`);
      expect(snapshot.phase).toBe('failed');
      expect(snapshot.lastError).toBeInstanceOf(SceneLayerResourceBudgetError);
    }

    const runtime = createSceneLayerLifecycleRuntime<Resource>({ maxLoadedLayers: 1 });
    runtime.register({ id: 'one' }, adapter());
    runtime.register({ id: 'two' }, adapter());
    await runtime.request('one');
    const second = await runtime.request('two');
    expect(second.phase).toBe('failed');
    expect(runtime.getSnapshot().loadedLayers).toBe(1);
  });

  it('evicts an unrequested low-priority layer to admit a new visible layer', async () => {
    const disposed: string[] = [];
    const runtime = createSceneLayerLifecycleRuntime<Resource>({
      maxLoadedLayers: 1,
    });
    runtime.register({ id: 'old', priority: 'low' }, adapter({
      dispose: async (resource) => {
        disposed.push(resource.id);
      },
    }));
    runtime.register({ id: 'new', priority: 'high' }, adapter());

    await runtime.request('old');
    await runtime.suspend('old', 'not-visible');
    const next = await runtime.request('new');

    expect(next.phase).toBe('ready');
    expect(disposed).toContain('old');
    expect(runtime.getLayerSnapshot('old')?.phase).toBe('idle');
    expect(runtime.getSnapshot().loadedLayers).toBe(1);
  });

  it('does not evict a required retained layer and rejects the new admission instead', async () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>({ maxLoadedLayers: 1 });
    runtime.register({ id: 'required', required: true }, adapter());
    runtime.register({ id: 'optional' }, adapter());

    await runtime.request('required');
    const optional = await runtime.request('optional');

    expect(runtime.getLayerSnapshot('required')?.phase).toBe('ready');
    expect(optional.phase).toBe('failed');
    expect(optional.lastError).toBeInstanceOf(SceneLayerResourceBudgetError);
  });
});

describe('scene layer teardown', () => {
  it('unregisters and disposes a loaded resource', async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'remove-me' }, adapter({ dispose }));
    await runtime.request('remove-me');

    await expect(runtime.unregister('remove-me', 'route-change')).resolves.toBe(true);
    expect(dispose).toHaveBeenCalledWith({ id: 'remove-me' }, 'route-change');
    expect(runtime.getLayerSnapshot('remove-me')).toBeNull();
  });

  it('removes registry state even when the adapter dispose hook throws', async () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'bad-dispose' }, adapter({
      dispose: async () => {
        throw new Error('dispose failed');
      },
    }));
    await runtime.request('bad-dispose');

    await expect(runtime.unregister('bad-dispose')).rejects.toThrow('dispose failed');
    expect(runtime.getLayerSnapshot('bad-dispose')).toBeNull();
  });

  it('disposes all resident resources with allSettled semantics', async () => {
    const disposed: string[] = [];
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    runtime.register({ id: 'one' }, adapter({
      dispose: async (resource) => {
        disposed.push(resource.id);
        throw new Error('one failed');
      },
    }));
    runtime.register({ id: 'two' }, adapter({
      dispose: async (resource) => {
        disposed.push(resource.id);
      },
    }));
    await runtime.request('one');
    await runtime.request('two');

    await expect(runtime.dispose('shutdown')).resolves.toBeUndefined();
    expect(disposed.sort()).toEqual(['one', 'two']);
    expect(runtime.getSnapshot()).toMatchObject({
      loadedLayers: 0,
      activeLoads: 0,
      layers: [],
    });
  });

  it('is idempotent when disposed repeatedly', async () => {
    const runtime = createSceneLayerLifecycleRuntime<Resource>();
    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(() => runtime.register({ id: 'late' }, adapter()))
      .toThrow('Scene layer runtime is disposed');
  });
});
