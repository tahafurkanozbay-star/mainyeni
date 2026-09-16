export type GisServiceKind = 'feature' | 'map' | 'image' | 'scene' | 'vector-tile';
export type GisLayerMode = '2d' | '3d' | 'both';

export type GisServiceConfig = Readonly<{
  id: string;
  url: string;
  kind: GisServiceKind;
  enabled: boolean;
  metadataTtlMs: number;
  cacheTtlMs: number;
  timeoutMs: number;
}>;

export type GisLayerConfig = Readonly<{
  id: string;
  title: string;
  serviceId: string;
  layerId: number | null;
  mode: GisLayerMode;
  visible: boolean;
  opacity: number;
  minScale: number;
  maxScale: number;
  iconKey: string | null;
  parentId: string | null;
  children: readonly string[];
  cluster: boolean;
  labels: boolean;
}>;

export type GisConfigIssue = Readonly<{
  code: string;
  severity: 'warning' | 'error';
  path: string;
  message: string;
}>;

export type GisJsonConfig = Readonly<{
  version: number;
  services: readonly GisServiceConfig[];
  layers: readonly GisLayerConfig[];
  serviceMap: ReadonlyMap<string, GisServiceConfig>;
  layerMap: ReadonlyMap<string, GisLayerConfig>;
  roots: readonly string[];
  issues: readonly GisConfigIssue[];
}>;

export class GisConfigContractError extends Error {
  readonly code: string;
  readonly issues: readonly GisConfigIssue[];
  constructor(message: string, code = 'GIS_CONFIG_CONTRACT_ERROR', issues: readonly GisConfigIssue[] = []) {
    super(message);
    this.name = 'GisConfigContractError';
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const finite = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const nonNegative = (value: unknown): number => {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : 0;
};
const positiveInteger = (value: unknown, fallback: number, max: number): number => {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? Math.min(max, Math.floor(numeric)) : fallback;
};
const normalizeOpacity = (value: unknown): number => Math.max(0, Math.min(1, finite(value) ?? 1));
const unique = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)]);
const issue = (code: string, severity: GisConfigIssue['severity'], path: string, message: string): GisConfigIssue => (
  Object.freeze({ code, severity, path, message })
);

const normalizeId = (value: unknown, path: string, issues: GisConfigIssue[]): string => {
  const id = text(value);
  if (!id) {
    issues.push(issue('missing-id', 'error', path, 'A stable id is required.'));
    return '';
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
    issues.push(issue('invalid-id', 'error', path, 'Id contains unsupported characters or exceeds 128 characters.'));
  }
  return id;
};

const classifyServiceUrl = (url: string): GisServiceKind | null => {
  const normalized = url.replace(/\/+$/, '').toLowerCase();
  if (normalized.endsWith('/featureserver') || /\/featureserver\/\d+$/.test(normalized)) return 'feature';
  if (normalized.endsWith('/mapserver') || /\/mapserver\/\d+$/.test(normalized)) return 'map';
  if (normalized.endsWith('/imageserver')) return 'image';
  if (normalized.endsWith('/sceneserver')) return 'scene';
  if (normalized.endsWith('/vectortileserver')) return 'vector-tile';
  return null;
};

const isForbiddenOgc = (url: string): boolean => (
  /(?:\/|\b)(?:wms|wfs)(?:\/|\b|\?)/i.test(url) || /[?&]service=(?:wms|wfs)(?:&|$)/i.test(url)
);

const normalizeService = (value: unknown, index: number, issues: GisConfigIssue[]): GisServiceConfig | null => {
  const source = record(value);
  const path = `services[${index}]`;
  const id = normalizeId(source.id, `${path}.id`, issues);
  const url = (text(source.url) ?? '').replace(/\/+$/, '');
  if (!url) issues.push(issue('missing-service-url', 'error', `${path}.url`, 'ArcGIS service URL is required.'));
  if (url && isForbiddenOgc(url)) issues.push(issue('forbidden-ogc-service', 'error', `${path}.url`, 'WMS/WFS resources are forbidden.'));
  const detectedKind = url ? classifyServiceUrl(url) : null;
  if (url && !detectedKind) issues.push(issue('unsupported-service-url', 'error', `${path}.url`, 'Only ArcGIS REST service paths are allowed.'));
  const requestedKind = text(source.kind);
  const allowedKinds: readonly GisServiceKind[] = ['feature', 'map', 'image', 'scene', 'vector-tile'];
  const explicitKind = requestedKind && allowedKinds.includes(requestedKind as GisServiceKind) ? requestedKind as GisServiceKind : null;
  if (requestedKind && !explicitKind) issues.push(issue('invalid-service-kind', 'error', `${path}.kind`, `Unsupported service kind: ${requestedKind}.`));
  if (explicitKind && detectedKind && explicitKind !== detectedKind) {
    issues.push(issue('service-kind-mismatch', 'error', `${path}.kind`, `Configured kind ${explicitKind} does not match URL kind ${detectedKind}.`));
  }
  const kind = explicitKind ?? detectedKind;
  if (!id || !url || !kind) return null;
  return Object.freeze({
    id,
    url,
    kind,
    enabled: source.enabled !== false,
    metadataTtlMs: positiveInteger(source.metadataTtlMs, 300_000, 86_400_000),
    cacheTtlMs: positiveInteger(source.cacheTtlMs, 15_000, 3_600_000),
    timeoutMs: positiveInteger(source.timeoutMs, 20_000, 120_000),
  });
};

const normalizeMode = (value: unknown): GisLayerMode => {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === '2d' || mode === '3d') return mode;
  return 'both';
};

const normalizeLayer = (value: unknown, index: number, issues: GisConfigIssue[]): GisLayerConfig | null => {
  const source = record(value);
  const path = `layers[${index}]`;
  const id = normalizeId(source.id, `${path}.id`, issues);
  const serviceId = normalizeId(source.serviceId, `${path}.serviceId`, issues);
  const layerIdNumber = finite(source.layerId);
  const layerId = layerIdNumber !== null && Number.isInteger(layerIdNumber) && layerIdNumber >= 0 ? layerIdNumber : null;
  if (source.layerId !== undefined && layerId === null) issues.push(issue('invalid-layer-id', 'error', `${path}.layerId`, 'Layer id must be a non-negative integer.'));
  const minScale = nonNegative(source.minScale);
  const maxScale = nonNegative(source.maxScale);
  if (minScale > 0 && maxScale > 0 && minScale <= maxScale) {
    issues.push(issue('invalid-scale-range', 'warning', path, 'ArcGIS scale denominators normally require minScale > maxScale.'));
  }
  const iconKey = text(source.iconKey);
  if (iconKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(iconKey)) issues.push(issue('invalid-icon-key', 'error', `${path}.iconKey`, 'Icon key is invalid.'));
  const children = unique(list(source.children).map(text).filter((candidate): candidate is string => Boolean(candidate)));
  if (!id || !serviceId) return null;
  return Object.freeze({
    id,
    title: text(source.title) ?? text(source.name) ?? id,
    serviceId,
    layerId,
    mode: normalizeMode(source.mode),
    visible: source.visible !== false,
    opacity: normalizeOpacity(source.opacity),
    minScale,
    maxScale,
    iconKey,
    parentId: text(source.parentId),
    children,
    cluster: source.cluster === true,
    labels: source.labels !== false,
  });
};

const validateUniqueIds = (
  services: readonly GisServiceConfig[],
  layers: readonly GisLayerConfig[],
  issues: GisConfigIssue[],
): void => {
  const serviceIds = new Set<string>();
  services.forEach((service) => {
    if (serviceIds.has(service.id)) issues.push(issue('duplicate-service-id', 'error', `services.${service.id}`, 'Service id is duplicated.'));
    serviceIds.add(service.id);
  });
  const layerIds = new Set<string>();
  layers.forEach((layer) => {
    if (layerIds.has(layer.id)) issues.push(issue('duplicate-layer-id', 'error', `layers.${layer.id}`, 'Layer id is duplicated.'));
    layerIds.add(layer.id);
  });
};

const validateReferences = (
  layers: readonly GisLayerConfig[],
  serviceMap: ReadonlyMap<string, GisServiceConfig>,
  layerMap: ReadonlyMap<string, GisLayerConfig>,
  knownIconKeys: ReadonlySet<string> | undefined,
  issues: GisConfigIssue[],
): void => {
  for (const layer of layers) {
    const service = serviceMap.get(layer.serviceId);
    if (!service) {
      issues.push(issue('missing-service-reference', 'error', `layers.${layer.id}.serviceId`, `Service ${layer.serviceId} does not exist.`));
    } else {
      const concrete = /\/(?:FeatureServer|MapServer)\/\d+$/i.test(service.url);
      if ((service.kind === 'feature' || service.kind === 'map') && !concrete && layer.layerId === null) {
        issues.push(issue('missing-concrete-layer-id', 'error', `layers.${layer.id}.layerId`, 'FeatureServer/MapServer roots require a sublayer id.'));
      }
      if (service.kind === 'scene' && layer.mode === '2d') issues.push(issue('scene-layer-2d-only', 'warning', `layers.${layer.id}.mode`, 'Scene service is configured as 2D-only.'));
    }
    if (layer.parentId && !layerMap.has(layer.parentId)) issues.push(issue('missing-parent-layer', 'error', `layers.${layer.id}.parentId`, `Parent layer ${layer.parentId} does not exist.`));
    if (layer.parentId === layer.id) issues.push(issue('self-parent-layer', 'error', `layers.${layer.id}.parentId`, 'Layer cannot be its own parent.'));
    for (const childId of layer.children) {
      if (!layerMap.has(childId)) issues.push(issue('missing-child-layer', 'error', `layers.${layer.id}.children`, `Child layer ${childId} does not exist.`));
      if (childId === layer.id) issues.push(issue('self-child-layer', 'error', `layers.${layer.id}.children`, 'Layer cannot contain itself.'));
      const child = layerMap.get(childId);
      if (child && child.parentId && child.parentId !== layer.id) {
        issues.push(issue('child-parent-mismatch', 'warning', `layers.${layer.id}.children`, `Child ${childId} declares parent ${child.parentId}.`));
      }
    }
    if (layer.iconKey && knownIconKeys && !knownIconKeys.has(layer.iconKey)) issues.push(issue('unknown-icon-key', 'warning', `layers.${layer.id}.iconKey`, `Icon key ${layer.iconKey} is absent from the shared icon registry.`));
  }
};

const validateParentCycles = (layers: readonly GisLayerConfig[], layerMap: ReadonlyMap<string, GisLayerConfig>, issues: GisConfigIssue[]): void => {
  const done = new Set<string>();
  for (const start of layers) {
    if (done.has(start.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: GisLayerConfig | undefined = start;
    while (current) {
      if (done.has(current.id)) break;
      const existing = positions.get(current.id);
      if (existing !== undefined) {
        const cycle = [...path.slice(existing), current.id];
        issues.push(issue('layer-cycle', 'error', `layers.${start.id}`, `Layer parent cycle detected: ${cycle.join(' -> ')}`));
        break;
      }
      positions.set(current.id, path.length);
      path.push(current.id);
      current = current.parentId ? layerMap.get(current.parentId) : undefined;
    }
    path.forEach((id) => done.add(id));
  }
};

const rootsFor = (layers: readonly GisLayerConfig[], layerMap: ReadonlyMap<string, GisLayerConfig>): readonly string[] => unique(
  layers.filter((layer) => !layer.parentId || !layerMap.has(layer.parentId)).map((layer) => layer.id),
);

export const parseGisJsonConfig = (
  input: unknown,
  options: Readonly<{ knownIconKeys?: ReadonlySet<string>; rejectWarnings?: boolean }> = {},
): GisJsonConfig => {
  if (!isRecord(input)) throw new GisConfigContractError('GIS configuration must be a JSON object.', 'CONFIG_NOT_OBJECT');
  const issues: GisConfigIssue[] = [];
  const version = positiveInteger(input.version, 1, 1_000_000);
  const rawServices = list(input.services);
  const rawLayers = list(input.layers);
  if (!rawServices.length) issues.push(issue('empty-services', 'error', 'services', 'At least one ArcGIS service is required.'));
  const services = Object.freeze(rawServices.map((value, index) => normalizeService(value, index, issues)).filter((candidate): candidate is GisServiceConfig => candidate !== null));
  const layers = Object.freeze(rawLayers.map((value, index) => normalizeLayer(value, index, issues)).filter((candidate): candidate is GisLayerConfig => candidate !== null));
  validateUniqueIds(services, layers, issues);
  const serviceMap = new Map<string, GisServiceConfig>();
  services.forEach((service) => { if (!serviceMap.has(service.id)) serviceMap.set(service.id, service); });
  const layerMap = new Map<string, GisLayerConfig>();
  layers.forEach((layer) => { if (!layerMap.has(layer.id)) layerMap.set(layer.id, layer); });
  validateReferences(layers, serviceMap, layerMap, options.knownIconKeys, issues);
  validateParentCycles(layers, layerMap, issues);
  const frozenIssues = Object.freeze(issues);
  if (issues.some((candidate) => candidate.severity === 'error') || (options.rejectWarnings === true && issues.length)) {
    throw new GisConfigContractError('GIS configuration failed validation.', 'INVALID_GIS_CONFIG', frozenIssues);
  }
  return Object.freeze({
    version,
    services,
    layers,
    serviceMap,
    layerMap,
    roots: rootsFor(layers, layerMap),
    issues: frozenIssues,
  });
};

export const resolveLayerResourceUrl = (config: GisJsonConfig, layerId: string): string => {
  const normalized = String(layerId ?? '').trim();
  const layer = config.layerMap.get(normalized);
  if (!layer) throw new GisConfigContractError(`Unknown GIS layer: ${normalized}`, 'UNKNOWN_LAYER');
  const service = config.serviceMap.get(layer.serviceId);
  if (!service) throw new GisConfigContractError(`Layer ${layer.id} references missing service ${layer.serviceId}.`, 'MISSING_SERVICE');
  if (/\/(?:FeatureServer|MapServer)\/\d+$/i.test(service.url)) return service.url;
  if ((service.kind === 'feature' || service.kind === 'map') && layer.layerId !== null) return `${service.url}/${layer.layerId}`;
  return service.url;
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean => left.join('\u0000') === right.join('\u0000');

export const diffGisConfigs = (previous: GisJsonConfig, next: GisJsonConfig): Readonly<{
  addedServices: readonly string[]; removedServices: readonly string[]; changedServices: readonly string[];
  addedLayers: readonly string[]; removedLayers: readonly string[]; changedLayers: readonly string[];
}> => Object.freeze({
  addedServices: Object.freeze(next.services.filter((item) => !previous.serviceMap.has(item.id)).map((item) => item.id)),
  removedServices: Object.freeze(previous.services.filter((item) => !next.serviceMap.has(item.id)).map((item) => item.id)),
  changedServices: Object.freeze(next.services.filter((item) => {
    const before = previous.serviceMap.get(item.id);
    return Boolean(before && (before.url !== item.url || before.kind !== item.kind || before.enabled !== item.enabled || before.metadataTtlMs !== item.metadataTtlMs || before.cacheTtlMs !== item.cacheTtlMs || before.timeoutMs !== item.timeoutMs));
  }).map((item) => item.id)),
  addedLayers: Object.freeze(next.layers.filter((item) => !previous.layerMap.has(item.id)).map((item) => item.id)),
  removedLayers: Object.freeze(previous.layers.filter((item) => !next.layerMap.has(item.id)).map((item) => item.id)),
  changedLayers: Object.freeze(next.layers.filter((item) => {
    const before = previous.layerMap.get(item.id);
    return Boolean(before && (
      before.serviceId !== item.serviceId || before.layerId !== item.layerId || before.mode !== item.mode || before.visible !== item.visible ||
      before.opacity !== item.opacity || before.minScale !== item.minScale || before.maxScale !== item.maxScale || before.iconKey !== item.iconKey ||
      before.parentId !== item.parentId || before.cluster !== item.cluster || before.labels !== item.labels || !sameStrings(before.children, item.children)
    ));
  }).map((item) => item.id)),
});
