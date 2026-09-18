import { describe, expect, it } from 'vitest';
import { SpatialLayerLifecycleRuntime, type SpatialLayerDescriptor } from './spatialLayerLifecycleRuntime';

function layer(id: string, overrides: Partial<SpatialLayerDescriptor> = {}): SpatialLayerDescriptor {
  return {
    id,
    priority: 'foreground',
    estimatedCpuBytes: 10,
    estimatedGpuBytes: 20,
    ...overrides,
  };
}

describe('SpatialLayerLifecycleRuntime', () => {
  it('tracks deterministic lifecycle transitions', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    expect(runtime.register(layer('roads'))).toEqual([]);
    expect(runtime.phase('roads')).toBe('registered');
    runtime.transition('roads', 'loading');
    runtime.transition('roads', 'ready');
    expect(runtime.phase('roads')).toBe('ready');
    expect(runtime.snapshot()).toMatchObject({ layers: 1, activeLayers: 1, cpuBytes: 10, gpuBytes: 20, transitions: 2 });
  });

  it('rejects invalid state transitions', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('roads'));
    expect(() => runtime.transition('roads', 'ready')).toThrow(/invalid layer transition/);
  });

  it('suspends repeatedly failing layers at the bounded failure threshold', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxFailuresPerLayer: 2 });
    runtime.register(layer('buildings'));
    runtime.transition('buildings', 'loading');
    expect(runtime.markFailed('buildings')).toBe(false);
    expect(runtime.phase('buildings')).toBe('failed');
    runtime.retry('buildings');
    expect(runtime.markFailed('buildings')).toBe(true);
    expect(runtime.phase('buildings')).toBe('suspended');
    expect(runtime.snapshot().failures).toBe(2);
  });

  it('suspends active layers outside ArcGIS-style scale constraints', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('parcels', { minScale: 50_000, maxScale: 1_000 }));
    runtime.transition('parcels', 'loading');
    runtime.transition('parcels', 'ready');
    expect(runtime.reconcileScale(500)).toEqual(['parcels']);
    expect(runtime.phase('parcels')).toBe('suspended');
  });

  it('keeps layers active while scale remains within bounds', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('parcels', { minScale: 50_000, maxScale: 1_000 }));
    runtime.transition('parcels', 'loading');
    expect(runtime.reconcileScale(10_000)).toEqual([]);
    expect(runtime.phase('parcels')).toBe('loading');
  });

  it('suspends active hidden layers without removing registration', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('poi'));
    runtime.transition('poi', 'loading');
    runtime.setVisible('poi', false);
    expect(runtime.phase('poi')).toBe('suspended');
    expect(runtime.has('poi')).toBe(true);
  });

  it('evicts lower-priority layers when memory pressure exceeds budget', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxCpuBytes: 20, maxGpuBytes: 40 });
    runtime.register(layer('background', { priority: 'background' }));
    const evicted = runtime.register(layer('interactive', { priority: 'interactive', estimatedCpuBytes: 15, estimatedGpuBytes: 25 }));
    expect(evicted).toEqual(['background']);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.has('interactive')).toBe(true);
  });

  it('never evicts critical layers to admit lower-priority work', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxLayers: 1, maxActiveLayers: 1 });
    runtime.register(layer('critical', { priority: 'critical' }));
    expect(() => runtime.register(layer('background', { priority: 'background' }))).toThrow(/cannot admit protected layer/);
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('background')).toBe(false);
  });

  it('bounds active layer cardinality separately from registered cardinality', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxLayers: 4, maxActiveLayers: 1 });
    runtime.register(layer('a', { priority: 'background' }));
    runtime.register(layer('b', { priority: 'interactive' }));
    runtime.transition('a', 'loading');
    const evicted = runtime.transition('b', 'loading');
    expect(evicted).toEqual(['a']);
    expect(runtime.snapshot().activeLayers).toBe(1);
  });

  it('uses least-recently-touched ordering for equal-priority eviction', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxLayers: 2, maxActiveLayers: 2 });
    runtime.register(layer('old'));
    runtime.register(layer('new'));
    runtime.setVisible('new', true);
    const evicted = runtime.register(layer('third'));
    expect(evicted).toEqual(['old']);
  });

  it('replaces an existing registration without double-counting memory', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('roads'));
    runtime.register(layer('roads', { estimatedCpuBytes: 30, estimatedGpuBytes: 40 }));
    expect(runtime.snapshot()).toMatchObject({ layers: 1, cpuBytes: 30, gpuBytes: 40 });
  });

  it('disposes layers deterministically and releases accounting', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('roads'));
    expect(runtime.dispose('roads')).toBe(true);
    expect(runtime.dispose('roads')).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ layers: 0, cpuBytes: 0, gpuBytes: 0 });
  });

  it('clears all allocation accounting', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('a'));
    runtime.register(layer('b'));
    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({ layers: 0, activeLayers: 0, cpuBytes: 0, gpuBytes: 0 });
  });

  it('fails closed for oversized individual layer allocations', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxCpuBytes: 100, maxGpuBytes: 100 });
    expect(() => runtime.register(layer('huge', { estimatedCpuBytes: 101 }))).toThrow(/memory budget/);
  });

  it('validates budget relationships', () => {
    expect(() => new SpatialLayerLifecycleRuntime({ maxLayers: 2, maxActiveLayers: 3 })).toThrow(/maxActiveLayers/);
    expect(() => new SpatialLayerLifecycleRuntime({ maxLayers: 0 })).toThrow(/positive safe integer/);
  });

  it('validates identifiers and numeric allocation estimates', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxIdLength: 4 });
    expect(() => runtime.register(layer(''))).toThrow(/must not be empty/);
    expect(() => runtime.register(layer('abcde'))).toThrow(/length budget/);
    expect(() => runtime.register(layer('x', { estimatedCpuBytes: -1 }))).toThrow(/non-negative safe integer/);
  });

  it('validates scale ranges and finite scale input', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    expect(() => runtime.register(layer('bad', { minScale: 100, maxScale: 1000 }))).toThrow(/minScale/);
    runtime.register(layer('ok'));
    expect(() => runtime.reconcileScale(Number.NaN)).toThrow(/finite and non-negative/);
  });

  it('returns immutable public layer snapshots in registration order', () => {
    const runtime = new SpatialLayerLifecycleRuntime();
    runtime.register(layer('a'));
    runtime.register(layer('b', { priority: 'interactive' }));
    const listed = runtime.list();
    expect(listed.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });

  it('reports deterministic eviction totals', () => {
    const runtime = new SpatialLayerLifecycleRuntime({ maxLayers: 1, maxActiveLayers: 1 });
    runtime.register(layer('a', { priority: 'background' }));
    runtime.register(layer('b', { priority: 'foreground' }));
    expect(runtime.snapshot().evictions).toBe(1);
  });
});
