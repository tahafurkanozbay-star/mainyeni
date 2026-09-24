import { describe, expect, it, vi } from 'vitest';

import { ModernGisViewOrchestrationRuntime } from './modernGisViewOrchestrationRuntime';
import { SceneSectionRuntime } from './sceneSectionRuntime';
import type { GisRenderBudget } from './runtimeContracts';
import type { LayerViewResource } from './layerViewLifecycleCoordinator';
import type { SceneLodResource } from './sceneLodBudgetCoordinator';
import type { UnifiedViewState } from './viewStateTransitionCoordinator';

const budget = (
  overrides: Partial<GisRenderBudget> = {},
): GisRenderBudget => ({
  tier: 'balanced',
  maxVisibleFeatures: 80_000,
  maxPointSymbols: 20_000,
  maxLabels: 6_000,
  maxSceneNodes: 32_000,
  maxResidentBytes: 256 * 1024 * 1024,
  maxConcurrentRequests: 6,
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

const resource = (index: number): SceneLodResource => ({
  id: `resource-${String(index).padStart(3, '0')}`,
  kind: index % 2 === 0 ? 'scene' : 'mesh',
  visible: true,
  priority: index % 7,
  levels: [
    {
      id: 'high',
      minScale: 250_000,
      maxScale: 0,
      estimatedGpuBytes: 2 * 1024 * 1024 + (index % 5) * 256 * 1024,
      estimatedCpuBytes: 512 * 1024 + (index % 3) * 128 * 1024,
      estimatedDrawCalls: 10 + (index % 5),
      estimatedFeatures: 500 + (index % 10) * 50,
      quality: 1,
    },
    {
      id: 'low',
      minScale: 250_000,
      maxScale: 0,
      estimatedGpuBytes: 256 * 1024,
      estimatedCpuBytes: 128 * 1024,
      estimatedDrawCalls: 2,
      estimatedFeatures: 100,
      quality: 0.35,
    },
  ],
});

const state2d = (index: number): UnifiedViewState => ({
  mode: '2d',
  center: {
    x: 32 + index / 1000,
    y: 39.9,
    spatialReference: { wkid: 4326 },
  },
  scale: 10_000 + index,
  rotation: index % 360,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe('ModernGisViewOrchestrationRuntime stress invariants', () => {
  it('produces deterministic Scene LOD admission independent of registration order', () => {
    const first = new ModernGisViewOrchestrationRuntime({
      budget: budget({ maxResidentBytes: 64 * 1024 * 1024 }),
      initialView: { kind: '3d', scale: 20_000 },
    });
    const second = new ModernGisViewOrchestrationRuntime({
      budget: budget({ maxResidentBytes: 64 * 1024 * 1024 }),
      initialView: { kind: '3d', scale: 20_000 },
    });
    const resources = Array.from({ length: 80 }, (_, index) => resource(index));
    for (const entry of resources) first.registerSceneLodResource(entry);
    for (const entry of [...resources].reverse()) second.registerSceneLodResource(entry);

    const firstPlan = first.planSceneLod();
    const secondPlan = second.planSceneLod();
    const summarize = (plan: typeof firstPlan) => plan.decisions
      .map((entry) => `${entry.resourceId}:${entry.admitted ? entry.levelId : entry.reason}`)
      .sort();

    expect(summarize(firstPlan)).toEqual(summarize(secondPlan));
    expect(firstPlan.usage.gpuBytes).toBeLessThanOrEqual(first.snapshot().budget.sceneLod.maxGpuBytes);
    expect(firstPlan.usage.cpuBytes).toBeLessThanOrEqual(first.snapshot().budget.sceneLod.maxCpuBytes);
    expect(firstPlan.usage.drawCalls).toBeLessThanOrEqual(first.snapshot().budget.sceneLod.maxDrawCalls);
    expect(firstPlan.usage.features).toBeLessThanOrEqual(first.snapshot().budget.sceneLod.maxFeatures);
  });

  it('survives repeated render-budget changes without losing Scene LOD registrations', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    for (let index = 0; index < 50; index += 1) runtime.registerSceneLodResource(resource(index));

    for (let iteration = 0; iteration < 30; iteration += 1) {
      runtime.updateRenderBudget(budget({
        tier: iteration % 2 === 0 ? 'economy' : 'quality',
        maxResidentBytes: (64 + (iteration % 5) * 32) * 1024 * 1024,
        maxVisibleFeatures: 20_000 + iteration * 1000,
        framePressure: iteration % 3 === 0 ? 'high' : 'none',
      }), `iteration-${iteration}`);
      runtime.updateView({ kind: '3d', scale: 5_000 + iteration * 100 });
      expect(runtime.planSceneLod().decisions).toHaveLength(50);
    }

    expect(runtime.diagnostics().registeredSceneLodResources).toBe(50);
    expect(runtime.snapshot().metrics.budgetUpdates).toBe(30);
  });

  it('keeps transition history bounded during long navigation sessions', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: budget(),
      transitions: { maxHistory: 16 },
    });
    runtime.seedViewTransition(state2d(0));

    for (let index = 1; index <= 100; index += 1) {
      await runtime.transitionView({ target: state2d(index), durationMs: 0 }, async ({ target }) => target);
    }

    expect(runtime.snapshot().transitions.historySize).toBe(16);
    expect(runtime.snapshot().transitions.historyIndex).toBe(15);
    expect(runtime.snapshot().metrics.transitions).toBe(100);
  });

  it('maintains deterministic section survivors across reverse insertion order', () => {
    const build = (reverse: boolean): SceneSectionRuntime => {
      const runtime = new SceneSectionRuntime({
        maxSections: 64,
        maxActivePlanes: 12,
      });
      const indexes = Array.from({ length: 32 }, (_, index) => index);
      if (reverse) indexes.reverse();
      for (const index of indexes) {
        runtime.upsert({
          id: `section-${String(index).padStart(2, '0')}`,
          priority: index % 5,
          essential: index % 13 === 0,
          planes: [{
            id: `plane-${index}`,
            origin: { x: index, y: 0, z: 0 },
            normal: { x: 1, y: index % 2, z: 0 },
          }],
        });
      }
      return runtime;
    };
    const first = build(false).plan({ pressure: 'elevated' });
    const second = build(true).plan({ pressure: 'elevated' });

    const admitted = (plan: typeof first) => plan.decisions
      .filter((entry) => entry.admitted)
      .map((entry) => entry.sectionId)
      .sort();
    expect(admitted(first)).toEqual(admitted(second));
    expect(first.admittedPlanes).toBeLessThanOrEqual(9);
    expect(second.admittedPlanes).toBeLessThanOrEqual(9);
  });

  it('keeps critical-pressure section plans focused on essential sections', () => {
    const runtime = new SceneSectionRuntime({ maxSections: 64, maxActivePlanes: 16 });
    for (let index = 0; index < 24; index += 1) {
      runtime.upsert({
        id: `section-${index}`,
        priority: index,
        essential: index === 0 || index === 12,
        planes: [{
          id: `plane-${index}`,
          origin: { x: index, y: index, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
        }],
      });
    }

    const plan = runtime.plan({ pressure: 'critical' });

    expect(plan.activePlanes.every((entry) => ['section-0', 'section-12'].includes(entry.sectionId))).toBe(true);
    expect(plan.admittedPlanes).toBeLessThanOrEqual(8);
  });

  it('enforces layer-view registry capacity under descriptor churn', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: budget(),
      layerViews: {
        maxEntries: 16,
        maxConcurrentLoads: 2,
        maxReadyResources: 4,
      },
    });
    for (let index = 0; index < 16; index += 1) {
      runtime.registerLayerView({
        key: { layerId: `layer-${index}`, mode: index % 2 === 0 ? '2d' : '3d' },
        priority: 'normal',
        load: async (): Promise<LayerViewResource> => ({ dispose: vi.fn() }),
      });
    }

    expect(() => runtime.registerLayerView({
      key: { layerId: 'overflow', mode: '2d' },
      priority: 'normal',
      load: async () => ({ dispose: vi.fn() }),
    })).toThrow(/capacity/i);
    expect(runtime.snapshot().layerViews.entries).toHaveLength(16);
  });

  it('never exceeds configured concurrent layer-view loads', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: budget(),
      layerViews: {
        maxEntries: 12,
        maxConcurrentLoads: 2,
        maxReadyResources: 12,
      },
    });
    const gates = Array.from({ length: 6 }, () => deferred<LayerViewResource>());
    let active = 0;
    let peak = 0;
    for (let index = 0; index < gates.length; index += 1) {
      runtime.registerLayerView({
        key: { layerId: `layer-${index}`, mode: '3d' },
        priority: 'normal',
        load: async () => {
          active += 1;
          peak = Math.max(peak, active);
          const value = await gates[index]!.promise;
          active -= 1;
          return value;
        },
      });
    }

    const ensures = gates.map((_, index) => runtime.ensureLayerView({ layerId: `layer-${index}`, mode: '3d' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    for (const gate of gates) {
      gate.resolve({ dispose: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(ensures);

    expect(peak).toBe(2);
    expect(runtime.snapshot().layerViews.readyResources).toBe(6);
  });

  it('isolates a large number of observer failures without corrupting runtime state', () => {
    const listenerError = vi.fn();
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: budget(),
      onEvent: () => { throw new Error('observer'); },
      onListenerError: listenerError,
    });

    for (let index = 0; index < 100; index += 1) {
      runtime.updateView({ kind: index % 2 === 0 ? '2d' : '3d', scale: 1000 + index });
    }

    expect(runtime.snapshot().metrics.listenerErrors).toBe(100);
    expect(listenerError).toHaveBeenCalledTimes(100);
    expect(runtime.snapshot().currentView?.scale).toBe(1099);
  });

  it('disposes many ready layer-view resources exactly once', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({
      budget: budget(),
      layerViews: {
        maxEntries: 32,
        maxConcurrentLoads: 8,
        maxReadyResources: 32,
      },
    });
    const disposers = Array.from({ length: 24 }, () => vi.fn());
    for (let index = 0; index < disposers.length; index += 1) {
      runtime.registerLayerView({
        key: { layerId: `owned-${index}`, mode: '2d' },
        priority: 'normal',
        load: async () => ({ dispose: disposers[index]! }),
      });
    }
    await Promise.all(disposers.map((_, index) => runtime.ensureLayerView({ layerId: `owned-${index}`, mode: '2d' })));

    await runtime.dispose();
    await runtime.dispose();

    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(runtime.snapshot().layerViews.entries).toHaveLength(0);
  });
});
