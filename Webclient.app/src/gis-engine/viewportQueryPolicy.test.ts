import { describe, expect, it } from 'vitest';
import { createViewportQueryPolicy } from './viewportQueryPolicy';

const extent = Object.freeze({
  xmin: 0,
  ymin: 0,
  xmax: 100,
  ymax: 50,
  spatialReference: 'EPSG:3857',
});

const input = Object.freeze({
  layerId: 'roads',
  extent,
  scale: 10_000,
  pixelWidth: 1280,
  pixelHeight: 720,
});

describe('viewportQueryPolicy', () => {
  it('creates a deterministic bounded foreground plan', () => {
    const policy = createViewportQueryPolicy({ maxFeatures: 4_000 });
    const plan = policy.plan({ ...input, requestedFields: ['name', 'id', 'name'] });
    expect(plan.maxFeatures).toBe(4_000);
    expect(plan.fields).toEqual(['id', 'name']);
    expect(plan.key).toBe(policy.plan({ ...input, requestedFields: ['id', 'name'] }).key);
    expect(plan.pressure).toBe('low');
  });

  it('reduces budgets while the viewport is moving', () => {
    const policy = createViewportQueryPolicy({ maxFeatures: 4_000, movingFeatureFactor: 0.25 });
    const plan = policy.plan({ ...input, moving: true });
    expect(plan.maxFeatures).toBe(1_000);
    expect(plan.warnings).toContain('viewport-moving-budget-reduced');
  });

  it('reduces speculative prefetch budgets independently', () => {
    const policy = createViewportQueryPolicy({ maxFeatures: 4_000, prefetchFeatureFactor: 0.2 });
    expect(policy.plan({ ...input, priority: 'prefetch' }).maxFeatures).toBe(800);
    expect(policy.plan({ ...input, priority: 'interactive' }).maxFeatures).toBe(4_000);
  });

  it('combines movement and prefetch pressure without exceeding the global cap', () => {
    const policy = createViewportQueryPolicy({
      maxFeatures: 10_000,
      movingFeatureFactor: 0.4,
      prefetchFeatureFactor: 0.5,
    });
    expect(policy.plan({ ...input, moving: true, priority: 'prefetch' }).maxFeatures).toBe(2_000);
  });

  it('reports density pressure without trusting it as an allocation authority', () => {
    const policy = createViewportQueryPolicy({ maxFeatures: 1_000 });
    const plan = policy.plan({ ...input, estimatedFeatureDensity: 1 });
    expect(plan.estimatedFeatures).toBe(5_000);
    expect(plan.pressure).toBe('high');
    expect(plan.warnings).toContain('estimated-feature-budget-exceeded');
    expect(plan.maxFeatures).toBe(1_000);
  });

  it('reports medium pressure near the feature budget', () => {
    const policy = createViewportQueryPolicy({ maxFeatures: 10_000 });
    const plan = policy.plan({ ...input, estimatedFeatureDensity: 1.5 });
    expect(plan.estimatedFeatures).toBe(7_500);
    expect(plan.pressure).toBe('medium');
  });

  it('keeps geometry intent in the dedupe key', () => {
    const policy = createViewportQueryPolicy();
    const withGeometry = policy.plan({ ...input, includeGeometry: true });
    const withoutGeometry = policy.plan({ ...input, includeGeometry: false });
    expect(withGeometry.key).not.toBe(withoutGeometry.key);
  });

  it('keeps requested field sets in the dedupe key', () => {
    const policy = createViewportQueryPolicy();
    const first = policy.plan({ ...input, requestedFields: ['id'] });
    const second = policy.plan({ ...input, requestedFields: ['id', 'name'] });
    expect(first.key).not.toBe(second.key);
  });

  it('normalizes field order before key generation', () => {
    const policy = createViewportQueryPolicy();
    const first = policy.plan({ ...input, requestedFields: ['name', 'id'] });
    const second = policy.plan({ ...input, requestedFields: ['id', 'name'] });
    expect(first.key).toBe(second.key);
  });

  it('rejects malformed extents', () => {
    const policy = createViewportQueryPolicy();
    expect(() => policy.plan({ ...input, extent: { ...extent, xmax: 0 } })).toThrow('positive width and height');
    expect(() => policy.plan({ ...input, extent: { ...extent, xmin: Number.NaN } })).toThrow('finite');
  });

  it('rejects oversized extents before transport execution', () => {
    const policy = createViewportQueryPolicy({ maxExtentArea: 100 });
    expect(() => policy.plan(input)).toThrow('maxExtentArea');
  });

  it('rejects oversized viewport allocations', () => {
    const policy = createViewportQueryPolicy({ maxPixelArea: 100 });
    expect(() => policy.plan(input)).toThrow('maxPixelArea');
  });

  it('rejects scales outside the configured service policy', () => {
    const policy = createViewportQueryPolicy({ minScale: 100, maxScale: 1_000 });
    expect(() => policy.plan({ ...input, scale: 99 })).toThrow('outside configured query range');
    expect(() => policy.plan({ ...input, scale: 1_001 })).toThrow('outside configured query range');
  });

  it('rejects excessive requested fields', () => {
    const policy = createViewportQueryPolicy({ maxFields: 2 });
    expect(() => policy.plan({ ...input, requestedFields: ['a', 'b', 'c'] })).toThrow('maxFields');
  });

  it('ignores empty field names but never emits them', () => {
    const policy = createViewportQueryPolicy();
    expect(policy.plan({ ...input, requestedFields: [' ', 'id'] }).fields).toEqual(['id']);
  });

  it('rejects invalid configuration eagerly', () => {
    expect(() => createViewportQueryPolicy({ maxFeatures: 0 })).toThrow('maxFeatures');
    expect(() => createViewportQueryPolicy({ minScale: 10, maxScale: 5 })).toThrow('minScale');
    expect(() => createViewportQueryPolicy({ extentPrecision: 20 })).toThrow('extentPrecision');
  });

  it('trims layer and spatial-reference identities', () => {
    const policy = createViewportQueryPolicy();
    const plan = policy.plan({
      ...input,
      layerId: ' roads ',
      extent: { ...extent, spatialReference: ' EPSG:3857 ' },
    });
    expect(plan.layerId).toBe('roads');
    expect(plan.extent.spatialReference).toBe('EPSG:3857');
  });

  it('uses extent precision to suppress insignificant viewport jitter', () => {
    const policy = createViewportQueryPolicy({ extentPrecision: 2 });
    const first = policy.plan(input);
    const second = policy.plan({ ...input, extent: { ...extent, xmin: 0.001 } });
    expect(second.key).toBe(first.key);
  });

  it('changes the key for meaningful viewport movement', () => {
    const policy = createViewportQueryPolicy({ extentPrecision: 2 });
    const first = policy.plan(input);
    const second = policy.plan({ ...input, extent: { ...extent, xmin: 1 } });
    expect(second.key).not.toBe(first.key);
  });
});
