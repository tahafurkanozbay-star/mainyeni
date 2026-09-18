import {
  GIS_LOD_TIER,
  GIS_VIEW_MODE,
  LABEL_DENSITY,
  createPresentationState,
  createSharedPointPresentation,
  isSummaryPresentation,
  lodPresentationBudget,
  planLayerPresentation,
  resolveLodTier,
  shouldRefreshPresentation,
} from './renderPolicyRuntime';

describe('renderPolicyRuntime', () => {
  test('resolves 2D LOD from map scale', () => {
    expect(resolveLodTier({ mode: '2d', scale: 500000 })).toBe(GIS_LOD_TIER.OVERVIEW);
    expect(resolveLodTier({ mode: '2d', scale: 80000 })).toBe(GIS_LOD_TIER.REGIONAL);
    expect(resolveLodTier({ mode: '2d', scale: 10000 })).toBe(GIS_LOD_TIER.LOCAL);
    expect(resolveLodTier({ mode: '2d', scale: 1000 })).toBe(GIS_LOD_TIER.DETAIL);
  });

  test('resolves 3D LOD from camera distance', () => {
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 300000 })).toBe(GIS_LOD_TIER.OVERVIEW);
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 50000 })).toBe(GIS_LOD_TIER.REGIONAL);
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 10000 })).toBe(GIS_LOD_TIER.LOCAL);
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 1000 })).toBe(GIS_LOD_TIER.DETAIL);
  });

  test('uses hysteresis to avoid 2D LOD flapping around a threshold', () => {
    expect(resolveLodTier({ mode: '2d', scale: 145000 }, GIS_LOD_TIER.OVERVIEW, 0.1))
      .toBe(GIS_LOD_TIER.OVERVIEW);
    expect(resolveLodTier({ mode: '2d', scale: 130000 }, GIS_LOD_TIER.OVERVIEW, 0.1))
      .toBe(GIS_LOD_TIER.REGIONAL);
  });

  test('uses hysteresis to avoid 3D camera LOD flapping', () => {
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 115000 }, GIS_LOD_TIER.OVERVIEW, 0.1))
      .toBe(GIS_LOD_TIER.OVERVIEW);
    expect(resolveLodTier({ mode: '3d', cameraDistanceMeters: 100000 }, GIS_LOD_TIER.OVERVIEW, 0.1))
      .toBe(GIS_LOD_TIER.REGIONAL);
  });

  test('overview budget suppresses labels and aggressively bounds features', () => {
    const budget = lodPresentationBudget(GIS_LOD_TIER.OVERVIEW, {
      maxVisibleFeatures: 8000,
      sceneQuality: 1,
    });
    expect(budget.maxVisibleFeatures).toBe(2000);
    expect(budget.labelDensity).toBe(LABEL_DENSITY.NONE);
    expect(budget.allowLabels).toBe(false);
  });

  test('3D presentation budget scales with current scene quality', () => {
    const quality = lodPresentationBudget(GIS_LOD_TIER.DETAIL, {
      maxVisibleFeatures: 10000,
      sceneQuality: 1,
    }, GIS_VIEW_MODE.SCENE_3D);
    const eco = lodPresentationBudget(GIS_LOD_TIER.DETAIL, {
      maxVisibleFeatures: 10000,
      sceneQuality: 0.5,
    }, GIS_VIEW_MODE.SCENE_3D);
    expect(quality.maxVisibleFeatures).toBeGreaterThan(eco.maxVisibleFeatures);
    expect(quality.allowShadows).toBe(true);
    expect(eco.allowShadows).toBe(false);
  });

  test('creates 2D point presentation through the shared deterministic icon resolver', () => {
    const presentation = createSharedPointPresentation({ type: 'unknown-type', title: 'Record' }, {
      mode: '2d',
      zoom: 13,
    });
    expect(presentation.iconKey).toBeTruthy();
    expect(presentation.symbol).toEqual(expect.objectContaining({
      type: 'picture-marker',
      url: expect.any(String),
    }));
  });

  test('creates 3D point presentation through the same shared icon authority', () => {
    const presentation = createSharedPointPresentation({ category: 'unknown-category', title: 'Record' }, {
      mode: '3d',
    });
    expect(presentation.symbol).toEqual(expect.objectContaining({
      iconKey: expect.any(String),
      billboard: expect.any(String),
    }));
    expect(presentation.iconKey).toBe(presentation.symbol.iconKey);
  });

  test('plans clustering for a medium-density point layer', () => {
    const plan = planLayerPresentation({
      layer: { id: 'poi' },
      featureStats: { featureCount: 1200, geometryType: 'esriGeometryPoint' },
      view: { mode: '2d', scale: 10000 },
      performanceBudget: {
        maxVisibleFeatures: 6500,
        clusterThreshold: 800,
        sceneQuality: 0.78,
      },
      options: { supportsClustering: true, labelField: 'NAME' },
    });
    expect(plan.renderPlan.shouldCluster).toBe(true);
    expect(plan.featureReduction).toEqual(expect.objectContaining({ type: 'cluster' }));
    expect(plan.renderer.useSharedIconResolver).toBe(true);
  });

  test('polygon overview can recommend simplification without silently changing query coordinates', () => {
    const plan = planLayerPresentation({
      layer: { id: 'districts' },
      featureStats: {
        featureCount: 1000,
        geometryType: 'esriGeometryPolygon',
        averageVertices: 100,
      },
      view: { mode: '2d', scale: 200000 },
      performanceBudget: {
        maxVisibleFeatures: 6500,
        clusterThreshold: 800,
        sceneQuality: 0.78,
      },
    });
    expect(plan.featureReduction).toBeNull();
    expect(plan.simplificationTolerance).toBeGreaterThan(0);
    expect(plan.request.maxAllowableOffset).toBeUndefined();
  });

  test('generalization reaches the ArcGIS request only after explicit verified opt-in', () => {
    const plan = planLayerPresentation({
      layer: { id: 'districts' },
      featureStats: { featureCount: 1000, geometryType: 'polygon', averageVertices: 100 },
      view: { mode: '2d', scale: 200000 },
      options: {
        allowGeneralization: true,
        generalizationTolerance: 2.5,
      },
    });
    expect(plan.request.maxAllowableOffset).toBe(2.5);
  });

  test('generalization rejects zero, negative and implicit tolerances', () => {
    const base = {
      layer: { id: 'districts' },
      featureStats: { featureCount: 1000, geometryType: 'polygon' },
      view: { mode: '2d', scale: 200000 },
    };
    expect(planLayerPresentation({ ...base, options: { allowGeneralization: true, generalizationTolerance: 0 } }).request.maxAllowableOffset)
      .toBeUndefined();
    expect(planLayerPresentation({ ...base, options: { allowGeneralization: true, generalizationTolerance: -1 } }).request.maxAllowableOffset)
      .toBeUndefined();
    expect(planLayerPresentation(base).request.maxAllowableOffset).toBeUndefined();
  });

  test('detail polygon view removes simplification recommendation and request tolerance', () => {
    const plan = planLayerPresentation({
      layer: { id: 'parcels' },
      featureStats: { featureCount: 100, geometryType: 'polygon', averageVertices: 20 },
      view: { mode: '2d', scale: 1000 },
      performanceBudget: { maxVisibleFeatures: 6500, sceneQuality: 1 },
    });
    expect(plan.tier).toBe(GIS_LOD_TIER.DETAIL);
    expect(plan.simplificationTolerance).toBe(0);
    expect(plan.request.maxAllowableOffset).toBeUndefined();
  });

  test('3D local polygon view enables extrusion only when quality allows it', () => {
    const plan = planLayerPresentation({
      layer: { id: 'buildings' },
      featureStats: { featureCount: 1000, geometryType: 'polygon' },
      view: { mode: '3d', cameraDistanceMeters: 10000 },
      performanceBudget: { maxVisibleFeatures: 10000, sceneQuality: 0.9 },
    });
    expect(plan.renderer.allowExtrusion).toBe(true);
  });

  test('3D low-quality mode prevents expensive extrusion and shadow recommendations', () => {
    const plan = planLayerPresentation({
      layer: { id: 'buildings' },
      featureStats: { featureCount: 1000, geometryType: 'polygon' },
      view: { mode: '3d', cameraDistanceMeters: 1000 },
      performanceBudget: { maxVisibleFeatures: 10000, sceneQuality: 0.5 },
    });
    expect(plan.renderer.allowExtrusion).toBe(false);
    expect(plan.renderer.allowShadows).toBe(false);
  });

  test('request fields are minimized to known rendering and identity needs', () => {
    const plan = planLayerPresentation({
      layer: { id: 'poi' },
      featureStats: { featureCount: 10, geometryType: 'point' },
      view: { mode: '2d', scale: 1000 },
      options: {
        objectIdField: 'OBJECTID',
        labelField: 'NAME',
        categoryField: 'TYPE',
        requiredFields: ['ADDRESS', 'NAME'],
      },
    });
    expect(plan.request.outFields).toEqual(['OBJECTID', 'NAME', 'TYPE', 'ADDRESS']);
  });

  test('overview presentation suppresses labels even when a field is configured', () => {
    const plan = planLayerPresentation({
      layer: { id: 'roads' },
      featureStats: { featureCount: 1000, geometryType: 'polyline' },
      view: { mode: '2d', scale: 1000000 },
      options: { labelField: 'NAME' },
    });
    expect(plan.labels).toBeNull();
  });

  test('local presentation builds bounded label configuration', () => {
    const plan = planLayerPresentation({
      layer: { id: 'roads' },
      featureStats: { featureCount: 100, geometryType: 'polyline' },
      view: { mode: '2d', scale: 10000 },
      options: { labelField: 'NAME' },
    });
    expect(plan.labels).toEqual(expect.objectContaining({
      labelExpressionInfo: { expression: '$feature.NAME' },
      deconflictionStrategy: 'dynamic',
    }));
  });

  test('clamps layer opacity to the valid SDK range', () => {
    expect(planLayerPresentation({
      layer: { id: 'x', opacity: 4 },
      featureStats: { featureCount: 0 },
      view: { mode: '2d', scale: 1 },
    }).opacity).toBe(1);
    expect(planLayerPresentation({
      layer: { id: 'x', opacity: -1 },
      featureStats: { featureCount: 0 },
      view: { mode: '2d', scale: 1 },
    }).opacity).toBe(0);
  });

  test('summary strategy is exposed for extreme geometry pressure', () => {
    const plan = planLayerPresentation({
      layer: { id: 'massive-polygons' },
      featureStats: { featureCount: 100000, geometryType: 'polygon', averageVertices: 200 },
      view: { mode: '2d', scale: 200000 },
      performanceBudget: { maxVisibleFeatures: 5000, clusterThreshold: 800, sceneQuality: 0.8 },
    });
    expect(isSummaryPresentation(plan)).toBe(true);
  });

  test('refresh predicate ignores equivalent presentation state', () => {
    const plan = planLayerPresentation({
      layer: { id: 'same' },
      featureStats: { featureCount: 10, geometryType: 'point' },
      view: { mode: '2d', scale: 1000 },
    });
    expect(shouldRefreshPresentation(plan, plan)).toBe(false);
  });

  test('refresh predicate detects LOD, strategy and mode transitions', () => {
    const detail = planLayerPresentation({
      layer: { id: 'layer' },
      featureStats: { featureCount: 10, geometryType: 'point' },
      view: { mode: '2d', scale: 1000 },
    });
    const overview = planLayerPresentation({
      layer: { id: 'layer' },
      featureStats: { featureCount: 100000, geometryType: 'point' },
      view: { mode: '2d', scale: 300000 },
    });
    expect(shouldRefreshPresentation(detail, overview)).toBe(true);
  });

  test('refresh predicate detects verified generalization changes', () => {
    const base = planLayerPresentation({
      layer: { id: 'districts' },
      featureStats: { featureCount: 1000, geometryType: 'polygon' },
      view: { mode: '2d', scale: 200000 },
    });
    const generalized = planLayerPresentation({
      layer: { id: 'districts' },
      featureStats: { featureCount: 1000, geometryType: 'polygon' },
      view: { mode: '2d', scale: 200000 },
      options: { allowGeneralization: true, generalizationTolerance: 3 },
    });
    expect(shouldRefreshPresentation(base, generalized)).toBe(true);
  });

  test('presentation state tracks previous LOD to apply hysteresis consistently', () => {
    const state = createPresentationState();
    const first = state.plan({
      layer: { id: 'layer' },
      featureStats: { featureCount: 100, geometryType: 'point' },
      view: { mode: '2d', scale: 160000 },
    });
    const nearBoundary = state.plan({
      layer: { id: 'layer' },
      featureStats: { featureCount: 100, geometryType: 'point' },
      view: { mode: '2d', scale: 145000 },
      options: { hysteresis: 0.1 },
    });
    expect(first.next.tier).toBe(GIS_LOD_TIER.OVERVIEW);
    expect(nearBoundary.next.tier).toBe(GIS_LOD_TIER.OVERVIEW);
    expect(state.size()).toBe(1);
  });

  test('presentation state can forget destroyed layers', () => {
    const state = createPresentationState();
    state.plan({
      layer: { id: 'transient' },
      featureStats: { featureCount: 1 },
      view: { scale: 1 },
    });
    expect(state.forget('transient')).toBe(true);
    expect(state.get('transient')).toBeNull();
  });
});
