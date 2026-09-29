export type ArcGisExportFormat = 'png' | 'jpeg' | 'pdf';
export type ArcGisExportMode = '2d' | '3d';

export interface ArcGisExportLayer {
  readonly id: string;
  readonly revision: number;
  readonly visible: boolean;
  readonly exportable: boolean;
  readonly priority?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}

export interface ArcGisExportRequest {
  readonly expectedRevision: number;
  readonly mode: ArcGisExportMode;
  readonly format: ArcGisExportFormat;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly mapScale: number;
  readonly includeLegend: boolean;
  readonly includeAttribution: boolean;
  readonly layers: readonly ArcGisExportLayer[];
}

export interface ArcGisExportBudget {
  readonly maxLayers: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixelRatio: number;
  readonly maxOutputPixels: number;
  readonly maxEstimatedBytes: number;
  readonly estimatedBytesPerPixel: number;
}

export interface ArcGisExportPlan {
  readonly revision: number;
  readonly mode: ArcGisExportMode;
  readonly format: ArcGisExportFormat;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly includeLegend: boolean;
  readonly includeAttribution: boolean;
  readonly layerIds: readonly string[];
  readonly outputPixels: number;
  readonly estimatedBytes: number;
  readonly fingerprint: string;
}

export type ArcGisExportDecision =
  | { readonly ok: true; readonly plan: ArcGisExportPlan }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_BUDGET: ArcGisExportBudget = Object.freeze({
  maxLayers: 32,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixelRatio: 4,
  maxOutputPixels: 40_000_000,
  maxEstimatedBytes: 160_000_000,
  estimatedBytesPerPixel: 4,
});

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const normalizeId = (value: string): string => value.trim();

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const validateBudget = (budget: ArcGisExportBudget): boolean =>
  Number.isSafeInteger(budget.maxLayers) && budget.maxLayers > 0
  && Number.isSafeInteger(budget.maxWidth) && budget.maxWidth > 0
  && Number.isSafeInteger(budget.maxHeight) && budget.maxHeight > 0
  && finitePositive(budget.maxPixelRatio)
  && Number.isSafeInteger(budget.maxOutputPixels) && budget.maxOutputPixels > 0
  && Number.isSafeInteger(budget.maxEstimatedBytes) && budget.maxEstimatedBytes > 0
  && Number.isSafeInteger(budget.estimatedBytesPerPixel) && budget.estimatedBytesPerPixel > 0;

const scaleVisible = (layer: ArcGisExportLayer, scale: number): boolean => {
  if (layer.minScale !== undefined && (!finitePositive(layer.minScale) || scale > layer.minScale)) return false;
  if (layer.maxScale !== undefined && (!finitePositive(layer.maxScale) || scale < layer.maxScale)) return false;
  return true;
};

export const planArcGisExport = (
  request: ArcGisExportRequest,
  budget: ArcGisExportBudget = DEFAULT_BUDGET,
): ArcGisExportDecision => {
  if (!validateBudget(budget)) return { ok: false, reason: 'invalid-budget' };
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) return { ok: false, reason: 'invalid-revision' };
  if (!finitePositive(request.mapScale)) return { ok: false, reason: 'invalid-map-scale' };
  if (!Number.isSafeInteger(request.width) || request.width <= 0 || request.width > budget.maxWidth) return { ok: false, reason: 'width-budget-exceeded' };
  if (!Number.isSafeInteger(request.height) || request.height <= 0 || request.height > budget.maxHeight) return { ok: false, reason: 'height-budget-exceeded' };
  if (!finitePositive(request.pixelRatio) || request.pixelRatio > budget.maxPixelRatio) return { ok: false, reason: 'pixel-ratio-budget-exceeded' };
  if (request.layers.length === 0 || request.layers.length > budget.maxLayers) return { ok: false, reason: 'layer-budget-exceeded' };

  const ids = new Set<string>();
  const admitted: Array<{ id: string; priority: number }> = [];
  for (const layer of request.layers) {
    const id = normalizeId(layer.id);
    if (!id || ids.has(id)) return { ok: false, reason: id ? 'duplicate-layer' : 'invalid-layer-id' };
    ids.add(id);
    if (!Number.isSafeInteger(layer.revision) || layer.revision < 0) return { ok: false, reason: 'invalid-layer-revision' };
    if (layer.revision !== request.expectedRevision) return { ok: false, reason: 'stale-layer-revision' };
    const priority = layer.priority ?? 0;
    if (!Number.isFinite(priority)) return { ok: false, reason: 'invalid-layer-priority' };
    if (layer.visible && layer.exportable && scaleVisible(layer, request.mapScale)) admitted.push({ id, priority });
  }
  if (admitted.length === 0) return { ok: false, reason: 'no-exportable-layers' };

  const physicalWidth = request.width * request.pixelRatio;
  const physicalHeight = request.height * request.pixelRatio;
  const outputPixels = physicalWidth * physicalHeight;
  if (!Number.isSafeInteger(outputPixels) || outputPixels > budget.maxOutputPixels) return { ok: false, reason: 'pixel-budget-exceeded' };
  const estimatedBytes = outputPixels * budget.estimatedBytesPerPixel;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > budget.maxEstimatedBytes) return { ok: false, reason: 'byte-budget-exceeded' };

  admitted.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id, 'en'));
  const layerIds = Object.freeze(admitted.map((entry) => entry.id));
  const payload = [request.expectedRevision, request.mode, request.format, request.width, request.height, request.pixelRatio, request.includeLegend ? 1 : 0, request.includeAttribution ? 1 : 0, ...layerIds].join('|');
  return {
    ok: true,
    plan: Object.freeze({
      revision: request.expectedRevision,
      mode: request.mode,
      format: request.format,
      width: request.width,
      height: request.height,
      pixelRatio: request.pixelRatio,
      includeLegend: request.includeLegend,
      includeAttribution: request.includeAttribution,
      layerIds,
      outputPixels,
      estimatedBytes,
      fingerprint: `export-v1-${fnv1a(payload)}`,
    }),
  };
};
