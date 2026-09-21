import { describe, expect, it } from 'vitest';
import {
  createSpatialLayerEpochRegistry,
  normalizeSpatialLayerEpochRegistryPolicy,
  type SpatialLayerEpochToken,
} from './spatialLayerEpochRegistry';

describe('normalizeSpatialLayerEpochRegistryPolicy', () => {
  it('returns a frozen bounded default policy', () => {
    const policy = normalizeSpatialLayerEpochRegistryPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.maxLayers).toBe(4096);
  });

  it('rejects invalid layer capacity', () => {
    expect(() => normalizeSpatialLayerEpochRegistryPolicy({ maxLayers: 0 })).toThrow(RangeError);
    expect(() => normalizeSpatialLayerEpochRegistryPolicy({ maxLayers: -1 })).toThrow(RangeError);
    expect(() => normalizeSpatialLayerEpochRegistryPolicy({ maxLayers: 100_001 })).toThrow(RangeError);
    expect(() => normalizeSpatialLayerEpochRegistryPolicy({ maxLayers: 1.5 })).toThrow(RangeError);
  });
});

describe('createSpatialLayerEpochRegistry', () => {
  it('keeps repeated captures current until a mutation advances the layer', () => {
    const registry = createSpatialLayerEpochRegistry();
    const first = registry.capture({ serviceId: 'parks', layerId: 2 });
    const second = registry.capture({ serviceId: ' parks ', layerId: 2 });

    expect(second.version).toBe(first.version);
    expect(registry.isCurrent(first)).toBe(true);
    expect(registry.isCurrent(second)).toBe(true);
    expect(registry.snapshot()).toMatchObject({
      trackedLayers: 1,
      captures: 2,
      advances: 0,
    });
  });

  it('invalidates pre-mutation tokens after advance', () => {
    const registry = createSpatialLayerEpochRegistry();
    const before = registry.capture({ serviceId: 'roads', layerId: 7 });
    const after = registry.advance({ serviceId: 'roads', layerId: 7 });

    expect(after.version).toBeGreaterThan(before.version);
    expect(registry.isCurrent(before)).toBe(false);
    expect(registry.isCurrent(after)).toBe(true);
    expect(registry.snapshot().advances).toBe(1);
  });

  it('isolates generations between layers in the same service', () => {
    const registry = createSpatialLayerEpochRegistry();
    const roads = registry.capture({ serviceId: 'transport', layerId: 1 });
    const stops = registry.capture({ serviceId: 'transport', layerId: 2 });

    registry.advance({ serviceId: 'transport', layerId: 1 });

    expect(registry.isCurrent(roads)).toBe(false);
    expect(registry.isCurrent(stops)).toBe(true);
  });

  it('isolates identical layer ids between different services', () => {
    const registry = createSpatialLayerEpochRegistry();
    const first = registry.capture({ serviceId: 'service-a', layerId: 3 });
    const second = registry.capture({ serviceId: 'service-b', layerId: 3 });

    registry.advance({ serviceId: 'service-b', layerId: 3 });

    expect(registry.isCurrent(first)).toBe(true);
    expect(registry.isCurrent(second)).toBe(false);
  });

  it('normalizes surrounding service whitespace without merging distinct ids', () => {
    const registry = createSpatialLayerEpochRegistry();
    const token = registry.capture({ serviceId: '  parcels  ', layerId: 0 });

    expect(token).toMatchObject({ serviceId: 'parcels', layerId: 0 });
    expect(registry.isCurrent({ ...token, serviceId: 'parcels' })).toBe(true);
    expect(registry.isCurrent({ ...token, serviceId: 'PARCELS' })).toBe(false);
  });

  it('rejects empty and excessively long service ids', () => {
    const registry = createSpatialLayerEpochRegistry();

    expect(() => registry.capture({ serviceId: '   ', layerId: 1 })).toThrow(TypeError);
    expect(() => registry.capture({ serviceId: 'x'.repeat(513), layerId: 1 })).toThrow(RangeError);
  });

  it('rejects invalid layer ids', () => {
    const registry = createSpatialLayerEpochRegistry();

    expect(() => registry.capture({ serviceId: 'parks', layerId: -1 })).toThrow(RangeError);
    expect(() => registry.capture({ serviceId: 'parks', layerId: 1.5 })).toThrow(RangeError);
    expect(() => registry.capture({ serviceId: 'parks', layerId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
  });

  it('fails closed for malformed tokens', () => {
    const registry = createSpatialLayerEpochRegistry();
    registry.capture({ serviceId: 'parks', layerId: 1 });

    const malformed = { serviceId: 'parks', layerId: 1, version: 0 } as SpatialLayerEpochToken;
    expect(registry.isCurrent(malformed)).toBe(false);
    expect(registry.snapshot().invalidTokens).toBe(1);
  });

  it('fails closed when a token refers to an untracked layer', () => {
    const registry = createSpatialLayerEpochRegistry();
    const token = Object.freeze({ serviceId: 'missing', layerId: 9, version: 1 });

    expect(registry.isCurrent(token)).toBe(false);
    expect(registry.snapshot()).toMatchObject({ trackedLayers: 0, invalidTokens: 1 });
  });

  it('evicts the least recently used tracked layer at capacity', () => {
    const registry = createSpatialLayerEpochRegistry({ maxLayers: 2 });
    const first = registry.capture({ serviceId: 'a', layerId: 1 });
    const second = registry.capture({ serviceId: 'b', layerId: 1 });

    expect(registry.isCurrent(first)).toBe(true);
    const third = registry.capture({ serviceId: 'c', layerId: 1 });

    expect(registry.isCurrent(first)).toBe(true);
    expect(registry.isCurrent(second)).toBe(false);
    expect(registry.isCurrent(third)).toBe(true);
    expect(registry.snapshot()).toMatchObject({ trackedLayers: 2, evictions: 1 });
  });

  it('treats eviction as a stale-result barrier for old tokens', () => {
    const registry = createSpatialLayerEpochRegistry({ maxLayers: 1 });
    const old = registry.capture({ serviceId: 'a', layerId: 1 });

    registry.capture({ serviceId: 'b', layerId: 1 });

    expect(registry.isCurrent(old)).toBe(false);
  });

  it('remove makes outstanding tokens invalid and is idempotent', () => {
    const registry = createSpatialLayerEpochRegistry();
    const token = registry.capture({ serviceId: 'parcels', layerId: 4 });

    expect(registry.remove({ serviceId: 'parcels', layerId: 4 })).toBe(true);
    expect(registry.remove({ serviceId: 'parcels', layerId: 4 })).toBe(false);
    expect(registry.isCurrent(token)).toBe(false);
    expect(registry.snapshot().removals).toBe(1);
  });

  it('clear invalidates every outstanding token', () => {
    const registry = createSpatialLayerEpochRegistry();
    const one = registry.capture({ serviceId: 'one', layerId: 1 });
    const two = registry.capture({ serviceId: 'two', layerId: 2 });

    expect(registry.clear()).toBe(2);
    expect(registry.clear()).toBe(0);
    expect(registry.isCurrent(one)).toBe(false);
    expect(registry.isCurrent(two)).toBe(false);
    expect(registry.snapshot()).toMatchObject({ trackedLayers: 0, removals: 2 });
  });

  it('returns frozen tokens and snapshots', () => {
    const registry = createSpatialLayerEpochRegistry();
    const token = registry.capture({ serviceId: 'parks', layerId: 2 });
    const snapshot = registry.snapshot();

    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('increments generation for structural changes and layer advances', () => {
    const registry = createSpatialLayerEpochRegistry();
    expect(registry.snapshot().generation).toBe(0);

    registry.capture({ serviceId: 'a', layerId: 1 });
    const afterCapture = registry.snapshot().generation;
    registry.capture({ serviceId: 'a', layerId: 1 });
    expect(registry.snapshot().generation).toBe(afterCapture);

    registry.advance({ serviceId: 'a', layerId: 1 });
    expect(registry.snapshot().generation).toBe(afterCapture + 1);

    registry.remove({ serviceId: 'a', layerId: 1 });
    expect(registry.snapshot().generation).toBe(afterCapture + 2);
  });
});
