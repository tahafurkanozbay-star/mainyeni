import {
  create3DGraphicModel,
  createPictureMarkerSymbol,
  getIconKey,
} from './iconPresentation';
import {
  FEATURE_RENDER_STRATEGY,
  createClusterConfiguration,
  planFeatureRendering,
} from './featureBudget';

export const GIS_VIEW_MODE = Object.freeze({
  MAP_2D: '2d',
  SCENE_3D: '3d',
});

export const GIS_LOD_TIER = Object.freeze({
  OVERVIEW: 'overview',
  REGIONAL: 'regional',
  LOCAL: 'local',
  DETAIL: 'detail',
});

export const LABEL_DENSITY = Object.freeze({
  NONE: 'none',
  SPARSE: 'sparse',
  NORMAL: 'normal',
  DENSE: 'dense',
});

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalizeMode = (value) => value === GIS_VIEW_MODE.SCENE_3D ? GIS_VIEW_MODE.SCENE_3D : GIS_VIEW_MODE.MAP_2D;

const normalizeGeometryType = (value) => {
  const normalized = String(value || '').toLowerCase().replace('esrigeometry', '');
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('polyline') || normalized.includes('line')) return 'polyline';
  if (normalized.includes('multipoint')) return 'multipoint';
  return 'point';
};

const tierRank = (tier) => ({
  [GIS_LOD_TIER.OVERVIEW]: 0,
  [GIS_LOD_TIER.REGIONAL]: 1,
  [GIS_LOD_TIER.LOCAL]: 2,
  [GIS_LOD_TIER.DETAIL]: 3,
}[tier] ?? 0);

const tierFromScale = (scale) => {
  const numeric = finite(scale, Infinity);
  if (numeric >= 150000) return GIS_LOD_TIER.OVERVIEW;
  if (numeric >= 30000) return GIS_LOD_TIER.REGIONAL;
  if (numeric >= 5000) return GIS_LOD_TIER.LOCAL;
  return GIS_LOD_TIER.DETAIL;
};

const tierFromCameraDistance = (distanceMeters) => {
  const distance = finite(distanceMeters, Infinity);
  if (distance >= 120000) return GIS_LOD_TIER.OVERVIEW;
  if (distance >= 30000) return GIS_LOD_TIER.REGIONAL;
  if (distance >= 5000) return GIS_LOD_TIER.LOCAL;
  return GIS_LOD_TIER.DETAIL;
};

export const resolveLodTier = ({ mode, scale, cameraDistanceMeters } = {}, previousTier = null, hysteresis = 0.12) => {
  const viewMode = normalizeMode(mode);
  const next = viewMode === GIS_VIEW_MODE.SCENE_3D
    ? tierFromCameraDistance(cameraDistanceMeters)
    : tierFromScale(scale);
  if (!previousTier || previousTier === next) return next;

  const margin = clamp(finite(hysteresis, 0.12), 0, 0.45);
  if (viewMode === GIS_VIEW_MODE.MAP_2D) {
    const thresholds = {
      [GIS_LOD_TIER.OVERVIEW]: 150000,
      [GIS_LOD_TIER.REGIONAL]: 30000,
      [GIS_LOD_TIER.LOCAL]: 5000,
    };
    const previousRank = tierRank(previousTier);
    const nextRank = tierRank(next);
    const boundaryTier = nextRank > previousRank ? previousTier : next;
    const boundary = thresholds[boundaryTier];
    const numericScale = finite(scale, Infinity);
    if (boundary) {
      if (nextRank > previousRank && numericScale > boundary * (1 - margin)) return previousTier;
      if (nextRank < previousRank && numericScale < boundary * (1 + margin)) return previousTier;
    }
  }

  if (viewMode === GIS_VIEW_MODE.SCENE_3D) {
    const thresholds = {
      [GIS_LOD_TIER.OVERVIEW]: 120000,
      [GIS_LOD_TIER.REGIONAL]: 30000,
      [GIS_LOD_TIER.LOCAL]: 5000,
    };
    const previousRank = tierRank(previousTier);
    const nextRank = tierRank(next);
    const boundaryTier = nextRank > previousRank ? previousTier : next;
    const boundary = thresholds[boundaryTier];
    const distance = finite(cameraDistanceMeters, Infinity);
    if (boundary) {
      if (nextRank > previousRank && distance > boundary * (1 - margin)) return previousTier;
      if (nextRank < previousRank && distance < boundary * (1 + margin)) return previousTier;
    }
  }

  return next;
};

export const lodPresentationBudget = (tier, performanceBudget = {}, mode = GIS_VIEW_MODE.MAP_2D) => {
  const quality = clamp(finite(performanceBudget.sceneQuality, 0.78), 0.25, 1);
  const visibleFeatureBudget = Math.max(250, Math.floor(finite(performanceBudget.maxVisibleFeatures, 6500)));
  const factor = {
    [GIS_LOD_TIER.OVERVIEW]: 0.25,
    [GIS_LOD_TIER.REGIONAL]: 0.5,
    [GIS_LOD_TIER.LOCAL]: 0.8,
    [GIS_LOD_TIER.DETAIL]: 1,
  }[tier] ?? 0.5;
  const sceneFactor = normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D ? quality : 1;
  const labelDensity = factor <= 0.25
    ? LABEL_DENSITY.NONE
    : factor <= 0.5
      ? LABEL_DENSITY.SPARSE
      : factor < 1
        ? LABEL_DENSITY.NORMAL
        : LABEL_DENSITY.DENSE;

  return Object.freeze({
    tier,
    maxVisibleFeatures: Math.max(100, Math.floor(visibleFeatureBudget * factor * sceneFactor)),
    vertexFactor: factor * sceneFactor,
    symbolScale: clamp(0.7 + (factor * 0.3), 0.7, 1),
    labelDensity,
    allowLabels: labelDensity !== LABEL_DENSITY.NONE,
    allowExtrusion: normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D && tierRank(tier) >= tierRank(GIS_LOD_TIER.LOCAL) && quality >= 0.65,
    allowShadows: normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D && tier === GIS_LOD_TIER.DETAIL && quality >= 0.9,
  });
};

const labelConfig = (options, density) => {
  if (!options?.labelField || density === LABEL_DENSITY.NONE) return null;
  const deconfliction = density === LABEL_DENSITY.SPARSE ? 'static' : 'dynamic';
  const maxScale = density === LABEL_DENSITY.SPARSE ? 30000 : 0;
  return Object.freeze({
    labelExpressionInfo: { expression: `$feature.${String(options.labelField)}` },
    deconflictionStrategy: deconfliction,
    minScale: finite(options.labelMinScale, 0) || 0,
    maxScale: finite(options.labelMaxScale, maxScale) || maxScale,
  });
};

const pointSymbol = (record, context, options) => {
  if (context.mode === GIS_VIEW_MODE.SCENE_3D) {
    return create3DGraphicModel(record, {
      fallback: options.fallbackIcon,
    });
  }
  return createPictureMarkerSymbol(record, finite(context.zoom, 12), {
    fallback: options.fallbackIcon,
    minSize: finite(options.minIconSize, 24),
    maxSize: finite(options.maxIconSize, 48),
    zoomThreshold: finite(options.zoomThreshold, 10),
  });
};

export const createSharedPointPresentation = (record, context = {}, options = {}) => Object.freeze({
  iconKey: getIconKey(record, { fallback: options.fallbackIcon }),
  mode: normalizeMode(context.mode),
  symbol: pointSymbol(record, { ...context, mode: normalizeMode(context.mode) }, options),
});

const generalizationTolerance = (geometryType, tier, performanceBudget) => {
  if (geometryType === 'point' || geometryType === 'multipoint') return 0;
  const quality = clamp(finite(performanceBudget.sceneQuality, 0.78), 0.25, 1);
  const base = geometryType === 'polygon' ? 2 : 1;
  const tierFactor = {
    [GIS_LOD_TIER.OVERVIEW]: 8,
    [GIS_LOD_TIER.REGIONAL]: 4,
    [GIS_LOD_TIER.LOCAL]: 1.5,
    [GIS_LOD_TIER.DETAIL]: 0,
  }[tier] ?? 2;
  return Number((base * tierFactor * (1.15 - quality * 0.15)).toFixed(2));
};

const verifiedMaxAllowableOffset = (geometryType, options = {}) => {
  if (geometryType === 'point' || geometryType === 'multipoint') return undefined;
  if (options.allowGeneralization !== true) return undefined;
  const explicitTolerance = finite(options.generalizationTolerance, null);
  return explicitTolerance !== null && explicitTolerance > 0 ? explicitTolerance : undefined;
};

const recommendedOutFields = (options = {}) => {
  const fields = [
    options.objectIdField,
    options.labelField,
    options.categoryField,
    ...(options.requiredFields || []),
  ].filter(Boolean).map(String);
  return [...new Set(fields)];
};

export const planLayerPresentation = ({
  layer = {},
  featureStats = {},
  view = {},
  performanceBudget = {},
  previousTier = null,
  options = {},
} = {}) => {
  const mode = normalizeMode(view.mode);
  const geometryType = normalizeGeometryType(
    featureStats.geometryType || layer.geometryType || layer.source?.geometryType,
  );
  const tier = resolveLodTier({
    mode,
    scale: view.scale,
    cameraDistanceMeters: view.cameraDistanceMeters,
  }, previousTier, options.hysteresis);
  const lodBudget = lodPresentationBudget(tier, performanceBudget, mode);
  const renderPlan = planFeatureRendering({
    featureCount: featureStats.featureCount,
    geometryType,
    averageVertices: featureStats.averageVertices,
    hasLabels: Boolean(options.labelField),
    hasPictures: geometryType === 'point' && Boolean(options.hasPictures),
    supportsClustering: options.supportsClustering,
    serviceMaxRecordCount: featureStats.serviceMaxRecordCount,
  }, {
    ...performanceBudget,
    maxVisibleFeatures: Math.min(
      finite(performanceBudget.maxVisibleFeatures, 6500),
      lodBudget.maxVisibleFeatures,
    ),
  });

  const featureReduction = renderPlan.shouldCluster
    ? createClusterConfiguration(renderPlan, {
      radius: options.clusterRadius,
      popupEnabled: options.clusterPopupEnabled,
      fields: recommendedOutFields(options),
    })
    : null;

  const labels = labelConfig(options, lodBudget.labelDensity);
  const simplificationTolerance = generalizationTolerance(geometryType, tier, performanceBudget);
  const maxAllowableOffset = verifiedMaxAllowableOffset(geometryType, options);
  const opacity = clamp(finite(layer.opacity ?? layer.runtime?.opacity, 1), 0, 1);

  return Object.freeze({
    layerId: String(layer.id ?? layer.layerId ?? ''),
    mode,
    geometryType,
    tier,
    lodBudget,
    renderPlan,
    featureReduction,
    labels,
    opacity,
    simplificationTolerance,
    request: Object.freeze({
      outFields: recommendedOutFields(options),
      returnGeometry: options.returnGeometry !== false,
      maxAllowableOffset,
      resultRecordCount: renderPlan.pageSize || undefined,
    }),
    renderer: Object.freeze({
      strategy: renderPlan.strategy,
      useSharedIconResolver: geometryType === 'point' || geometryType === 'multipoint',
      allowExtrusion: lodBudget.allowExtrusion && geometryType === 'polygon',
      allowShadows: lodBudget.allowShadows,
      labelDensity: lodBudget.labelDensity,
    }),
  });
};

export const shouldRefreshPresentation = (previous, next) => {
  if (!previous) return true;
  if (!next) return false;
  if (previous.mode !== next.mode) return true;
  if (previous.tier !== next.tier) return true;
  if (previous.renderPlan?.strategy !== next.renderPlan?.strategy) return true;
  if (previous.renderPlan?.pageSize !== next.renderPlan?.pageSize) return true;
  if (previous.lodBudget?.labelDensity !== next.lodBudget?.labelDensity) return true;
  if (previous.renderer?.allowExtrusion !== next.renderer?.allowExtrusion) return true;
  if (previous.simplificationTolerance !== next.simplificationTolerance) return true;
  if (previous.request?.maxAllowableOffset !== next.request?.maxAllowableOffset) return true;
  return false;
};

export const createPresentationState = (configuration = {}) => {
  const states = new Map();

  const plan = (input) => {
    const layerId = String(input?.layer?.id ?? input?.layer?.layerId ?? '');
    const previous = states.get(layerId) || null;
    const next = planLayerPresentation({
      ...input,
      previousTier: previous?.tier,
      performanceBudget: input?.performanceBudget || configuration.performanceBudget || {},
    });
    const changed = shouldRefreshPresentation(previous, next);
    states.set(layerId, next);
    return { changed, previous, next };
  };

  return Object.freeze({
    plan,
    get: (layerId) => states.get(String(layerId)) || null,
    forget: (layerId) => states.delete(String(layerId)),
    clear: () => states.clear(),
    size: () => states.size,
  });
};

export const isSummaryPresentation = (presentation) => (
  presentation?.renderPlan?.strategy === FEATURE_RENDER_STRATEGY.SUMMARY
);
