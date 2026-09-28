export type ArcGisClusterViewMode = '2d' | '3d';
export type ArcGisClusterGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon';
export type ArcGisClusterPlanMode = 'direct' | 'cluster' | 'reject';
export type ArcGisClusterPlanReason =
  | 'aggregate-field-budget'
  | 'cluster-memory-budget'
  | 'cluster-size-budget'
  | 'clustering-unsupported'
  | 'direct-feature-budget'
  | 'label-budget'
  | 'popup-field-budget'
  | 'scale-disables-clustering';

export interface ArcGisClusterBudgetPolicy {
  readonly maxLayerKeyLength: number;
  readonly directFeatureThreshold2d: number;
  readonly directFeatureThreshold3d: number;
  readonly minClusterRadiusPx: number;
  readonly maxClusterRadiusPx: number;
  readonly minClusterSymbolSizePx: number;
  readonly maxClusterSymbolSizePx: number;
  readonly maxAggregateFields: number;
  readonly maxLabelClasses: number;
  readonly maxPopupFields: number;
  readonly maxEstimatedClusters: number;
  readonly maxClusterMemoryBytes: number;
  readonly estimatedBytesPerCluster: number;
  readonly maxViewportPixelArea: number;
}

export interface ArcGisClusterBudgetRequest {
  readonly layerKey: string;
  readonly viewMode: ArcGisClusterViewMode;
  readonly geometryType: ArcGisClusterGeometryType;
  readonly featureCountEstimate: number;
  readonly viewportPixelArea: number;
  readonly requestedRadiusPx: number;
  readonly clusterMinSizePx: number;
  readonly clusterMaxSizePx: number;
  readonly aggregateFieldCount: number;
  readonly labelClassCount: number;
  readonly popupFieldCount: number;
  readonly viewScale: number;
  readonly clusterMaxScale: number;
  readonly clusteringSupported: boolean;
}

export interface ArcGisClusterBudgetPlan {
  readonly layerKey: string;
  readonly viewMode: ArcGisClusterViewMode;
  readonly geometryType: ArcGisClusterGeometryType;
  readonly mode: ArcGisClusterPlanMode;
  readonly featureCountEstimate: number;
  readonly clusterRadiusPx: number;
  readonly estimatedClusterCount: number;
  readonly estimatedClusterMemoryBytes: number;
  readonly scaleAllowsClustering: boolean;
  readonly reasons: readonly ArcGisClusterPlanReason[];
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const finite = (value: number, name: string, minimum = 0): number => {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

/**
 * Bounded admission planner for ArcGIS FeatureReductionCluster configuration.
 * It owns no FeatureLayer, FeatureReductionCluster, renderer, popup, label, aggregate result or
 * view handle. Callers apply the returned primitive plan through the existing ArcGIS adapter.
 */
export class ArcGisClusterBudgetPlanner {
  private readonly policy: Readonly<ArcGisClusterBudgetPolicy>;

  constructor(policy: ArcGisClusterBudgetPolicy) {
    this.policy = Object.freeze({
      maxLayerKeyLength: integer(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      directFeatureThreshold2d: integer(policy.directFeatureThreshold2d, 'directFeatureThreshold2d'),
      directFeatureThreshold3d: integer(policy.directFeatureThreshold3d, 'directFeatureThreshold3d'),
      minClusterRadiusPx: finite(policy.minClusterRadiusPx, 'minClusterRadiusPx'),
      maxClusterRadiusPx: finite(policy.maxClusterRadiusPx, 'maxClusterRadiusPx'),
      minClusterSymbolSizePx: finite(policy.minClusterSymbolSizePx, 'minClusterSymbolSizePx'),
      maxClusterSymbolSizePx: finite(policy.maxClusterSymbolSizePx, 'maxClusterSymbolSizePx'),
      maxAggregateFields: integer(policy.maxAggregateFields, 'maxAggregateFields', true),
      maxLabelClasses: integer(policy.maxLabelClasses, 'maxLabelClasses', true),
      maxPopupFields: integer(policy.maxPopupFields, 'maxPopupFields', true),
      maxEstimatedClusters: integer(policy.maxEstimatedClusters, 'maxEstimatedClusters'),
      maxClusterMemoryBytes: integer(policy.maxClusterMemoryBytes, 'maxClusterMemoryBytes'),
      estimatedBytesPerCluster: integer(policy.estimatedBytesPerCluster, 'estimatedBytesPerCluster'),
      maxViewportPixelArea: integer(policy.maxViewportPixelArea, 'maxViewportPixelArea'),
    });
    if (this.policy.minClusterRadiusPx <= 0 || this.policy.maxClusterRadiusPx < this.policy.minClusterRadiusPx) throw new Error('invalid cluster radius policy');
    if (this.policy.minClusterSymbolSizePx <= 0 || this.policy.maxClusterSymbolSizePx < this.policy.minClusterSymbolSizePx) throw new Error('invalid cluster symbol size policy');
  }

  plan(input: ArcGisClusterBudgetRequest): ArcGisClusterBudgetPlan {
    const layerKey = boundedText(input.layerKey, this.policy.maxLayerKeyLength, 'layer key');
    this.assertViewMode(input.viewMode);
    this.assertGeometryType(input.geometryType);
    const featureCountEstimate = integer(input.featureCountEstimate, 'featureCountEstimate', true);
    const viewportPixelArea = integer(input.viewportPixelArea, 'viewportPixelArea');
    if (viewportPixelArea > this.policy.maxViewportPixelArea) throw new Error('viewportPixelArea exceeds configured bound');
    const requestedRadiusPx = finite(input.requestedRadiusPx, 'requestedRadiusPx');
    const clusterMinSizePx = finite(input.clusterMinSizePx, 'clusterMinSizePx');
    const clusterMaxSizePx = finite(input.clusterMaxSizePx, 'clusterMaxSizePx');
    const aggregateFieldCount = integer(input.aggregateFieldCount, 'aggregateFieldCount', true);
    const labelClassCount = integer(input.labelClassCount, 'labelClassCount', true);
    const popupFieldCount = integer(input.popupFieldCount, 'popupFieldCount', true);
    const viewScale = finite(input.viewScale, 'viewScale');
    const clusterMaxScale = finite(input.clusterMaxScale, 'clusterMaxScale');
    if (typeof input.clusteringSupported !== 'boolean') throw new Error('clusteringSupported must be boolean');

    const reasons: ArcGisClusterPlanReason[] = [];
    if (aggregateFieldCount > this.policy.maxAggregateFields) reasons.push('aggregate-field-budget');
    if (labelClassCount > this.policy.maxLabelClasses) reasons.push('label-budget');
    if (popupFieldCount > this.policy.maxPopupFields) reasons.push('popup-field-budget');
    if (clusterMinSizePx < this.policy.minClusterSymbolSizePx || clusterMaxSizePx > this.policy.maxClusterSymbolSizePx || clusterMinSizePx > clusterMaxSizePx) reasons.push('cluster-size-budget');

    const directThreshold = input.viewMode === '2d' ? this.policy.directFeatureThreshold2d : this.policy.directFeatureThreshold3d;
    const scaleAllowsClustering = clusterMaxScale === 0 || viewScale >= clusterMaxScale;
    if (!scaleAllowsClustering && featureCountEstimate > directThreshold) reasons.push('scale-disables-clustering');
    if (!input.clusteringSupported && featureCountEstimate > directThreshold) reasons.push('clustering-unsupported');

    if (reasons.length > 0) return this.reject(layerKey, input, featureCountEstimate, scaleAllowsClustering, requestedRadiusPx, reasons);
    if (featureCountEstimate <= directThreshold || !scaleAllowsClustering || !input.clusteringSupported) {
      return Object.freeze({
        layerKey,
        viewMode: input.viewMode,
        geometryType: input.geometryType,
        mode: 'direct',
        featureCountEstimate,
        clusterRadiusPx: 0,
        estimatedClusterCount: 0,
        estimatedClusterMemoryBytes: 0,
        scaleAllowsClustering,
        reasons: Object.freeze([]),
      });
    }

    let radius = Math.min(this.policy.maxClusterRadiusPx, Math.max(this.policy.minClusterRadiusPx, requestedRadiusPx));
    let estimatedClusterCount = this.estimateClusterCount(featureCountEstimate, viewportPixelArea, radius);
    const maxByMemory = Math.floor(this.policy.maxClusterMemoryBytes / this.policy.estimatedBytesPerCluster);
    const allowedClusters = Math.min(this.policy.maxEstimatedClusters, maxByMemory);
    if (allowedClusters < 1) return this.reject(layerKey, input, featureCountEstimate, scaleAllowsClustering, radius, ['cluster-memory-budget']);

    if (estimatedClusterCount > allowedClusters) {
      const requiredRadius = Math.sqrt(viewportPixelArea / (Math.PI * allowedClusters));
      radius = Math.min(this.policy.maxClusterRadiusPx, Math.max(radius, requiredRadius));
      estimatedClusterCount = this.estimateClusterCount(featureCountEstimate, viewportPixelArea, radius);
    }

    const estimatedClusterMemoryBytes = estimatedClusterCount * this.policy.estimatedBytesPerCluster;
    if (!Number.isSafeInteger(estimatedClusterMemoryBytes)) throw new Error('cluster memory estimate overflow');
    if (estimatedClusterCount > this.policy.maxEstimatedClusters || estimatedClusterMemoryBytes > this.policy.maxClusterMemoryBytes) {
      return this.reject(layerKey, input, featureCountEstimate, scaleAllowsClustering, radius, ['cluster-memory-budget']);
    }

    return Object.freeze({
      layerKey,
      viewMode: input.viewMode,
      geometryType: input.geometryType,
      mode: 'cluster',
      featureCountEstimate,
      clusterRadiusPx: radius,
      estimatedClusterCount,
      estimatedClusterMemoryBytes,
      scaleAllowsClustering,
      reasons: Object.freeze([]),
    });
  }

  private estimateClusterCount(featureCount: number, viewportPixelArea: number, radiusPx: number): number {
    const influenceArea = Math.PI * radiusPx * radiusPx;
    if (!Number.isFinite(influenceArea) || influenceArea <= 0) throw new Error('cluster influence area is invalid');
    const screenCells = Math.max(1, Math.ceil(viewportPixelArea / influenceArea));
    return Math.min(featureCount, screenCells);
  }

  private reject(
    layerKey: string,
    input: ArcGisClusterBudgetRequest,
    featureCountEstimate: number,
    scaleAllowsClustering: boolean,
    radius: number,
    reasons: readonly ArcGisClusterPlanReason[],
  ): ArcGisClusterBudgetPlan {
    const allReasons = [...reasons];
    const directThreshold = input.viewMode === '2d' ? this.policy.directFeatureThreshold2d : this.policy.directFeatureThreshold3d;
    if (featureCountEstimate > directThreshold && !allReasons.includes('direct-feature-budget')) allReasons.push('direct-feature-budget');
    return Object.freeze({
      layerKey,
      viewMode: input.viewMode,
      geometryType: input.geometryType,
      mode: 'reject',
      featureCountEstimate,
      clusterRadiusPx: radius,
      estimatedClusterCount: 0,
      estimatedClusterMemoryBytes: 0,
      scaleAllowsClustering,
      reasons: Object.freeze([...new Set(allReasons)].sort()),
    });
  }

  private assertViewMode(value: string): asserts value is ArcGisClusterViewMode {
    if (value !== '2d' && value !== '3d') throw new Error('invalid cluster view mode');
  }

  private assertGeometryType(value: string): asserts value is ArcGisClusterGeometryType {
    if (value !== 'point' && value !== 'multipoint' && value !== 'polyline' && value !== 'polygon') throw new Error('invalid cluster geometry type');
  }
}
