import type {
  ArcGisOrderBy,
  ArcGisQuerySpec,
  ArcGisQueryWindow,
} from './arcgisQueryContract';
import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

/**
 * Turns server-advertised ArcGIS metadata plus user intent into a bounded query
 * execution policy. It does not issue requests and does not invent capabilities.
 */

export type QueryPurpose = 'interactive' | 'analysis' | 'export';
export type QueryExecutionStrategy = 'single' | 'offset-pagination' | 'bounded-single-page';

export interface QueryExecutionLimits {
  readonly maxFeatures?: number;
  readonly maxPages?: number;
  readonly preferredPageSize?: number;
  readonly maxPageSize?: number;
  readonly maxOutFields?: number;
  readonly maxWhereLength?: number;
  readonly geometryVertexBudget?: number;
  readonly allowUnboundedExport?: boolean;
}

export interface QueryExecutionRequest {
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly returnGeometry?: boolean;
  readonly geometry?: ArcGisQuerySpec['geometry'];
  readonly spatialRel?: ArcGisQuerySpec['spatialRel'];
  readonly outSpatialReference?: ArcGisQuerySpec['outSpatialReference'];
  readonly orderBy?: readonly ArcGisOrderBy[];
  readonly purpose?: QueryPurpose;
  readonly startOffset?: number;
  readonly expectedFeatureCount?: number;
}

export type QueryPlanDiagnosticCode =
  | 'query-not-ready'
  | 'identity-not-ready'
  | 'pagination-unavailable'
  | 'stable-order-unavailable'
  | 'page-size-clamped'
  | 'feature-limit-clamped'
  | 'field-projection-expanded'
  | 'field-projection-deduped'
  | 'field-projection-truncated'
  | 'unknown-field-dropped'
  | 'geometry-disabled'
  | 'export-bounded'
  | 'expected-count-exceeds-budget'
  | 'where-normalized';

export interface QueryPlanDiagnostic {
  readonly code: QueryPlanDiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface QueryExecutionPage {
  readonly index: number;
  readonly offset: number;
  readonly limit: number;
}

export interface QueryExecutionPlan {
  readonly resourceUrl: string;
  readonly strategy: QueryExecutionStrategy;
  readonly purpose: QueryPurpose;
  readonly query: Omit<ArcGisQuerySpec, 'window'>;
  readonly pageSize: number;
  readonly maxFeatures: number;
  readonly maxPages: number;
  readonly initialOffset: number;
  readonly stableOrder: boolean;
  readonly objectIdField: string | null;
  readonly diagnostics: readonly QueryPlanDiagnostic[];
  readonly signature: string;
  page(index: number): QueryExecutionPage;
  pageSpec(index: number): ArcGisQuerySpec;
}

export class QueryExecutionPlannerError extends Error {
  readonly code: string;
  readonly diagnostics: readonly QueryPlanDiagnostic[];

  constructor(message: string, code: string, diagnostics: readonly QueryPlanDiagnostic[] = []) {
    super(message);
    this.name = 'QueryExecutionPlannerError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

interface NormalizedLimits {
  readonly maxFeatures: number;
  readonly maxPages: number;
  readonly preferredPageSize: number;
  readonly maxPageSize: number;
  readonly maxOutFields: number;
  readonly maxWhereLength: number;
  readonly geometryVertexBudget: number;
  readonly allowUnboundedExport: boolean;
}

const DEFAULT_LIMITS: NormalizedLimits = Object.freeze({
  maxFeatures: 25_000,
  maxPages: 100,
  preferredPageSize: 1000,
  maxPageSize: 5000,
  maxOutFields: 128,
  maxWhereLength: 16_384,
  geometryVertexBudget: 100_000,
  allowUnboundedExport: false,
});

const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(numeric)));
};

const nonNegativeInteger = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const normalizeLimits = (limits: QueryExecutionLimits = {}): NormalizedLimits => {
  const maxPageSize = positiveInteger(limits.maxPageSize, DEFAULT_LIMITS.maxPageSize, 10_000);
  const preferredPageSize = Math.min(
    maxPageSize,
    positiveInteger(limits.preferredPageSize, DEFAULT_LIMITS.preferredPageSize, maxPageSize),
  );
  return Object.freeze({
    maxFeatures: positiveInteger(limits.maxFeatures, DEFAULT_LIMITS.maxFeatures, 5_000_000),
    maxPages: positiveInteger(limits.maxPages, DEFAULT_LIMITS.maxPages, 10_000),
    preferredPageSize,
    maxPageSize,
    maxOutFields: positiveInteger(limits.maxOutFields, DEFAULT_LIMITS.maxOutFields, 2048),
    maxWhereLength: positiveInteger(limits.maxWhereLength, DEFAULT_LIMITS.maxWhereLength, 65_536),
    geometryVertexBudget: positiveInteger(
      limits.geometryVertexBudget,
      DEFAULT_LIMITS.geometryVertexBudget,
      5_000_000,
    ),
    allowUnboundedExport: limits.allowUnboundedExport === true,
  });
};

const diagnostic = (
  code: QueryPlanDiagnosticCode,
  severity: QueryPlanDiagnostic['severity'],
  message: string,
): QueryPlanDiagnostic => Object.freeze({ code, severity, message });

const normalizePurpose = (value: unknown): QueryPurpose => (
  value === 'analysis' || value === 'export' ? value : 'interactive'
);

const normalizeWhere = (
  value: unknown,
  maxLength: number,
  diagnostics: QueryPlanDiagnostic[],
): string => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    diagnostics.push(diagnostic('where-normalized', 'info', 'Empty where clause was normalized to 1=1.'));
    return '1=1';
  }
  if (raw.length > maxLength) {
    throw new QueryExecutionPlannerError(
      `Where clause exceeds ${maxLength} characters.`,
      'WHERE_TOO_LONG',
      diagnostics,
    );
  }
  return raw;
};

const normalizeField = (field: unknown): string | null => {
  const candidate = String(field ?? '').trim();
  return candidate && FIELD_PATTERN.test(candidate) ? candidate : null;
};

const fieldLookup = (metadata: ArcGisMetadataContract): Map<string, string> => {
  const lookup = new Map<string, string>();
  for (const field of metadata.fields) lookup.set(field.name.toLowerCase(), field.name);
  return lookup;
};

const normalizeFields = (
  requested: readonly string[] | undefined,
  metadata: ArcGisMetadataContract,
  limits: NormalizedLimits,
  diagnostics: QueryPlanDiagnostic[],
): readonly string[] => {
  const lookup = fieldLookup(metadata);
  const output: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let deduped = 0;

  const append = (raw: unknown, required = false): void => {
    const normalized = normalizeField(raw);
    if (!normalized) {
      if (!required) dropped += 1;
      return;
    }
    const resolved = lookup.get(normalized.toLowerCase());
    if (!resolved) {
      if (!required) dropped += 1;
      return;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      deduped += 1;
      return;
    }
    seen.add(key);
    output.push(resolved);
  };

  if (!requested || requested.length === 0 || requested.includes('*')) {
    for (const field of metadata.fields) append(field.name);
  } else {
    for (const field of requested) append(field);
  }

  if (metadata.objectIdField) {
    const before = output.length;
    append(metadata.objectIdField, true);
    if (output.length > before) {
      diagnostics.push(diagnostic(
        'field-projection-expanded',
        'info',
        `Identity field ${metadata.objectIdField} was added to preserve deterministic de-duplication.`,
      ));
    }
  }

  if (metadata.globalIdField && output.length < limits.maxOutFields) append(metadata.globalIdField, true);
  if (dropped > 0) {
    diagnostics.push(diagnostic(
      'unknown-field-dropped',
      'warning',
      `${dropped} requested field(s) were not present in verified layer metadata and were removed.`,
    ));
  }
  if (deduped > 0) {
    diagnostics.push(diagnostic(
      'field-projection-deduped',
      'info',
      `${deduped} duplicate field projection(s) were removed.`,
    ));
  }
  if (output.length > limits.maxOutFields) {
    const required = new Set(
      [metadata.objectIdField, metadata.globalIdField]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
    const head = output.filter((field) => required.has(field.toLowerCase()));
    const tail = output.filter((field) => !required.has(field.toLowerCase()));
    output.splice(0, output.length, ...head, ...tail.slice(0, Math.max(0, limits.maxOutFields - head.length)));
    diagnostics.push(diagnostic(
      'field-projection-truncated',
      'warning',
      `Field projection was bounded to ${limits.maxOutFields} verified fields.`,
    ));
  }
  if (output.length === 0) {
    throw new QueryExecutionPlannerError(
      'No verified output fields remain after metadata validation.',
      'EMPTY_FIELD_PROJECTION',
      diagnostics,
    );
  }
  return Object.freeze(output.slice());
};

const normalizeOrderBy = (
  requested: readonly ArcGisOrderBy[] | undefined,
  metadata: ArcGisMetadataContract,
): readonly ArcGisOrderBy[] => {
  if (!metadata.capabilities.has('order-by')) return Object.freeze([]);
  const lookup = fieldLookup(metadata);
  const output: ArcGisOrderBy[] = [];
  const seen = new Set<string>();
  for (const item of requested ?? []) {
    const field = normalizeField(item.field);
    if (!field) continue;
    const resolved = lookup.get(field.toLowerCase());
    if (!resolved || seen.has(resolved.toLowerCase())) continue;
    seen.add(resolved.toLowerCase());
    output.push(Object.freeze({
      field: resolved,
      direction: item.direction === 'DESC' ? 'DESC' : 'ASC',
    }));
  }
  if (metadata.objectIdField && !seen.has(metadata.objectIdField.toLowerCase())) {
    output.push(Object.freeze({ field: metadata.objectIdField, direction: 'ASC' as const }));
  }
  return Object.freeze(output);
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
};

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const querySignature = (resourceUrl: string, query: Omit<ArcGisQuerySpec, 'window'>): string => fnv1a(stableStringify({
  resourceUrl,
  where: query.where,
  outFields: query.outFields,
  returnGeometry: query.returnGeometry,
  geometry: query.geometry ?? null,
  spatialRel: query.spatialRel ?? null,
  outSpatialReference: query.outSpatialReference ?? null,
  orderBy: query.orderBy ?? null,
}));

const choosePageSize = (
  metadata: ArcGisMetadataContract,
  limits: NormalizedLimits,
  diagnostics: QueryPlanDiagnostic[],
): number => {
  const advertised = positiveInteger(metadata.maxRecordCount, limits.preferredPageSize, 100_000);
  const pageSize = Math.max(1, Math.min(advertised, limits.preferredPageSize, limits.maxPageSize));
  if (pageSize < limits.preferredPageSize) {
    diagnostics.push(diagnostic(
      'page-size-clamped',
      'info',
      `Page size was clamped to ${pageSize} using verified maxRecordCount metadata.`,
    ));
  }
  return pageSize;
};

const chooseFeatureLimit = (
  purpose: QueryPurpose,
  request: QueryExecutionRequest,
  limits: NormalizedLimits,
  pageSize: number,
  diagnostics: QueryPlanDiagnostic[],
): number => {
  const purposeDefault = purpose === 'interactive'
    ? Math.min(limits.maxFeatures, 10_000)
    : limits.maxFeatures;
  let maxFeatures = Math.min(limits.maxFeatures, limits.maxPages * pageSize, purposeDefault);
  if (purpose === 'export' && limits.allowUnboundedExport) {
    maxFeatures = Math.min(5_000_000, limits.maxPages * pageSize);
  } else if (purpose === 'export') {
    diagnostics.push(diagnostic(
      'export-bounded',
      'warning',
      `Export remains bounded to ${maxFeatures} features; unbounded browser export is disabled.`,
    ));
  }
  const expected = Number(request.expectedFeatureCount);
  if (Number.isFinite(expected) && expected > maxFeatures) {
    diagnostics.push(diagnostic(
      'expected-count-exceeds-budget',
      'warning',
      `Expected feature count ${Math.floor(expected)} exceeds browser execution budget ${maxFeatures}.`,
    ));
  }
  if (maxFeatures < limits.maxFeatures) {
    diagnostics.push(diagnostic(
      'feature-limit-clamped',
      'info',
      `Feature budget was bounded to ${maxFeatures} for ${purpose} execution.`,
    ));
  }
  return maxFeatures;
};

export const createQueryExecutionPlan = (
  metadata: ArcGisMetadataContract,
  request: QueryExecutionRequest = {},
  rawLimits: QueryExecutionLimits = {},
): QueryExecutionPlan => {
  const diagnostics: QueryPlanDiagnostic[] = [];
  const limits = normalizeLimits(rawLimits);
  const purpose = normalizePurpose(request.purpose);

  if (!metadata.queryReady || !metadata.capabilities.has('query')) {
    diagnostics.push(diagnostic(
      'query-not-ready',
      'error',
      'Verified layer metadata does not permit query execution.',
    ));
    throw new QueryExecutionPlannerError('Layer is not query-ready.', 'QUERY_NOT_READY', diagnostics);
  }

  const pageSize = choosePageSize(metadata, limits, diagnostics);
  const maxFeatures = chooseFeatureLimit(purpose, request, limits, pageSize, diagnostics);
  const maxPages = Math.min(limits.maxPages, Math.max(1, Math.ceil(maxFeatures / pageSize)));
  const supportsPagination = metadata.capabilities.has('pagination');
  const supportsOrdering = metadata.capabilities.has('order-by');
  const stableOrder = Boolean(supportsOrdering && metadata.objectIdField);
  let strategy: QueryExecutionStrategy = 'single';

  if (supportsPagination && stableOrder && maxPages > 1) {
    strategy = 'offset-pagination';
  } else if (maxPages > 1) {
    strategy = 'bounded-single-page';
    if (!supportsPagination) {
      diagnostics.push(diagnostic(
        'pagination-unavailable',
        'warning',
        'Server metadata does not advertise pagination; runtime will not guess resultOffset support.',
      ));
    }
    if (!stableOrder) {
      diagnostics.push(diagnostic(
        'stable-order-unavailable',
        'warning',
        'Stable pagination requires an object-id field and order-by capability.',
      ));
      if (!metadata.identityReady) {
        diagnostics.push(diagnostic(
          'identity-not-ready',
          'warning',
          'Layer metadata does not expose a reliable identity field for de-duplication.',
        ));
      }
    }
  }

  const returnGeometry = request.returnGeometry !== false;
  if (!returnGeometry && request.geometry) {
    diagnostics.push(diagnostic(
      'geometry-disabled',
      'info',
      'Input geometry is retained as a spatial filter while output geometry remains disabled.',
    ));
  }
  const outFields = normalizeFields(request.outFields, metadata, limits, diagnostics);
  const orderBy = normalizeOrderBy(request.orderBy, metadata);
  const query: Omit<ArcGisQuerySpec, 'window'> = Object.freeze({
    where: normalizeWhere(request.where, limits.maxWhereLength, diagnostics),
    outFields,
    returnGeometry,
    ...(request.geometry ? { geometry: request.geometry, geometryType: 'esriGeometryEnvelope' as const } : {}),
    ...(request.spatialRel ? { spatialRel: request.spatialRel } : {}),
    ...(request.outSpatialReference ? { outSpatialReference: request.outSpatialReference } : {}),
    ...(orderBy.length ? { orderBy } : {}),
  });
  const initialOffset = nonNegativeInteger(request.startOffset, 0);
  const signature = querySignature(metadata.resourceUrl, query);

  const page = (index: number): QueryExecutionPage => {
    const normalizedIndex = nonNegativeInteger(index, -1);
    if (normalizedIndex < 0 || normalizedIndex >= maxPages) {
      throw new QueryExecutionPlannerError(
        `Page index ${index} is outside bounded range 0..${maxPages - 1}.`,
        'PAGE_OUT_OF_RANGE',
        diagnostics,
      );
    }
    const offset = strategy === 'offset-pagination'
      ? initialOffset + normalizedIndex * pageSize
      : initialOffset;
    const remaining = maxFeatures - normalizedIndex * pageSize;
    return Object.freeze({
      index: normalizedIndex,
      offset,
      limit: Math.max(1, Math.min(pageSize, remaining)),
    });
  };

  const pageSpec = (index: number): ArcGisQuerySpec => {
    const descriptor = page(index);
    const window: ArcGisQueryWindow | undefined = strategy === 'offset-pagination'
      ? Object.freeze({ resultOffset: descriptor.offset, resultRecordCount: descriptor.limit })
      : undefined;
    return Object.freeze({
      ...query,
      ...(window ? { window } : {}),
    });
  };

  return Object.freeze({
    resourceUrl: metadata.resourceUrl,
    strategy,
    purpose,
    query,
    pageSize,
    maxFeatures,
    maxPages,
    initialOffset,
    stableOrder,
    objectIdField: metadata.objectIdField,
    diagnostics: Object.freeze(diagnostics.slice()),
    signature,
    page,
    pageSpec,
  });
};

export interface AdaptiveQueryFeedback {
  readonly latencyMs: number;
  readonly featureCount: number;
  readonly exceededTransferLimit: boolean;
  readonly payloadBytes?: number;
}

export interface AdaptivePageSizePolicy {
  readonly minimum: number;
  readonly maximum: number;
  readonly targetLatencyMs: number;
  readonly targetPayloadBytes: number;
}

export const recommendNextPageSize = (
  current: number,
  feedback: AdaptiveQueryFeedback,
  policy: Partial<AdaptivePageSizePolicy> = {},
): number => {
  const minimum = positiveInteger(policy.minimum, 100, 10_000);
  const maximum = Math.max(minimum, positiveInteger(policy.maximum, 5000, 10_000));
  const targetLatencyMs = positiveInteger(policy.targetLatencyMs, 800, 60_000);
  const targetPayloadBytes = positiveInteger(policy.targetPayloadBytes, 2 * 1024 * 1024, 64 * 1024 * 1024);
  const normalizedCurrent = Math.min(maximum, Math.max(minimum, positiveInteger(current, minimum, maximum)));
  const latency = Math.max(0, Number(feedback.latencyMs) || 0);
  const payload = Math.max(0, Number(feedback.payloadBytes) || 0);
  const sparse = feedback.featureCount < normalizedCurrent * 0.25 && !feedback.exceededTransferLimit;
  const pressure = latency > targetLatencyMs * 1.5 || payload > targetPayloadBytes * 1.5;
  const headroom = latency > 0 && latency < targetLatencyMs * 0.5 && (payload === 0 || payload < targetPayloadBytes * 0.5);

  if (pressure) return Math.max(minimum, Math.floor(normalizedCurrent * 0.65));
  if (headroom && feedback.exceededTransferLimit) return Math.min(maximum, Math.ceil(normalizedCurrent * 1.25));
  if (sparse) return Math.max(minimum, Math.floor(normalizedCurrent * 0.8));
  return normalizedCurrent;
};
