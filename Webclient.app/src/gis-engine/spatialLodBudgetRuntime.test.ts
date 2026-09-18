import { describe, expect, it } from 'vitest';

import {
  SpatialLodBudgetRuntime,
  isSpatialLodResourceInScale,
  type SpatialLodPriority,
  type SpatialLodResource,
} from './spatialLodBudgetRuntime';

function resource(
  id: string,
  overrides: Partial<SpatialLodResource> = {},
): SpatialLodResource {
  return {
    id,
    layerId: 'parcels',
    priority: 'foreground',
    estimatedCpuBytes: 100,
    estimatedGpuBytes: 200,
    estimatedVertices: 50,
    estimatedDrawCalls: 1,
    visible: true,
    ...overrides,
  };
}

describe('isSpatialLodResourceInScale', () => {
  it('accepts resources without scale constraints', () => {
    expect(isSpatialLodResourceInScale(resource('a'), 5_000)).toBe(true);
  });

  it('enforces ArcGIS-style min and max scale boundaries', () => {
    const bounded = resource('a', { minScale: 10_000, maxScale: 1_000 });
    expect(isSpatialLodResourceInScale(bounded, 10_001)).toBe(false);
    expect(isSpatialLodResourceInScale(bounded, 10_000)).toBe(true);
    expect(isSpatialLodResourceInScale(bounded, 5_000)).toBe(true);
    expect(isSpatialLodResourceInScale(bounded, 1_000)).toBe(true);
    expect(isSpatialLodResourceInScale(bounded, 999)).toBe(false);
  });

  it('rejects non-finite scales', () => {
    expect(() => isSpatialLodResourceInScale(resource('a'), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('SpatialLodBudgetRuntime', () => {
  it('accounts admitted resources across CPU, GPU, vertices and draw calls', () => {
    const runtime = new SpatialLodBudgetRuntime({
      maxResources: 10,
      maxCpuBytes: 10_000,
      maxGpuBytes: 10_000,
      maxVertices: 10_000,
      maxDrawCalls: 100,
    });

    expect(runtime.admit(resource('a'), 5_000).admitted).toBe(true);
    expect(runtime.admit(resource('b', {
      estimatedCpuBytes: 250,
      estimatedGpuBytes: 350,
      estimatedVertices: 75,
      estimatedDrawCalls: 2,
    }), 5_000).admitted).toBe(true);

    expect(runtime.snapshot()).toMatchObject({
      resources: 2,
      cpuBytes: 350,
      gpuBytes: 550,
      vertices: 125,
      drawCalls: 3,
      admissions: 2,
      rejections: 0,
      evictions: 0,
    });
  });

  it('rejects hidden and out-of-scale resources before allocation', () => {
    const runtime = new SpatialLodBudgetRuntime();
    expect(runtime.admit(resource('hidden', { visible: false }), 5_000).reason).toBe('hidden');
    expect(runtime.admit(resource('far', { minScale: 1_000 }), 5_000).reason).toBe('out-of-scale');
    expect(runtime.snapshot()).toMatchObject({ resources: 0, admissions: 0, rejections: 2 });
  });

  it('rejects resources that cannot individually fit the hard budget', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxGpuBytes: 100 });
    const result = runtime.admit(resource('huge', { estimatedGpuBytes: 101 }), 5_000);
    expect(result).toMatchObject({ admitted: false, reason: 'resource-too-large' });
    expect(runtime.snapshot().gpuBytes).toBe(0);
  });

  it('evicts background work before foreground work', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxResources: 2 });
    runtime.admit(resource('foreground', { priority: 'foreground' }), 5_000);
    runtime.admit(resource('background', { priority: 'background' }), 5_000);

    const result = runtime.admit(resource('interactive', { priority: 'interactive' }), 5_000);
    expect(result.evictedIds).toEqual(['background']);
    expect(runtime.has('foreground')).toBe(true);
    expect(runtime.has('interactive')).toBe(true);
  });

  it('uses distance as a deterministic tie breaker for equal priorities', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxResources: 2 });
    runtime.admit(resource('near', { priority: 'background', distanceMeters: 10 }), 5_000);
    runtime.admit(resource('far', { priority: 'background', distanceMeters: 100 }), 5_000);

    const result = runtime.admit(resource('new', { priority: 'foreground' }), 5_000);
    expect(result.evictedIds).toEqual(['far']);
    expect(runtime.has('near')).toBe(true);
  });

  it('protects selected and critical resources from ordinary eviction', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxResources: 2 });
    runtime.admit(resource('selected', { selected: true, priority: 'background' }), 5_000);
    runtime.admit(resource('critical', { priority: 'critical' }), 5_000);

    const result = runtime.admit(resource('candidate', { priority: 'interactive' }), 5_000);
    expect(result.admitted).toBe(false);
    expect(runtime.has('selected')).toBe(true);
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('candidate')).toBe(false);
  });

  it('replaces an existing identity without double accounting', () => {
    const runtime = new SpatialLodBudgetRuntime();
    runtime.admit(resource('same'), 5_000);
    runtime.admit(resource('same', {
      estimatedCpuBytes: 300,
      estimatedGpuBytes: 400,
      estimatedVertices: 80,
      estimatedDrawCalls: 3,
    }), 5_000);

    expect(runtime.snapshot()).toMatchObject({
      resources: 1,
      cpuBytes: 300,
      gpuBytes: 400,
      vertices: 80,
      drawCalls: 3,
      admissions: 2,
    });
  });

  it('restores a previous identity when its replacement cannot survive admission', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxResources: 1, maxGpuBytes: 500 });
    runtime.admit(resource('same', { selected: true, estimatedGpuBytes: 100 }), 5_000);
    runtime.admit(resource('critical', { priority: 'critical', estimatedGpuBytes: 100 }), 5_000);

    expect(runtime.has('same')).toBe(false);
    expect(runtime.has('critical')).toBe(true);
  });

  it('enforces per-layer resource budgets independently', () => {
    const runtime = new SpatialLodBudgetRuntime({ maxLayerResources: 1 });
    expect(runtime.admit(resource('a', { layerId: 'roads' }), 5_000).admitted).toBe(true);
    expect(runtime.admit(resource('b', { layerId: 'roads' }), 5_000).reason).toBe('layer-budget');
    expect(runtime.admit(resource('c', { layerId: 'buildings' }), 5_000).admitted).toBe(true);
  });

  it('removes a complete layer and returns deterministic identities', () => {
    const runtime = new SpatialLodBudgetRuntime();
    runtime.admit(resource('a', { layerId: 'roads' }), 5_000);
    runtime.admit(resource('b', { layerId: 'buildings' }), 5_000);
    runtime.admit(resource('c', { layerId: 'roads' }), 5_000);

    expect(runtime.removeLayer('roads')).toEqual(['a', 'c']);
    expect(runtime.has('b')).toBe(true);
    expect(runtime.snapshot().resources).toBe(1);
  });

  it('reconciles resources when view scale changes', () => {
    const runtime = new SpatialLodBudgetRuntime();
    runtime.admit(resource('city', { minScale: 100_000, maxScale: 10_000 }), 50_000);
    runtime.admit(resource('parcel', { minScale: 5_000, maxScale: 100 }), 1_000);

    expect(runtime.reconcileScale(50_000)).toEqual(['parcel']);
    expect(runtime.has('city')).toBe(true);
  });

  it('reports normalized pressure and maximum pressure', () => {
    const runtime = new SpatialLodBudgetRuntime({
      maxResources: 4,
      maxCpuBytes: 1_000,
      maxGpuBytes: 1_000,
      maxVertices: 1_000,
      maxDrawCalls: 10,
    });
    runtime.admit(resource('a', {
      estimatedCpuBytes: 250,
      estimatedGpuBytes: 500,
      estimatedVertices: 100,
      estimatedDrawCalls: 2,
    }), 5_000);

    expect(runtime.pressure()).toEqual({
      resources: 0.25,
      cpu: 0.25,
      gpu: 0.5,
      vertices: 0.1,
      drawCalls: 0.2,
      maximum: 0.5,
    });
  });

  it('clears all accounting deterministically', () => {
    const runtime = new SpatialLodBudgetRuntime();
    runtime.admit(resource('a'), 5_000);
    runtime.admit(resource('b'), 5_000);
    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({ resources: 0, cpuBytes: 0, gpuBytes: 0, vertices: 0, drawCalls: 0 });
  });

  it('validates budget dimensions', () => {
    expect(() => new SpatialLodBudgetRuntime({ maxResources: 0 })).toThrow(RangeError);
    expect(() => new SpatialLodBudgetRuntime({ maxGpuBytes: Number.NaN })).toThrow(RangeError);
  });

  it('validates resource dimensions and identity', () => {
    const runtime = new SpatialLodBudgetRuntime();
    expect(() => runtime.admit(resource('   '), 5_000)).toThrow(TypeError);
    expect(() => runtime.admit(resource('a', { estimatedVertices: -1 }), 5_000)).toThrow(RangeError);
    expect(() => runtime.admit(resource('a', { distanceMeters: Number.NaN }), 5_000)).toThrow(RangeError);
  });

  it('validates inverted ArcGIS scale constraints', () => {
    const runtime = new SpatialLodBudgetRuntime();
    expect(() => runtime.admit(resource('a', { minScale: 1_000, maxScale: 10_000 }), 5_000)).toThrow(RangeError);
  });

  it('preserves deterministic ordering for layer snapshots', () => {
    const runtime = new SpatialLodBudgetRuntime();
    runtime.admit(resource('first'), 5_000);
    runtime.admit(resource('second'), 5_000);
    runtime.admit(resource('third'), 5_000);
    expect(runtime.listLayer('parcels').map(({ id }) => id)).toEqual(['first', 'second', 'third']);
  });

  it.each<SpatialLodPriority>(['critical', 'interactive', 'foreground', 'background'])(
    'accepts the %s priority contract',
    (priority) => {
      const runtime = new SpatialLodBudgetRuntime();
      expect(runtime.admit(resource(priority, { priority }), 5_000).admitted).toBe(true);
    },
  );
});
