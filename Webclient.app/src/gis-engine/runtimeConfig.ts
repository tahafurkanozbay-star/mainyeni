import type { GisServiceInput, SanitizedGisService } from './contracts';
import { sanitizeCatalog } from './serviceCatalog';
import type { GeometryBudget } from './geometryGuard';
import type { QueryExecutionLimits } from './queryExecutionPlanner';
import type { RequestCoordinatorOptions } from './requestCoordinator';

/**
 * Strict JSON configuration boundary for the GIS runtime.
 *
 * It normalizes only application-owned limits and references existing service
 * records. Service URLs continue to be sanitized by serviceCatalog; this module
 * never creates an endpoint and explicitly rejects OGC/WMS/WFS-style entries.
 */

export type RuntimeConfigIssueSeverity = 'info' | 'warning' | 'error';

export type RuntimeConfigIssueCode =
  | 'config-not-object'
  | 'services-not-array'
  | 'service-rejected'
  | 'duplicate-service-id'
  | 'layer-not-object'
  | 'layer-missing-id'
  | 'layer-missing-service'
  | 'layer-service-not-found'
  | 'duplicate-layer-id'
  | 'invalid-scale-range'
  | 'invalid-opacity'
  | 'invalid-number'
  | 'invalid-boolean'
  | 'invalid-mode'
  | 'invalid-spatial-reference'
  | 'unsafe-limit-clamped';

export interface RuntimeConfigIssue {
  readonly code: RuntimeConfigIssueCode;
  readonly severity: RuntimeConfigIssueSeverity;
  readonly path: string;
  readonly message: string;
}

export interface RuntimeLayerConfig {
  readonly id: string;
  readonly title: string;
  readonly serviceId: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly iconKey: string | null;
  readonly category: string | null;
  readonly queryable: boolean;
  readonly selectable: boolean;
  readonly cluster: 'auto' | 'on' | 'off';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RuntimeViewConfig {
  readonly defaultMode: '2d' | '3d';
  readonly defaultWkid: number | null;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly defaultZoom: number;
  readonly persistState: boolean;
}

export interface RuntimePerformanceConfig {
  readonly request: Readonly<Required<Pick<
    RequestCoordinatorOptions,
    'maxConcurrent' | 'maxQueued' | 'cacheEntries' | 'cacheBytes' | 'defaultTtlMs'
  >>>;
  readonly query: Readonly<Required<QueryExecutionLimits>>;
  readonly geometry: Readonly<Required<Omit<GeometryBudget, 'allowedWkids'>> & { allowedWkids: readonly number[] }>;
  readonly maxOperationalLayers: number;
  readonly maxVisibleLayers: number;
}

export interface GisRuntimeConfig {
  readonly version: 1;
  readonly services: readonly SanitizedGisService[];
  readonly serviceById: ReadonlyMap<string, SanitizedGisService>;
  readonly layers: readonly RuntimeLayerConfig[];
  readonly layerById: ReadonlyMap<string, RuntimeLayerConfig>;
  readonly view: RuntimeViewConfig;
  readonly performance: RuntimePerformanceConfig;
  readonly issues: readonly RuntimeConfigIssue[];
  readonly valid: boolean;
}

export interface ParseRuntimeConfigOptions {
  readonly strict?: boolean;
  readonly rejectUnknownServices?: boolean;
}

export class RuntimeConfigError extends Error {
  readonly code: string;
  readonly issues: readonly RuntimeConfigIssue[];

  constructor(message: string, code: string, issues: readonly RuntimeConfigIssue[] = []) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const record = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const issue = (
  code: RuntimeConfigIssueCode,
  severity: RuntimeConfigIssueSeverity,
  path: string,
  message: string,
): RuntimeConfigIssue => Object.freeze({ code, severity, path, message });

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const bool = (
  value: unknown,
  fallback: boolean,
  path: string,
  issues: RuntimeConfigIssue[],
): boolean => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  issues.push(issue('invalid-boolean', 'warning', path, `Expected boolean; using ${String(fallback)}.`));
  return fallback;
};

const finite = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
  issues: RuntimeConfigIssue[],
): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    issues.push(issue('invalid-number', 'warning', path, `Expected finite number; using ${fallback}.`));
    return fallback;
  }
  const clamped = Math.min(maximum, Math.max(minimum, numeric));
  if (clamped !== numeric) {
    issues.push(issue(
      'unsafe-limit-clamped',
      'warning',
      path,
      `Value ${numeric} was clamped to safe range ${minimum}..${maximum}.`,
    ));
  }
  return clamped;
};

const integer = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
  issues: RuntimeConfigIssue[],
): number => Math.floor(finite(value, fallback, minimum, maximum, path, issues));

const numberArray = (value: unknown): readonly number[] => (
  Array.isArray(value)
    ? Object.freeze(value
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry > 0))
    : Object.freeze([])
);

const deepFreezeRecord = (value: UnknownRecord): Readonly<Record<string, unknown>> => {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) output[key] = Object.freeze(entry.slice());
    else if (isRecord(entry)) output[key] = deepFreezeRecord(entry);
    else output[key] = entry;
  }
  return Object.freeze(output);
};

const explicitDisallowedService = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const type = String(value.type ?? '').trim().toUpperCase();
  return ['WMS', 'WFS', 'WMTS', 'OGC-WMS', 'OGC-WFS'].includes(type);
};

const parseServices = (
  source: UnknownRecord,
  issues: RuntimeConfigIssue[],
): readonly SanitizedGisService[] => {
  const raw = source.services;
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    issues.push(issue('services-not-array', 'error', 'services', 'GIS services must be an array.'));
    return Object.freeze([]);
  }
  const accepted: GisServiceInput[] = [];
  const seenRawIds = new Set<string>();
  raw.forEach((candidate, index) => {
    const path = `services[${index}]`;
    if (!isRecord(candidate)) {
      issues.push(issue('service-rejected', 'error', path, 'Service entry must be an object.'));
      return;
    }
    if (explicitDisallowedService(candidate)) {
      issues.push(issue(
        'service-rejected',
        'error',
        path,
        'WMS/WFS/WMTS/OGC service variants are forbidden by the Kent Rehberi GIS runtime policy.',
      ));
      return;
    }
    const id = text(candidate.id);
    if (id && seenRawIds.has(id)) {
      issues.push(issue('duplicate-service-id', 'error', `${path}.id`, `Duplicate GIS service id ${id}.`));
      return;
    }
    if (id) seenRawIds.add(id);
    accepted.push(candidate as GisServiceInput);
  });

  const sanitized = sanitizeCatalog(accepted);
  const sanitizedIds = new Set(sanitized.map((service) => service.id));
  for (const candidate of accepted) {
    const id = text(candidate.id);
    if (!id || !sanitizedIds.has(id)) {
      issues.push(issue(
        'service-rejected',
        'error',
        id ? `services.${id}` : 'services',
        id
          ? `Service ${id} was rejected by the canonical GIS service catalog policy.`
          : 'Service without a stable id was rejected by the canonical GIS service catalog policy.',
      ));
    }
  }
  return Object.freeze(sanitized.slice());
};

const clusterMode = (value: unknown): RuntimeLayerConfig['cluster'] => (
  value === 'on' || value === 'off' ? value : 'auto'
);

const parseLayers = (
  source: UnknownRecord,
  serviceById: ReadonlyMap<string, SanitizedGisService>,
  issues: RuntimeConfigIssue[],
): readonly RuntimeLayerConfig[] => {
  const raw = source.layers;
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    issues.push(issue('layer-not-object', 'error', 'layers', 'GIS layers must be an array.'));
    return Object.freeze([]);
  }
  const output: RuntimeLayerConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((candidate, index) => {
    const path = `layers[${index}]`;
    if (!isRecord(candidate)) {
      issues.push(issue('layer-not-object', 'error', path, 'Layer entry must be an object.'));
      return;
    }
    const id = text(candidate.id);
    if (!id) {
      issues.push(issue('layer-missing-id', 'error', `${path}.id`, 'Layer requires a stable id.'));
      return;
    }
    if (seen.has(id)) {
      issues.push(issue('duplicate-layer-id', 'error', `${path}.id`, `Duplicate layer id ${id}.`));
      return;
    }
    seen.add(id);
    const serviceId = text(candidate.serviceId);
    if (!serviceId) {
      issues.push(issue('layer-missing-service', 'error', `${path}.serviceId`, `Layer ${id} requires serviceId.`));
      return;
    }
    if (!serviceById.has(serviceId)) {
      issues.push(issue(
        'layer-service-not-found',
        'error',
        `${path}.serviceId`,
        `Layer ${id} references unknown/rejected service ${serviceId}.`,
      ));
      return;
    }

    const minScale = finite(candidate.minScale, 0, 0, 1_000_000_000, `${path}.minScale`, issues);
    const maxScale = finite(candidate.maxScale, 0, 0, 1_000_000_000, `${path}.maxScale`, issues);
    if (minScale > 0 && maxScale > 0 && minScale < maxScale) {
      issues.push(issue(
        'invalid-scale-range',
        'warning',
        path,
        'ArcGIS minScale should be numerically greater than maxScale; values were reset to unbounded.',
      ));
    }
    const opacityRaw = Number(candidate.opacity);
    if (candidate.opacity !== undefined && (!Number.isFinite(opacityRaw) || opacityRaw < 0 || opacityRaw > 1)) {
      issues.push(issue('invalid-opacity', 'warning', `${path}.opacity`, 'Opacity must be between 0 and 1.'));
    }
    const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
    output.push(Object.freeze({
      id,
      title: text(candidate.title) ?? text(candidate.name) ?? id,
      serviceId,
      visible: bool(candidate.visible, true, `${path}.visible`, issues),
      opacity: finite(candidate.opacity, 1, 0, 1, `${path}.opacity`, issues),
      minScale: minScale > 0 && maxScale > 0 && minScale < maxScale ? 0 : minScale,
      maxScale: minScale > 0 && maxScale > 0 && minScale < maxScale ? 0 : maxScale,
      iconKey: text(candidate.iconKey),
      category: text(candidate.category),
      queryable: bool(candidate.queryable, true, `${path}.queryable`, issues),
      selectable: bool(candidate.selectable, true, `${path}.selectable`, issues),
      cluster: clusterMode(candidate.cluster),
      metadata: deepFreezeRecord(metadata),
    }));
  });
  return Object.freeze(output);
};

const parseView = (source: UnknownRecord, issues: RuntimeConfigIssue[]): RuntimeViewConfig => {
  const view = record(source.view);
  const modeRaw = text(view.defaultMode);
  if (modeRaw && modeRaw !== '2d' && modeRaw !== '3d') {
    issues.push(issue('invalid-mode', 'warning', 'view.defaultMode', 'Only 2d or 3d view modes are accepted.'));
  }
  const wkidRaw = Number(view.defaultWkid);
  const defaultWkid = view.defaultWkid === undefined || view.defaultWkid === null
    ? null
    : Number.isInteger(wkidRaw) && wkidRaw > 0
      ? wkidRaw
      : null;
  if (view.defaultWkid !== undefined && defaultWkid === null) {
    issues.push(issue(
      'invalid-spatial-reference',
      'warning',
      'view.defaultWkid',
      'Default WKID must be a positive integer; no projection is guessed.',
    ));
  }
  const minZoom = finite(view.minZoom, 0, 0, 30, 'view.minZoom', issues);
  const maxZoom = finite(view.maxZoom, 23, minZoom, 30, 'view.maxZoom', issues);
  const defaultZoom = finite(view.defaultZoom, 11, minZoom, maxZoom, 'view.defaultZoom', issues);
  return Object.freeze({
    defaultMode: modeRaw === '3d' ? '3d' : '2d',
    defaultWkid,
    minZoom,
    maxZoom,
    defaultZoom,
    persistState: bool(view.persistState, true, 'view.persistState', issues),
  });
};

const parsePerformance = (source: UnknownRecord, issues: RuntimeConfigIssue[]): RuntimePerformanceConfig => {
  const performance = record(source.performance);
  const request = record(performance.request);
  const query = record(performance.query);
  const geometry = record(performance.geometry);
  const allowedWkids = numberArray(geometry.allowedWkids);

  return Object.freeze({
    request: Object.freeze({
      maxConcurrent: integer(request.maxConcurrent, 6, 1, 32, 'performance.request.maxConcurrent', issues),
      maxQueued: integer(request.maxQueued, 128, 8, 5000, 'performance.request.maxQueued', issues),
      cacheEntries: integer(request.cacheEntries, 128, 0, 5000, 'performance.request.cacheEntries', issues),
      cacheBytes: integer(
        request.cacheBytes,
        32 * 1024 * 1024,
        0,
        512 * 1024 * 1024,
        'performance.request.cacheBytes',
        issues,
      ),
      defaultTtlMs: integer(request.defaultTtlMs, 30_000, 0, 600_000, 'performance.request.defaultTtlMs', issues),
    }),
    query: Object.freeze({
      maxFeatures: integer(query.maxFeatures, 25_000, 100, 5_000_000, 'performance.query.maxFeatures', issues),
      maxPages: integer(query.maxPages, 100, 1, 10_000, 'performance.query.maxPages', issues),
      preferredPageSize: integer(query.preferredPageSize, 1000, 10, 10_000, 'performance.query.preferredPageSize', issues),
      maxPageSize: integer(query.maxPageSize, 5000, 10, 10_000, 'performance.query.maxPageSize', issues),
      maxOutFields: integer(query.maxOutFields, 128, 1, 2048, 'performance.query.maxOutFields', issues),
      maxWhereLength: integer(query.maxWhereLength, 16_384, 256, 65_536, 'performance.query.maxWhereLength', issues),
      geometryVertexBudget: integer(
        query.geometryVertexBudget,
        100_000,
        100,
        5_000_000,
        'performance.query.geometryVertexBudget',
        issues,
      ),
      allowUnboundedExport: bool(
        query.allowUnboundedExport,
        false,
        'performance.query.allowUnboundedExport',
        issues,
      ),
    }),
    geometry: Object.freeze({
      maxVertices: integer(geometry.maxVertices, 100_000, 100, 5_000_000, 'performance.geometry.maxVertices', issues),
      maxParts: integer(geometry.maxParts, 2048, 1, 100_000, 'performance.geometry.maxParts', issues),
      maxRings: integer(geometry.maxRings, 2048, 1, 100_000, 'performance.geometry.maxRings', issues),
      maxCoordinatesPerPart: integer(
        geometry.maxCoordinatesPerPart,
        50_000,
        4,
        5_000_000,
        'performance.geometry.maxCoordinatesPerPart',
        issues,
      ),
      maxAbsoluteCoordinate: finite(
        geometry.maxAbsoluteCoordinate,
        1_000_000_000,
        1,
        Number.MAX_SAFE_INTEGER,
        'performance.geometry.maxAbsoluteCoordinate',
        issues,
      ),
      requireSpatialReference: bool(
        geometry.requireSpatialReference,
        false,
        'performance.geometry.requireSpatialReference',
        issues,
      ),
      allowZ: bool(geometry.allowZ, true, 'performance.geometry.allowZ', issues),
      allowedWkids,
    }),
    maxOperationalLayers: integer(
      performance.maxOperationalLayers,
      250,
      1,
      5000,
      'performance.maxOperationalLayers',
      issues,
    ),
    maxVisibleLayers: integer(
      performance.maxVisibleLayers,
      80,
      1,
      1000,
      'performance.maxVisibleLayers',
      issues,
    ),
  });
};

export const parseGisRuntimeConfig = (
  value: unknown,
  options: ParseRuntimeConfigOptions = {},
): GisRuntimeConfig => {
  const issues: RuntimeConfigIssue[] = [];
  if (!isRecord(value)) {
    issues.push(issue('config-not-object', 'error', '$', 'GIS runtime configuration must be a JSON object.'));
    const error = new RuntimeConfigError('Invalid GIS runtime configuration.', 'CONFIG_NOT_OBJECT', issues);
    if (options.strict !== false) throw error;
  }
  const source = record(value);
  const services = parseServices(source, issues);
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const layers = parseLayers(source, serviceById, issues);
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const view = parseView(source, issues);
  const performance = parsePerformance(source, issues);
  const valid = !issues.some((entry) => entry.severity === 'error');
  if (!valid && options.strict !== false) {
    throw new RuntimeConfigError('GIS runtime configuration contains blocking errors.', 'CONFIG_INVALID', issues);
  }
  return Object.freeze({
    version: 1 as const,
    services,
    serviceById,
    layers,
    layerById,
    view,
    performance,
    issues: Object.freeze(issues.slice()),
    valid,
  });
};

export const configSummary = (config: GisRuntimeConfig): Readonly<Record<string, number | boolean | string>> => Object.freeze({
  valid: config.valid,
  serviceCount: config.services.length,
  layerCount: config.layers.length,
  enabledServiceCount: config.services.filter((service) => service.enabled).length,
  visibleLayerCount: config.layers.filter((layer) => layer.visible).length,
  issueCount: config.issues.length,
  errorCount: config.issues.filter((entry) => entry.severity === 'error').length,
  warningCount: config.issues.filter((entry) => entry.severity === 'warning').length,
  defaultMode: config.view.defaultMode,
  maxConcurrentRequests: config.performance.request.maxConcurrent,
  maxQueryFeatures: config.performance.query.maxFeatures,
});

export const referencedServiceIds = (config: GisRuntimeConfig): readonly string[] => Object.freeze(
  Array.from(new Set(config.layers.map((layer) => layer.serviceId))).sort(),
);

export const unreferencedServiceIds = (config: GisRuntimeConfig): readonly string[] => {
  const referenced = new Set(referencedServiceIds(config));
  return Object.freeze(config.services.map((service) => service.id).filter((id) => !referenced.has(id)).sort());
};

export const collectLayerCategories = (config: GisRuntimeConfig): readonly string[] => Object.freeze(
  Array.from(new Set(
    config.layers
      .map((layer) => layer.category)
      .filter((value): value is string => Boolean(value)),
  )).sort((left, right) => left.localeCompare(right, 'tr-TR')),
);

export const collectDeclaredIconKeys = (config: GisRuntimeConfig): readonly string[] => Object.freeze(
  Array.from(new Set(
    config.layers
      .map((layer) => layer.iconKey)
      .filter((value): value is string => Boolean(value)),
  )).sort(),
);
