const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positiveInteger = (value, fallback) => {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? Math.floor(numeric) : fallback;
};

export const FEATURE_RENDER_STRATEGY = Object.freeze({
  DIRECT: 'direct',
  CLUSTER: 'cluster',
  PAGED: 'paged',
  SUMMARY: 'summary',
});

export const estimateFeaturePressure = ({ featureCount, geometryType, averageVertices = 1, hasLabels = false, hasPictures = false } = {}) => {
  const count = Math.max(0, positiveInteger(featureCount, 0));
  const vertices = Math.max(1, positiveInteger(averageVertices, 1));
  const geometryWeight = geometryType === 'polygon' ? 3 : geometryType === 'polyline' ? 2 : 1;
  const labelWeight = hasLabels ? 1.35 : 1;
  const pictureWeight = hasPictures ? 1.6 : 1;
  return Math.round(count * vertices * geometryWeight * labelWeight * pictureWeight);
};

export const planFeatureRendering = (input = {}, budget = {}) => {
  const count = Math.max(0, positiveInteger(input.featureCount, 0));
  const clusterThreshold = positiveInteger(budget.clusterThreshold, 800);
  const maxVisibleFeatures = positiveInteger(budget.maxVisibleFeatures, 6500);
  const pressure = estimateFeaturePressure(input);
  const pointLike = input.geometryType === 'point' || input.geometryType === 'multipoint' || !input.geometryType;
  const clusteringAllowed = input.supportsClustering !== false && pointLike;

  let strategy = FEATURE_RENDER_STRATEGY.DIRECT;
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

export const createClusterConfiguration = (plan, options = {}) => {
  if (!plan?.shouldCluster) return null;
  const radius = Math.max(24, Math.min(96, positiveInteger(options.radius, 48)));
  return Object.freeze({
    type: 'cluster',
    clusterRadius: `${radius}px`,
    popupEnabled: options.popupEnabled !== false,
    fields: Array.isArray(options.fields) ? options.fields.filter(Boolean) : [],
  });
};
