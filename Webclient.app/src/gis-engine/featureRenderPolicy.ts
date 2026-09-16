export type RenderPressure = 'low' | 'moderate' | 'high' | 'critical';
export type RenderStrategy = 'direct' | 'cluster' | 'paged' | 'summary';

export type FeatureRenderInput = Readonly<{
  featureCount: number;
  geometryType: 'point' | 'multipoint' | 'polyline' | 'polygon' | 'unknown';
  scale: number;
  mode: '2d' | '3d';
  pressure: RenderPressure;
  supportsClustering: boolean;
  supportsPagination: boolean;
  interactive: boolean;
}>;

export type FeatureRenderDecision = Readonly<{
  strategy: RenderStrategy;
  pageSize: number;
  clusterRadius: number;
  maxVisibleFeatures: number;
  labelsEnabled: boolean;
  popupEnabled: boolean;
  reason: string;
}>;

const pressureMultiplier: Readonly<Record<RenderPressure, number>> = Object.freeze({
  low: 1,
  moderate: 0.75,
  high: 0.5,
  critical: 0.25,
});

const geometryBudget = (geometryType: FeatureRenderInput['geometryType'], mode: FeatureRenderInput['mode']): number => {
  const base = geometryType === 'point' || geometryType === 'multipoint'
    ? 12_000
    : geometryType === 'polyline'
      ? 4_000
      : geometryType === 'polygon'
        ? 2_000
        : 1_500;
  return mode === '3d' ? Math.floor(base * 0.6) : base;
};

export const decideFeatureRenderPolicy = (input: FeatureRenderInput): FeatureRenderDecision => {
  const count = Math.max(0, Math.floor(Number(input.featureCount) || 0));
  const scale = Math.max(1, Number(input.scale) || 1);
  const budget = Math.max(100, Math.floor(geometryBudget(input.geometryType, input.mode) * pressureMultiplier[input.pressure]));
  const denseOverview = scale > 250_000;
  const labelsEnabled = input.pressure === 'low' && count <= Math.floor(budget * 0.5) && scale < 100_000;
  const popupEnabled = input.interactive && input.pressure !== 'critical';

  if (count <= budget) {
    return Object.freeze({
      strategy: 'direct',
      pageSize: budget,
      clusterRadius: 0,
      maxVisibleFeatures: budget,
      labelsEnabled,
      popupEnabled,
      reason: 'feature-count-within-device-budget',
    });
  }

  if ((input.geometryType === 'point' || input.geometryType === 'multipoint') && input.supportsClustering && denseOverview) {
    return Object.freeze({
      strategy: 'cluster',
      pageSize: budget,
      clusterRadius: input.pressure === 'critical' ? 96 : input.pressure === 'high' ? 80 : 64,
      maxVisibleFeatures: budget,
      labelsEnabled: false,
      popupEnabled,
      reason: 'dense-point-overview-clustered',
    });
  }

  if (input.supportsPagination) {
    return Object.freeze({
      strategy: 'paged',
      pageSize: Math.max(100, Math.min(2_000, budget)),
      clusterRadius: 0,
      maxVisibleFeatures: budget,
      labelsEnabled: false,
      popupEnabled,
      reason: 'feature-count-exceeds-render-budget',
    });
  }

  return Object.freeze({
    strategy: 'summary',
    pageSize: 0,
    clusterRadius: 0,
    maxVisibleFeatures: Math.min(500, budget),
    labelsEnabled: false,
    popupEnabled: false,
    reason: 'unbounded-service-requires-summary-mode',
  });
};
