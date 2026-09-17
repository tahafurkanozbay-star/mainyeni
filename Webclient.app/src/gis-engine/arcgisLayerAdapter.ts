import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

export type ArcGisLayerMode = '2d' | '3d';
export type ArcGisLayerKind = 'feature' | 'map-image';

export type ArcGisLayerSource = Readonly<{
  id: string;
  contract: ArcGisMetadataContract;
  title?: string;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  popupEnabled?: boolean;
  labelsEnabled?: boolean;
}>;

export type ArcGisLayerDescriptor = Readonly<{
  id: string;
  kind: ArcGisLayerKind;
  resourceUrl: string;
  title: string;
  mode: ArcGisLayerMode;
  visible: boolean;
  opacity: number;
  minScale: number;
  maxScale: number;
  popupEnabled: boolean;
  labelsEnabled: boolean;
  queryable: boolean;
  selectable: boolean;
  objectIdField: string | null;
  geometryType: ArcGisMetadataContract['geometryType'];
  spatialReference: ArcGisMetadataContract['spatialReference'];
}>;

export class ArcGisLayerAdapterError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARCGIS_LAYER_ADAPTER_ERROR') {
    super(message);
    this.name = 'ArcGisLayerAdapterError';
    this.code = code;
  }
}

const boundedId = (value: unknown): string => {
  const id = String(value ?? '').trim();
  if (!id || id.length > 256) throw new ArcGisLayerAdapterError('Layer id must be non-empty and bounded.', 'INVALID_LAYER_ID');
  return id;
};

const boundedOpacity = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
};

const scale = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const kindFor = (contract: ArcGisMetadataContract): ArcGisLayerKind => {
  const url = contract.resourceUrl.toLowerCase();
  if (url.includes('/featureserver/')) return 'feature';
  if (url.includes('/mapserver/')) return 'map-image';
  throw new ArcGisLayerAdapterError('Only verified ArcGIS FeatureServer/MapServer layer resources are supported.', 'UNSUPPORTED_LAYER_RESOURCE');
};

const titleFor = (source: ArcGisLayerSource): string => {
  const explicit = source.title?.trim();
  if (explicit) return explicit.slice(0, 256);
  const metadata = source.contract.name?.trim();
  return metadata ? metadata.slice(0, 256) : source.id;
};

/**
 * Converts verified ArcGIS metadata into a renderer-neutral layer descriptor.
 * It deliberately does not instantiate SDK classes, issue network requests,
 * infer endpoints, or duplicate renderer/icon policy. This keeps service facts
 * separate from 2D/3D renderer ownership and makes lifecycle state testable.
 */
export const adaptArcGisLayer = (source: ArcGisLayerSource, mode: ArcGisLayerMode): ArcGisLayerDescriptor => {
  const id = boundedId(source.id);
  const contract = source.contract;
  if (!contract.resourceUrl) throw new ArcGisLayerAdapterError('Verified ArcGIS resource URL is required.', 'MISSING_RESOURCE_URL');
  const minScale = scale(source.minScale, contract.scales.minScale);
  const maxScale = scale(source.maxScale, contract.scales.maxScale);
  if (minScale > 0 && maxScale > 0 && minScale < maxScale) {
    throw new ArcGisLayerAdapterError('ArcGIS minScale must be greater than or equal to maxScale when both are active.', 'INVALID_SCALE_RANGE');
  }
  const queryable = contract.queryReady;
  return Object.freeze({
    id,
    kind: kindFor(contract),
    resourceUrl: contract.resourceUrl,
    title: titleFor(source),
    mode,
    visible: source.visible !== false,
    opacity: boundedOpacity(source.opacity),
    minScale,
    maxScale,
    popupEnabled: source.popupEnabled !== false && queryable,
    labelsEnabled: source.labelsEnabled !== false && contract.renderer.labelingRuleCount > 0,
    queryable,
    selectable: queryable && contract.identityReady,
    objectIdField: contract.objectIdField,
    geometryType: contract.geometryType,
    spatialReference: contract.spatialReference,
  });
};

export const adaptArcGisLayers = (
  sources: readonly ArcGisLayerSource[],
  mode: ArcGisLayerMode,
  maximum = 512,
): readonly ArcGisLayerDescriptor[] => {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 4096) {
    throw new ArcGisLayerAdapterError('Layer adapter maximum must be between 1 and 4096.', 'INVALID_LAYER_BUDGET');
  }
  if (sources.length > maximum) throw new ArcGisLayerAdapterError(`Layer count exceeds bounded maximum of ${maximum}.`, 'LAYER_BUDGET_EXCEEDED');
  const seen = new Set<string>();
  const descriptors: ArcGisLayerDescriptor[] = [];
  for (const source of sources) {
    const descriptor = adaptArcGisLayer(source, mode);
    if (seen.has(descriptor.id)) throw new ArcGisLayerAdapterError(`Duplicate layer id: ${descriptor.id}`, 'DUPLICATE_LAYER_ID');
    seen.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return Object.freeze(descriptors);
};

export const isLayerVisibleAtScale = (descriptor: ArcGisLayerDescriptor, currentScale: unknown): boolean => {
  if (!descriptor.visible) return false;
  const numeric = Number(currentScale);
  if (!Number.isFinite(numeric) || numeric < 0) return false;
  if (descriptor.minScale > 0 && numeric > descriptor.minScale) return false;
  if (descriptor.maxScale > 0 && numeric < descriptor.maxScale) return false;
  return true;
};
