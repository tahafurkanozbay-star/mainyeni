import {
  advanceArcGisPagedQueryState,
  createArcGisValidatedQueryPlan,
  deriveArcGisServiceCapabilities,
  type ArcGisLayerMetadataLike,
  type ArcGisPagedQueryState,
  type ArcGisQueryPlanInput,
  type ArcGisServiceCapabilities,
  type ArcGisValidatedQueryPlan,
} from './arcgisCapabilityAdapter';

export type ArcGisQueryPriority = 'interactive' | 'normal' | 'background';

export interface ArcGisQueryPage<TFeature = unknown> {
  features: readonly TFeature[];
  exceededTransferLimit?: boolean;
}

export interface ArcGisQueryExecutionContext {
  serviceUrl: string;
  requestKey: string;
  priority: ArcGisQueryPriority;
  signal: AbortSignal;
}

export interface ArcGisQueryExecutor<TFeature = unknown> {
  execute: (
    plan: ArcGisValidatedQueryPlan,
    context: ArcGisQueryExecutionContext,
  ) => Promise<ArcGisQueryPage<TFeature>>;
  count?: (
    plan: ArcGisValidatedQueryPlan,
    context: ArcGisQueryExecutionContext,
  ) => Promise<number>;
}

export interface ArcGisQuerySessionConfiguration<TFeature = unknown> {
  serviceUrl: string;
  metadata: ArcGisLayerMetadataLike;
  executor: ArcGisQueryExecutor<TFeature>;
  maxRecords?: number;
  maxPages?: number;
  priority?: ArcGisQueryPriority;
}

export interface ArcGisQueryRequestOptions extends ArcGisQueryPlanInput {
  signal?: AbortSignal;
  priority?: ArcGisQueryPriority;
  maxRecords?: number;
  maxPages?: number;
}

export interface ArcGisQueryPageResult<TFeature = unknown> {
  features: readonly TFeature[];
  plan: ArcGisValidatedQueryPlan;
  requestKey: string;
  exceededTransferLimit: boolean;
  deduped: boolean;
}

export interface ArcGisQueryAllResult<TFeature = unknown> {
  features: readonly TFeature[];
  pages: number;
  complete: boolean;
  exceededTransferLimit: boolean;
  truncated: boolean;
  nextOffset: number;
  requestKeys: readonly string[];
  warnings: readonly string[];
}

export interface ArcGisQuerySessionSnapshot {
  serviceUrl: string;
  revision: number;
  disposed: boolean;
  inFlight: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  deduped: number;
  pageRequests: number;
  countRequests: number;
  capabilities: ArcGisServiceCapabilities;
}

interface SharedRequest<T> {
  key: string;
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
}

const DEFAULT_MAX_RECORDS = 50_000;
const DEFAULT_MAX_PAGES = 64;
const MAX_RECORDS_HARD_LIMIT = 250_000;
const MAX_PAGES_HARD_LIMIT = 512;

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

const cancelledError = (): Error & { code: string } => Object.assign(
  new Error('ArcGIS query session request was cancelled.'),
  { code: 'CANCELLED' },
);

const disposedError = (): Error & { code: string } => Object.assign(
  new Error('ArcGIS query session has been disposed.'),
  { code: 'SESSION_DISPOSED' },
);

const invalidServiceError = (serviceUrl: string): Error & { code: string } => Object.assign(
  new Error(`ArcGIS query session requires a concrete MapServer/FeatureServer layer URL: ${serviceUrl}`),
  { code: 'INVALID_ARCGIS_LAYER_URL' },
);

const normalizeServiceUrl = (value: string): string => {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  const withoutQuery = normalized.split(/[?#]/, 1)[0] ?? '';
  const lower = withoutQuery.toLowerCase();
  if (lower.includes('/wms') || lower.includes('/wfs')) throw invalidServiceError(normalized);
  if (!/\/rest\/services\/.+\/(?:FeatureServer|MapServer)\/\d+$/i.test(withoutQuery)) {
    throw invalidServiceError(normalized);
  }
  return withoutQuery;
};

const canonicalParams = (params: Readonly<Record<string, string | number | boolean>>): string => JSON.stringify(
  Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
);

const createRequestKey = (
  serviceUrl: string,
  revision: number,
  operation: 'features' | 'count',
  plan: ArcGisValidatedQueryPlan,
): string => `${revision}:${operation}:${serviceUrl}:${canonicalParams(plan.params)}`;

const normalizePriority = (
  value: ArcGisQueryPriority | undefined,
  fallback: ArcGisQueryPriority,
): ArcGisQueryPriority => value ?? fallback;

const asFeatureRecord = (feature: unknown): Record<string, unknown> | null => (
  feature && typeof feature === 'object' ? feature as Record<string, unknown> : null
);

const readAttributes = (feature: unknown): Record<string, unknown> | null => {
  const record = asFeatureRecord(feature);
  const attributes = record?.attributes;
  return attributes && typeof attributes === 'object' ? attributes as Record<string, unknown> : null;
};

const stableIdentity = (feature: unknown, field: string | null): string | null => {
  if (!field) return null;
  const attributes = readAttributes(feature);
  if (!attributes || !(field in attributes)) return null;
  const value = attributes[field];
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return `${typeof value}:${String(value)}`;
};

const appendUniqueFeatures = <TFeature>(
  target: TFeature[],
  incoming: readonly TFeature[],
  identityField: string | null,
  seenIdentities: Set<string>,
  maxRecords: number,
): number => {
  let accepted = 0;
  for (const feature of incoming) {
    if (target.length >= maxRecords) break;
    const identity = stableIdentity(feature, identityField);
    if (identity && seenIdentities.has(identity)) continue;
    if (identity) seenIdentities.add(identity);
    target.push(feature);
    accepted += 1;
  }
  return accepted;
};

export class ArcGisQuerySession<TFeature = unknown> {
  readonly serviceUrl: string;

  #capabilities: ArcGisServiceCapabilities;
  #executor: ArcGisQueryExecutor<TFeature>;
  #defaultMaxRecords: number;
  #defaultMaxPages: number;
  #defaultPriority: ArcGisQueryPriority;
  #revision = 1;
  #disposed = false;
  #inFlight = new Map<string, SharedRequest<unknown>>();
  #started = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #deduped = 0;
  #pageRequests = 0;
  #countRequests = 0;

  constructor(configuration: ArcGisQuerySessionConfiguration<TFeature>) {
    this.serviceUrl = normalizeServiceUrl(configuration.serviceUrl);
    this.#capabilities = deriveArcGisServiceCapabilities(configuration.metadata);
    this.#executor = configuration.executor;
    this.#defaultMaxRecords = clampInteger(
      configuration.maxRecords,
      DEFAULT_MAX_RECORDS,
      1,
      MAX_RECORDS_HARD_LIMIT,
    );
    this.#defaultMaxPages = clampInteger(
      configuration.maxPages,
      DEFAULT_MAX_PAGES,
      1,
      MAX_PAGES_HARD_LIMIT,
    );
    this.#defaultPriority = configuration.priority ?? 'normal';
  }

  get capabilities(): ArcGisServiceCapabilities {
    return this.#capabilities;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  refreshMetadata(metadata: ArcGisLayerMetadataLike): ArcGisServiceCapabilities {
    this.#assertActive();
    this.#capabilities = deriveArcGisServiceCapabilities(metadata);
    this.#revision += 1;
    this.#abortInFlight('metadata-refresh');
    return this.#capabilities;
  }

  async queryPage(options: ArcGisQueryRequestOptions = {}): Promise<ArcGisQueryPageResult<TFeature>> {
    this.#assertActive();
    if (options.signal?.aborted) throw cancelledError();

    const plan = createArcGisValidatedQueryPlan(this.#capabilities, options);
    const requestKey = createRequestKey(this.serviceUrl, this.#revision, 'features', plan);
    const priority = normalizePriority(options.priority, this.#defaultPriority);
    const existing = this.#inFlight.has(requestKey);
    this.#pageRequests += 1;

    const page = await this.#runShared<ArcGisQueryPage<TFeature>>(
      requestKey,
      options.signal,
      (signal) => this.#executor.execute(plan, {
        serviceUrl: this.serviceUrl,
        requestKey,
        priority,
        signal,
      }),
    );

    return Object.freeze({
      features: Object.freeze([...page.features]),
      plan,
      requestKey,
      exceededTransferLimit: page.exceededTransferLimit === true,
      deduped: existing,
    });
  }

  async queryAll(options: ArcGisQueryRequestOptions = {}): Promise<ArcGisQueryAllResult<TFeature>> {
    this.#assertActive();
    if (options.signal?.aborted) throw cancelledError();

    const maxRecords = clampInteger(
      options.maxRecords,
      this.#defaultMaxRecords,
      1,
      MAX_RECORDS_HARD_LIMIT,
    );
    const maxPages = clampInteger(
      options.maxPages,
      this.#defaultMaxPages,
      1,
      MAX_PAGES_HARD_LIMIT,
    );
    const features: TFeature[] = [];
    const requestKeys: string[] = [];
    const warnings = new Set<string>();
    const seenIdentities = new Set<string>();
    let state: ArcGisPagedQueryState<TFeature> | null = null;
    let exceededTransferLimit = false;
    let pageOffset = Math.max(0, Math.floor(Number(options.resultOffset) || 0));
    let pages = 0;

    while (pages < maxPages && features.length < maxRecords) {
      if (options.signal?.aborted) throw cancelledError();
      const remaining = maxRecords - features.length;
      const requestedSize = clampInteger(
        options.resultRecordCount,
        Math.min(this.#capabilities.maxRecordCount, 1_000),
        1,
        Math.max(1, this.#capabilities.maxRecordCount),
      );
      const pageSize = Math.min(requestedSize, remaining);
      const page = await this.queryPage({
        ...options,
        resultOffset: pageOffset,
        resultRecordCount: pageSize,
      });
      pages += 1;
      requestKeys.push(page.requestKey);
      for (const warning of page.plan.warnings) warnings.add(warning);

      const accepted = appendUniqueFeatures(
        features,
        page.features,
        this.#capabilities.objectIdField,
        seenIdentities,
        maxRecords,
      );
      exceededTransferLimit = page.exceededTransferLimit;
      state = advanceArcGisPagedQueryState(state, page.features, {
        pageSize: page.plan.pageSize,
        exceededTransferLimit: page.exceededTransferLimit,
        maxRecords,
      });

      if (!this.#capabilities.supportsPagination) {
        if (page.exceededTransferLimit || page.features.length >= page.plan.pageSize) {
          warnings.add('pagination-required-but-not-supported');
        }
        break;
      }
      if (state.complete || page.features.length === 0) break;

      const advanceBy = page.features.length;
      if (advanceBy <= 0 || accepted === 0 && page.features.length > 0 && !this.#capabilities.objectIdField) {
        warnings.add('pagination-did-not-produce-progress');
        break;
      }
      pageOffset += advanceBy;
    }

    const pageLimitReached = pages >= maxPages && state?.complete !== true;
    const recordLimitReached = features.length >= maxRecords && state?.complete !== true;
    if (pageLimitReached) warnings.add('max-pages-reached');
    if (recordLimitReached) warnings.add('max-records-reached');
    const complete = state?.complete === true && !pageLimitReached && !recordLimitReached;

    return Object.freeze({
      features: Object.freeze([...features]),
      pages,
      complete,
      exceededTransferLimit,
      truncated: !complete && (pageLimitReached || recordLimitReached || exceededTransferLimit),
      nextOffset: pageOffset,
      requestKeys: Object.freeze(requestKeys),
      warnings: Object.freeze([...warnings]),
    });
  }

  async count(options: ArcGisQueryRequestOptions = {}): Promise<number> {
    this.#assertActive();
    if (options.signal?.aborted) throw cancelledError();
    if (!this.#executor.count) {
      throw Object.assign(new Error('ArcGIS query executor does not expose count().'), {
        code: 'COUNT_UNSUPPORTED',
      });
    }

    const plan = createArcGisValidatedQueryPlan(this.#capabilities, {
      ...options,
      returnGeometry: false,
      resultOffset: 0,
      resultRecordCount: 1,
    });
    const requestKey = createRequestKey(this.serviceUrl, this.#revision, 'count', plan);
    const priority = normalizePriority(options.priority, this.#defaultPriority);
    this.#countRequests += 1;
    const countExecutor = this.#executor.count;

    const value = await this.#runShared<number>(
      requestKey,
      options.signal,
      (signal) => countExecutor(plan, {
        serviceUrl: this.serviceUrl,
        requestKey,
        priority,
        signal,
      }),
    );
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  snapshot(): ArcGisQuerySessionSnapshot {
    return Object.freeze({
      serviceUrl: this.serviceUrl,
      revision: this.#revision,
      disposed: this.#disposed,
      inFlight: this.#inFlight.size,
      started: this.#started,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      deduped: this.#deduped,
      pageRequests: this.#pageRequests,
      countRequests: this.#countRequests,
      capabilities: this.#capabilities,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortInFlight('dispose');
  }

  #assertActive(): void {
    if (this.#disposed) throw disposedError();
  }

  #abortInFlight(_reason: string): void {
    for (const request of this.#inFlight.values()) request.controller.abort();
    this.#inFlight.clear();
  }

  #runShared<T>(
    key: string,
    subscriberSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const existing = this.#inFlight.get(key) as SharedRequest<T> | undefined;
    let request = existing;
    if (request) {
      request.subscribers += 1;
      this.#deduped += 1;
    } else {
      const controller = new AbortController();
      this.#started += 1;
      const created: SharedRequest<T> = {
        key,
        controller,
        subscribers: 1,
        settled: false,
        promise: Promise.resolve(undefined as T),
      };
      created.promise = execute(controller.signal)
        .then((value) => {
          this.#completed += 1;
          return value;
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) this.#cancelled += 1;
          else this.#failed += 1;
          throw error;
        })
        .finally(() => {
          created.settled = true;
          const current = this.#inFlight.get(key);
          if (current === created) this.#inFlight.delete(key);
        });
      request = created;
      this.#inFlight.set(key, created as SharedRequest<unknown>);
    }

    return new Promise<T>((resolve, reject) => {
      let detached = false;
      let subscriberCancelled = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        if (subscriberSignal) subscriberSignal.removeEventListener('abort', onAbort);
        request.subscribers = Math.max(0, request.subscribers - 1);
        if (request.subscribers === 0 && !request.settled) request.controller.abort();
      };
      const onAbort = (): void => {
        if (subscriberCancelled) return;
        subscriberCancelled = true;
        detach();
        reject(cancelledError());
      };

      if (subscriberSignal?.aborted) {
        onAbort();
        return;
      }
      subscriberSignal?.addEventListener('abort', onAbort, { once: true });
      request.promise.then(
        (value) => {
          if (subscriberCancelled) return;
          detach();
          resolve(value);
        },
        (error: unknown) => {
          if (subscriberCancelled) return;
          detach();
          reject(error);
        },
      );
    });
  }
}

export const createArcGisQuerySession = <TFeature = unknown>(
  configuration: ArcGisQuerySessionConfiguration<TFeature>,
): ArcGisQuerySession<TFeature> => new ArcGisQuerySession(configuration);
