import { describe, expect, it, vi } from 'vitest';
import {
  createArcgisEsmLifecycleRuntime,
  type ArcgisEsmLifecycleConfiguration,
} from './arcgisEsmLifecycleRuntime';

const configuration: ArcgisEsmLifecycleConfiguration = {
  bundleBudget: {
    maxModules: 24,
    maxRelativeWeight: 80,
  },
  governor: {
    maxConcurrent: 2,
    maxQueued: 8,
    maxHistory: 8,
    maxBatchModules: 24,
    defaultTimeoutMs: 0,
  },
  maxEvents: 8,
};

describe('arcgisEsmLifecycleRuntime', () => {
  it('starts only when the static ESM importer registry fully covers the catalog', () => {
    const runtime = createArcgisEsmLifecycleRuntime(
      configuration,
      async (moduleIds) => moduleIds,
    );
    expect(runtime.auditStaticCoverage().valid).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      disposed: false,
      coverageValid: true,
      loadedSpecifiers: 0,
    });
  });

  it('plans and loads feature bundles through one bounded governor request', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => (
      moduleIds.map((moduleId) => ({ moduleId }))
    ));
    const runtime = createArcgisEsmLifecycleRuntime(configuration, loader);

    const result = await runtime.ensureFeatures([
      'map-2d',
      'reactive-view',
      'query',
      'identify',
    ], { requireComplete: true, priority: 'critical' });

    expect(result.plan.complete).toBe(true);
    expect(result.modules.map((item) => item.moduleId)).toEqual(result.plan.moduleIds);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({
      featureRequests: 1,
      failedRequests: 0,
      incompletePlans: 0,
    });
    expect(runtime.snapshot().loadedSpecifiers).toBe(result.plan.specifiers.length);
  });

  it('fails before loading when a caller requires a complete plan that exceeds budget', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const runtime = createArcgisEsmLifecycleRuntime({
      ...configuration,
      bundleBudget: { maxModules: 5, maxRelativeWeight: 20 },
    }, loader);

    await expect(runtime.ensureFeatures([
      'map-2d',
      'measurement',
    ], { requireComplete: true })).rejects.toMatchObject({
      code: 'BUNDLE_BUDGET_EXCEEDED',
    });
    expect(loader).not.toHaveBeenCalled();
    expect(runtime.snapshot().incompletePlans).toBe(1);
    expect(runtime.listEvents().some((event) => event.kind === 'bundle-deferred')).toBe(true);
  });

  it('allows partial bounded plans when completeness is not required', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const runtime = createArcgisEsmLifecycleRuntime({
      ...configuration,
      bundleBudget: { maxModules: 5, maxRelativeWeight: 20 },
    }, loader);

    const result = await runtime.ensureFeatures(['map-2d', 'measurement']);
    expect(result.plan.complete).toBe(false);
    expect(result.plan.acceptedFeatures).toEqual(['map-2d']);
    expect(result.plan.deferredFeatures).toEqual(['measurement']);
    expect(loader).toHaveBeenCalledWith(result.plan.moduleIds, expect.any(AbortSignal));
  });

  it('prewarms a runtime profile using the same catalog and local load policy', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const runtime = createArcgisEsmLifecycleRuntime(configuration, loader);
    const result = await runtime.prewarmProfile({
      view: 'hybrid',
      query: true,
      featureLayer: true,
      sceneLayer: true,
    });

    expect(result.plan.acceptedFeatures).toContain('map-2d');
    expect(result.plan.acceptedFeatures).toContain('map-3d');
    expect(result.modules.some((item) => item.specifier.endsWith('/SceneView.js'))).toBe(true);
    expect(runtime.snapshot().governor.completed).toBe(1);
  });

  it('deduplicates direct modern and compatibility ids at the ESM specifier boundary', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const runtime = createArcgisEsmLifecycleRuntime(configuration, loader);

    const modules = await runtime.ensureModuleIds([
      'esri/tasks/QueryTask',
      'esri/rest/query',
      'esri/core/watchUtils',
      'esri/core/reactiveUtils',
    ]);

    expect(modules.map((item) => item.moduleId)).toEqual([
      'esri/tasks/QueryTask',
      'esri/core/watchUtils',
    ]);
    expect(modules.map((item) => item.specifier)).toEqual([
      '@arcgis/core/rest/query.js',
      '@arcgis/core/core/reactiveUtils.js',
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('enforces direct module-count and relative-weight budgets', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const moduleLimited = createArcgisEsmLifecycleRuntime({
      ...configuration,
      bundleBudget: { maxModules: 1, maxRelativeWeight: 100 },
    }, loader);
    await expect(moduleLimited.ensureModuleIds([
      'esri/Map',
      'esri/views/MapView',
    ])).rejects.toMatchObject({ code: 'DIRECT_MODULE_BUDGET_EXCEEDED' });

    const weightLimited = createArcgisEsmLifecycleRuntime({
      ...configuration,
      bundleBudget: { maxModules: 10, maxRelativeWeight: 2 },
    }, loader);
    await expect(weightLimited.ensureModuleIds(['esri/views/SceneView']))
      .rejects.toMatchObject({ code: 'DIRECT_WEIGHT_BUDGET_EXCEEDED' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('propagates cancellation to governed feature loading', async () => {
    let signalSeen: AbortSignal | undefined;
    const loader = vi.fn(async (_moduleIds: readonly string[], signal: AbortSignal) => {
      signalSeen = signal;
      return new Promise<readonly unknown[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const runtime = createArcgisEsmLifecycleRuntime(configuration, loader);
    const controller = new AbortController();

    const result = runtime.ensureFeatures(['map-3d'], { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('navigation left 3d mode'));
    await expect(result).rejects.toThrow('navigation left 3d mode');
    expect(signalSeen?.aborted).toBe(true);
    expect(runtime.snapshot().failedRequests).toBe(1);
  });

  it('bounds local diagnostics and rejects work after disposal', async () => {
    const runtime = createArcgisEsmLifecycleRuntime({
      ...configuration,
      maxEvents: 2,
    }, async (moduleIds) => moduleIds);

    await runtime.ensureModuleIds(['esri/Map']);
    await runtime.ensureModuleIds(['esri/Graphic']);
    await runtime.ensureModuleIds(['esri/core/reactiveUtils']);
    expect(runtime.listEvents()).toHaveLength(2);

    runtime.dispose();
    expect(runtime.snapshot().disposed).toBe(true);
    expect(runtime.listEvents()[0]?.kind).toBe('disposed');
    expect(() => runtime.ensureFeatures(['map-2d'])).toThrow(/disposed/);
  });

  it('rejects unsupported module ids before invoking the loader', async () => {
    const loader = vi.fn(async (moduleIds: readonly string[]) => moduleIds);
    const runtime = createArcgisEsmLifecycleRuntime(configuration, loader);
    await expect(runtime.ensureModuleIds(['dojo/Deferred'])).rejects.toThrow(/Unsupported ArcGIS module id/);
    expect(loader).not.toHaveBeenCalled();
  });
});
