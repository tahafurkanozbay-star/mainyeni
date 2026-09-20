import { describe, expect, it, vi } from 'vitest';
import {
  ViewportQueryOrchestrator,
  ViewportQueryResponseBudgetError,
  ViewportQueryStaleError,
  createViewportQueryOrchestrator,
  type ViewportLayerQueryResponse,
} from './viewportQueryOrchestrator';

type Feature = Readonly<{ id: number; label?: string }>;

const frame = (overrides: Partial<Parameters<ViewportQueryOrchestrator['setViewport']>[0]> = {}) => ({
  extent: {
    xmin: 0,
    ymin: 0,
    xmax: 1_000,
    ymax: 500,
    spatialReference: 'EPSG:3857',
  },
  scale: 10_000,
  pixelWidth: 1_000,
  pixelHeight: 500,
  viewMode: '2d' as const,
  moving: false,
  ...overrides,
});

const completeResponse = (
  features: readonly Feature[],
  overrides: Partial<ViewportLayerQueryResponse<Feature>> = {},
): ViewportLayerQueryResponse<Feature> => ({
  features,
  complete: true,
  exceededTransferLimit: false,
  estimatedBytes: features.length * 64,
  ...overrides,
});

const register = (
  runtime: ViewportQueryOrchestrator,
  execute: (plan: Parameters<Parameters<ViewportQueryOrchestrator['registerLayer']>[0]['execute']>[0], context: Parameters<Parameters<ViewportQueryOrchestrator['registerLayer']>[0]['execute']>[1]) => Promise<ViewportLayerQueryResponse<Feature>>,
  overrides: Partial<Parameters<ViewportQueryOrchestrator['registerLayer']>[0]> = {},
): void => runtime.registerLayer<Feature>({
  layerId: 'roads',
  execute,
  policy: {
    maxFeatures: 100,
    maxFields: 10,
    maxPixelArea: 2_000_000,
    maxExtentArea: 10_000_000,
  },
  defaultFields: ['OBJECTID', 'NAME'],
  estimatedBytesPerFeature: 128,
  maxResponseBytes: 1024 * 1024,
  ...overrides,
});

describe('ViewportQueryOrchestrator registration and view lifecycle', () => {
  it('requires a viewport before querying', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([]));

    await expect(runtime.queryLayer('roads')).rejects.toThrow(
      'viewport frame must be set before querying layers',
    );
  });

  it('normalizes equivalent frames without incrementing generation', () => {
    const runtime = createViewportQueryOrchestrator({ frameCoordinatePrecision: 3 });
    const first = runtime.setViewport(frame());
    const second = runtime.setViewport(frame({
      extent: {
        xmin: 0.0001,
        ymin: 0.0001,
        xmax: 1_000.0001,
        ymax: 500.0001,
        spatialReference: ' EPSG:3857 ',
      },
    }));

    expect(first.generation).toBe(1);
    expect(second).toBe(first);
    expect(runtime.snapshot().viewportChanges).toBe(1);
  });

  it('increments generation when meaningful viewport state changes', () => {
    const runtime = createViewportQueryOrchestrator();
    const first = runtime.setViewport(frame());
    const second = runtime.setViewport(frame({ scale: 20_000 }));

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('treats 2d and 3d frames as distinct generations', () => {
    const runtime = createViewportQueryOrchestrator();
    runtime.setViewport(frame({ viewMode: '2d' }));
    const scene = runtime.setViewport(frame({ viewMode: '3d' }));

    expect(scene.generation).toBe(2);
    expect(scene.viewMode).toBe('3d');
  });

  it('enforces layer registration cardinality', () => {
    const runtime = createViewportQueryOrchestrator({ maxLayers: 1 });
    register(runtime, async () => completeResponse([]));

    expect(() => runtime.registerLayer({
      layerId: 'buildings',
      execute: async () => completeResponse([]),
    })).toThrow('viewport query orchestrator exceeds layer budget');
  });

  it('rejects registration that cannot fit the governance byte budget', () => {
    const runtime = createViewportQueryOrchestrator({
      governance: {
        maxFeaturesPerRequest: 100,
        maxBytesPerRequest: 1_000,
      },
    });

    expect(() => runtime.registerLayer({
      layerId: 'heavy',
      execute: async () => completeResponse([]),
      policy: { maxFeatures: 100 },
      estimatedBytesPerFeature: 100,
      maxResponseBytes: 1_000,
    })).toThrow(
      'viewport layer maxFeatures and estimatedBytesPerFeature exceed governance byte budget',
    );
  });

  it('replaces a registration without consuming another layer slot', () => {
    const runtime = createViewportQueryOrchestrator({ maxLayers: 1 });
    register(runtime, async () => completeResponse([{ id: 1 }]));
    register(runtime, async () => completeResponse([{ id: 2 }]));

    expect(runtime.snapshot()).toMatchObject({
      registeredLayers: 1,
      registrations: 1,
    });
  });

  it('unregisters layers and reports missing removals deterministically', () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([]));

    expect(runtime.unregisterLayer('roads')).toBe(true);
    expect(runtime.unregisterLayer('roads')).toBe(false);
    expect(runtime.snapshot()).toMatchObject({
      registeredLayers: 0,
      unregistrations: 1,
    });
  });
});

describe('ViewportQueryOrchestrator query planning and execution', () => {
  it('passes a bounded deterministic plan to the layer executor', async () => {
    const execute = vi.fn(async (plan) => completeResponse([{ id: 1 }], {
      warnings: [plan.priority],
    }));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    const result = await runtime.queryLayer<Feature>('roads');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      layerId: 'roads',
      scale: 10_000,
      priority: 'foreground',
      maxFeatures: 100,
      fields: ['NAME', 'OBJECTID'],
      includeGeometry: true,
    });
    expect(result).toMatchObject({
      source: 'executor',
      generation: 1,
      complete: true,
      exceededTransferLimit: false,
    });
    expect(result.features).toEqual([{ id: 1 }]);
  });

  it('respects query-level field, geometry, and priority overrides', async () => {
    const execute = vi.fn(async () => completeResponse([]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    await runtime.queryLayer('roads', {
      requestedFields: ['TYPE'],
      includeGeometry: false,
      priority: 'interactive',
    });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      fields: ['TYPE'],
      includeGeometry: false,
      priority: 'interactive',
    });
  });

  it('deduplicates concurrent equal requests through governance', async () => {
    let resolve!: (value: ViewportLayerQueryResponse<Feature>) => void;
    const execute = vi.fn(() => new Promise<ViewportLayerQueryResponse<Feature>>(
      (resolvePromise) => {
        resolve = resolvePromise;
      },
    ));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    const first = runtime.queryLayer<Feature>('roads');
    const second = runtime.queryLayer<Feature>('roads');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolve(completeResponse([{ id: 1 }]));

    const [one, two] = await Promise.all([first, second]);
    expect(one.features).toEqual([{ id: 1 }]);
    expect(two.features).toEqual([{ id: 1 }]);
    expect(runtime.snapshot().governance.deduplicatedSubscribers).toBe(1);
  });

  it('cancels old-generation work when the viewport changes', async () => {
    let observedSignal: AbortSignal | null = null;
    const execute = vi.fn((_plan, context) => new Promise<ViewportLayerQueryResponse<Feature>>(
      (_resolve, reject) => {
        observedSignal = context.signal;
        context.signal.addEventListener('abort', () => reject(context.signal.reason), {
          once: true,
        });
      },
    ));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    const pending = runtime.queryLayer('roads');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    runtime.setViewport(frame({ scale: 20_000 }));

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(ViewportQueryStaleError);
    expect(runtime.snapshot().activeRequestKeys).toBe(0);
  });

  it('isolates caller cancellation from unrelated later requests', async () => {
    const execute = vi.fn(async () => completeResponse([{ id: 1 }]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());
    const controller = new AbortController();
    controller.abort('caller-cancel');

    await expect(runtime.queryLayer('roads', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    const result = await runtime.queryLayer<Feature>('roads');
    expect(result.features).toEqual([{ id: 1 }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('runs multi-layer batches through the same governance boundary', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([{ id: 1 }]));
    runtime.registerLayer<Feature>({
      layerId: 'parks',
      execute: async () => completeResponse([{ id: 2 }]),
      policy: { maxFeatures: 100 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024 * 1024,
    });
    runtime.setViewport(frame());

    const result = await runtime.queryLayers<Feature>(['parks', 'roads', 'parks']);

    expect(Object.keys(result.fulfilled).sort()).toEqual(['parks', 'roads']);
    expect(Object.keys(result.rejected)).toEqual([]);
    expect(result.fulfilled.parks?.features).toEqual([{ id: 2 }]);
  });

  it('captures per-layer failures in batch results without failing siblings', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => {
      throw new Error('roads failed');
    });
    runtime.registerLayer<Feature>({
      layerId: 'parks',
      execute: async () => completeResponse([{ id: 2 }]),
      policy: { maxFeatures: 100 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024 * 1024,
    });
    runtime.setViewport(frame());

    const result = await runtime.queryLayers<Feature>(['roads', 'parks']);

    expect(result.fulfilled.parks?.features).toEqual([{ id: 2 }]);
    expect(result.rejected.roads).toBeInstanceOf(Error);
  });
});

describe('ViewportQueryOrchestrator adaptive budgets', () => {
  it('reduces feature budgets under critical pressure', async () => {
    const execute = vi.fn(async () => completeResponse([]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());
    runtime.samplePerformance({
      gpuPressure: 0.95,
      timestamp: 1,
    });

    await runtime.queryLayer('roads');

    expect(execute.mock.calls[0]?.[0].maxFeatures).toBe(35);
  });

  it('applies additional motion reduction while panning', async () => {
    const execute = vi.fn(async () => completeResponse([]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame({ moving: true }));

    await runtime.queryLayer('roads');

    expect(execute.mock.calls[0]?.[0].maxFeatures).toBe(35);
    expect(execute.mock.calls[0]?.[0].warnings)
      .toContain('viewport-moving-budget-reduced');
  });

  it('combines pressure and motion without allowing a zero feature budget', async () => {
    const execute = vi.fn(async () => completeResponse([]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute, {
      policy: {
        maxFeatures: 2,
        maxFields: 2,
      },
    });
    runtime.setViewport(frame({ moving: true }));
    runtime.samplePerformance({
      heapPressure: 0.95,
      moving: true,
      timestamp: 1,
    });

    await runtime.queryLayer('roads');

    expect(execute.mock.calls[0]?.[0].maxFeatures).toBe(1);
  });

  it('bounds estimated features by the effective plan budget before governance', async () => {
    const execute = vi.fn(async () => completeResponse([]));
    const runtime = createViewportQueryOrchestrator({
      governance: {
        maxFeaturesPerRequest: 50,
        maxBytesPerRequest: 64 * 1024,
      },
    });
    register(runtime, execute, {
      policy: {
        maxFeatures: 50,
        maxExtentArea: 10_000_000,
      },
      estimatedFeatureDensity: 100,
    });
    runtime.setViewport(frame());

    await runtime.queryLayer('roads');

    expect(execute.mock.calls[0]?.[0].maxFeatures).toBe(50);
    expect(execute.mock.calls[0]?.[0].estimatedFeatures).toBeGreaterThan(50);
  });
});

describe('ViewportQueryOrchestrator cache lifecycle', () => {
  it('caches only complete responses and reuses them', async () => {
    const execute = vi.fn(async () => completeResponse([{ id: 1 }]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute, { cacheTtlMs: 5_000 });
    runtime.setViewport(frame());

    const first = await runtime.queryLayer<Feature>('roads');
    const second = await runtime.queryLayer<Feature>('roads');

    expect(first.source).toBe('executor');
    expect(second.source).toBe('cache');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 1,
      cacheHits: 1,
      cacheWrites: 1,
    });
  });

  it('does not cache transfer-limited responses', async () => {
    const execute = vi.fn(async () => completeResponse([{ id: 1 }], {
      complete: false,
      exceededTransferLimit: true,
    }));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    const first = await runtime.queryLayer('roads');
    const second = await runtime.queryLayer('roads');

    expect(first.complete).toBe(false);
    expect(first.warnings).toContain('transfer-limit-reached');
    expect(second.source).toBe('executor');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not cache responses with missing completion evidence', async () => {
    const execute = vi.fn(async () => ({
      features: [{ id: 1 }],
      estimatedBytes: 64,
    }));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());

    const first = await runtime.queryLayer('roads');
    await runtime.queryLayer('roads');

    expect(first.complete).toBe(false);
    expect(first.warnings).toContain('completion-evidence-missing');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('expires cache entries without polling', async () => {
    let timestamp = 100;
    const execute = vi.fn(async () => completeResponse([{ id: timestamp }]));
    const runtime = createViewportQueryOrchestrator({ now: () => timestamp });
    register(runtime, execute, { cacheTtlMs: 10 });
    runtime.setViewport(frame());

    await runtime.queryLayer('roads');
    timestamp = 105;
    expect((await runtime.queryLayer('roads')).source).toBe('cache');
    timestamp = 111;
    expect((await runtime.queryLayer('roads')).source).toBe('executor');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entries when entry capacity is exceeded', async () => {
    const runtime = createViewportQueryOrchestrator({ maxCacheEntries: 1 });
    register(runtime, async () => completeResponse([{ id: 1 }]));
    runtime.registerLayer<Feature>({
      layerId: 'parks',
      execute: async () => completeResponse([{ id: 2 }]),
      policy: { maxFeatures: 100 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024 * 1024,
    });
    runtime.setViewport(frame());

    await runtime.queryLayer('roads');
    await runtime.queryLayer('parks');

    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 1,
      cacheEvictions: 1,
    });
  });

  it('invalidates cache entries by layer', async () => {
    const execute = vi.fn(async () => completeResponse([{ id: 1 }]));
    const runtime = createViewportQueryOrchestrator();
    register(runtime, execute);
    runtime.setViewport(frame());
    await runtime.queryLayer('roads');

    expect(runtime.invalidateLayer('roads')).toBe(1);
    await runtime.queryLayer('roads');

    expect(execute).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().invalidations).toBe(1);
  });

  it('clears cache budgets atomically', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([{ id: 1 }]));
    runtime.setViewport(frame());
    await runtime.queryLayer('roads');

    expect(runtime.clearCache()).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 0,
      cacheFeatures: 0,
      cacheBytes: 0,
    });
  });
});

describe('ViewportQueryOrchestrator response integrity', () => {
  it('rejects responses that exceed the planned feature budget', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse(
      Array.from({ length: 101 }, (_, index) => ({ id: index })),
    ));
    runtime.setViewport(frame());

    await expect(runtime.queryLayer('roads')).rejects.toBeInstanceOf(
      ViewportQueryResponseBudgetError,
    );
    expect(runtime.snapshot().rejectedResponses).toBe(1);
  });

  it('rejects responses that exceed the layer byte budget', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([{ id: 1 }], {
      estimatedBytes: 2_000_000,
    }), {
      maxResponseBytes: 1_000,
    });
    runtime.setViewport(frame());

    await expect(runtime.queryLayer('roads')).rejects.toThrow(
      'viewport query response exceeds maxResponseBytes',
    );
  });

  it('rejects invalid response byte evidence', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([{ id: 1 }], {
      estimatedBytes: Number.NaN,
    }));
    runtime.setViewport(frame());

    await expect(runtime.queryLayer('roads')).rejects.toThrow(
      'response estimatedBytes must be finite and non-negative',
    );
  });

  it('bounds inferred bytes using the layer estimate', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => ({
      features: [{ id: 1 }, { id: 2 }],
      complete: true,
      exceededTransferLimit: false,
    }), {
      estimatedBytesPerFeature: 300,
    });
    runtime.setViewport(frame());

    const result = await runtime.queryLayer('roads');
    expect(result.estimatedBytes).toBe(600);
  });
});

describe('ViewportQueryOrchestrator cleanup and diagnostics', () => {
  it('rejects invalid clock values before cache operations', async () => {
    const runtime = createViewportQueryOrchestrator({
      now: () => Number.NaN,
    });
    register(runtime, async () => completeResponse([]));
    runtime.setViewport(frame());

    await expect(runtime.queryLayer('roads')).rejects.toThrow(
      'viewport query clock must return a finite non-negative number',
    );
  });

  it('disposes governance, cache, layers, and viewport state', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => completeResponse([{ id: 1 }]));
    runtime.setViewport(frame());
    await runtime.queryLayer('roads');

    runtime.dispose();

    expect(runtime.snapshot()).toMatchObject({
      disposed: true,
      registeredLayers: 0,
      cacheEntries: 0,
      activeRequestKeys: 0,
      frame: null,
    });
    expect(() => runtime.setViewport(frame())).toThrow(
      'viewport query orchestrator is disposed',
    );
  });

  it('surfaces governance queue rejection as a rejected response', async () => {
    let release!: () => void;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createViewportQueryOrchestrator({
      governance: {
        maxConcurrent: 1,
        maxQueued: 1,
      },
    });
    runtime.registerLayer<Feature>({
      layerId: 'a',
      execute: async () => {
        await blocking;
        return completeResponse([{ id: 1 }]);
      },
      policy: { maxFeatures: 10 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024,
    });
    runtime.registerLayer<Feature>({
      layerId: 'b',
      execute: async () => {
        await blocking;
        return completeResponse([{ id: 2 }]);
      },
      policy: { maxFeatures: 10 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024,
    });
    runtime.registerLayer<Feature>({
      layerId: 'c',
      execute: async () => completeResponse([{ id: 3 }]),
      policy: { maxFeatures: 10 },
      estimatedBytesPerFeature: 128,
      maxResponseBytes: 1024,
    });
    runtime.setViewport(frame());

    const a = runtime.queryLayer('a');
    const b = runtime.queryLayer('b');
    await expect(runtime.queryLayer('c')).rejects.toThrow(
      'Spatial query queue capacity exceeded',
    );
    release();
    await Promise.all([a, b]);

    expect(runtime.snapshot().rejectedResponses).toBe(1);
  });
  it('rejects inferred response bytes that exceed the layer budget', async () => {
    const runtime = createViewportQueryOrchestrator();
    register(runtime, async () => ({
      features: [{ id: 1 }, { id: 2 }],
      complete: true,
      exceededTransferLimit: false,
    }), {
      estimatedBytesPerFeature: 300,
      maxResponseBytes: 500,
    });
    runtime.setViewport(frame());

    await expect(runtime.queryLayer('roads')).rejects.toThrow(
      'viewport query response exceeds maxResponseBytes',
    );
  });

});
