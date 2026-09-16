import { describe, expect, it } from 'vitest';
import { createSceneLodPlanner, planSceneLayerLod, type SceneFrameContext, type SceneLayerEstimate, type SceneLayerLodPolicy } from './sceneLodPlanner';

const policy: SceneLayerLodPolicy = {
  layerId: 'buildings', minScale: 100, maxScale: 1_000_000, maxDistance: 50_000,
  minScreenCoverage: 0.001, mediumScreenCoverage: 0.02, fineScreenCoverage: 0.15,
  mediumDistance: 15_000, fineDistance: 2_000, maxVisibleFeatures: 10_000, maxLabels: 1_000,
};
const estimate: SceneLayerEstimate = { featureCount: 20_000, labelCount: 2_000, cpuBytesPerFeature: 80, gpuBytesPerFeature: 120, drawCalls: 100 };
const frame = (overrides: Partial<SceneFrameContext> = {}): SceneFrameContext => ({
  mode: '3d', scale: 10_000, cameraDistance: 1_000, screenCoverage: 0.2, intersectsFrustum: true, ...overrides,
});

describe('scene LOD planner', () => {
  it('selects fine LOD for close high-coverage content', () => {
    const result = planSceneLayerLod(policy, frame(), estimate);
    expect(result.visible).toBe(true);
    expect(result.quality).toBe('fine');
    expect(result.featureLimit).toBe(10_000);
    expect(result.labelLimit).toBe(750);
    expect(result.resourceRequests[0]).toMatchObject({ kind: 'mesh', estimatedFeatures: 10_000, estimatedCpuBytes: 800_000, estimatedGpuBytes: 1_200_000 });
  });

  it('degrades feature and label work at medium LOD', () => {
    const result = planSceneLayerLod(policy, frame({ cameraDistance: 8_000, screenCoverage: 0.05 }), estimate);
    expect(result.quality).toBe('medium');
    expect(result.featureLimit).toBe(4_500);
    expect(result.labelLimit).toBe(338);
  });

  it('uses coarse LOD for small distant visible content', () => {
    const result = planSceneLayerLod(policy, frame({ cameraDistance: 30_000, screenCoverage: 0.01 }), estimate);
    expect(result.quality).toBe('coarse');
    expect(result.priority).toBe('prefetch');
    expect(result.featureLimit).toBe(1_200);
  });

  it.each([
    [{ intersectsFrustum: false }, 'outside-frustum'],
    [{ cameraDistance: 60_000 }, 'outside-distance'],
    [{ screenCoverage: 0.0001 }, 'tiny-screen-footprint'],
    [{ scale: 50 }, 'outside-scale'],
    [{ scale: 2_000_000 }, 'outside-scale'],
  ] as const)('culls work before resource admission: %o', (overrides, reason) => {
    const result = planSceneLayerLod(policy, frame(overrides), estimate);
    expect(result.visible).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.resourceRequests).toHaveLength(0);
  });

  it('respects explicit disabled layers', () => {
    expect(planSceneLayerLod({ ...policy, enabled: false }, frame(), estimate).reason).toBe('disabled');
  });

  it('rejects invalid frame facts fail-closed', () => {
    expect(planSceneLayerLod(policy, frame({ screenCoverage: 2 }), estimate).reason).toBe('invalid');
    expect(planSceneLayerLod(policy, frame({ cameraDistance: Number.NaN }), estimate).reason).toBe('invalid');
    expect(planSceneLayerLod(policy, frame({ scale: 0 }), estimate).reason).toBe('invalid');
  });

  it('promotes only interaction-owned layers without inflating LOD', () => {
    const active = planSceneLayerLod({ ...policy, interactionPriority: true }, frame({ interactionActive: true, cameraDistance: 30_000, screenCoverage: 0.01 }), estimate);
    const background = planSceneLayerLod(policy, frame({ interactionActive: true, cameraDistance: 30_000, screenCoverage: 0.01 }), estimate);
    expect(active.quality).toBe('coarse');
    expect(active.priority).toBe('interactive');
    expect(background.priority).toBe('prefetch');
  });

  it('uses feature resources in 2D and does not apply the 3D label reduction', () => {
    const result = planSceneLayerLod(policy, frame({ mode: '2d' }), estimate);
    expect(result.resourceRequests[0]?.kind).toBe('feature');
    expect(result.labelLimit).toBe(1_000);
  });

  it('bounds estimates with malformed negative values rather than propagating them', () => {
    const result = planSceneLayerLod(policy, frame(), { featureCount: -1, labelCount: -2, cpuBytesPerFeature: -4, gpuBytesPerFeature: -5, drawCalls: -1 });
    expect(result.featureLimit).toBe(0);
    expect(result.labelLimit).toBe(0);
    expect(result.resourceRequests).toHaveLength(0);
  });

  it('sorts planMany deterministically with visible and larger work first', () => {
    const planner = createSceneLodPlanner();
    const results = planner.planMany([
      { policy: { ...policy, layerId: 'hidden', enabled: false }, estimate },
      { policy: { ...policy, layerId: 'small', maxVisibleFeatures: 100 }, estimate },
      { policy: { ...policy, layerId: 'large', maxVisibleFeatures: 5_000 }, estimate },
    ], frame());
    expect(results.map((result) => result.layerId)).toEqual(['large', 'small', 'hidden']);
  });
});
