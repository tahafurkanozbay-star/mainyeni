import { describe, expect, it } from 'vitest';
import {
  expandArcgisRuntimeFeatureProfile,
  getArcgisFeatureRequirements,
  planArcgisBundle,
  planArcgisRuntimeProfile,
} from './arcgisBundlePlanner';

describe('arcgisBundlePlanner', () => {
  it('builds a deterministic hybrid 2D/3D bundle without duplicate ESM specifiers', () => {
    const plan = planArcgisRuntimeProfile({
      view: 'hybrid',
      reactiveView: true,
      query: true,
      identify: true,
      featureLayer: true,
      sceneLayer: true,
    }, {
      maxModules: 32,
      maxRelativeWeight: 100,
    });

    expect(plan.complete).toBe(true);
    expect(plan.acceptedFeatures).toContain('map-2d');
    expect(plan.acceptedFeatures).toContain('map-3d');
    expect(plan.moduleIds).toContain('esri/views/MapView');
    expect(plan.moduleIds).toContain('esri/views/SceneView');
    expect(plan.specifiers.length).toBe(new Set(plan.specifiers).size);
    expect(plan.moduleIds.filter((moduleId) => moduleId === 'esri/Map')).toHaveLength(1);
    expect(plan.relativeWeight).toBeGreaterThan(0);
  });

  it('defers an entire feature instead of partially scheduling it when a budget is exhausted', () => {
    const plan = planArcgisBundle([
      { intent: 'map-2d', priority: 100 },
      { intent: 'measurement', priority: 10 },
    ], {
      maxModules: 6,
      maxRelativeWeight: 30,
    });

    expect(plan.acceptedFeatures).toEqual(['map-2d']);
    expect(plan.deferredFeatures).toEqual(['measurement']);
    expect(plan.complete).toBe(false);
    expect(plan.moduleIds).not.toContain('esri/widgets/Measurement');
    expect(plan.featurePlans[1]).toMatchObject({
      intent: 'measurement',
      accepted: false,
      reason: 'module-budget',
    });
  });

  it('uses feature priority before input order under a constrained budget', () => {
    const plan = planArcgisBundle([
      { intent: 'imagery-layer', priority: 1 },
      { intent: 'query', priority: 90 },
    ], {
      maxModules: 2,
      maxRelativeWeight: 6,
    });

    expect(plan.acceptedFeatures).toEqual(['query']);
    expect(plan.deferredFeatures).toEqual(['imagery-layer']);
    expect(plan.moduleIds).toEqual(['esri/tasks/QueryTask', 'esri/tasks/support/Query']);
  });

  it('deduplicates repeated feature requests while keeping the highest explicit priority', () => {
    const plan = planArcgisBundle([
      { intent: 'legend', priority: 10 },
      { intent: 'legend', priority: 80 },
      'map-2d',
    ], {
      maxModules: 12,
      maxRelativeWeight: 40,
    });
    const legendPlan = plan.featurePlans.find((item) => item.intent === 'legend');
    expect(plan.requestedFeatures.filter((intent) => intent === 'legend')).toHaveLength(1);
    expect(legendPlan?.priority).toBe(80);
  });

  it('expands runtime profiles without guessing optional features', () => {
    expect(expandArcgisRuntimeFeatureProfile({
      view: '3d',
      measurement: true,
      sceneLayer: true,
    })).toEqual(['map-3d', 'measurement', 'scene-layer']);

    expect(expandArcgisRuntimeFeatureProfile({ view: '2d' })).toEqual(['map-2d']);
  });

  it('exposes immutable feature requirements for audit and planning', () => {
    expect(getArcgisFeatureRequirements('identify')).toEqual([
      'esri/rest/identify',
      'esri/rest/support/IdentifyParameters',
    ]);
    expect(getArcgisFeatureRequirements('projection')).toContain('esri/geometry/projection');
  });

  it('rejects invalid budgets and non-finite priorities', () => {
    expect(() => planArcgisBundle(['map-2d'], {
      maxModules: 0,
      maxRelativeWeight: 10,
    })).toThrow(/maxModules/);

    expect(() => planArcgisBundle([
      { intent: 'map-2d', priority: Number.NaN },
    ], {
      maxModules: 10,
      maxRelativeWeight: 50,
    })).toThrow(/priority/);
  });

  it('uses specifier-level dedupe for modern and compatibility query paths', () => {
    const queryRequirements = getArcgisFeatureRequirements('query');
    expect(queryRequirements).toContain('esri/tasks/QueryTask');
    const plan = planArcgisBundle(['query', 'reactive-view'], {
      maxModules: 8,
      maxRelativeWeight: 30,
    });
    expect(plan.specifiers).toContain('@arcgis/core/rest/query.js');
    expect(plan.specifiers).toContain('@arcgis/core/core/reactiveUtils.js');
    expect(plan.specifiers.length).toBe(plan.moduleIds.length);
  });
});
