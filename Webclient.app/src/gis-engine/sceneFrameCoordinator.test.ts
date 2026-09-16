import { describe, expect, it } from 'vitest';
import { createSceneFrameCoordinator } from './sceneFrameCoordinator';
import type { SceneFrameContext, SceneLayerEstimate, SceneLayerLodPolicy } from './sceneLodPlanner';

const context = (overrides: Partial<SceneFrameContext> = {}): SceneFrameContext => ({
  mode: '2d',
  scale: 2_000,
  cameraDistance: 500,
  screenCoverage: 0.5,
  intersectsFrustum: true,
  ...overrides,
});

const estimate = (overrides: Partial<SceneLayerEstimate> = {}): SceneLayerEstimate => ({
  featureCount: 1_000,
  labelCount: 100,
  cpuBytesPerFeature: 64,
  gpuBytesPerFeature: 96,
  drawCalls: 10,
  ...overrides,
});

const policy = (layerId: string, overrides: Partial<SceneLayerLodPolicy> = {}): SceneLayerLodPolicy => ({
  layerId,
  maxVisibleFeatures: 1_000,
  maxLabels: 100,
  ...overrides,
});

const layer = (layerId: string, policyOverrides: Partial<SceneLayerLodPolicy> = {}, estimateOverrides: Partial<SceneLayerEstimate> = {}) => ({
  policy: policy(layerId, policyOverrides),
  estimate: estimate(estimateOverrides),
});

describe('sceneFrameCoordinator', () => {
  it('admits planned resources and keeps stable ownership across identical frames', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    const first = coordinator.reconcile([layer('roads')], context());
    expect(first.generation).toBe(1);
    expect(first.admissions[0]?.admittedResourceIds).toEqual(['roads:features:fine', 'roads:labels:fine']);
    expect(first.releasedResourceIds).toEqual([]);
    expect(first.snapshot.usage.resources).toBe(2);

    const second = coordinator.reconcile([layer('roads')], context());
    expect(second.generation).toBe(2);
    expect(second.admissions[0]?.admittedResourceIds).toEqual(['roads:features:fine', 'roads:labels:fine']);
    expect(second.releasedResourceIds).toEqual([]);
    expect(second.snapshot.usage.resources).toBe(2);
  });

  it('releases fine resources before replacing them with a lower LOD', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('buildings')], context());

    const next = coordinator.reconcile([layer('buildings')], context({ cameraDistance: 8_000, screenCoverage: 0.05 }));
    expect(next.releasedResourceIds).toEqual(expect.arrayContaining(['buildings:features:fine', 'buildings:labels:fine']));
    expect(next.admissions[0]?.decision.quality).toBe('medium');
    expect(next.admissions[0]?.admittedResourceIds).toEqual(['buildings:features:medium', 'buildings:labels:medium']);
    expect(next.snapshot.resources.map((resource) => resource.id)).toEqual(['buildings:features:medium', 'buildings:labels:medium']);
  });

  it('releases resources when a layer becomes frustum culled', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '3d' });
    coordinator.reconcile([layer('terrain')], context({ mode: '3d' }));

    const hidden = coordinator.reconcile([layer('terrain')], context({ mode: '3d', intersectsFrustum: false }));
    expect(hidden.admissions[0]?.decision.visible).toBe(false);
    expect(hidden.admissions[0]?.decision.reason).toBe('outside-frustum');
    expect(hidden.admissions[0]?.admittedResourceIds).toEqual([]);
    expect(hidden.releasedResourceIds).toHaveLength(2);
    expect(hidden.snapshot.usage.resources).toBe(0);
  });

  it('releases resources for layers removed from the frame', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('a'), layer('b')], context());
    const next = coordinator.reconcile([layer('b')], context());
    expect(next.releasedResourceIds).toEqual(expect.arrayContaining(['a:features:fine', 'a:labels:fine']));
    expect(next.snapshot.resources.every((resource) => resource.layerId === 'b')).toBe(true);
  });

  it('replaces same-id resources when estimates change', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('parcels', {}, { cpuBytesPerFeature: 64 })], context());
    const next = coordinator.reconcile([layer('parcels', {}, { cpuBytesPerFeature: 128 })], context());
    expect(next.releasedResourceIds).toContain('parcels:features:fine');
    expect(next.admissions[0]?.admittedResourceIds).toContain('parcels:features:fine');
    const feature = next.snapshot.resources.find((resource) => resource.id === 'parcels:features:fine');
    expect(feature?.estimatedCpuBytes).toBe(128_000);
  });

  it('lets higher-priority interactive resources evict prefetch allocations', () => {
    const coordinator = createSceneFrameCoordinator({
      mode: '2d',
      limits: { maxResources: 2, maxResourcesPerLayer: 2, maxCpuBytes: 10_000_000, maxGpuBytes: 10_000_000, maxDrawCalls: 1_000, maxFeatures: 10_000 },
    });

    coordinator.reconcile([layer('background')], context({ cameraDistance: 30_000, screenCoverage: 0.005 }));
    const next = coordinator.reconcile([
      layer('background'),
      layer('selected'),
    ], context({ interactionActive: true }));

    expect(next.snapshot.resources.every((resource) => resource.layerId === 'selected')).toBe(true);
    expect(next.releasedResourceIds).toEqual(expect.arrayContaining(['background:features:coarse', 'background:labels:coarse']));
    expect(next.admissions.find((entry) => entry.layerId === 'selected')?.admittedResourceIds).toHaveLength(2);
  });

  it('does not report resources as admitted after a later admission evicts them', () => {
    const coordinator = createSceneFrameCoordinator({
      mode: '2d',
      limits: { maxResources: 2, maxResourcesPerLayer: 2, maxCpuBytes: 10_000_000, maxGpuBytes: 10_000_000, maxDrawCalls: 1_000, maxFeatures: 10_000 },
    });

    const result = coordinator.reconcile([
      layer('background'),
      layer('foreground'),
    ], context({ interactionActive: true }));
    const actual = new Set(result.snapshot.resources.map((resource) => resource.id));
    for (const admission of result.admissions) {
      for (const id of admission.admittedResourceIds) expect(actual.has(id)).toBe(true);
    }
  });

  it('rejects duplicate layer ids before mutating ownership', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    expect(() => coordinator.reconcile([layer('roads'), layer(' roads ')], context())).toThrow(/Duplicate scene layer id/);
    expect(coordinator.snapshot().usage.resources).toBe(0);
  });

  it('allows invalid blank layer policies to fail closed through the planner', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    const result = coordinator.reconcile([layer('   ')], context());
    expect(result.admissions[0]?.decision.visible).toBe(false);
    expect(result.admissions[0]?.decision.reason).toBe('invalid');
    expect(result.snapshot.usage.resources).toBe(0);
  });

  it('supports explicit layer release without disturbing other ownership', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('roads'), layer('water')], context());
    expect(coordinator.releaseLayer('roads')).toBe(2);
    expect(coordinator.snapshot().resources.every((resource) => resource.layerId === 'water')).toBe(true);
    expect(coordinator.releaseLayer('missing')).toBe(0);
  });

  it('tracks evictions caused by a runtime budget shrink', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('roads'), layer('water')], context());
    const evicted = coordinator.updateLimits({ maxResources: 1 });
    expect(evicted.length).toBeGreaterThan(0);
    expect(coordinator.snapshot().usage.resources).toBeLessThanOrEqual(1);

    const next = coordinator.reconcile([layer('roads'), layer('water')], context());
    const actual = new Set(next.snapshot.resources.map((resource) => resource.id));
    for (const admission of next.admissions) {
      for (const id of admission.admittedResourceIds) expect(actual.has(id)).toBe(true);
    }
  });

  it('disposes deterministically and rejects later use', () => {
    const coordinator = createSceneFrameCoordinator({ mode: '2d' });
    coordinator.reconcile([layer('roads')], context());
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot()).toThrow(/disposed/);
    expect(() => coordinator.reconcile([], context())).toThrow(/disposed/);
    expect(() => coordinator.updateLimits({ maxResources: 1 })).toThrow(/disposed/);
  });
});
