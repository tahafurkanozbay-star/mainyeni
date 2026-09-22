import { describe, expect, it, vi } from 'vitest';
import {
  createSceneContentOrchestrator,
  type SceneContentDefinition,
  type SceneContentLayerLike,
  type SceneContentMapLike,
} from './sceneContentOrchestrator';

const createMap = () => {
  const layers: SceneContentLayerLike[] = [];
  const map: SceneContentMapLike = {
    add: (layer) => {
      if (!layers.includes(layer)) layers.push(layer);
      return layer;
    },
    remove: (layer) => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      return layer;
    },
    findLayerById: (id) => layers.find((layer) => layer.id === id) ?? null,
  };
  return { map, layers };
};

const feature = (id: string, overrides: Partial<SceneContentDefinition> = {}): SceneContentDefinition => ({
  id,
  kind: 'feature',
  title: `Layer ${id}`,
  visible: true,
  loadPolicy: 'visible',
  priority: 'visible',
  estimate: {
    cpuBytes: 1_000,
    gpuBytes: 1_000,
    drawCalls: 2,
    features: 100,
  },
  ...overrides,
});

describe('sceneContentOrchestrator', () => {
  it('loads registered visible content only after activation', async () => {
    const { map, layers } = createMap();
    const factory = vi.fn(async ({ definition }: { definition: Readonly<SceneContentDefinition> }) => ({
      id: definition.id,
      loaded: false,
      load: vi.fn(async () => undefined),
    }));
    const runtime = createSceneContentOrchestrator({ map, scale: 10_000 }, factory);

    runtime.register(feature('parks'));
    expect(runtime.getSnapshot().registered).toBe(1);
    expect(factory).not.toHaveBeenCalled();

    runtime.setActive(true);
    await runtime.reconcile();

    const snapshot = runtime.getSnapshot();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(snapshot.ready).toBe(1);
    expect(snapshot.visible).toBe(1);
    expect(snapshot.records[0]?.status).toBe('ready');
    expect(layers).toHaveLength(1);
    expect(layers[0]?.id).toBe('parks');
  });

  it('deduplicates concurrent reconciles for one record', async () => {
    const { map } = createMap();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory = vi.fn(async ({ definition }: { definition: Readonly<SceneContentDefinition> }) => {
      await gate;
      return { id: definition.id, loaded: true };
    });
    const runtime = createSceneContentOrchestrator({ map }, factory);
    runtime.register(feature('roads'));
    runtime.setActive(true);

    const first = runtime.reconcile('first');
    const second = runtime.reconcile('second');
    release?.();
    await Promise.all([first, second]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().ready).toBe(1);
  });

  it('bounds the pending content queue and admits higher-priority work first', async () => {
    const { map } = createMap();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const factory = vi.fn(async ({ definition }: { definition: Readonly<SceneContentDefinition> }) => {
      started.push(definition.id);
      if (started.length === 1) await firstGate;
      return { id: definition.id, loaded: true };
    });
    const runtime = createSceneContentOrchestrator({ map }, factory, {
      concurrency: 1,
      maximumQueueDepth: 2,
    });

    runtime.registerMany([
      feature('prefetch-a', { priority: 'prefetch' }),
      feature('prefetch-b', { priority: 'prefetch' }),
      feature('visible', { priority: 'visible' }),
      feature('critical', { priority: 'critical' }),
    ]);

    runtime.setActive(true);
    await Promise.resolve();

    const pressured = runtime.getSnapshot();
    expect(started[0]).toBe('critical');
    expect(pressured.queueCapacity).toBe(2);
    expect(pressured.queueDepth).toBeLessThanOrEqual(2);
    expect(pressured.deferred).toBe(1);
    expect(pressured.records.filter((record) => record.queueDeferred)).toHaveLength(1);

    releaseFirst?.();
    await runtime.reconcile('drain-backpressure');

    const completed = runtime.getSnapshot();
    expect(completed.queueDepth).toBe(0);
    expect(completed.deferred).toBe(0);
    expect(completed.ready).toBe(4);
    expect(started).toEqual(['critical', 'visible', 'prefetch-a', 'prefetch-b']);
  });

  it('removes stale queue entries when a registered definition is replaced', async () => {
    const { map } = createMap();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory = vi.fn(async ({ definition }: { definition: Readonly<SceneContentDefinition> }) => {
      if (definition.id === 'blocker') await gate;
      return { id: definition.id, loaded: true };
    });
    const runtime = createSceneContentOrchestrator({ map }, factory, {
      concurrency: 1,
      maximumQueueDepth: 2,
    });

    runtime.registerMany([
      feature('blocker', { priority: 'critical' }),
      feature('replace-me', { priority: 'visible' }),
    ]);
    runtime.setActive(true);
    await Promise.resolve();

    runtime.register(feature('replace-me', { priority: 'interactive', title: 'Updated' }));
    const queued = runtime.getSnapshot();
    expect(queued.queueDepth).toBeLessThanOrEqual(1);

    release?.();
    await runtime.reconcile('replacement');

    expect(factory.mock.calls.filter(([context]) => context.definition.id === 'replace-me')).toHaveLength(1);
    expect(runtime.getSnapshot().records.find((record) => record.id === 'replace-me')).toMatchObject({
      status: 'ready',
      priority: 'interactive',
      queueDeferred: false,
    });
  });

  it('honors visible scale ranges and hides loaded layers outside range', async () => {
    const { map, layers } = createMap();
    const factory = vi.fn(async () => ({ loaded: true }));
    const runtime = createSceneContentOrchestrator({ map, scale: 8_000 }, factory);
    runtime.register(feature('districts', { minScale: 2_000, maxScale: 20_000 }));
    runtime.setActive(true);
    await runtime.reconcile();

    expect(runtime.getSnapshot().visible).toBe(1);
    expect(layers[0]?.visible).toBe(true);

    runtime.setScale(50_000);
    expect(runtime.getSnapshot().visible).toBe(0);
    expect(runtime.getSnapshot().records[0]?.status).toBe('hidden');
    expect(layers[0]?.visible).toBe(false);

    runtime.setScale(5_000);
    await runtime.reconcile();
    expect(runtime.getSnapshot().visible).toBe(1);
    expect(layers[0]?.visible).toBe(true);
  });

  it('keeps manual content unloaded until its policy changes', async () => {
    const { map } = createMap();
    const factory = vi.fn(async () => ({ loaded: true }));
    const runtime = createSceneContentOrchestrator({ map }, factory);
    runtime.register(feature('manual', { loadPolicy: 'manual' }));
    runtime.setActive(true);
    await runtime.reconcile();

    expect(factory).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().records[0]?.status).toBe('registered');

    runtime.register(feature('manual', { loadPolicy: 'visible' }));
    await runtime.reconcile();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().records[0]?.status).toBe('ready');
  });

  it('applies normalized layer presentation', async () => {
    const { map, layers } = createMap();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true }));
    runtime.register({
      id: 'buildings',
      title: '3B Binalar',
      kind: 'building',
      opacity: 2,
      minScale: 500,
      maxScale: 40_000,
      elevationMode: 'relative-to-ground',
      estimate: { cpuBytes: 1_000, gpuBytes: 2_000, drawCalls: 3, features: 20 },
    });
    runtime.setActive(true);
    await runtime.reconcile();

    expect(layers[0]).toMatchObject({
      id: 'buildings',
      title: '3B Binalar',
      visible: true,
      opacity: 1,
      minScale: 500,
      maxScale: 40_000,
      elevationInfo: { mode: 'relative-to-ground' },
    });
  });

  it('blocks content when its resource estimate exceeds the budget', async () => {
    const { map } = createMap();
    const factory = vi.fn(async () => ({ loaded: true }));
    const runtime = createSceneContentOrchestrator({ map }, factory, {
      limits: {
        maxCpuBytes: 1_024,
        maxGpuBytes: 1_024,
        maxDrawCalls: 10,
        maxFeatures: 100,
        maxResources: 2,
        maxResourcesPerLayer: 1,
      },
    });
    runtime.register(feature('heavy', {
      estimate: { cpuBytes: 10_000, gpuBytes: 10_000, drawCalls: 50, features: 5_000 },
    }));
    runtime.setActive(true);
    await runtime.reconcile();

    const record = runtime.getSnapshot().records[0];
    expect(factory).not.toHaveBeenCalled();
    expect(record?.admitted).toBe(false);
    expect(record?.status).toBe('blocked');
    expect(record?.admissionReason).toBe('cpu-limit');
  });

  it('allows higher priority content to evict lower priority resources', async () => {
    const { map, layers } = createMap();
    const runtime = createSceneContentOrchestrator({ map }, async ({ definition }) => ({ id: definition.id, loaded: true }), {
      concurrency: 1,
      limits: {
        maxCpuBytes: 1_500,
        maxGpuBytes: 1_500,
        maxDrawCalls: 10,
        maxFeatures: 500,
        maxResources: 1,
        maxResourcesPerLayer: 1,
      },
    });
    runtime.register(feature('prefetch', {
      priority: 'prefetch',
      estimate: { cpuBytes: 1_000, gpuBytes: 1_000, drawCalls: 2, features: 100 },
    }));
    runtime.setActive(true);
    await runtime.reconcile();
    expect(runtime.getSnapshot().records.find((record) => record.id === 'prefetch')?.admitted).toBe(true);

    runtime.register(feature('critical', {
      priority: 'critical',
      estimate: { cpuBytes: 1_000, gpuBytes: 1_000, drawCalls: 2, features: 100 },
    }));
    await runtime.reconcile();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.records.find((record) => record.id === 'critical')?.admitted).toBe(true);
    expect(snapshot.records.find((record) => record.id === 'prefetch')?.status).toBe('blocked');
    expect(layers.find((layer) => layer.id === 'prefetch')?.visible).toBe(false);
  });

  it('updates visibility without reconstructing an already loaded layer', async () => {
    const { map, layers } = createMap();
    const factory = vi.fn(async () => ({ loaded: true }));
    const runtime = createSceneContentOrchestrator({ map }, factory);
    runtime.register(feature('poi'));
    runtime.setActive(true);
    await runtime.reconcile();

    runtime.setVisibility('poi', false);
    expect(layers[0]?.visible).toBe(false);
    expect(runtime.getSnapshot().records[0]?.status).toBe('hidden');

    runtime.setVisibility('poi', true);
    await runtime.reconcile();
    expect(layers[0]?.visible).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries failed content with bounded attempt state', async () => {
    const { map } = createMap();
    let calls = 0;
    const factory = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return { loaded: true };
    });
    const errors: string[] = [];
    const runtime = createSceneContentOrchestrator({ map }, factory, {
      maximumAttempts: 2,
      onError: (_error, context) => errors.push(context),
    });
    runtime.register(feature('retry'));
    runtime.setActive(true);
    await runtime.reconcile();

    expect(runtime.getSnapshot().records[0]?.status).toBe('failed');
    expect(errors).toContain('scene-content-load');

    await expect(runtime.retry('retry')).resolves.toBe(true);
    expect(runtime.getSnapshot().records[0]?.status).toBe('ready');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('aborts in-flight work and destroys owned layers on dispose', async () => {
    const { map, layers } = createMap();
    let observedSignal: AbortSignal | null = null;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const destroy = vi.fn();
    const factory = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      await gate;
      return { loaded: true, destroy };
    });
    const runtime = createSceneContentOrchestrator({ map }, factory);
    runtime.register(feature('slow'));
    runtime.setActive(true);
    const pending = runtime.reconcile();

    await Promise.resolve();
    runtime.dispose();
    expect(observedSignal?.aborted).toBe(true);
    release?.();
    await pending;

    expect(runtime.getSnapshot().disposed).toBe(true);
    expect(layers).toHaveLength(0);
  });

  it('destroys attached owned layers when unregistering', async () => {
    const { map, layers } = createMap();
    const destroy = vi.fn();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true, destroy }));
    runtime.register(feature('temporary'));
    runtime.setActive(true);
    await runtime.reconcile();

    expect(layers).toHaveLength(1);
    expect(runtime.unregister('temporary')).toBe(true);
    expect(layers).toHaveLength(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runtime.unregister('missing')).toBe(false);
  });

  it('preserves externally owned layers when configured not to destroy them', async () => {
    const { map } = createMap();
    const destroy = vi.fn();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true, destroy }), {
      ownLayers: false,
    });
    runtime.register(feature('shared'));
    runtime.setActive(true);
    await runtime.reconcile();
    runtime.dispose();

    expect(destroy).not.toHaveBeenCalled();
  });

  it('emits bounded lifecycle snapshots to subscribers', async () => {
    const { map } = createMap();
    const reasons: string[] = [];
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true }));
    const unsubscribe = runtime.subscribe((_snapshot, reason) => reasons.push(reason));

    runtime.register(feature('observed'));
    runtime.setActive(true);
    await runtime.reconcile('observed-reconcile');
    expect(reasons).toContain('register');
    expect(reasons).toContain('activate');
    expect(reasons).toContain('load-start');
    expect(reasons).toContain('load-success');
    expect(reasons).toContain('observed-reconcile:complete');

    expect(unsubscribe()).toBe(true);
    runtime.setVisibility('observed', false);
    expect(reasons.at(-1)).toBe('observed-reconcile:complete');
  });

  it('rejects invalid identifiers and inverted scale ranges', () => {
    const { map } = createMap();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({}));

    expect(() => runtime.register(feature('   '))).toThrow(/non-empty id/);
    expect(() => runtime.register(feature('bad-scale', { minScale: 10_000, maxScale: 1_000 }))).toThrow(/scale range/);
  });

  it('updates runtime budget limits and exposes current usage', async () => {
    const { map } = createMap();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true }), {
      limits: { maxResources: 4, maxResourcesPerLayer: 2 },
    });
    runtime.registerMany([
      feature('one', { priority: 'prefetch' }),
      feature('two', { priority: 'critical' }),
    ]);
    runtime.setActive(true);
    await runtime.reconcile();

    const before = runtime.getSnapshot();
    expect(before.budget.usage.resources).toBe(2);

    runtime.updateBudget({ maxResources: 1 });
    await runtime.reconcile('post-budget');
    const after = runtime.getSnapshot();
    expect(after.budget.limits.maxResources).toBe(1);
    expect(after.budget.usage.resources).toBeLessThanOrEqual(1);
    expect(after.records.find((record) => record.id === 'two')?.admitted).toBe(true);
  });

  it('supports elevation content with terrain budget classification', async () => {
    const { map } = createMap();
    const runtime = createSceneContentOrchestrator({ map }, async () => ({ loaded: true }));
    runtime.register({
      id: 'terrain',
      kind: 'elevation',
      priority: 'critical',
      loadPolicy: 'eager',
      estimate: { cpuBytes: 1_000, gpuBytes: 1_000, drawCalls: 1, features: 0 },
    });
    runtime.setActive(true);
    await runtime.reconcile();

    expect(runtime.getSnapshot().budget.resources[0]).toMatchObject({
      layerId: 'terrain',
      kind: 'terrain',
      priority: 'critical',
    });
  });
});
