import { describe, expect, it, vi } from 'vitest';

import {
  bindArcgisLayerViewLifecycle,
  createArcgisLayerViewRegistration,
  type ArcgisLayerViewLike,
} from './arcgisLayerViewLifecycleAdapter';
import { ModernGisViewOrchestrationRuntime } from './modernGisViewOrchestrationRuntime';
import type { GisRenderBudget } from './runtimeContracts';

const budget = (): GisRenderBudget => ({
  tier: 'balanced',
  maxVisibleFeatures: 50_000,
  maxPointSymbols: 20_000,
  maxLabels: 5_000,
  maxSceneNodes: 20_000,
  maxResidentBytes: 256 * 1024 * 1024,
  maxConcurrentRequests: 6,
  maxConcurrentLayerLoads: 3,
  sceneQuality: 0.7,
  labelDensity: 0.7,
  enableShadows: true,
  enableExtrusion: true,
  allowPrefetch: true,
  geometryDetail: 0.7,
  framePressure: 'none',
  memoryPressure: 'low',
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

describe('arcgisLayerViewLifecycleAdapter', () => {
  it('validates required layer ids, layers and whenLayerView support', () => {
    expect(() => createArcgisLayerViewRegistration({
      layerId: '   ',
      mode: '2d',
      view: { whenLayerView: async () => ({}) },
      layer: {},
    })).toThrow(/layerId/i);

    expect(() => createArcgisLayerViewRegistration({
      layerId: 'roads',
      mode: '2d',
      view: {} as never,
      layer: {},
    })).toThrow(/whenLayerView/i);

    expect(() => createArcgisLayerViewRegistration({
      layerId: 'roads',
      mode: '2d',
      view: { whenLayerView: async () => ({}) },
      layer: null,
    })).toThrow(/layer is required/i);
  });

  it('normalizes the registration and preserves mode and priority', () => {
    const layer = {};
    const registration = createArcgisLayerViewRegistration({
      layerId: ' roads ',
      mode: '3d',
      priority: 'critical',
      view: { whenLayerView: async () => ({}) },
      layer,
    });

    expect(registration.key).toEqual({ layerId: 'roads', mode: '3d' });
    expect(registration.priority).toBe('critical');
    expect(Object.isFrozen(registration)).toBe(true);
  });

  it('loads the ArcGIS layer view exactly once through orchestration dedupe', async () => {
    const layerView: ArcgisLayerViewLike = {};
    const whenLayerView = vi.fn(async () => layerView);
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'roads',
      mode: '2d',
      view: { whenLayerView },
      layer: { id: 'roads' },
    });
    binding.register(runtime);

    const first = binding.ensure(runtime);
    const second = binding.ensure(runtime);
    await Promise.all([first, second]);

    expect(whenLayerView).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().layerViews.readyResources).toBe(1);
  });

  it('maps suspend and resume to the ArcGIS LayerView suspended flag', async () => {
    const layerView: ArcgisLayerViewLike = { suspended: false };
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'parcels',
      mode: '3d',
      view: { whenLayerView: async () => layerView },
      layer: {},
    });
    binding.register(runtime);

    await binding.ensure(runtime);
    await binding.suspend(runtime);
    expect(layerView.suspended).toBe(true);
    await binding.ensure(runtime);
    expect(layerView.suspended).toBe(false);
  });

  it('invokes optional suspend and resume hooks after changing ArcGIS state', async () => {
    const layerView: ArcgisLayerViewLike = { suspended: false };
    const onSuspend = vi.fn((value: ArcgisLayerViewLike) => {
      expect(value.suspended).toBe(true);
    });
    const onResume = vi.fn((value: ArcgisLayerViewLike) => {
      expect(value.suspended).toBe(false);
    });
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'buildings',
      mode: '3d',
      view: { whenLayerView: async () => layerView },
      layer: {},
      onSuspend,
      onResume,
    });
    binding.register(runtime);

    await binding.ensure(runtime);
    await binding.suspend(runtime);
    await binding.ensure(runtime);

    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not destroy ArcGIS-managed LayerView objects by default', async () => {
    const destroy = vi.fn();
    const release = vi.fn();
    const layerView: ArcgisLayerViewLike = { destroy };
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'managed',
      mode: '2d',
      view: { whenLayerView: async () => layerView },
      layer: {},
      release,
    });
    binding.register(runtime);
    await binding.ensure(runtime);

    await binding.remove(runtime);

    expect(layerView.suspended).toBe(true);
    expect(release).toHaveBeenCalledWith(layerView);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('supports explicit LayerView destruction only when ownership is opted in', async () => {
    const destroy = vi.fn();
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'owned',
      mode: '3d',
      view: { whenLayerView: async () => ({ destroy }) },
      layer: {},
      destroyLayerViewOnDispose: true,
    });
    binding.register(runtime);
    await binding.ensure(runtime);

    await binding.remove(runtime);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('awaits asynchronous release before optional destroy', async () => {
    const order: string[] = [];
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'async-release',
      mode: '3d',
      view: {
        whenLayerView: async () => ({
          destroy: () => { order.push('destroy'); },
        }),
      },
      layer: {},
      destroyLayerViewOnDispose: true,
      release: async () => {
        await Promise.resolve();
        order.push('release');
      },
    });
    binding.register(runtime);
    await binding.ensure(runtime);

    await binding.remove(runtime);

    expect(order).toEqual(['release', 'destroy']);
  });

  it('rejects an ensure when the runtime removes a still-pending ArcGIS layer view', async () => {
    const pending = deferred<ArcgisLayerViewLike>();
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'pending',
      mode: '2d',
      view: { whenLayerView: () => pending.promise },
      layer: {},
    });
    binding.register(runtime);

    const ensure = binding.ensure(runtime);
    await Promise.resolve();
    await binding.remove(runtime);

    await expect(ensure).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({});
  });

  it('rejects pending loads when the parent orchestration runtime is disposed', async () => {
    const pending = deferred<ArcgisLayerViewLike>();
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'dispose-pending',
      mode: '3d',
      view: { whenLayerView: () => pending.promise },
      layer: {},
    });
    binding.register(runtime);

    const ensure = binding.ensure(runtime);
    await Promise.resolve();
    await runtime.dispose();

    await expect(ensure).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({});
  });

  it('keeps bindings isolated across independent orchestration instances', async () => {
    const first = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const second = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const binding = bindArcgisLayerViewLifecycle({
      layerId: 'shared-id',
      mode: '2d',
      view: { whenLayerView: async () => ({}) },
      layer: {},
    });

    binding.register(first);
    binding.register(second);
    await binding.ensure(first);

    expect(first.snapshot().layerViews.readyResources).toBe(1);
    expect(second.snapshot().layerViews.readyResources).toBe(0);
  });
});
