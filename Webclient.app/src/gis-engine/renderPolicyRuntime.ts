import {
  create3DGraphicModel,
  createPictureMarkerSymbol,
  getIconKey,
} from './iconPresentation';
import {
  FEATURE_RENDER_STRATEGY,
  FeatureRenderPlan,
  createClusterConfiguration,
  planFeatureRendering,
} from './featureBudget';
import { Dictionary, IconRecord } from './contracts';

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

export type GisViewMode = typeof GIS_VIEW_MODE[keyof typeof GIS_VIEW_MODE];
export type GisLodTier = typeof GIS_LOD_TIER[keyof typeof GIS_LOD_TIER];
export type LabelDensity = typeof LABEL_DENSITY[keyof typeof LABEL_DENSITY];
export type NormalizedGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon';

export interface LodViewInput {
  mode?: unknown;
  scale?: unknown;
  cameraDistanceMeters?: unknown;
  zoom?: unknown;
}

export interface PresentationPerformanceBudget {
  sceneQuality?: unknown;
  maxVisibleFeatures?: unknown;
  clusterThreshold?: unknown;
  [key: string]: unknown;
}

export interface LodPresentationBudget {
  tier: GisLodTier;
  maxVisibleFeatures: number;
  vertexFactor: number;
  symbolScale: number;
  labelDensity: LabelDensity;
  allowLabels: boolean;
  allowExtrusion: boolean;
  allowShadows: boolean;
}

export interface PresentationLayerLike {
  id?: string | number;
  layerId?: string | number;
  geometryType?: string;
  opacity?: unknown;
  runtime?: { opacity?: unknown; [key: string]: unknown };
  source?: { geometryType?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface FeatureStatsLike {
  geometryType?: string;
  featureCount?: unknown;
  averageVertices?: unknown;
  serviceMaxRecordCount?: unknown;
  [key: string]: unknown;
}

export interface PresentationOptions {
  fallbackIcon?: string;
  minIconSize?: unknown;
  maxIconSize?: unknown;
  zoomThreshold?: unknown;
  labelField?: string;
  labelMinScale?: unknown;
  labelMaxScale?: unknown;
  objectIdField?: string;
  categoryField?: string;
  requiredFields?: string[];
  hysteresis?: unknown;
  hasPictures?: boolean;
  supportsClustering?: boolean;
  clusterRadius?: unknown;
  clusterPopupEnabled?: boolean;
  allowGeneralization?: boolean;
  generalizationTolerance?: unknown;
  returnGeometry?: boolean;
}

export interface PresentationRequest {
  outFields: string[];
  returnGeometry: boolean;
  maxAllowableOffset?: number;
  resultRecordCount?: number;
}

export interface PresentationRenderer {
  strategy: FeatureRenderPlan['strategy'];
  useSharedIconResolver: boolean;
  allowExtrusion: boolean;
  allowShadows: boolean;
  labelDensity: LabelDensity;
}

export interface LabelConfiguration {
  labelExpressionInfo: { expression: string };
  deconflictionStrategy: 'static' | 'dynamic';
  minScale: number;
  maxScale: number;
}

export interface LayerPresentationPlan {
  layerId: string;
  mode: GisViewMode;
  geometryType: NormalizedGeometryType;
  tier: GisLodTier;
  lodBudget: LodPresentationBudget;
  renderPlan: FeatureRenderPlan;
  featureReduction: ReturnType<typeof createClusterConfiguration>;
  labels: LabelConfiguration | null;
  opacity: number;
  simplificationTolerance: number;
  request: PresentationRequest;
  renderer: PresentationRenderer;
}

export interface LayerPresentationInput {
  layer?: PresentationLayerLike;
  featureStats?: FeatureStatsLike;
  view?: LodViewInput;
  performanceBudget?: PresentationPerformanceBudget;
  previousTier?: GisLodTier | null;
  options?: PresentationOptions;
}

export interface PointPresentationContext extends LodViewInput {
  mode?: unknown;
  zoom?: unknown;
}

export interface SharedPointPresentation {
  iconKey: string;
  mode: GisViewMode;
  symbol: ReturnType<typeof create3DGraphicModel> | ReturnType<typeof createPictureMarkerSymbol>;
}

export interface PresentationPlanResult {
  changed: boolean;
  previous: LayerPresentationPlan | null;
  next: LayerPresentationPlan;
}

export interface PresentationStateConfiguration {
  performanceBudget?: PresentationPerformanceBudget;
}

export interface PresentationState {
  plan: (input: LayerPresentationInput) => PresentationPlanResult;
  get: (layerId: string | number) => LayerPresentationPlan | null;
  forget: (layerId: string | number) => boolean;
  clear: () => void;
  size: () => number;
}

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeMode = (value: unknown): GisViewMode => (
  value === GIS_VIEW_MODE.SCENE_3D ? GIS_VIEW_MODE.SCENE_3D : GIS_VIEW_MODE.MAP_2D
);

const normalizeGeometryType = (value: unknown): NormalizedGeometryType => {
  const normalized = String(value || '').toLowerCase().replace('esrigeometry', '');
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('polyline') || normalized.includes('line')) return 'polyline';
  if (normalized.includes('multipoint')) return 'multipoint';
  return 'point';
};

const tierRank = (tier: GisLodTier): number => ({
  [GIS_LOD_TIER.OVERVIEW]: 0,
  [GIS_LOD_TIER.REGIONAL]: 1,
  [GIS_LOD_TIER.LOCAL]: 2,
  [GIS_LOD_TIER.DETAIL]: 3,
}[tier]);

const tierFromScale = (scale: unknown): GisLodTier => {
  const numeric = finite(scale, Infinity) as number;
  if (numeric >= 150000) return GIS_LOD_TIER.OVERVIEW;
  if (numeric >= 30000) return GIS_LOD_TIER.REGIONAL;
  if (numeric >= 5000) return GIS_LOD_TIER.LOCAL;
  return GIS_LOD_TIER.DETAIL;
};

const tierFromCameraDistance = (distanceMeters: unknown): GisLodTier => {
  const distance = finite(distanceMeters, Infinity) as number;
  if (distance >= 120000) return GIS_LOD_TIER.OVERVIEW;
  if (distance >= 30000) return GIS_LOD_TIER.REGIONAL;
  if (distance >= 5000) return GIS_LOD_TIER.LOCAL;
  return GIS_LOD_TIER.DETAIL;
};

export const resolveLodTier = (
  input: LodViewInput = {},
  previousTier: GisLodTier | null = null,
  hysteresis: unknown = 0.12,
): GisLodTier => {
  const viewMode = normalizeMode(input.mode);
  const next = viewMode === GIS_VIEW_MODE.SCENE_3D
    ? tierFromCameraDistance(input.cameraDistanceMeters)
    : tierFromScale(input.scale);
  if (!previousTier || previousTier === next) return next;

  const margin = clamp(finite(hysteresis, 0.12) as number, 0, 0.45);
  const thresholds: Record<string, number> = viewMode === GIS_VIEW_MODE.MAP_2D
    ? {
      [GIS_LOD_TIER.OVERVIEW]: 150000,
      [GIS_LOD_TIER.REGIONAL]: 30000,
      [GIS_LOD_TIER.LOCAL]: 5000,
    }
    : {
      [GIS_LOD_TIER.OVERVIEW]: 120000,
      [GIS_LOD_TIER.REGIONAL]: 30000,
      [GIS_LOD_TIER.LOCAL]: 5000,
    };
  const previousRank = tierRank(previousTier);
  const nextRank = tierRank(next);
  const boundaryTier = nextRank > previousRank ? previousTier : next;
  const boundary = thresholds[boundaryTier];
  const measurement = viewMode === GIS_VIEW_MODE.MAP_2D
    ? finite(input.scale, Infinity) as number
    : finite(input.cameraDistanceMeters, Infinity) as number;
  if (boundary) {
    if (nextRank > previousRank && measurement > boundary * (1 - margin)) return previousTier;
    if (nextRank < previousRank && measurement < boundary * (1 + margin)) return previousTier;
  }
  return next;
};

export const lodPresentationBudget = (
  tier: GisLodTier,
  performanceBudget: PresentationPerformanceBudget = {},
  mode: GisViewMode = GIS_VIEW_MODE.MAP_2D,
): LodPresentationBudget => {
  const quality = clamp(finite(performanceBudget.sceneQuality, 0.78) as number, 0.25, 1);
  const visibleFeatureBudget = Math.max(250, Math.floor(finite(performanceBudget.maxVisibleFeatures, 6500) as number));
  const factor = ({
    [GIS_LOD_TIER.OVERVIEW]: 0.25,
    [GIS_LOD_TIER.REGIONAL]: 0.5,
    [GIS_LOD_TIER.LOCAL]: 0.8,
    [GIS_LOD_TIER.DETAIL]: 1,
  } as Record<GisLodTier, number>)[tier];
  const sceneFactor = normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D ? quality : 1;
  const labelDensity: LabelDensity = factor <= 0.25
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
    symbolScale: clamp(0.7 + factor * 0.3, 0.7, 1),
    labelDensity,
    allowLabels: labelDensity !== LABEL_DENSITY.NONE,
    allowExtrusion: normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D && tierRank(tier) >= tierRank(GIS_LOD_TIER.LOCAL) && quality >= 0.65,
    allowShadows: normalizeMode(mode) === GIS_VIEW_MODE.SCENE_3D && tier === GIS_LOD_TIER.DETAIL && quality >= 0.9,
  });
};

const labelConfig = (
  options: PresentationOptions,
  density: LabelDensity,
): LabelConfiguration | null => {
  if (!options.labelField || density === LABEL_DENSITY.NONE) return null;
  const deconfliction: 'static' | 'dynamic' = density === LABEL_DENSITY.SPARSE ? 'static' : 'dynamic';
  const maxScale = density === LABEL_DENSITY.SPARSE ? 30000 : 0;
  return Object.freeze({
    labelExpressionInfo: { expression: `$feature.${String(options.labelField)}` },
    deconflictionStrategy: deconfliction,
    minScale: finite(options.labelMinScale, 0) || 0,
    maxScale: finite(options.labelMaxScale, maxScale) || maxScale,
  });
};

const pointSymbol = (
  record: IconRecord,
  context: PointPresentationContext & { mode: GisViewMode },
  options: PresentationOptions,
): ReturnType<typeof create3DGraphicModel> | ReturnType<typeof createPictureMarkerSymbol> => {
  if (context.mode === GIS_VIEW_MODE.SCENE_3D) {
    return create3DGraphicModel(record, { fallback: options.fallbackIcon });
  }
  return createPictureMarkerSymbol(record, finite(context.zoom, 12) as number, {
    fallback: options.fallbackIcon,
    minSize: finite(options.minIconSize, 24) as number,
    maxSize: finite(options.maxIconSize, 48) as number,
    zoomThreshold: finite(options.zoomThreshold, 10) as number,
  });
};

export const createSharedPointPresentation = (
  record: IconRecord,
  context: PointPresentationContext = {},
  options: PresentationOptions = {},
): SharedPointPresentation => {
  const mode = normalizeMode(context.mode);
  return Object.freeze({
    iconKey: getIconKey(record, { fallback: options.fallbackIcon }),
    mode,
    symbol: pointSymbol(record, { ...context, mode }, options),
  });
};

const generalizationTolerance = (
  geometryType: NormalizedGeometryType,
  tier: GisLodTier,
  performanceBudget: PresentationPerformanceBudget,
): number => {
  if (geometryType === 'point' || geometryType === 'multipoint') return 0;
  const quality = clamp(finite(performanceBudget.sceneQuality, 0.78) as number, 0.25, 1);
  const base = geometryType === 'polygon' ? 2 : 1;
  const tierFactor = ({
    [GIS_LOD_TIER.OVERVIEW]: 8,
    [GIS_LOD_TIER.REGIONAL]: 4,
    [GIS_LOD_TIER.LOCAL]: 1.5,
    [GIS_LOD_TIER.DETAIL]: 0,
  } as Record<GisLodTier, number>)[tier];
  return Number((base * tierFactor * (1.15 - quality * 0.15)).toFixed(2));
};

const verifiedMaxAllowableOffset = (
  geometryType: NormalizedGeometryType,
  options: PresentationOptions = {},
): number | undefined => {
  if (geometryType === 'point' || geometryType === 'multipoint') return undefined;
  if (options.allowGeneralization !== true) return undefined;
  const explicitTolerance = finite(options.generalizationTolerance, null);
  return explicitTolerance !== null && explicitTolerance > 0 ? explicitTolerance : undefined;
};

const recommendedOutFields = (options: PresentationOptions = {}): string[] => {
  const fields = [
    options.objectIdField,
    options.labelField,
    options.categoryField,
    ...(options.requiredFields || []),
  ].filter((field): field is string => Boolean(field)).map(String);
  return Array.from(new Set(fields));
};

export const planLayerPresentation = ({
  layer = {},
  featureStats = {},
  view = {},
  performanceBudget = {},
  previousTier = null,
  options = {},
}: LayerPresentationInput = {}): LayerPresentationPlan => {
  const mode = normalizeMode(view.mode);
  const geometryType = normalizeGeometryType(featureStats.geometryType || layer.geometryType || (layer.source && layer.source.geometryType));
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
      finite(performanceBudget.maxVisibleFeatures, 6500) as number,
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
  const opacity = clamp(finite(layer.opacity !== undefined ? layer.opacity : layer.runtime && layer.runtime.opacity, 1) as number, 0, 1);

  const request: PresentationRequest = {
    outFields: recommendedOutFields(options),
    returnGeometry: options.returnGeometry !== false,
  };
  if (maxAllowableOffset !== undefined) request.maxAllowableOffset = maxAllowableOffset;
  if (renderPlan.pageSize !== null) request.resultRecordCount = renderPlan.pageSize;

  return Object.freeze({
    layerId: String(layer.id !== undefined ? layer.id : layer.layerId || ''),
    mode,
    geometryType,
    tier,
    lodBudget,
    renderPlan,
    featureReduction,
    labels,
    opacity,
    simplificationTolerance,
    request: Object.freeze(request),
    renderer: Object.freeze({
      strategy: renderPlan.strategy,
      useSharedIconResolver: geometryType === 'point' || geometryType === 'multipoint',
      allowExtrusion: lodBudget.allowExtrusion && geometryType === 'polygon',
      allowShadows: lodBudget.allowShadows,
      labelDensity: lodBudget.labelDensity,
    }),
  });
};

export const shouldRefreshPresentation = (
  previous: LayerPresentationPlan | null | undefined,
  next: LayerPresentationPlan | null | undefined,
): boolean => {
  if (!previous) return true;
  if (!next) return false;
  return previous.mode !== next.mode ||
    previous.tier !== next.tier ||
    previous.renderPlan.strategy !== next.renderPlan.strategy ||
    previous.renderPlan.pageSize !== next.renderPlan.pageSize ||
    previous.lodBudget.labelDensity !== next.lodBudget.labelDensity ||
    previous.renderer.allowExtrusion !== next.renderer.allowExtrusion ||
    previous.simplificationTolerance !== next.simplificationTolerance ||
    previous.request.maxAllowableOffset !== next.request.maxAllowableOffset;
};

export const createPresentationState = (
  configuration: PresentationStateConfiguration = {},
): PresentationState => {
  const states = new Map<string, LayerPresentationPlan>();

  const plan = (input: LayerPresentationInput): PresentationPlanResult => {
    const layer = input.layer || {};
    const layerId = String(layer.id !== undefined ? layer.id : layer.layerId || '');
    const previous = states.get(layerId) || null;
    const next = planLayerPresentation({
      ...input,
      previousTier: previous ? previous.tier : null,
      performanceBudget: input.performanceBudget || configuration.performanceBudget || {},
    });
    const changed = shouldRefreshPresentation(previous, next);
    states.set(layerId, next);
    return { changed, previous, next };
  };

  return Object.freeze({
    plan,
    get: (layerId: string | number) => states.get(String(layerId)) || null,
    forget: (layerId: string | number) => states.delete(String(layerId)),
    clear: () => states.clear(),
    size: () => states.size,
  });
};

export const isSummaryPresentation = (presentation: LayerPresentationPlan | null | undefined): boolean => (
  Boolean(presentation && presentation.renderPlan.strategy === FEATURE_RENDER_STRATEGY.SUMMARY)
);
