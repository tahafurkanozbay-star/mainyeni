import {
  createArcGisQueryPlan,
  type ArcGisQueryPlan,
  type ArcGisQuerySpec,
} from './arcgisQueryContract';
import {
  metadataContractToQueryCapabilities,
  type ArcGisMetadataContract,
} from './arcgisMetadataAdapter';
import {
  dedupeFeaturesByIdentity,
  resolveFeatureIdentity,
  type ArcGisAttributes,
  type FeatureIdentity,
} from './featureIdentity';

export type ArcGisFeature = Readonly<{
  attributes: ArcGisAttributes;
  geometry?: unknown;
}>;

export type ArcGisQueryResponse = Readonly<{
  objectIdFieldName?: string;
  globalIdFieldName?: string;
  geometryType?: string;
  spatialReference?: unknown;
  fields?: readonly unknown[];
  features?: readonly unknown[];
  exceededTransferLimit?: boolean;
  count?: number;
  extent?: unknown;
  error?: unknown;
}>;

export type ArcGisQueryTransportRequest = Readonly<{
  url: string;
  method: 'POST';
  body: URLSearchParams;
  signal: AbortSignal;
  headers: Readonly<Record<string, string>>;
}>;

export type ArcGisQueryTransportResponse = Readonly<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export type ArcGisQueryTransport = (
  request: ArcGisQueryTransportRequest,
) => Promise<ArcGisQueryTransportResponse>;

export type ArcGisSchedulerRequest<T> = Readonly<{
  key: string;
  resourceUrl: string;
  priority?: number | string;
  signal?: AbortSignal;
  cache?: boolean;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  allowStale?: boolean;
  allowStaleOnError?: boolean;
  estimatedBytes?: number;
  tags?: readonly string[];
  execute(input: Readonly<{ signal: AbortSignal; requestKey: string; resourceUrl: string }>): Promise<T>;
}>;

export type ArcGisScheduler = Readonly<{
  schedule<T>(request: ArcGisSchedulerRequest<T>): Promise<T>;
  invalidate?(key: string): boolean;
  invalidateTag?(tag: string): number;
}>;

export type ArcGisQueryExecutionOptions = Readonly<{
  signal?: AbortSignal;
  priority?: number | string;
  cache?: boolean;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  allowStale?: boolean;
  allowStaleOnError?: boolean;
  estimatedBytes?: number;
  tags?: readonly string[];
  rejectTransferLimit?: boolean;
  requireStableIdentity?: boolean;
}>;

export type ArcGisQueryResult = Readonly<{
  requestKey: string;
  resourceUrl: string;
  queryUrl: string;
  features: readonly ArcGisFeature[];
  identities: readonly FeatureIdentity[];
  objectIdFieldName: string | null;
  globalIdFieldName: string | null;
  exceededTransferLimit: boolean;
  duplicateCount: number;
  rawFeatureCount: number;
  returnedFeatureCount: number;
  stableIdentityCount: number;
  anonymousIdentityCount: number;
}>;

export class ArcGisQueryExecutionError extends Error {
  readonly code: string;
  readonly resourceUrl: string | null;
  readonly requestKey: string | null;
  readonly httpStatus: number | null;
  readonly arcGisCode: number | null;
  readonly details: readonly string[];
  readonly cause?: unknown;

  constructor(
    message: string,
    options: Readonly<{
      code?: string;
      resourceUrl?: string | null;
      requestKey?: string | null;
      httpStatus?: number | null;
      arcGisCode?: number | null;
      details?: readonly string[];
      cause?: unknown;
    }> = {},
  ) {
    super(message);
    this.name = 'ArcGisQueryExecutionError';
    this.code = options.code ?? 'ARCGIS_QUERY_EXECUTION_ERROR';
    this.resourceUrl = options.resourceUrl ?? null;
    this.requestKey = options.requestKey ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.arcGisCode = options.arcGisCode ?? null;
    this.details = Object.freeze([...(options.details ?? [])]);
    this.cause = options.cause;
  }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const record = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const finiteInteger = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Number.isInteger(numeric) ? numeric : null;
};

const abortError = (reason: unknown = 'ArcGIS query aborted'): Error => {
  const error = new Error(String(reason || 'ArcGIS query aborted'));
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortError(signal.reason);
};

const canonicalBody = (body: URLSearchParams): string => {
  const entries = [...body.entries()]
    .filter(([key]) => !['token', 'apikey', 'apiKey'].includes(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
};

const fnv1a = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createArcGisQueryRequestKey = (plan: ArcGisQueryPlan): string => (
  `arcgis-query:${fnv1a(`${plan.queryUrl}|${canonicalBody(plan.body)}`)}`
);

const normalizeFeature = (value: unknown): ArcGisFeature | null => {
  const source = record(value);
  const attributes = isRecord(source.attributes) ? source.attributes : null;
  if (!attributes) return null;
  return Object.freeze({
    attributes,
    ...(source.geometry !== undefined ? { geometry: source.geometry } : {}),
  });
};

const normalizeResponse = (value: unknown): ArcGisQueryResponse => {
  if (!isRecord(value)) {
    throw new ArcGisQueryExecutionError('ArcGIS query returned a non-object response.', {
      code: 'INVALID_RESPONSE_SHAPE',
    });
  }
  return value as ArcGisQueryResponse;
};

const arcGisError = (value: unknown): Readonly<{
  code: number | null;
  message: string | null;
  details: readonly string[];
}> | null => {
  const source = record(value);
  if (!Object.keys(source).length) return null;
  const code = finiteInteger(source.code);
  const message = text(source.message);
  const details = asArray(source.details).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (code === null && !message && !details.length) return null;
  return Object.freeze({ code, message, details: Object.freeze(details) });
};

const executeTransport = async (
  transport: ArcGisQueryTransport,
  plan: ArcGisQueryPlan,
  signal: AbortSignal,
  requestKey: string,
): Promise<ArcGisQueryResponse> => {
  throwIfAborted(signal);
  let response: ArcGisQueryTransportResponse;
  try {
    response = await transport({
      url: plan.queryUrl,
      method: 'POST',
      body: plan.body,
      signal,
      headers: Object.freeze({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      }),
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError(signal.reason);
    throw new ArcGisQueryExecutionError('ArcGIS query transport failed.', {
      code: 'TRANSPORT_FAILURE',
      resourceUrl: plan.resourceUrl,
      requestKey,
      cause: error,
    });
  }
  throwIfAborted(signal);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ArcGisQueryExecutionError('ArcGIS query response is not valid JSON.', {
      code: 'INVALID_JSON_RESPONSE',
      resourceUrl: plan.resourceUrl,
      requestKey,
      httpStatus: response.status,
      cause: error,
    });
  }
  const normalized = normalizeResponse(payload);
  const serviceError = arcGisError(record(normalized).error);
  if (!response.ok || serviceError) {
    throw new ArcGisQueryExecutionError(
      serviceError?.message ?? response.statusText ?? `ArcGIS query failed with HTTP ${response.status}.`,
      {
        code: serviceError ? 'ARCGIS_SERVICE_ERROR' : 'HTTP_ERROR',
        resourceUrl: plan.resourceUrl,
        requestKey,
        httpStatus: response.status,
        arcGisCode: serviceError?.code ?? null,
        details: serviceError?.details ?? [],
      },
    );
  }
  return normalized;
};

const normalizeQueryResult = (
  contract: ArcGisMetadataContract,
  plan: ArcGisQueryPlan,
  response: ArcGisQueryResponse,
  requestKey: string,
  options: ArcGisQueryExecutionOptions,
): ArcGisQueryResult => {
  const rawFeatures = asArray(response.features);
  const normalizedFeatures = rawFeatures.map(normalizeFeature).filter((value): value is ArcGisFeature => value !== null);
  const deduped = dedupeFeaturesByIdentity(contract, normalizedFeatures, {
    allowCompositeFallback: true,
    compositeFields: [contract.displayField, contract.globalIdField].filter((value): value is string => Boolean(value)),
    namespace: contract.resourceUrl,
  });
  const identities = deduped.features.map((feature) => resolveFeatureIdentity(contract, feature.attributes, {
    allowCompositeFallback: true,
    compositeFields: [contract.displayField, contract.globalIdField].filter((value): value is string => Boolean(value)),
    namespace: contract.resourceUrl,
  }));
  const stableIdentityCount = identities.filter((identity) => identity.stable).length;
  const anonymousIdentityCount = identities.filter((identity) => identity.kind === 'anonymous').length;
  const exceededTransferLimit = response.exceededTransferLimit === true;
  if (options.rejectTransferLimit === true && exceededTransferLimit) {
    throw new ArcGisQueryExecutionError('ArcGIS query result exceeded the service transfer limit.', {
      code: 'TRANSFER_LIMIT_EXCEEDED',
      resourceUrl: contract.resourceUrl,
      requestKey,
    });
  }
  if (options.requireStableIdentity === true && stableIdentityCount !== deduped.features.length) {
    throw new ArcGisQueryExecutionError('ArcGIS query returned features without stable service identity.', {
      code: 'UNSTABLE_FEATURE_IDENTITY',
      resourceUrl: contract.resourceUrl,
      requestKey,
    });
  }
  return Object.freeze({
    requestKey,
    resourceUrl: contract.resourceUrl,
    queryUrl: plan.queryUrl,
    features: deduped.features,
    identities: Object.freeze(identities),
    objectIdFieldName: text(response.objectIdFieldName) ?? contract.objectIdField,
    globalIdFieldName: text(response.globalIdFieldName) ?? contract.globalIdField,
    exceededTransferLimit,
    duplicateCount: deduped.duplicateCount,
    rawFeatureCount: rawFeatures.length,
    returnedFeatureCount: deduped.features.length,
    stableIdentityCount,
    anonymousIdentityCount,
  });
};

const mergeSignals = (outer: AbortSignal | undefined, inner: AbortSignal): Readonly<{
  signal: AbortSignal;
  cleanup(): void;
}> => {
  if (!outer) return Object.freeze({ signal: inner, cleanup: () => {} });
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onOuter = (): void => abortFrom(outer);
  const onInner = (): void => abortFrom(inner);
  if (outer.aborted) abortFrom(outer);
  if (inner.aborted) abortFrom(inner);
  outer.addEventListener('abort', onOuter, { once: true });
  inner.addEventListener('abort', onInner, { once: true });
  return Object.freeze({
    signal: controller.signal,
    cleanup: () => {
      outer.removeEventListener('abort', onOuter);
      inner.removeEventListener('abort', onInner);
    },
  });
};

export const createArcGisQueryExecutor = (dependencies: Readonly<{
  transport: ArcGisQueryTransport;
  scheduler?: ArcGisScheduler;
  defaultCacheTtlMs?: number;
  defaultStaleTtlMs?: number;
}>): Readonly<{
  execute(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options?: ArcGisQueryExecutionOptions): Promise<ArcGisQueryResult>;
  createPlan(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): ArcGisQueryPlan;
  requestKey(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): string;
}> => {
  if (!dependencies || typeof dependencies.transport !== 'function') {
    throw new ArcGisQueryExecutionError('ArcGIS query executor requires an injected transport.', {
      code: 'MISSING_TRANSPORT',
    });
  }
  const createPlan = (contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): ArcGisQueryPlan => (
    createArcGisQueryPlan(metadataContractToQueryCapabilities(contract), spec)
  );
  const requestKey = (contract: ArcGisMetadataContract, spec: ArcGisQuerySpec): string => (
    createArcGisQueryRequestKey(createPlan(contract, spec))
  );

  const execute = async (
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options: ArcGisQueryExecutionOptions = {},
  ): Promise<ArcGisQueryResult> => {
    throwIfAborted(options.signal);
    if (!contract.queryReady) {
      throw new ArcGisQueryExecutionError('ArcGIS metadata contract is not query-ready.', {
        code: 'METADATA_NOT_QUERY_READY',
        resourceUrl: contract.resourceUrl,
      });
    }
    const plan = createPlan(contract, spec);
    const key = createArcGisQueryRequestKey(plan);
    const run = async (schedulerSignal: AbortSignal): Promise<ArcGisQueryResult> => {
      const merged = mergeSignals(options.signal, schedulerSignal);
      try {
        const response = await executeTransport(dependencies.transport, plan, merged.signal, key);
        throwIfAborted(merged.signal);
        return normalizeQueryResult(contract, plan, response, key, options);
      } finally {
        merged.cleanup();
      }
    };

    if (!dependencies.scheduler) {
      const local = new AbortController();
      const merged = mergeSignals(options.signal, local.signal);
      try {
        const response = await executeTransport(dependencies.transport, plan, merged.signal, key);
        return normalizeQueryResult(contract, plan, response, key, options);
      } finally {
        merged.cleanup();
      }
    }

    return dependencies.scheduler.schedule<ArcGisQueryResult>({
      key,
      resourceUrl: contract.resourceUrl,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...((options.cacheTtlMs ?? dependencies.defaultCacheTtlMs) !== undefined
        ? { cacheTtlMs: options.cacheTtlMs ?? dependencies.defaultCacheTtlMs }
        : {}),
      ...((options.staleTtlMs ?? dependencies.defaultStaleTtlMs) !== undefined
        ? { staleTtlMs: options.staleTtlMs ?? dependencies.defaultStaleTtlMs }
        : {}),
      ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
      ...(options.allowStaleOnError !== undefined ? { allowStaleOnError: options.allowStaleOnError } : {}),
      ...(options.estimatedBytes !== undefined ? { estimatedBytes: options.estimatedBytes } : {}),
      tags: Object.freeze([contract.resourceUrl, ...(options.tags ?? [])]),
      execute: ({ signal }) => run(signal),
    });
  };

  return Object.freeze({ execute, createPlan, requestKey });
};

export const mergeArcGisQueryPages = (
  contract: ArcGisMetadataContract,
  pages: readonly ArcGisQueryResult[],
): Readonly<{
  features: readonly ArcGisFeature[];
  identities: readonly FeatureIdentity[];
  duplicateCount: number;
  incomplete: boolean;
}> => {
  const combined = pages.flatMap((page) => page.features);
  const deduped = dedupeFeaturesByIdentity(contract, combined, {
    allowCompositeFallback: true,
    compositeFields: [contract.displayField].filter((value): value is string => Boolean(value)),
    namespace: contract.resourceUrl,
  });
  const identities = deduped.features.map((feature) => resolveFeatureIdentity(contract, feature.attributes, {
    allowCompositeFallback: true,
    compositeFields: [contract.displayField].filter((value): value is string => Boolean(value)),
    namespace: contract.resourceUrl,
  }));
  return Object.freeze({
    features: deduped.features,
    identities: Object.freeze(identities),
    duplicateCount: deduped.duplicateCount + pages.reduce((sum, page) => sum + page.duplicateCount, 0),
    incomplete: pages.some((page) => page.exceededTransferLimit),
  });
};
