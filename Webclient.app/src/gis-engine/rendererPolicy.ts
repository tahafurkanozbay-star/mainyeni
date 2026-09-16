import type { IconRecord } from './contracts';
import {
  resolveIcon,
  resolveIconUrl,
  type IconRegistry,
} from './iconResolver';

/**
 * Shared 2D/3D presentation policy. It consumes the canonical icon resolver and
 * returns serializable renderer intent rather than creating SDK renderer objects.
 * ArcGIS SDK adapters remain responsible for turning these models into symbols.
 */

export type RendererViewMode = '2d' | '3d';
export type DeviceClass = 'low' | 'balanced' | 'high';

export interface RendererBudgetInput {
  readonly deviceClass?: DeviceClass;
  readonly featureCount?: number;
  readonly visibleFeatureCount?: number;
  readonly zoom?: number;
  readonly scale?: number;
  readonly moving?: boolean;
  readonly reducedMotion?: boolean;
  readonly memoryPressure?: boolean;
}

export interface RendererBudget {
  readonly maxVisibleFeatures: number;
  readonly maxLabels: number;
  readonly maxPictureMarkers: number;
  readonly clusterThreshold: number;
  readonly clusterRadiusPx: number;
  readonly markerSizePx: number;
  readonly labelMinScale: number;
  readonly renderQuality: 'economy' | 'balanced' | 'quality';
  readonly suspendLabels: boolean;
  readonly preferClustering: boolean;
  readonly preferSimplifiedGeometry: boolean;
}

export interface RendererPolicyInput extends RendererBudgetInput {
  readonly mode: RendererViewMode;
  readonly record: IconRecord;
  readonly registry: IconRegistry;
  readonly fallbackIcon?: string;
  readonly title?: string;
  readonly category?: string;
  readonly opacity?: number;
  readonly angle?: number;
  readonly selected?: boolean;
  readonly hovered?: boolean;
}

export interface Marker2DPresentation {
  readonly type: 'picture-marker';
  readonly url: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly angle: number;
  readonly opacity: number;
  readonly selected: boolean;
}

export interface Marker3DPresentation {
  readonly type: 'icon-3d';
  readonly url: string;
  readonly sizePx: number;
  readonly heading: number;
  readonly opacity: number;
  readonly verticalOffsetPx: number;
  readonly selected: boolean;
}

export interface LabelPresentation {
  readonly enabled: boolean;
  readonly text: string;
  readonly maxLength: number;
  readonly deconfliction: 'none' | 'static';
  readonly placement: 'above-center' | 'above-right';
}

export interface ClusterPresentation {
  readonly enabled: boolean;
  readonly radiusPx: number;
  readonly maxClusterSizePx: number;
  readonly labeling: boolean;
}

export interface RendererPresentation {
  readonly mode: RendererViewMode;
  readonly iconKey: string;
  readonly iconUrl: string;
  readonly isFallbackIcon: boolean;
  readonly marker2d: Marker2DPresentation | null;
  readonly marker3d: Marker3DPresentation | null;
  readonly label: LabelPresentation;
  readonly cluster: ClusterPresentation;
  readonly budget: RendererBudget;
}

export interface LayerLodInput {
  readonly geometryType?: string;
  readonly featureCount?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly currentScale?: number;
  readonly mode?: RendererViewMode;
  readonly deviceClass?: DeviceClass;
}

export interface LayerLodDecision {
  readonly visible: boolean;
  readonly reason: 'visible' | 'below-min-scale' | 'above-max-scale' | 'feature-pressure';
  readonly detailLevel: 'hidden' | 'clustered' | 'simplified' | 'full';
  readonly queryGeometry: boolean;
  readonly queryAttributes: boolean;
  readonly targetFeatureBudget: number;
}

const DEVICE_BUDGETS: Readonly<Record<DeviceClass, Readonly<{
  maxVisibleFeatures: number;
  maxLabels: number;
  maxPictureMarkers: number;
  clusterThreshold: number;
}>>> = Object.freeze({
  low: Object.freeze({
    maxVisibleFeatures: 5_000,
    maxLabels: 300,
    maxPictureMarkers: 2_000,
    clusterThreshold: 800,
  }),
  balanced: Object.freeze({
    maxVisibleFeatures: 15_000,
    maxLabels: 1000,
    maxPictureMarkers: 8_000,
    clusterThreshold: 2_500,
  }),
  high: Object.freeze({
    maxVisibleFeatures: 40_000,
    maxLabels: 3_000,
    maxPictureMarkers: 20_000,
    clusterThreshold: 8_000,
  }),
});

const finite = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const nonNegative = (value: unknown, fallback = 0): number => Math.max(0, finite(value, fallback));

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const deviceClass = (value: unknown): DeviceClass => (
  value === 'low' || value === 'high' ? value : 'balanced'
);

const normalizeOpacity = (value: unknown): number => clamp(finite(value, 1), 0, 1);

const normalizeAngle = (value: unknown): number => {
  const angle = finite(value, 0) % 360;
  return angle < 0 ? angle + 360 : angle;
};

const zoomMarkerSize = (zoom: number, mode: RendererViewMode): number => {
  const base = mode === '3d' ? 30 : 26;
  if (!Number.isFinite(zoom)) return base;
  if (zoom < 9) return Math.max(16, base - 8);
  if (zoom < 13) return base - 4;
  if (zoom < 17) return base;
  return Math.min(44, base + 6);
};

const scaleLabelThreshold = (mode: RendererViewMode, device: DeviceClass): number => {
  if (mode === '3d') return device === 'low' ? 25_000 : 50_000;
  if (device === 'low') return 20_000;
  if (device === 'high') return 100_000;
  return 50_000;
};

export const computeRendererBudget = (
  mode: RendererViewMode,
  input: RendererBudgetInput = {},
): RendererBudget => {
  const device = deviceClass(input.deviceClass);
  const base = DEVICE_BUDGETS[device];
  const visible = Math.floor(nonNegative(input.visibleFeatureCount ?? input.featureCount, 0));
  const moving = input.moving === true;
  const memoryPressure = input.memoryPressure === true;
  const pressureFactor = memoryPressure ? 0.5 : moving ? 0.7 : 1;
  const modeFactor = mode === '3d' ? 0.75 : 1;
  const maxVisibleFeatures = Math.max(500, Math.floor(base.maxVisibleFeatures * pressureFactor * modeFactor));
  const maxLabels = Math.max(0, Math.floor(base.maxLabels * pressureFactor * modeFactor));
  const maxPictureMarkers = Math.max(250, Math.floor(base.maxPictureMarkers * pressureFactor * modeFactor));
  const clusterThreshold = Math.max(200, Math.floor(base.clusterThreshold * pressureFactor * modeFactor));
  const zoom = finite(input.zoom, 12);
  const markerSizePx = zoomMarkerSize(zoom, mode);
  const densityRatio = maxVisibleFeatures > 0 ? visible / maxVisibleFeatures : 1;
  const preferClustering = visible > clusterThreshold || densityRatio > 0.7;
  const preferSimplifiedGeometry = moving || memoryPressure || densityRatio > 0.85;
  const suspendLabels = moving || visible > maxLabels || memoryPressure;
  const renderQuality: RendererBudget['renderQuality'] = memoryPressure || moving
    ? 'economy'
    : device === 'high' && densityRatio < 0.5
      ? 'quality'
      : 'balanced';
  const clusterRadiusPx = clamp(
    Math.round(36 + Math.min(28, Math.max(0, densityRatio - 0.2) * 24)),
    28,
    64,
  );

  return Object.freeze({
    maxVisibleFeatures,
    maxLabels,
    maxPictureMarkers,
    clusterThreshold,
    clusterRadiusPx,
    markerSizePx,
    labelMinScale: scaleLabelThreshold(mode, device),
    renderQuality,
    suspendLabels,
    preferClustering,
    preferSimplifiedGeometry,
  });
};

const truncateLabel = (value: unknown, maximum = 96): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const buildLabel = (
  input: RendererPolicyInput,
  budget: RendererBudget,
): LabelPresentation => {
  const scale = nonNegative(input.scale, 0);
  const title = truncateLabel(input.title ?? input.record.title ?? input.record.name ?? '');
  const scaleAllows = scale === 0 || scale <= budget.labelMinScale;
  return Object.freeze({
    enabled: Boolean(title) && !budget.suspendLabels && scaleAllows,
    text: title,
    maxLength: 96,
    deconfliction: input.mode === '3d' ? 'static' : 'none',
    placement: input.mode === '3d' ? 'above-center' : 'above-right',
  });
};

const buildCluster = (budget: RendererBudget): ClusterPresentation => Object.freeze({
  enabled: budget.preferClustering,
  radiusPx: budget.clusterRadiusPx,
  maxClusterSizePx: clamp(Math.round(budget.markerSizePx * 1.8), 36, 72),
  labeling: !budget.suspendLabels,
});

export const createRendererPresentation = (input: RendererPolicyInput): RendererPresentation => {
  const budget = computeRendererBudget(input.mode, input);
  const fallback = input.fallbackIcon ?? 'default';
  const resolved = resolveIcon(input.record, input.registry, { fallback });
  const iconUrl = resolveIconUrl(input.record, input.registry, { fallback });
  const selected = input.selected === true;
  const hovered = input.hovered === true;
  const markerScale = selected ? 1.18 : hovered ? 1.08 : 1;
  const markerSize = clamp(Math.round(budget.markerSizePx * markerScale), 14, 56);
  const opacity = normalizeOpacity(input.opacity);
  const angle = normalizeAngle(input.angle ?? input.record.angle);

  const marker2d: Marker2DPresentation | null = input.mode === '2d'
    ? Object.freeze({
        type: 'picture-marker' as const,
        url: iconUrl,
        widthPx: markerSize,
        heightPx: markerSize,
        angle,
        opacity,
        selected,
      })
    : null;
  const marker3d: Marker3DPresentation | null = input.mode === '3d'
    ? Object.freeze({
        type: 'icon-3d' as const,
        url: iconUrl,
        sizePx: markerSize,
        heading: angle,
        opacity,
        verticalOffsetPx: selected ? 8 : 4,
        selected,
      })
    : null;

  return Object.freeze({
    mode: input.mode,
    iconKey: resolved.id,
    iconUrl,
    isFallbackIcon: resolved.isFallback,
    marker2d,
    marker3d,
    label: buildLabel(input, budget),
    cluster: buildCluster(budget),
    budget,
  });
};

const normalizeScale = (value: unknown): number => Math.max(0, finite(value, 0));

const scaleVisibility = (
  currentScale: number,
  minScale: number,
  maxScale: number,
): LayerLodDecision['reason'] | null => {
  if (currentScale <= 0) return null;
  if (minScale > 0 && currentScale > minScale) return 'below-min-scale';
  if (maxScale > 0 && currentScale < maxScale) return 'above-max-scale';
  return null;
};

export const decideLayerLod = (input: LayerLodInput = {}): LayerLodDecision => {
  const mode: RendererViewMode = input.mode === '3d' ? '3d' : '2d';
  const device = deviceClass(input.deviceClass);
  const base = DEVICE_BUDGETS[device];
  const featureCount = Math.floor(nonNegative(input.featureCount, 0));
  const currentScale = normalizeScale(input.currentScale);
  const minScale = normalizeScale(input.minScale);
  const maxScale = normalizeScale(input.maxScale);
  const hiddenReason = scaleVisibility(currentScale, minScale, maxScale);
  const targetFeatureBudget = Math.floor(base.maxVisibleFeatures * (mode === '3d' ? 0.75 : 1));
  if (hiddenReason) {
    return Object.freeze({
      visible: false,
      reason: hiddenReason,
      detailLevel: 'hidden' as const,
      queryGeometry: false,
      queryAttributes: false,
      targetFeatureBudget,
    });
  }

  const geometryType = String(input.geometryType ?? '').toLowerCase();
  const pointLike = geometryType.includes('point');
  if (featureCount > targetFeatureBudget * 3) {
    return Object.freeze({
      visible: true,
      reason: 'feature-pressure' as const,
      detailLevel: pointLike ? 'clustered' as const : 'simplified' as const,
      queryGeometry: true,
      queryAttributes: false,
      targetFeatureBudget,
    });
  }
  if (featureCount > targetFeatureBudget) {
    return Object.freeze({
      visible: true,
      reason: 'feature-pressure' as const,
      detailLevel: pointLike ? 'clustered' as const : 'simplified' as const,
      queryGeometry: true,
      queryAttributes: true,
      targetFeatureBudget,
    });
  }
  return Object.freeze({
    visible: true,
    reason: 'visible' as const,
    detailLevel: 'full' as const,
    queryGeometry: true,
    queryAttributes: true,
    targetFeatureBudget,
  });
};

export interface ParityCheckInput {
  readonly record: IconRecord;
  readonly registry: IconRegistry;
  readonly fallbackIcon?: string;
  readonly title?: string;
}

export interface RendererParityResult {
  readonly consistent: boolean;
  readonly iconKey2d: string;
  readonly iconKey3d: string;
  readonly iconUrl2d: string;
  readonly iconUrl3d: string;
  readonly differences: readonly string[];
}

export const verifyRendererParity = (input: ParityCheckInput): RendererParityResult => {
  const common = {
    record: input.record,
    registry: input.registry,
    ...(input.fallbackIcon ? { fallbackIcon: input.fallbackIcon } : {}),
    ...(input.title ? { title: input.title } : {}),
    featureCount: 1,
  };
  const model2d = createRendererPresentation({ ...common, mode: '2d' });
  const model3d = createRendererPresentation({ ...common, mode: '3d' });
  const differences: string[] = [];
  if (model2d.iconKey !== model3d.iconKey) differences.push('icon-key');
  if (model2d.iconUrl !== model3d.iconUrl) differences.push('icon-url');
  if (model2d.isFallbackIcon !== model3d.isFallbackIcon) differences.push('fallback-state');
  return Object.freeze({
    consistent: differences.length === 0,
    iconKey2d: model2d.iconKey,
    iconKey3d: model3d.iconKey,
    iconUrl2d: model2d.iconUrl,
    iconUrl3d: model3d.iconUrl,
    differences: Object.freeze(differences),
  });
};
