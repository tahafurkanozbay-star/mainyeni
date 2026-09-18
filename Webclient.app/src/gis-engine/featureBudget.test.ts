import {
  FEATURE_RENDER_STRATEGY,
  createClusterConfiguration,
  estimateFeaturePressure,
  planFeatureRendering,
} from './featureBudget';

describe('featureBudget', () => {
  test('keeps small datasets direct', () => {
    expect(planFeatureRendering({ featureCount: 20, geometryType: 'point' }, { clusterThreshold: 100 }).strategy)
      .toBe(FEATURE_RENDER_STRATEGY.DIRECT);
  });

  test('clusters point datasets above threshold', () => {
    const plan = planFeatureRendering({ featureCount: 900, geometryType: 'point' }, { clusterThreshold: 800, maxVisibleFeatures: 6500 });
    expect(plan.shouldCluster).toBe(true);
    expect(createClusterConfiguration(plan)).toMatchObject({ type: 'cluster', clusterRadius: '48px' });
  });

  test('does not cluster polygon datasets', () => {
    expect(planFeatureRendering({ featureCount: 1000, geometryType: 'polygon' }, { clusterThreshold: 100 }).shouldCluster).toBe(false);
  });

  test('paginates datasets beyond visible budget', () => {
    const plan = planFeatureRendering({ featureCount: 7000, geometryType: 'point', serviceMaxRecordCount: 2000 }, { maxVisibleFeatures: 6500, clusterThreshold: 800 });
    expect(plan.strategy).toBe(FEATURE_RENDER_STRATEGY.PAGED);
    expect(plan.pageSize).toBe(2000);
  });

  test('uses summary for extreme feature pressure', () => {
    const plan = planFeatureRendering({ featureCount: 100000, geometryType: 'polygon', averageVertices: 50 }, { maxVisibleFeatures: 5000 });
    expect(plan.strategy).toBe(FEATURE_RENDER_STRATEGY.SUMMARY);
  });

  test('weights complex geometry and labels', () => {
    expect(estimateFeaturePressure({ featureCount: 10, geometryType: 'polygon', averageVertices: 5, hasLabels: true }))
      .toBeGreaterThan(estimateFeaturePressure({ featureCount: 10, geometryType: 'point' }));
  });

  test('returns no cluster configuration when clustering is not selected', () => {
    expect(createClusterConfiguration(planFeatureRendering({ featureCount: 10 }))).toBeNull();
  });
});
