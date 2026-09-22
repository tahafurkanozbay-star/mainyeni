import { describe, expect, it } from 'vitest';
import { LayerResidencyRuntime, type LayerResidencyDescriptor } from './layerResidencyRuntime';

const budget = {
  cpuBytes: 100,
  gpuBytes: 100,
  featureCount: 100,
  drawCalls: 10,
  maxResidentLayers: 2,
};

const layer = (
  id: string,
  priority: LayerResidencyDescriptor['priority'] = 'normal',
  overrides: Partial<LayerResidencyDescriptor> = {},
): LayerResidencyDescriptor => {
  const {
    id: _ignoredId,
    mode = '2d',
    priority: overridePriority = priority,
    cost = { cpuBytes: 40, gpuBytes: 40, featureCount: 40, drawCalls: 2 },
    ...optionalOverrides
  } = overrides;
  return {
    ...optionalOverrides,
    id,
    mode,
    priority: overridePriority,
    cost,
  };
};

describe('LayerResidencyRuntime', () => {
  it('admits layers while every resource budget remains bounded', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('roads'));
    runtime.register(layer('buildings'));

    expect(runtime.admit('roads', 1_000).admitted).toBe(true);
    expect(runtime.admit('buildings', 1_000).admitted).toBe(true);
    expect(runtime.snapshot().usage).toEqual({
      cpuBytes: 80,
      gpuBytes: 80,
      featureCount: 80,
      drawCalls: 4,
      residentLayers: 2,
    });
  });

  it('evicts lower-priority least-recently-used work deterministically', () => {
    let now = 1;
    const runtime = new LayerResidencyRuntime({ budget, now: () => now++ });
    runtime.register(layer('low-a', 'low'));
    runtime.register(layer('low-b', 'low'));
    runtime.register(layer('critical', 'critical'));
    runtime.admit('low-a', 1_000);
    runtime.admit('low-b', 1_000);
    runtime.touch('low-b');

    const result = runtime.admit('critical', 1_000);
    expect(result).toEqual({ admitted: true, layerId: 'critical', evictedLayerIds: ['low-a'] });
    expect(runtime.snapshot().entries.find((entry) => entry.descriptor.id === 'low-a')?.state).toBe('suspended');
  });

  it('does not evict higher-priority resident work for lower-priority work', () => {
    const runtime = new LayerResidencyRuntime({ budget: { ...budget, maxResidentLayers: 1 } });
    runtime.register(layer('critical', 'critical'));
    runtime.register(layer('low', 'low'));
    runtime.admit('critical', 1_000);

    expect(runtime.admit('low', 1_000)).toEqual({
      admitted: false,
      layerId: 'low',
      evictedLayerIds: [],
      reason: 'capacity',
    });
  });

  it('rejects a layer that cannot fit even in an empty runtime', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('huge', 'critical', {
      cost: { cpuBytes: 101, gpuBytes: 1, featureCount: 1, drawCalls: 1 },
    }));
    expect(runtime.admit('huge', 1_000).reason).toBe('single-layer-budget');
    expect(runtime.snapshot().usage.residentLayers).toBe(0);
  });

  it('honors scale ranges and suspends resident layers that leave range', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('parcel', 'normal', { minScale: 500, maxScale: 5_000 }));
    expect(runtime.admit('parcel', 100).reason).toBe('scale');
    expect(runtime.admit('parcel', 1_000).admitted).toBe(true);
    expect(runtime.reconcileScale(10_000)).toEqual(['parcel']);
    expect(runtime.snapshot().usage.residentLayers).toBe(0);
  });

  it('bounds registration cardinality by evicting oldest non-resident metadata', () => {
    let now = 0;
    const runtime = new LayerResidencyRuntime({ budget, maxEntries: 2, now: () => ++now });
    runtime.register(layer('a'));
    runtime.register(layer('b'));
    runtime.touch('b');
    runtime.register(layer('c'));
    expect(runtime.snapshot().entries.map((entry) => entry.descriptor.id)).toEqual(['b', 'c']);
  });

  it('refuses registration overflow when all metadata belongs to resident layers', () => {
    const runtime = new LayerResidencyRuntime({ budget, maxEntries: 1 });
    runtime.register(layer('resident'));
    runtime.admit('resident', 1_000);
    expect(() => runtime.register(layer('new'))).toThrow('capacity exhausted');
  });

  it('normalizes ids and rejects invalid costs, ranges, and budgets', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    expect(runtime.register(layer('  roads  ')).descriptor.id).toBe('roads');
    expect(() => runtime.register(layer('bad', 'normal', { cost: { cpuBytes: -1, gpuBytes: 1, featureCount: 1, drawCalls: 1 } }))).toThrow();
    expect(() => runtime.register(layer('range', 'normal', { minScale: 2_000, maxScale: 1_000 }))).toThrow();
    expect(() => new LayerResidencyRuntime({ budget: { ...budget, maxResidentLayers: 0 } })).toThrow();
  });

  it('keeps snapshots immutable and sorted without exposing mutable internals', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('z'));
    runtime.register(layer('a'));
    const snapshot = runtime.snapshot();
    expect(snapshot.entries.map((entry) => entry.descriptor.id)).toEqual(['a', 'z']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.descriptor.cost)).toBe(true);
  });

  it('supports explicit suspension and removal without leaking usage', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('a'));
    runtime.admit('a', 1_000);
    expect(runtime.suspend('a')).toBe(true);
    expect(runtime.suspend('a')).toBe(false);
    expect(runtime.snapshot().usage.residentLayers).toBe(0);
    expect(runtime.remove('a')).toBe(true);
    expect(runtime.remove('a')).toBe(false);
    expect(runtime.admit('a', 1_000).reason).toBe('not-registered');
  });

  it('fails closed after disposal and disposal is idempotent', () => {
    const runtime = new LayerResidencyRuntime({ budget });
    runtime.register(layer('a'));
    runtime.admit('a', 1_000);
    runtime.dispose();
    runtime.dispose();
    expect(runtime.snapshot().entries).toEqual([]);
    expect(() => runtime.register(layer('b'))).toThrow('disposed');
    expect(() => runtime.admit('a', 1_000)).toThrow('disposed');
  });
});
