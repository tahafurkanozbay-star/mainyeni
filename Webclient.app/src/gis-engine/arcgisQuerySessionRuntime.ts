import {
  assessCapabilityContract,
  assertAllowedArcGisResourceUrl,
  buildArcGisCapabilityContract,
  capabilityContractToPaginationMetadata,
  selectCapabilityFields,
  type ArcGisCapabilityContract,
} from './serviceCapabilityRuntime';
import {
  executeArcGisPagination,
  type ArcGisFeatureLike,
  type ArcGisPageRequest,
  type ArcGisPageResult,
  type ArcGisPaginationOptions,
  type ArcGisPaginationResult,
} from './arcgisPaginationRuntime';

export type ArcGisQueryParameters = Readonly<Record<string, unknown>>;

export type ArcGisQueryTransportRequest = Readonly<{
  layerId: string;
  resourceUrl: string;
  parameters: ArcGisQueryParameters;
  signal: AbortSignal;
}>;

export type ArcGisObjectIdTransportRequest = Readonly<{
  layerId: string;
  resourceUrl: string;
  parameters: ArcGisQueryParameters;
  signal: AbortSignal;
}>;

export type ArcGisQueryTransport<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> = Readonly<{
  queryFeatures: (
    request: ArcGisQueryTransportRequest,
  ) => Promise<ArcGisPageResult<TFeature>> | ArcGisPageResult<TFeature>;
  queryObjectIds?: (
    request: ArcGisObjectIdTransportRequest,
  ) => Promise<ArcGisPageResult> | ArcGisPageResult;
}>;

export type ArcGisQuerySessionLayerDescriptor = Readonly<{
  layerId: string;
  resourceUrl: string;
  metadata: Record<string, unknown>;
  metadataVersion?: string | number | null;
}>;

export type ArcGisQuerySessionOptions = Readonly<{
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxInFlight?: number;
  maxFeatures?: number;
  maxPages?: number;
  pageSize?: number;
}>;

export type ArcGisSessionQueryOptions = Readonly<{
  signal?: AbortSignal;
  outFields?: readonly string[];
  cache?: boolean;
  cacheTtlMs?: number;
  maxFeatures?: number;
  maxPages?: number;
  pageSize?: number;
  strategy?: ArcGisPaginationOptions['strategy'];
  expectedSpatialReferenceWkid?: number;
}>;

export type ArcGisQuerySessionMetrics = Readonly<{
  registeredLayers: number;
  registrations: number;
  queries: number;
  completed: number;
  failed: number;
  deduped: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  cancelledSubscribers: number;
  invalidations: number;
}>;

export type ArcGisQuerySessionSnapshot = Readonly<{
  destroyed: boolean;
  layerCount: number;
  inFlightCount: number;
  cacheEntries: number;
  metrics: ArcGisQuerySessionMetrics;
  layers: readonly Readonly<{
    layerId: string;
    resourceUrl: string;
    metadataVersion: string | null;
    supportsQuery: boolean;
    stableIdentity: boolean;
    spatialReferenceWkid: number | null;
  }>[];
}>;

export class ArcGisQuerySessionError extends Error {
  readonly code: string;
  readonly layerId: string | null;
  override readonly cause: unknown;

  constructor(message: string, details: { code?: string; layerId?: string | null; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ArcGisQuerySessionError';
    this.code = details.code ?? 'ARCGIS_QUERY_SESSION_ERROR';
    this.layerId = details.layerId ?? null;
    this.cause = details.cause;
  }
}

type LayerSession = {
  layerId: string;
  resourceUrl: string;
  metadata: Record<string, unknown>;
  metadataVersion: string | null;
  contract: Readonly<ArcGisCapabilityContract>;
  generation: number;
};

type CacheEntry<TFeature extends ArcGisFeatureLike> = {
  value: ArcGisPaginationResult<TFeature>;
  expiresAt: number;
  layerId: string;
  generation: number;
};

type Subscriber<T> = {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
  unsubscribe: (() => void) | null;
};

type InFlight<TFeature extends ArcGisFeatureLike> = {
  key: string;
  layerId: string;
  controller: AbortController;
  subscribers: Set<Subscriber<ArcGisPaginationResult<TFeature>>>;
  settled: boolean;
};

const finiteInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, numeric);
};

const nonNegative = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const normalizeLayerId = (value: unknown): string => {
  const layerId = String(value ?? '').trim();
  if (!layerId) throw new ArcGisQuerySessionError('ArcGIS query session requires a stable layer id.', { code: 'INVALID_LAYER_ID' });
  return layerId;
};

const asWkid = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
};

const stableSerialize = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
    : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], seen)}`
    )).join(',')}}`;
  seen.delete(value);
  return serialized;
};

const abortError = (reason: unknown): Error => {
  const error = new Error(String(reason ?? 'ArcGIS query subscriber aborted'));
  error.name = 'AbortError';
  return error;
};

const querySpatialReferenceWkid = (parameters: ArcGisQueryParameters): number | null => {
  const outSr = asWkid(parameters.outSR ?? parameters.outSr);
  if (outSr) return outSr;
  const spatialReference = parameters.spatialReference;
  if (spatialReference && typeof spatialReference === 'object') {
    const record = spatialReference as Record<string, unknown>;
    return asWkid(record.latestWkid ?? record.wkid);
  }
  return null;
};

const createTransportParameters = (
  base: ArcGisQueryParameters,
  request: ArcGisPageRequest,
  outFields: readonly string[],
): ArcGisQueryParameters => Object.freeze({
  ...base,
  ...(outFields.length ? { outFields: outFields.join(',') } : {}),
  ...(request.resultOffset !== undefined ? { resultOffset: request.resultOffset } : {}),
  resultRecordCount: request.resultRecordCount,
  ...(request.orderByFields?.length ? { orderByFields: request.orderByFields.join(',') } : {}),
  ...(request.objectIds?.length ? { objectIds: request.objectIds.join(',') } : {}),
});

export const createArcGisQuerySessionRuntime = <TFeature extends ArcGisFeatureLike = ArcGisFeatureLike>(
  transport: ArcGisQueryTransport<TFeature>,
  options: ArcGisQuerySessionOptions = {},
) => {
  if (!transport || typeof transport.queryFeatures !== 'function') {
    throw new ArcGisQuerySessionError('A typed ArcGIS query transport is required.', { code: 'INVALID_TRANSPORT' });
  }

  const cacheTtlMs = nonNegative(options.cacheTtlMs, 15_000);
  const maxCacheEntries = finiteInteger(options.maxCacheEntries, 128, 10_000);
  const maxInFlight = finiteInteger(options.maxInFlight, 32, 512);
  const defaultMaxFeatures = finiteInteger(options.maxFeatures, 50_000, 500_000);
  const defaultMaxPages = finiteInteger(options.maxPages, 100, 1_000);
  const defaultPageSize = finiteInteger(options.pageSize, 1_000, 10_000);

  const layers = new Map<string, LayerSession>();
  const cache = new Map<string, CacheEntry<TFeature>>();
  const inFlight = new Map<string, InFlight<TFeature>>();
  let destroyed = false;
  const metrics = {
    registeredLayers: 0,
    registrations: 0,
    queries: 0,
    completed: 0,
    failed: 0,
    deduped: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEvictions: 0,
    cancelledSubscribers: 0,
    invalidations: 0,
  };

  const assertActive = (): void => {
    if (destroyed) throw new ArcGisQuerySessionError('ArcGIS query session runtime has been destroyed.', { code: 'RUNTIME_DESTROYED' });
  };

  const evictCache = (): void => {
    while (cache.size > maxCacheEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
      metrics.cacheEvictions += 1;
    }
  };

  const invalidateLayer = (layerId: string): number => {
    let removed = 0;
    for (const [key, entry] of [...cache]) {
      if (entry.layerId !== layerId) continue;
      cache.delete(key);
      removed += 1;
    }
    for (const item of inFlight.values()) {
      if (item.layerId === layerId && !item.controller.signal.aborted) item.controller.abort('Layer query session invalidated');
    }
    if (removed > 0) metrics.invalidations += 1;
    return removed;
  };

  const registerLayer = (descriptor: ArcGisQuerySessionLayerDescriptor): Readonly<ArcGisCapabilityContract> => {
    assertActive();
    const layerId = normalizeLayerId(descriptor.layerId);
    const resourceUrl = assertAllowedArcGisResourceUrl(descriptor.resourceUrl);
    if (!resourceUrl) {
      throw new ArcGisQuerySessionError('ArcGIS layer registration requires a verified REST resource URL.', {
        code: 'INVALID_RESOURCE_URL',
        layerId,
      });
    }
    const contract = buildArcGisCapabilityContract({
      url: resourceUrl,
      metadata: descriptor.metadata,
      serviceId: layerId,
    });
    const assessment = assessCapabilityContract(contract);
    if (!assessment.valid || !assessment.queryReady) {
      throw new ArcGisQuerySessionError(`ArcGIS layer capability contract is not query-ready: ${assessment.issues.join(', ')}`, {
        code: 'CAPABILITY_NOT_QUERY_READY',
        layerId,
      });
    }
    const previous = layers.get(layerId);
    const metadataVersion = descriptor.metadataVersion == null ? null : String(descriptor.metadataVersion);
    const changed = !previous
      || previous.resourceUrl !== resourceUrl
      || previous.metadataVersion !== metadataVersion
      || stableSerialize(previous.metadata) !== stableSerialize(descriptor.metadata);
    if (changed && previous) invalidateLayer(layerId);
    layers.set(layerId, {
      layerId,
      resourceUrl,
      metadata: { ...descriptor.metadata },
      metadataVersion,
      contract,
      generation: changed ? (previous?.generation ?? 0) + 1 : previous?.generation ?? 1,
    });
    metrics.registrations += 1;
    metrics.registeredLayers = layers.size;
    return contract;
  };

  const unregisterLayer = (layerIdInput: string): boolean => {
    assertActive();
    const layerId = normalizeLayerId(layerIdInput);
    invalidateLayer(layerId);
    const deleted = layers.delete(layerId);
    metrics.registeredLayers = layers.size;
    return deleted;
  };

  const requireLayer = (layerIdInput: string): LayerSession => {
    const layerId = normalizeLayerId(layerIdInput);
    const session = layers.get(layerId);
    if (!session) throw new ArcGisQuerySessionError('ArcGIS layer is not registered in the query session.', { code: 'LAYER_NOT_REGISTERED', layerId });
    return session;
  };

  const validateSpatialReference = (
    session: LayerSession,
    parameters: ArcGisQueryParameters,
    expectedWkid: number | undefined,
  ): void => {
    const serviceWkid = session.contract.spatialReference?.wkid ?? null;
    const requestedWkid = expectedWkid ?? querySpatialReferenceWkid(parameters);
    if (expectedWkid !== undefined && (!Number.isSafeInteger(expectedWkid) || expectedWkid <= 0)) {
      throw new ArcGisQuerySessionError('Expected spatial reference must be a positive WKID.', { code: 'INVALID_SPATIAL_REFERENCE', layerId: session.layerId });
    }
    if (requestedWkid && serviceWkid && requestedWkid !== serviceWkid) {
      throw new ArcGisQuerySessionError('Query spatial reference differs from service metadata; reprojection was not explicitly provided.', {
        code: 'SPATIAL_REFERENCE_MISMATCH',
        layerId: session.layerId,
      });
    }
  };

  const createKey = (
    session: LayerSession,
    parameters: ArcGisQueryParameters,
    queryOptions: ArcGisSessionQueryOptions,
    outFields: readonly string[],
  ): string => stableSerialize({
    layerId: session.layerId,
    generation: session.generation,
    resourceUrl: session.resourceUrl,
    parameters,
    outFields,
    pagination: {
      maxFeatures: queryOptions.maxFeatures ?? defaultMaxFeatures,
      maxPages: queryOptions.maxPages ?? defaultMaxPages,
      pageSize: queryOptions.pageSize ?? defaultPageSize,
      strategy: queryOptions.strategy ?? null,
    },
  });

  const readCache = (key: string): ArcGisPaginationResult<TFeature> | null => {
    const entry = cache.get(key);
    if (!entry) {
      metrics.cacheMisses += 1;
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      metrics.cacheMisses += 1;
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    metrics.cacheHits += 1;
    return entry.value;
  };

  const writeCache = (
    key: string,
    session: LayerSession,
    value: ArcGisPaginationResult<TFeature>,
    queryOptions: ArcGisSessionQueryOptions,
  ): void => {
    if (queryOptions.cache === false) return;
    const ttl = nonNegative(queryOptions.cacheTtlMs, cacheTtlMs);
    if (ttl <= 0) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + ttl, layerId: session.layerId, generation: session.generation });
    evictCache();
  };

  const settleSubscriber = (
    subscriber: Subscriber<ArcGisPaginationResult<TFeature>>,
    outcome: 'resolve' | 'reject',
    value: ArcGisPaginationResult<TFeature> | unknown,
  ): void => {
    if (subscriber.settled) return;
    subscriber.settled = true;
    subscriber.unsubscribe?.();
    subscriber.unsubscribe = null;
    if (outcome === 'resolve') subscriber.resolve(value as ArcGisPaginationResult<TFeature>);
    else subscriber.reject(value);
  };

  const subscribe = (
    job: InFlight<TFeature>,
    signal?: AbortSignal,
  ): Promise<ArcGisPaginationResult<TFeature>> => new Promise((resolve, reject) => {
    const subscriber: Subscriber<ArcGisPaginationResult<TFeature>> = { resolve, reject, settled: false, unsubscribe: null };
    job.subscribers.add(subscriber);
    const cancel = (): void => {
      if (subscriber.settled) return;
      metrics.cancelledSubscribers += 1;
      settleSubscriber(subscriber, 'reject', abortError(signal?.reason));
      job.subscribers.delete(subscriber);
      if (!job.settled && job.subscribers.size === 0 && !job.controller.signal.aborted) {
        job.controller.abort('All query subscribers cancelled');
      }
    };
    if (signal) {
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      subscriber.unsubscribe = () => signal.removeEventListener('abort', cancel);
    }
  });

  const runQuery = async (
    session: LayerSession,
    parameters: ArcGisQueryParameters,
    outFields: readonly string[],
    queryOptions: ArcGisSessionQueryOptions,
    controller: AbortController,
  ): Promise<ArcGisPaginationResult<TFeature>> => {
    const paginationOptions: ArcGisPaginationOptions = {
      pageSize: finiteInteger(queryOptions.pageSize, defaultPageSize, 10_000),
      maxPages: finiteInteger(queryOptions.maxPages, defaultMaxPages, 1_000),
      maxFeatures: finiteInteger(queryOptions.maxFeatures, defaultMaxFeatures, 500_000),
      signal: controller.signal,
      ...(queryOptions.strategy !== undefined ? { strategy: queryOptions.strategy } : {}),
    };
    const fetchPage = async (pageRequest: ArcGisPageRequest): Promise<ArcGisPageResult<TFeature>> => transport.queryFeatures({
      layerId: session.layerId,
      resourceUrl: session.resourceUrl,
      parameters: createTransportParameters(parameters, pageRequest, outFields),
      signal: controller.signal,
    });
    const fetchObjectIds = transport.queryObjectIds
      ? async (): Promise<ArcGisPageResult> => transport.queryObjectIds!({
        layerId: session.layerId,
        resourceUrl: session.resourceUrl,
        parameters: Object.freeze({ ...parameters, returnIdsOnly: true }),
        signal: controller.signal,
      })
      : undefined;

    return executeArcGisPagination<TFeature>({
      metadata: capabilityContractToPaginationMetadata(session.contract),
      fetchPage,
      ...(fetchObjectIds ? { fetchObjectIds } : {}),
      options: paginationOptions,
    });
  };

  const execute = (
    layerIdInput: string,
    parameters: ArcGisQueryParameters = {},
    queryOptions: ArcGisSessionQueryOptions = {},
  ): Promise<ArcGisPaginationResult<TFeature>> => {
    assertActive();
    const session = requireLayer(layerIdInput);
    validateSpatialReference(session, parameters, queryOptions.expectedSpatialReferenceWkid);
    const outFields = selectCapabilityFields(session.contract, queryOptions.outFields ?? []);
    const key = createKey(session, parameters, queryOptions, outFields);
    metrics.queries += 1;

    if (queryOptions.cache !== false) {
      const cached = readCache(key);
      if (cached) return Promise.resolve(cached);
    }

    const existing = inFlight.get(key);
    if (existing) {
      metrics.deduped += 1;
      return subscribe(existing, queryOptions.signal);
    }
    if (inFlight.size >= maxInFlight) {
      return Promise.reject(new ArcGisQuerySessionError('ArcGIS query session backpressure limit reached.', {
        code: 'BACKPRESSURE_LIMIT',
        layerId: session.layerId,
      }));
    }

    const controller = new AbortController();
    const job: InFlight<TFeature> = {
      key,
      layerId: session.layerId,
      controller,
      subscribers: new Set(),
      settled: false,
    };
    inFlight.set(key, job);
    const subscriberPromise = subscribe(job, queryOptions.signal);

    void runQuery(session, parameters, outFields, queryOptions, controller)
      .then((value) => {
        job.settled = true;
        metrics.completed += 1;
        writeCache(key, session, value, queryOptions);
        for (const subscriber of [...job.subscribers]) settleSubscriber(subscriber, 'resolve', value);
      })
      .catch((error: unknown) => {
        job.settled = true;
        metrics.failed += 1;
        for (const subscriber of [...job.subscribers]) settleSubscriber(subscriber, 'reject', error);
      })
      .finally(() => {
        job.subscribers.clear();
        inFlight.delete(key);
      });

    return subscriberPromise;
  };

  const clearCache = (): number => {
    assertActive();
    const size = cache.size;
    cache.clear();
    if (size > 0) metrics.invalidations += 1;
    return size;
  };

  const snapshot = (): ArcGisQuerySessionSnapshot => Object.freeze({
    destroyed,
    layerCount: layers.size,
    inFlightCount: inFlight.size,
    cacheEntries: cache.size,
    metrics: Object.freeze({ ...metrics }),
    layers: Object.freeze([...layers.values()].map((session) => Object.freeze({
      layerId: session.layerId,
      resourceUrl: session.resourceUrl,
      metadataVersion: session.metadataVersion,
      supportsQuery: session.contract.supportsQuery,
      stableIdentity: Boolean(session.contract.objectIdField || session.contract.globalIdField),
      spatialReferenceWkid: session.contract.spatialReference?.wkid ?? null,
    }))),
  });

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const job of inFlight.values()) {
      if (!job.controller.signal.aborted) job.controller.abort('ArcGIS query session runtime destroyed');
    }
    inFlight.clear();
    cache.clear();
    layers.clear();
  };

  return Object.freeze({ registerLayer, unregisterLayer, execute, invalidateLayer, clearCache, snapshot, destroy });
};
