import { describe, expect, it, vi } from 'vitest';

import {
  ModernGisViewOrchestrationRuntime,
  deriveGisViewOrchestrationBudget,
  type GisViewOrchestrationEvent,
} from './modernGisViewOrchestrationRuntime';
import type { GisRenderBudget, GisViewSnapshot } from './runtimeContracts';
import type { LayerViewResource } from './layerViewLifecycleCoordinator';
import type { SceneLodResource } from './sceneLodBudgetCoordinator';
import type { UnifiedViewState } from './viewStateTransitionCoordinator';

const renderBudget = (
  overrides: Partial<GisRenderBudget> = {},
): GisRenderBudget => ({
  tier: 'balanced',
  maxVisibleFeatures: 100_000,
  maxPointSymbols: 25_000,
  maxLabels: 8_000,
  maxSceneNodes: 64_000,
  maxResidentBytes: 512 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxConcurrentLayerLoads: 4,
  sceneQuality: 0.7,
  labelDensity: 0.7,
  enableShadows: true,
  enableExtrusion: true,
  allowPrefetch: true,
  geometryDetail: 0.7,
  framePressure: 'none',
  memoryPressure: 'low',
  ...overrides,
});

const view = (
  kind: '2d' | '3d' = '3d',
  scale = 25_000,
  overrides: Partial<GisViewSnapshot> = {},
): GisViewSnapshot => ({
  kind,
  scale,
  stationary: true,
  interacting: false,
  width: 1440,
  height: 900,
  devicePixelRatio: 1,
  ...overrides,
});

const sceneResource = (
  id: string,
  overrides: Partial<SceneLodResource> = {},
): SceneLodResource => ({
  id,
  kind: 'scene',
  visible: true,
  priority: 10,
  levels: [
    {
      id: 'high',
      minScale: 100_000,
      maxScale: 0,
      estimatedGpuBytes: 64 * 1024 * 1024,
      estimatedCpuBytes: 16 * 1024 * 1024,
      estimatedDrawCalls: 250,
      estimatedFeatures: 25_000,
      quality: 1,
    },
    {
      id: 'low',
      minScale: 100_000,
      maxScale: 0,
      estimatedGpuBytes: 8 * 1024 * 1024,
      estimatedCpuBytes: 4 * 1024 * 1024,
      estimatedDrawCalls: 50,
      estimatedFeatures: 5_000,
      quality: 0.4,
    },
  ],
  ...overrides,
});

const twoDState = (x: number, scale = 10_000): UnifiedViewState => ({
  mode: '2d',
  center: {
    x,
    y: 39.93,
    spatialReference: { wkid: 4326 },
  },
  scale,
  rotation: 0,
});

const threeDState = (x: number, scale = 10_000): UnifiedViewState => ({
  mode: '3d',
  camera: {
    position: {
      x,
      y: 39.93,
      z: 1500,
      spatialReference: { wkid: 4326 },
    },
    heading: 20,
    tilt: 60,
  },
  scale,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('deriveGisViewOrchestrationBudget', () => {
  it('derives bounded layer-view and scene budgets from the shared render budget', () => {
    const derived = deriveGisViewOrchestrationBudget(renderBudget());

    expect(derived.layerViews).toEqual({
      maxEntries: 128,
      maxConcurrentLoads: 4,
      maxReadyResources: 32,
    });
    expect(derived.sceneLod.maxGpuBytes).toBe(Math.floor(512 * 1024 * 1024 * 0.45));
    expect(derived.sceneLod.maxCpuBytes).toBe(Math.floor(512 * 1024 * 1024 * 0.30));
    expect(derived.sceneLod.maxFeatures).toBe(100_000);
    expect(derived.sceneLod.maxResources).toBe(96);
    expect(derived.sceneLod.maxDrawCalls).toBe(2000);
  });

  it('clamps extreme layer concurrency into a bounded hard limit', () => {
    const tiny = deriveGisViewOrchestrationBudget(renderBudget({ maxConcurrentLayerLoads: 0 }));
    const huge = deriveGisViewOrchestrationBudget(renderBudget({ maxConcurrentLayerLoads: 10_000 }));

    expect(tiny.layerViews.maxConcurrentLoads).toBe(1);
    expect(huge.layerViews.maxConcurrentLoads).toBe(12);
    expect(huge.layerViews.maxReadyResources).toBe(96);
    expect(huge.layerViews.maxEntries).toBe(384);
  });
});

describe('ModernGisViewOrchestrationRuntime', () => {
  it('uses the initial view scale for Scene LOD planning', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget(),
      initialView: view('3d', 50_000),
    });
    runtime.registerSceneLodResource(sceneResource('buildings'));

    expect(runtime.planSceneLod().scale).toBe(50_000);
    expect(runtime.snapshot().currentView?.kind).toBe('3d');
  });

  it('updates Scene LOD scale whenever the shared kernel view changes', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.registerSceneLodResource(sceneResource('buildings'));

    runtime.updateView(view('3d', 2_500));

    expect(runtime.planSceneLod().scale).toBe(2_500);
    expect(runtime.snapshot().metrics.viewUpdates).toBe(1);
  });

  it('preserves registered Scene LOD resources when render budgets are rebuilt', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.registerSceneLodResource(sceneResource('buildings'));
    const before = runtime.planSceneLod();

    runtime.updateRenderBudget(renderBudget({
      maxResidentBytes: 64 * 1024 * 1024,
      maxVisibleFeatures: 10_000,
      maxSceneNodes: 8_000,
    }), 'memory-pressure');
    const after = runtime.planSceneLod();

    expect(before.decisions.map((entry) => entry.resourceId)).toEqual(['buildings']);
    expect(after.decisions.map((entry) => entry.resourceId)).toEqual(['buildings']);
    expect(runtime.snapshot().metrics.budgetUpdates).toBe(1);
    expect(runtime.snapshot().budget.sceneLod.maxGpuBytes).toBeLessThan(before.usage.gpuBytes * 4);
  });

  it('degrades to a lower LOD level when the high-quality level no longer fits', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget({ maxResidentBytes: 40 * 1024 * 1024 }),
      initialView: view('3d', 20_000),
    });
    runtime.registerSceneLodResource(sceneResource('buildings'));

    const plan = runtime.planSceneLod();

    expect(plan.decisions[0]).toMatchObject({
      resourceId: 'buildings',
      admitted: true,
      levelId: 'low',
    });
  });

  it('removes Scene LOD resources from both catalog and planner', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.registerSceneLodResource(sceneResource('a'));
    runtime.registerSceneLodResource(sceneResource('b'));

    expect(runtime.removeSceneLodResource('a')).toBe(true);
    expect(runtime.removeSceneLodResource('a')).toBe(false);
    expect(runtime.planSceneLod().decisions.map((entry) => entry.resourceId)).toEqual(['b']);
    expect(runtime.diagnostics().registeredSceneLodResources).toBe(1);
  });

  it('deduplicates concurrent layer-view ensure calls through the shared lifecycle coordinator', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    const pending = deferred<LayerViewResource>();
    const load = vi.fn(async () => pending.promise);
    runtime.registerLayerView({
      key: { layerId: 'roads', mode: '2d' },
      priority: 'high',
      load,
    });

    const first = runtime.ensureLayerView({ layerId: 'roads', mode: '2d' });
    const second = runtime.ensureLayerView({ layerId: 'roads', mode: '2d' });
    pending.resolve({ dispose: vi.fn() });

    await expect(first).resolves.toMatchObject({ phase: 'ready' });
    await expect(second).resolves.toMatchObject({ phase: 'ready' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().layerViews.readyResources).toBe(1);
  });

  it('suspends and resumes a ready layer-view resource without reloading it', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    const suspend = vi.fn();
    const resume = vi.fn();
    const load = vi.fn(async (): Promise<LayerViewResource> => ({
      dispose: vi.fn(),
      suspend,
      resume,
    }));
    runtime.registerLayerView({
      key: { layerId: 'parcels', mode: '3d' },
      priority: 'normal',
      load,
    });

    await runtime.ensureLayerView({ layerId: 'parcels', mode: '3d' });
    await runtime.suspendLayerView({ layerId: 'parcels', mode: '3d' });
    await runtime.ensureLayerView({ layerId: 'parcels', mode: '3d' });

    expect(load).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().metrics.layerViewSuspensions).toBe(1);
  });

  it('disposes a layer-view resource when it is removed', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    const dispose = vi.fn();
    runtime.registerLayerView({
      key: { layerId: 'addresses', mode: '2d' },
      priority: 'normal',
      load: async () => ({ dispose }),
    });
    await runtime.ensureLayerView({ layerId: 'addresses', mode: '2d' });

    await expect(runtime.removeLayerView({ layerId: 'addresses', mode: '2d' })).resolves.toBe(true);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().layerViews.entries).toHaveLength(0);
  });

  it('bounds ready layer views and evicts lower-priority resources first', async () => {
    const disposed: string[] = [];
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget(),
      layerViews: {
        maxEntries: 4,
        maxConcurrentLoads: 2,
        maxReadyResources: 1,
      },
    });
    runtime.registerLayerView({
      key: { layerId: 'low', mode: '3d' },
      priority: 'low',
      load: async () => ({ dispose: () => { disposed.push('low'); } }),
    });
    runtime.registerLayerView({
      key: { layerId: 'critical', mode: '3d' },
      priority: 'critical',
      load: async () => ({ dispose: () => { disposed.push('critical'); } }),
    });

    await runtime.ensureLayerView({ layerId: 'low', mode: '3d' });
    await runtime.ensureLayerView({ layerId: 'critical', mode: '3d' });

    expect(disposed).toEqual(['low']);
    expect(runtime.snapshot().layerViews.readyResources).toBe(1);
    expect(runtime.snapshot().layerViews.entries.find((entry) => entry.key.layerId === 'critical')).toMatchObject({
      phase: 'ready',
    });
  });

  it('derives section pressure from render frame/memory pressure by default', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget({ memoryPressure: 'critical' }),
      sections: { maxActivePlanes: 8 },
    });
    runtime.upsertSceneSection({
      id: 'essential',
      essential: true,
      planes: [{
        id: 'e',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
      }],
    });
    runtime.upsertSceneSection({
      id: 'secondary',
      planes: [{
        id: 's',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      }],
    });

    const plan = runtime.planSceneSections();

    expect(plan.pressure).toBe('critical');
    expect(plan.decisions.find((entry) => entry.sectionId === 'essential')?.admitted).toBe(true);
    expect(plan.decisions.find((entry) => entry.sectionId === 'secondary')).toMatchObject({
      admitted: false,
      reason: 'pressure',
    });
  });

  it('allows an explicit section pressure override for deterministic tooling and tests', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget({ framePressure: 'critical' }),
    });
    runtime.upsertSceneSection({
      id: 'section',
      planes: [{
        id: 'plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
      }],
    });

    expect(runtime.planSceneSections({ pressure: 'normal' }).pressure).toBe('normal');
  });

  it('seeds and completes cross-mode view transitions', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.seedViewTransition(twoDState(32.8));

    const target = threeDState(32.9);
    const result = await runtime.transitionView({ target, intent: 'user' }, async (context) => {
      expect(context.from?.mode).toBe('2d');
      expect(context.target.mode).toBe('3d');
      return context.target;
    });

    expect(result).toMatchObject({ stale: false, state: { mode: '3d' } });
    expect(runtime.snapshot().transitions.historySize).toBe(2);
    expect(runtime.snapshot().metrics.transitions).toBe(1);
  });

  it('supports deterministic back and forward history after completed transitions', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.seedViewTransition(twoDState(1));
    await runtime.transitionView({ target: twoDState(2) }, async ({ target }) => target);
    await runtime.transitionView({ target: threeDState(3) }, async ({ target }) => target);

    expect(runtime.viewHistoryBack()).toMatchObject({ mode: '2d', center: { x: 2 } });
    expect(runtime.viewHistoryBack()).toMatchObject({ mode: '2d', center: { x: 1 } });
    expect(runtime.viewHistoryForward()).toMatchObject({ mode: '2d', center: { x: 2 } });
    expect(runtime.snapshot().metrics.historyNavigations).toBe(3);
  });

  it('marks superseded transition completions stale instead of committing them', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.seedViewTransition(twoDState(1));
    const firstDeferred = deferred<UnifiedViewState>();
    const first = runtime.transitionView({ target: threeDState(2) }, async () => firstDeferred.promise);
    const second = runtime.transitionView({ target: twoDState(3) }, async ({ target }) => target);

    await expect(second).resolves.toMatchObject({ stale: false, state: { mode: '2d' } });
    firstDeferred.resolve(threeDState(2));
    await expect(first).resolves.toMatchObject({ stale: true });
    expect(runtime.snapshot().transitions.staleCompletions).toBe(1);
  });

  it('passes reduced-motion requests through the transition coordinator', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.seedViewTransition(twoDState(1));
    let duration = -1;

    await runtime.transitionView({
      target: threeDState(2),
      durationMs: 900,
      reducedMotion: true,
    }, async (context) => {
      duration = context.durationMs;
      return context.target;
    });

    expect(duration).toBe(0);
  });

  it('emits bounded immutable events using the shared clock', () => {
    const events: GisViewOrchestrationEvent[] = [];
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget(),
      now: () => 1234,
      onEvent: (event) => events.push(event),
    });

    runtime.updateView(view('2d', 12_500));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'view-updated',
      timestamp: 1234,
      mode: '2d',
    });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.fields)).toBe(true);
  });

  it('isolates event listener failures from runtime behavior', () => {
    const onListenerError = vi.fn();
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: renderBudget(),
      onEvent: () => { throw new Error('listener failed'); },
      onListenerError,
    });

    expect(() => runtime.updateView(view('3d', 8_000))).not.toThrow();
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().metrics.listenerErrors).toBe(1);
  });

  it('returns a combined diagnostics snapshot without exposing mutable catalogs', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.registerSceneLodResource(sceneResource('buildings'));

    const diagnostics = runtime.diagnostics();

    expect(diagnostics).toMatchObject({
      disposed: false,
      registeredSceneLodResources: 1,
      layerViews: expect.any(Object),
      sceneLod: expect.any(Object),
      sceneSections: expect.any(Object),
      transitions: expect.any(Object),
      metrics: expect.any(Object),
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('disposes all owned view resources and fails closed afterward', async () => {
    const disposeLayerView = vi.fn();
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: renderBudget() });
    runtime.registerLayerView({
      key: { layerId: 'owned', mode: '2d' },
      priority: 'normal',
      load: async () => ({ dispose: disposeLayerView }),
    });
    await runtime.ensureLayerView({ layerId: 'owned', mode: '2d' });
    runtime.registerSceneLodResource(sceneResource('buildings'));
    runtime.upsertSceneSection({
      id: 'section',
      planes: [{
        id: 'plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
      }],
    });

    await runtime.dispose();
    await runtime.dispose();

    expect(disposeLayerView).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({
      disposed: true,
      layerViews: { entries: [] },
      sceneSections: { disposed: true },
    });
    expect(() => runtime.updateView(view())).toThrow(/disposed/i);
    expect(() => runtime.registerSceneLodResource(sceneResource('late'))).toThrow(/disposed/i);
  });
});
