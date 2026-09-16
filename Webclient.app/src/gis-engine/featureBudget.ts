export const FEATURE_RENDER_STRATEGY = Object.freeze({
  DIRECT: 'direct',
  CLUSTER: 'cluster',
  PAGED: 'paged',
  SUMMARY: 'summary',
});

export type FeatureRenderStrategy = typeof FEATURE_RENDER_STRATEGY[keyof typeof FEATURE_RENDER_STRATEGY];
export type FeatureGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon' | string;

export interface FeaturePressureInput {
  featureCount?: unknown;
  geometryType?: FeatureGeometryType;
  averageVertices?: unknown;
  hasLabels?: boolean;
  hasPictures?: boolean;
  supportsClustering?: boolean;
  serviceMaxRecordCount?: unknown;
}

export interface FeatureRenderBudget {
  clusterThreshold?: unknown;
  maxVisibleFeatures?: unknown;
}

export interface FeatureRenderPlan {
  strategy: FeatureRenderStrategy;
  featureCount: number;
  pressure: number;
  clusterThreshold: number;
  maxVisibleFeatures: number;
  pageSize: number | null;
  shouldCluster: boolean;
  shouldPaginate: boolean;
  shouldUseSummary: boolean;
  reason: string;
}

export interface ClusterFieldLike {
  name?: string;
  alias?: string;
  onStatisticField?: string;
  statisticType?: string;
  [key: string]: unknown;
}

export interface ClusterConfigurationOptions {
  radius?: unknown;
  popupEnabled?: boolean;
  fields?: Array<ClusterFieldLike | string | null | undefined>;
}

export interface ClusterConfiguration {
  type: 'cluster';
  clusterRadius: string;
  popupEnabled: boolean;
  fields: Array<ClusterFieldLike | string>;
}

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value: unknown, fallback: number): number => {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? Math.floor(numeric) : fallback;
};

const normalizeGeometryType = (geometryType?: FeatureGeometryType): string => String(geometryType || '').toLowerCase();

export const estimateFeaturePressure = ({
  featureCount,
  geometryType,
  averageVertices = 1,
  hasLabels = false,
  hasPictures = false,
}: FeaturePressureInput = {}): number => {
  const count = Math.max(0, positiveInteger(featureCount, 0));
  const vertices = Math.max(1, positiveInteger(averageVertices, 1));
  const normalizedGeometryType = normalizeGeometryType(geometryType);
  const geometryWeight = normalizedGeometryType === 'polygon'
    ? 3
    : normalizedGeometryType === 'polyline'
      ? 2
      : 1;
  const labelWeight = hasLabels ? 1.35 : 1;
  const pictureWeight = hasPictures ? 1.6 : 1;
  return Math.round(count * vertices * geometryWeight * labelWeight * pictureWeight);
};

export const planFeatureRendering = (
  input: FeaturePressureInput = {},
  budget: FeatureRenderBudget = {},
): FeatureRenderPlan => {
  const count = Math.max(0, positiveInteger(input.featureCount, 0));
  const clusterThreshold = positiveInteger(budget.clusterThreshold, 800);
  const maxVisibleFeatures = positiveInteger(budget.maxVisibleFeatures, 6500);
  const pressure = estimateFeaturePressure(input);
  const geometryType = normalizeGeometryType(input.geometryType);
  const pointLike = geometryType === 'point' || geometryType === 'multipoint' || !geometryType;
  const clusteringAllowed = input.supportsClustering !== false && pointLike;

  let strategy: FeatureRenderStrategy = FEATURE_RENDER_STRATEGY.DIRECT;
  if (count > maxVisibleFeatures * 4 || pressure > maxVisibleFeatures * 30) {
    strategy = FEATURE_RENDER_STRATEGY.SUMMARY;
  } else if (count > maxVisibleFeatures || pressure > maxVisibleFeatures * 12) {
    strategy = FEATURE_RENDER_STRATEGY.PAGED;
  } else if (clusteringAllowed && count >= clusterThreshold) {
    strategy = FEATURE_RENDER_STRATEGY.CLUSTER;
  }

  const pageSize = strategy === FEATURE_RENDER_STRATEGY.PAGED
    ? Math.max(100, Math.min(maxVisibleFeatures, positiveInteger(input.serviceMaxRecordCount, maxVisibleFeatures)))
    : null;

  return Object.freeze({
    strategy,
    featureCount: count,
    pressure,
    clusterThreshold,
    maxVisibleFeatures,
    pageSize,
    shouldCluster: strategy === FEATURE_RENDER_STRATEGY.CLUSTER,
    shouldPaginate: strategy === FEATURE_RENDER_STRATEGY.PAGED,
    shouldUseSummary: strategy === FEATURE_RENDER_STRATEGY.SUMMARY,
    reason: strategy === FEATURE_RENDER_STRATEGY.DIRECT ? 'within-budget' : `${strategy}-budget`,
  });
};

export const createClusterConfiguration = (
  plan: FeatureRenderPlan | null | undefined,
  options: ClusterConfigurationOptions = {},
): ClusterConfiguration | null => {
  if (!plan || !plan.shouldCluster) return null;
  const radius = Math.max(24, Math.min(96, positiveInteger(options.radius, 48)));
  const fields = Array.isArray(options.fields)
    ? options.fields.filter((field): field is ClusterFieldLike | string => Boolean(field))
    : [];
  return Object.freeze({
    type: 'cluster' as const,
    clusterRadius: `${radius}px`,
    popupEnabled: options.popupEnabled !== false,
    fields,
  });
};
