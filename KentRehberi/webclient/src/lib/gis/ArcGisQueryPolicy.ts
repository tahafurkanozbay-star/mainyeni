export type ArcGisQueryOrder = 'asc' | 'desc';

export interface ArcGisQueryLayer {
  readonly id: string;
  readonly revision: number;
  readonly visible: boolean;
  readonly queryable: boolean;
  readonly priority?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly allowedFields: readonly string[];
}

export interface ArcGisQuerySort {
  readonly field: string;
  readonly order: ArcGisQueryOrder;
}

export interface ArcGisQueryRequest {
  readonly expectedRevision: number;
  readonly mapScale: number;
  readonly fields: readonly string[];
  readonly sort?: readonly ArcGisQuerySort[];
  readonly resultOffset: number;
  readonly resultLimit: number;
  readonly returnGeometry: boolean;
  readonly layers: readonly ArcGisQueryLayer[];
}

export interface ArcGisQueryBudget {
  readonly maxLayers: number;
  readonly maxFields: number;
  readonly maxSortFields: number;
  readonly maxOffset: number;
  readonly maxResultLimit: number;
  readonly maxEstimatedResponseBytes: number;
  readonly estimatedBytesPerFeature: number;
}

export interface ArcGisQueryLayerPlan {
  readonly id: string;
  readonly fields: readonly string[];
  readonly sort: readonly Readonly<ArcGisQuerySort>[];
}

export interface ArcGisQueryPlan {
  readonly revision: number;
  readonly resultOffset: number;
  readonly resultLimit: number;
  readonly returnGeometry: boolean;
  readonly layers: readonly Readonly<ArcGisQueryLayerPlan>[];
  readonly fingerprint: string;
}

export type ArcGisQueryDecision =
  | { readonly ok: true; readonly plan: ArcGisQueryPlan }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_BUDGET: ArcGisQueryBudget = Object.freeze({
  maxLayers: 12,
  maxFields: 48,
  maxSortFields: 4,
  maxOffset: 10_000,
  maxResultLimit: 500,
  maxEstimatedResponseBytes: 6_000_000,
  estimatedBytesPerFeature: 2_048,
});

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const normalize = (value: string): string => value.trim();
const fieldKey = (value: string): string => normalize(value).toLocaleLowerCase('en-US');

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const isScaleVisible = (layer: ArcGisQueryLayer, scale: number): boolean => {
  if (layer.minScale !== undefined && (!finitePositive(layer.minScale) || scale > layer.minScale)) return false;
  if (layer.maxScale !== undefined && (!finitePositive(layer.maxScale) || scale < layer.maxScale)) return false;
  return true;
};

const validateBudget = (budget: ArcGisQueryBudget): boolean =>
  Number.isSafeInteger(budget.maxLayers) && budget.maxLayers > 0
  && Number.isSafeInteger(budget.maxFields) && budget.maxFields > 0
  && Number.isSafeInteger(budget.maxSortFields) && budget.maxSortFields >= 0
  && Number.isSafeInteger(budget.maxOffset) && budget.maxOffset >= 0
  && Number.isSafeInteger(budget.maxResultLimit) && budget.maxResultLimit > 0
  && Number.isSafeInteger(budget.maxEstimatedResponseBytes) && budget.maxEstimatedResponseBytes > 0
  && Number.isSafeInteger(budget.estimatedBytesPerFeature) && budget.estimatedBytesPerFeature > 0;

const normalizeUniqueFields = (fields: readonly string[], maxFields: number): readonly string[] | null => {
  if (fields.length === 0 || fields.length > maxFields) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of fields) {
    const field = normalize(candidate);
    const key = fieldKey(field);
    if (!field || seen.has(key)) return null;
    seen.add(key);
    normalized.push(field);
  }
  normalized.sort((left, right) => left.localeCompare(right, 'en'));
  return Object.freeze(normalized);
};

export const planArcGisQuery = (
  request: ArcGisQueryRequest,
  budget: ArcGisQueryBudget = DEFAULT_BUDGET,
): ArcGisQueryDecision => {
  if (!validateBudget(budget)) return { ok: false, reason: 'invalid-budget' };
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) return { ok: false, reason: 'invalid-revision' };
  if (!finitePositive(request.mapScale)) return { ok: false, reason: 'invalid-map-scale' };
  if (!Number.isSafeInteger(request.resultOffset) || request.resultOffset < 0 || request.resultOffset > budget.maxOffset) {
    return { ok: false, reason: 'offset-budget-exceeded' };
  }
  if (!Number.isSafeInteger(request.resultLimit) || request.resultLimit <= 0 || request.resultLimit > budget.maxResultLimit) {
    return { ok: false, reason: 'result-budget-exceeded' };
  }
  if (request.layers.length === 0 || request.layers.length > budget.maxLayers) return { ok: false, reason: 'layer-budget-exceeded' };

  const fields = normalizeUniqueFields(request.fields, budget.maxFields);
  if (!fields) return { ok: false, reason: 'invalid-fields' };

  const sortInput = request.sort ?? [];
  if (sortInput.length > budget.maxSortFields) return { ok: false, reason: 'sort-budget-exceeded' };
  const sortSeen = new Set<string>();
  const sort: ArcGisQuerySort[] = [];
  for (const candidate of sortInput) {
    const field = normalize(candidate.field);
    const key = fieldKey(field);
    if (!field || sortSeen.has(key)) return { ok: false, reason: 'invalid-sort' };
    sortSeen.add(key);
    sort.push(Object.freeze({ field, order: candidate.order }));
  }

  const ids = new Set<string>();
  const admitted: Array<{ id: string; priority: number; fields: readonly string[] }> = [];
  for (const layer of request.layers) {
    const id = normalize(layer.id);
    if (!id || ids.has(id)) return { ok: false, reason: id ? 'duplicate-layer' : 'invalid-layer-id' };
    ids.add(id);
    if (!Number.isSafeInteger(layer.revision) || layer.revision < 0) return { ok: false, reason: 'invalid-layer-revision' };
    if (layer.revision !== request.expectedRevision) return { ok: false, reason: 'stale-layer-revision' };
    if (!layer.visible || !layer.queryable || !isScaleVisible(layer, request.mapScale)) continue;
    const priority = layer.priority ?? 0;
    if (!Number.isFinite(priority)) return { ok: false, reason: 'invalid-layer-priority' };

    const allowed = new Map<string, string>();
    for (const candidate of layer.allowedFields) {
      const field = normalize(candidate);
      const key = fieldKey(field);
      if (!field || allowed.has(key)) return { ok: false, reason: 'invalid-layer-field-contract' };
      allowed.set(key, field);
    }
    if (allowed.size === 0) return { ok: false, reason: 'empty-layer-field-contract' };
    const layerFields: string[] = [];
    for (const requested of fields) {
      const canonical = allowed.get(fieldKey(requested));
      if (!canonical) return { ok: false, reason: 'field-not-allowed' };
      layerFields.push(canonical);
    }
    for (const requestedSort of sort) {
      if (!allowed.has(fieldKey(requestedSort.field))) return { ok: false, reason: 'sort-field-not-allowed' };
    }
    admitted.push({ id, priority, fields: Object.freeze(layerFields) });
  }
  if (admitted.length === 0) return { ok: false, reason: 'no-queryable-layers' };

  const estimatedBytes = admitted.length * request.resultLimit * budget.estimatedBytesPerFeature;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > budget.maxEstimatedResponseBytes) {
    return { ok: false, reason: 'response-byte-budget-exceeded' };
  }

  admitted.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id, 'en'));
  const frozenSort = Object.freeze(sort.map((entry) => Object.freeze({ ...entry })));
  const layers = Object.freeze(admitted.map((layer) => Object.freeze({ id: layer.id, fields: layer.fields, sort: frozenSort })));
  const fingerprintPayload = [
    request.expectedRevision,
    request.resultOffset,
    request.resultLimit,
    request.returnGeometry ? 1 : 0,
    ...layers.flatMap((layer) => [layer.id, ...layer.fields, ...layer.sort.map((entry) => `${entry.field}:${entry.order}`)]),
  ].join('|');

  return {
    ok: true,
    plan: Object.freeze({
      revision: request.expectedRevision,
      resultOffset: request.resultOffset,
      resultLimit: request.resultLimit,
      returnGeometry: request.returnGeometry,
      layers,
      fingerprint: `query-v1-${fnv1a(fingerprintPayload)}`,
    }),
  };
};
