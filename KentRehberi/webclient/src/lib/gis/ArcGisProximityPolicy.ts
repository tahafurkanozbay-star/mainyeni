export type ArcGisProximityMode = 'nearest' | 'within-distance';
export type ArcGisProximityViewMode = '2d' | '3d';

export interface ArcGisProximityPoint {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly spatialReferenceWkid: number;
}

export interface ArcGisProximityLayer {
  readonly id: string;
  readonly revision: number;
  readonly priority?: number;
  readonly visible: boolean;
  readonly queryable: boolean;
  readonly minScale?: number;
  readonly maxScale?: number;
}

export interface ArcGisProximityRequest {
  readonly mode: ArcGisProximityMode;
  readonly viewMode: ArcGisProximityViewMode;
  readonly origin: ArcGisProximityPoint;
  readonly distanceMeters: number;
  readonly maxResults: number;
  readonly mapScale: number;
  readonly expectedRevision: number;
  readonly layers: readonly ArcGisProximityLayer[];
}

export interface ArcGisProximityBudget {
  readonly maxDistanceMeters: number;
  readonly maxResults: number;
  readonly maxLayers: number;
  readonly maxEstimatedResponseBytes: number;
  readonly estimatedBytesPerFeature: number;
}

export interface ArcGisProximityPlan {
  readonly mode: ArcGisProximityMode;
  readonly viewMode: ArcGisProximityViewMode;
  readonly origin: Readonly<ArcGisProximityPoint>;
  readonly distanceMeters: number;
  readonly maxResults: number;
  readonly layerIds: readonly string[];
  readonly spatialReferenceWkid: number;
  readonly revision: number;
  readonly fingerprint: string;
}

export type ArcGisProximityDecision =
  | { readonly ok: true; readonly plan: ArcGisProximityPlan }
  | { readonly ok: false; readonly reason: string };

const WEB_MERCATOR_ALIASES = new Set([3857, 102100, 102113, 900913]);
const DEFAULT_BUDGET: ArcGisProximityBudget = Object.freeze({
  maxDistanceMeters: 50_000,
  maxResults: 500,
  maxLayers: 12,
  maxEstimatedResponseBytes: 4_000_000,
  estimatedBytesPerFeature: 2_048,
});

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const canonicalWkid = (wkid: number): number => WEB_MERCATOR_ALIASES.has(wkid) ? 3857 : wkid;
const normalizeId = (value: string): string => value.trim();

const isScaleVisible = (layer: ArcGisProximityLayer, scale: number): boolean => {
  if (layer.minScale !== undefined && (!finitePositive(layer.minScale) || scale > layer.minScale)) return false;
  if (layer.maxScale !== undefined && (!finitePositive(layer.maxScale) || scale < layer.maxScale)) return false;
  return true;
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const validateBudget = (budget: ArcGisProximityBudget): boolean =>
  finitePositive(budget.maxDistanceMeters)
  && Number.isSafeInteger(budget.maxResults) && budget.maxResults > 0
  && Number.isSafeInteger(budget.maxLayers) && budget.maxLayers > 0
  && Number.isSafeInteger(budget.maxEstimatedResponseBytes) && budget.maxEstimatedResponseBytes > 0
  && Number.isSafeInteger(budget.estimatedBytesPerFeature) && budget.estimatedBytesPerFeature > 0;

export const planArcGisProximity = (
  request: ArcGisProximityRequest,
  budget: ArcGisProximityBudget = DEFAULT_BUDGET,
): ArcGisProximityDecision => {
  if (!validateBudget(budget)) return { ok: false, reason: 'invalid-budget' };
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    return { ok: false, reason: 'invalid-revision' };
  }
  if (!finitePositive(request.mapScale)) return { ok: false, reason: 'invalid-map-scale' };
  if (!finitePositive(request.distanceMeters) || request.distanceMeters > budget.maxDistanceMeters) {
    return { ok: false, reason: 'distance-budget-exceeded' };
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults <= 0 || request.maxResults > budget.maxResults) {
    return { ok: false, reason: 'result-budget-exceeded' };
  }
  const { origin } = request;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || (origin.z !== undefined && !Number.isFinite(origin.z))) {
    return { ok: false, reason: 'invalid-origin' };
  }
  if (!Number.isSafeInteger(origin.spatialReferenceWkid) || origin.spatialReferenceWkid <= 0) {
    return { ok: false, reason: 'invalid-spatial-reference' };
  }
  if (request.viewMode === '2d' && origin.z !== undefined) return { ok: false, reason: '2d-origin-has-z' };
  if (request.layers.length > budget.maxLayers) return { ok: false, reason: 'layer-budget-exceeded' };

  const ids = new Set<string>();
  const admitted: Array<{ id: string; priority: number }> = [];
  for (const layer of request.layers) {
    const id = normalizeId(layer.id);
    if (!id || ids.has(id)) return { ok: false, reason: id ? 'duplicate-layer' : 'invalid-layer-id' };
    ids.add(id);
    if (!Number.isSafeInteger(layer.revision) || layer.revision < 0) return { ok: false, reason: 'invalid-layer-revision' };
    if (layer.revision !== request.expectedRevision) return { ok: false, reason: 'stale-layer-revision' };
    if (!layer.visible || !layer.queryable || !isScaleVisible(layer, request.mapScale)) continue;
    const priority = layer.priority ?? 0;
    if (!Number.isFinite(priority)) return { ok: false, reason: 'invalid-layer-priority' };
    admitted.push({ id, priority });
  }
  if (admitted.length === 0) return { ok: false, reason: 'no-queryable-layers' };

  const estimatedBytes = admitted.length * request.maxResults * budget.estimatedBytesPerFeature;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > budget.maxEstimatedResponseBytes) {
    return { ok: false, reason: 'response-byte-budget-exceeded' };
  }

  admitted.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id, 'en'));
  const layerIds = Object.freeze(admitted.map(({ id }) => id));
  const wkid = canonicalWkid(origin.spatialReferenceWkid);
  const frozenOrigin = Object.freeze({ ...origin, spatialReferenceWkid: wkid });
  const fingerprintPayload = [
    request.mode,
    request.viewMode,
    wkid,
    origin.x,
    origin.y,
    origin.z ?? '',
    request.distanceMeters,
    request.maxResults,
    request.expectedRevision,
    ...layerIds,
  ].join('|');

  return {
    ok: true,
    plan: Object.freeze({
      mode: request.mode,
      viewMode: request.viewMode,
      origin: frozenOrigin,
      distanceMeters: request.distanceMeters,
      maxResults: request.maxResults,
      layerIds,
      spatialReferenceWkid: wkid,
      revision: request.expectedRevision,
      fingerprint: `proximity-v1-${fnv1a(fingerprintPayload)}`,
    }),
  };
};
