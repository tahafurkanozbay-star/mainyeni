import {
  ViewportQueryPolicy,
  type ViewportQueryInput,
  type ViewportQueryPlan,
  type ViewportQueryPolicyConfiguration,
  type ViewportQueryPriority,
  type ViewportQueryExtent,
} from './viewportQueryPolicy';
import {
  ViewportBudgetController,
  type ViewportBudgetControllerConfiguration,
  type ViewportBudgetControllerSnapshot,
  type ViewportPerformanceSample,
} from './viewportBudgetController';
import {
  SpatialQueryGovernanceRuntime,
  SpatialQueryRejectedError,
  type SpatialQueryBudget,
  type SpatialQueryPriority,
} from './spatialQueryGovernanceRuntime';

export type ViewportQueryViewMode = '2d' | '3d';

export interface ViewportFrameInput {
  readonly extent: ViewportQueryExtent;
  readonly scale: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly viewMode: ViewportQueryViewMode;
  readonly moving?: boolean;
}

export interface ViewportFrameState extends ViewportFrameInput {
  readonly generation: number;
  readonly fingerprint: string;
}

export interface ViewportQueryExecutionContext {
  readonly requestKey: string;
  readonly generation: number;
  readonly viewMode: ViewportQueryViewMode;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface ViewportLayerQueryResponse<TFeature = unknown> {
  readonly features: readonly TFeature[];
  readonly complete?: boolean;
  readonly exceededTransferLimit?: boolean;
  readonly estimatedBytes?: number;
  readonly warnings?: readonly string[];
}

export type ViewportLayerQueryExecutor<TFeature = unknown> = (
  plan: ViewportQueryPlan,
  context: ViewportQueryExecutionContext,
) => Promise<ViewportLayerQueryResponse<TFeature>>;

export interface ViewportLayerRegistration<TFeature = unknown> {
  readonly layerId: string;
  readonly execute: ViewportLayerQueryExecutor<TFeature>;
  readonly policy?: Partial<ViewportQueryPolicyConfiguration>;
  readonly defaultFields?: readonly string[];
  readonly includeGeometry?: boolean;
  readonly estimatedFeatureDensity?: number;
  readonly estimatedBytesPerFeature?: number;
  readonly cacheTtlMs?: number;
  readonly maxResponseBytes?: number;
}

export interface ViewportLayerQueryOptions {
  readonly requestedFields?: readonly string[];
  readonly includeGeometry?: boolean;
  readonly estimatedFeatureDensity?: number;
  readonly priority?: ViewportQueryPriority;
  readonly cache?: boolean;
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal;
}

export interface ViewportLayerQueryResult<TFeature = unknown> {
  readonly layerId: string;
  readonly source: 'executor' | 'cache';
  readonly generation: number;
  readonly frameFingerprint: string;
  readonly plan: ViewportQueryPlan;
  readonly features: readonly TFeature[];
  readonly complete: boolean;
  readonly exceededTransferLimit: boolean | null;
  readonly estimatedBytes: number;
  readonly receivedAt: number;
  readonly warnings: readonly string[];
}

export interface ViewportLayerBatchResult<TFeature = unknown> {
  readonly generation: number;
  readonly frameFingerprint: string;
  readonly fulfilled: Readonly<Record<string, ViewportLayerQueryResult<TFeature>>>;
  readonly rejected: Readonly<Record<string, unknown>>;
}

export interface ViewportQueryOrchestratorConfiguration {
  readonly governance?: Partial<SpatialQueryBudget>;
  readonly budgetController?: Partial<ViewportBudgetControllerConfiguration>;
  readonly maxLayers?: number;
  readonly maxLayerIdLength?: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheFeatures?: number;
  readonly maxCacheBytes?: number;
  readonly maxCacheTtlMs?: number;
  readonly defaultCacheTtlMs?: number;
  readonly defaultEstimatedBytesPerFeature?: number;
  readonly defaultMaxResponseBytes?: number;
  readonly frameCoordinatePrecision?: number;
  readonly now?: () => number;
}

export interface ViewportQueryOrchestratorSnapshot {
  readonly disposed: boolean;
  readonly generation: number;
  readonly frame: ViewportFrameState | null;
  readonly registeredLayers: number;
  readonly activeRequestKeys: number;
  readonly cacheEntries: number;
  readonly cacheFeatures: number;
  readonly cacheBytes: number;
  readonly registrations: number;
  readonly unregistrations: number;
  readonly viewportChanges: number;
  readonly executions: number;
  readonly cacheHits: number;
  readonly cacheWrites: number;
  readonly cacheEvictions: number;
  readonly staleResults: number;
  readonly invalidations: number;
  readonly rejectedResponses: number;
  readonly governance: ReturnType<SpatialQueryGovernanceRuntime['snapshot']>;
  readonly budget: ViewportBudgetControllerSnapshot;
}

interface NormalizedLayerRegistration<TFeature = unknown> {
  readonly layerId: string;
  readonly execute: ViewportLayerQueryExecutor<TFeature>;
  readonly policy: ViewportQueryPolicy;
  readonly defaultFields: readonly string[];
  readonly includeGeometry: boolean;
  readonly estimatedFeatureDensity: number | undefined;
  readonly estimatedBytesPerFeature: number;
  readonly cacheTtlMs: number;
  readonly maxResponseBytes: number;
}

interface ViewportCacheEntry {
  readonly cacheKey: string;
  readonly layerId: string;
  readonly result: ViewportLayerQueryResult<unknown>;
  readonly expiresAt: number;
  readonly featureCount: number;
  readonly estimatedBytes: number;
}

const DEFAULT_MAX_LAYERS = 512;
const DEFAULT_MAX_LAYER_ID_LENGTH = 256;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_MAX_CACHE_FEATURES = 100_000;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_CACHE_TTL_MS = 300_000;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_ESTIMATED_BYTES_PER_FEATURE = 512;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_FRAME_COORDINATE_PRECISION = 5;

export class ViewportQueryStaleError extends Error {
  readonly code = 'VIEWPORT_QUERY_STALE';

  constructor(readonly requestGeneration: number, readonly currentGeneration: number) {
    super(
      `Viewport query generation ${requestGeneration} became stale at generation ${currentGeneration}`,
    );
    this.name = 'ViewportQueryStaleError';
  }
}

export class ViewportQueryResponseBudgetError extends Error {
  readonly code = 'VIEWPORT_QUERY_RESPONSE_BUDGET';

  constructor(message: string) {
    super(message);
    this.name = 'ViewportQueryResponseBudgetError';
  }
}

const finitePositive = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`);
  }
  return value;
};

const finiteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return Object.is(value, -0) ? 0 : value;
};

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
};

const normalizeLayerId = (value: string, maximumLength: number): string => {
  if (typeof value !== 'string') throw new TypeError('viewport layerId must be a string');
  const layerId = value.trim();
  if (!layerId) throw new TypeError('viewport layerId must not be empty');
  if (layerId.length > maximumLength) {
    throw new RangeError('viewport layerId exceeds configured length budget');
  }
  return layerId;
};

const normalizeFields = (
  values: readonly string[] | undefined,
): readonly string[] => {
  if (!values) return Object.freeze([]);
  const output = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('viewport query field must be a string');
    const normalized = value.trim();
    if (!normalized) continue;
    if (normalized.length > 128) {
      throw new RangeError('viewport query field exceeds 128 characters');
    }
    output.add(normalized);
  }
  return Object.freeze([...output].sort((left, right) => left.localeCompare(right)));
};

const boundedCacheTtl = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  const normalized = finiteNonNegative(value, 'cacheTtlMs');
  return Math.min(maximum, Math.floor(normalized));
};

const normalizeFrameExtent = (extent: ViewportQueryExtent): ViewportQueryExtent => {
  const coordinates = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!coordinates.every(Number.isFinite)) {
    throw new TypeError('viewport frame extent coordinates must be finite');
  }
  if (extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) {
    throw new RangeError('viewport frame extent must have positive width and height');
  }
  if (typeof extent.spatialReference !== 'string') {
    throw new TypeError('viewport frame spatialReference must be a string');
  }
  const spatialReference = extent.spatialReference.trim();
  if (!spatialReference || spatialReference.length > 128) {
    throw new RangeError('viewport frame spatialReference has invalid length');
  }
  return Object.freeze({
    xmin: extent.xmin,
    ymin: extent.ymin,
    xmax: extent.xmax,
    ymax: extent.ymax,
    spatialReference,
  });
};

const hash = (value: string): string => {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state = Math.imul(state ^ value.charCodeAt(index), 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, '0');
};

const frameFingerprint = (
  input: Omit<ViewportFrameState, 'generation' | 'fingerprint'>,
  precision: number,
): string => hash([
  input.viewMode,
  input.extent.spatialReference,
  input.extent.xmin.toFixed(precision),
  input.extent.ymin.toFixed(precision),
  input.extent.xmax.toFixed(precision),
  input.extent.ymax.toFixed(precision),
  Math.round(input.scale),
  Math.round(input.pixelWidth),
  Math.round(input.pixelHeight),
  input.moving === true ? 'm1' : 'm0',
].join('|'));

const normalizeFrame = (
  input: ViewportFrameInput,
  generation: number,
  precision: number,
): ViewportFrameState => {
  const extent = normalizeFrameExtent(input.extent);
  const scale = finitePositive(input.scale, 'viewport frame scale');
  const pixelWidth = finitePositive(input.pixelWidth, 'viewport frame pixelWidth');
  const pixelHeight = finitePositive(input.pixelHeight, 'viewport frame pixelHeight');
  const base = Object.freeze({
    extent,
    scale,
    pixelWidth,
    pixelHeight,
    viewMode: input.viewMode,
    moving: input.moving === true,
  });
  return Object.freeze({
    ...base,
    generation,
    fingerprint: frameFingerprint(base, precision),
  });
};

const normalizePriority = (priority: ViewportQueryPriority): SpatialQueryPriority => (
  priority === 'interactive'
    ? 'interactive'
    : priority === 'prefetch'
      ? 'background'
      : 'foreground'
);

const abortError = (reason?: unknown): Error => {
  if (reason instanceof Error) return reason;
  const error = new Error(String(reason ?? 'Viewport query was aborted'));
  error.name = 'AbortError';
  return error;
};

const responseComplete = (response: ViewportLayerQueryResponse<unknown>): boolean => (
  response.complete === true
  || (response.complete === undefined && response.exceededTransferLimit === false)
);

const responseTransferLimit = (
  response: ViewportLayerQueryResponse<unknown>,
): boolean | null => (
  typeof response.exceededTransferLimit === 'boolean'
    ? response.exceededTransferLimit
    : null
);

const uniqueWarnings = (values: readonly string[]): readonly string[] => {
  const output = new Set<string>();
  for (const value of values) {
    const normalized = String(value).trim();
    if (normalized) output.add(normalized);
  }
  return Object.freeze([...output].sort((left, right) => left.localeCompare(right)));
};

export class ViewportQueryOrchestrator {
  readonly #governance: SpatialQueryGovernanceRuntime;
  readonly #budgetController: ViewportBudgetController;
  readonly #layers = new Map<string, NormalizedLayerRegistration<unknown>>();
  readonly #cache = new Map<string, ViewportCacheEntry>();
  readonly #activeRequestKeys = new Set<string>();
  readonly #now: () => number;
  readonly #maxLayers: number;
  readonly #maxLayerIdLength: number;
  readonly #maxCacheEntries: number;
  readonly #maxCacheFeatures: number;
  readonly #maxCacheBytes: number;
  readonly #maxCacheTtlMs: number;
  readonly #defaultCacheTtlMs: number;
  readonly #defaultEstimatedBytesPerFeature: number;
  readonly #defaultMaxResponseBytes: number;
  readonly #frameCoordinatePrecision: number;

  #disposed = false;
  #generation = 0;
  #frame: ViewportFrameState | null = null;
  #cacheFeatures = 0;
  #cacheBytes = 0;
  #registrations = 0;
  #unregistrations = 0;
  #viewportChanges = 0;
  #executions = 0;
  #cacheHits = 0;
  #cacheWrites = 0;
  #cacheEvictions = 0;
  #staleResults = 0;
  #invalidations = 0;
  #rejectedResponses = 0;

  constructor(configuration: ViewportQueryOrchestratorConfiguration = {}) {
    this.#governance = new SpatialQueryGovernanceRuntime(configuration.governance);
    this.#budgetController = new ViewportBudgetController(configuration.budgetController);
    this.#now = configuration.now ?? Date.now;
    this.#maxLayers = positiveSafeInteger(
      configuration.maxLayers ?? DEFAULT_MAX_LAYERS,
      'maxLayers',
    );
    this.#maxLayerIdLength = positiveSafeInteger(
      configuration.maxLayerIdLength ?? DEFAULT_MAX_LAYER_ID_LENGTH,
      'maxLayerIdLength',
    );
    this.#maxCacheEntries = positiveSafeInteger(
      configuration.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      'maxCacheEntries',
    );
    this.#maxCacheFeatures = positiveSafeInteger(
      configuration.maxCacheFeatures ?? DEFAULT_MAX_CACHE_FEATURES,
      'maxCacheFeatures',
    );
    this.#maxCacheBytes = positiveSafeInteger(
      configuration.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
      'maxCacheBytes',
    );
    this.#maxCacheTtlMs = positiveSafeInteger(
      configuration.maxCacheTtlMs ?? DEFAULT_MAX_CACHE_TTL_MS,
      'maxCacheTtlMs',
    );
    this.#defaultCacheTtlMs = boundedCacheTtl(
      configuration.defaultCacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
      this.#maxCacheTtlMs,
    );
    this.#defaultEstimatedBytesPerFeature = positiveSafeInteger(
      configuration.defaultEstimatedBytesPerFeature
        ?? DEFAULT_ESTIMATED_BYTES_PER_FEATURE,
      'defaultEstimatedBytesPerFeature',
    );
    this.#defaultMaxResponseBytes = Math.min(
      positiveSafeInteger(
        configuration.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        'defaultMaxResponseBytes',
      ),
      this.#governance.budget.maxBytesPerRequest,
    );
    this.#frameCoordinatePrecision = configuration.frameCoordinatePrecision
      ?? DEFAULT_FRAME_COORDINATE_PRECISION;
    if (
      !Number.isInteger(this.#frameCoordinatePrecision)
      || this.#frameCoordinatePrecision < 0
      || this.#frameCoordinatePrecision > 12
    ) {
      throw new RangeError('frameCoordinatePrecision must be an integer from 0 through 12');
    }
  }

  get governance(): SpatialQueryGovernanceRuntime {
    return this.#governance;
  }

  get budgetController(): ViewportBudgetController {
    return this.#budgetController;
  }

  registerLayer<TFeature>(
    registration: ViewportLayerRegistration<TFeature>,
  ): void {
    this.#assertActive();
    const layerId = normalizeLayerId(registration.layerId, this.#maxLayerIdLength);
    if (typeof registration.execute !== 'function') {
      throw new TypeError('viewport layer execute function is required');
    }
    if (!this.#layers.has(layerId) && this.#layers.size >= this.#maxLayers) {
      throw new RangeError('viewport query orchestrator exceeds layer budget');
    }

    const policy = new ViewportQueryPolicy({
      ...registration.policy,
      maxFeatures: Math.min(
        registration.policy?.maxFeatures ?? this.#governance.budget.maxFeaturesPerRequest,
        this.#governance.budget.maxFeaturesPerRequest,
      ),
      maxFields: Math.max(1, Math.floor(registration.policy?.maxFields ?? 32)),
    });
    const estimatedBytesPerFeature = positiveSafeInteger(
      registration.estimatedBytesPerFeature ?? this.#defaultEstimatedBytesPerFeature,
      'estimatedBytesPerFeature',
    );
    const maxByGovernanceBytes = Math.max(
      1,
      Math.floor(this.#governance.budget.maxBytesPerRequest / estimatedBytesPerFeature),
    );
    if (policy.configuration.maxFeatures > maxByGovernanceBytes) {
      throw new RangeError(
        'viewport layer maxFeatures and estimatedBytesPerFeature exceed governance byte budget',
      );
    }
    const density = registration.estimatedFeatureDensity;
    if (density !== undefined) {
      finiteNonNegative(density, 'estimatedFeatureDensity');
    }
    const cacheTtlMs = boundedCacheTtl(
      registration.cacheTtlMs,
      this.#defaultCacheTtlMs,
      this.#maxCacheTtlMs,
    );
    const maxResponseBytes = positiveSafeInteger(
      registration.maxResponseBytes ?? this.#defaultMaxResponseBytes,
      'maxResponseBytes',
    );
    if (maxResponseBytes > this.#governance.budget.maxBytesPerRequest) {
      throw new RangeError('maxResponseBytes exceeds governance maxBytesPerRequest');
    }

    const previous = this.#layers.get(layerId);
    if (previous) {
      this.#invalidateLayerCache(layerId);
      this.#cancelLayerRequests(layerId, 'layer-registration-replaced');
    }
    this.#layers.set(layerId, Object.freeze({
      layerId,
      execute: registration.execute as ViewportLayerQueryExecutor<unknown>,
      policy,
      defaultFields: normalizeFields(registration.defaultFields),
      includeGeometry: registration.includeGeometry !== false,
      estimatedFeatureDensity: density,
      estimatedBytesPerFeature,
      cacheTtlMs,
      maxResponseBytes,
    }));
    if (!previous) this.#registrations += 1;
  }

  unregisterLayer(layerIdInput: string): boolean {
    this.#assertActive();
    const layerId = normalizeLayerId(layerIdInput, this.#maxLayerIdLength);
    const removed = this.#layers.delete(layerId);
    if (!removed) return false;
    this.#invalidateLayerCache(layerId);
    this.#cancelLayerRequests(layerId, 'layer-unregistered');
    this.#unregistrations += 1;
    return true;
  }

  setViewport(input: ViewportFrameInput): ViewportFrameState {
    this.#assertActive();
    const candidate = normalizeFrame(
      input,
      this.#generation + 1,
      this.#frameCoordinatePrecision,
    );
    if (candidate.fingerprint === this.#frame?.fingerprint) {
      return this.#frame;
    }

    this.#generation += 1;
    const next = Object.freeze({
      ...candidate,
      generation: this.#generation,
    });
    const staleKeys = [...this.#activeRequestKeys];
    this.#frame = next;
    this.#viewportChanges += 1;
    for (const requestKey of staleKeys) {
      this.#governance.cancel(
        requestKey,
        new ViewportQueryStaleError(this.#generation - 1, this.#generation),
      );
      this.#activeRequestKeys.delete(requestKey);
    }
    return next;
  }

  samplePerformance(
    sample: ViewportPerformanceSample,
  ): ViewportBudgetControllerSnapshot {
    this.#assertActive();
    return this.#budgetController.sample(sample);
  }

  async queryLayer<TFeature = unknown>(
    layerIdInput: string,
    options: ViewportLayerQueryOptions = {},
  ): Promise<ViewportLayerQueryResult<TFeature>> {
    this.#assertActive();
    const frame = this.#requireFrame();
    const layerId = normalizeLayerId(layerIdInput, this.#maxLayerIdLength);
    const registration = this.#layers.get(layerId) as NormalizedLayerRegistration<TFeature> | undefined;
    if (!registration) {
      throw new RangeError(`viewport layer is not registered: ${layerId}`);
    }
    if (options.signal?.aborted) throw abortError(options.signal.reason);

    const profile = this.#budgetController.profile();
    const policyConfiguration = registration.policy.configuration;
    const byteFeatureBudget = Math.max(
      1,
      Math.floor(this.#governance.budget.maxBytesPerRequest / registration.estimatedBytesPerFeature),
    );
    const effectiveMaxFeatures = Math.max(
      1,
      Math.min(
        policyConfiguration.maxFeatures,
        byteFeatureBudget,
        Math.floor(policyConfiguration.maxFeatures * profile.maxFeaturesFactor),
      ),
    );
    const effectiveMaxFields = Math.max(
      1,
      Math.min(
        Math.floor(policyConfiguration.maxFields),
        Math.floor(policyConfiguration.maxFields * profile.maxFieldsFactor),
      ),
    );
    const policy = new ViewportQueryPolicy({
      ...policyConfiguration,
      maxFeatures: effectiveMaxFeatures,
      maxFields: effectiveMaxFields,
      prefetchFeatureFactor: Math.min(
        policyConfiguration.prefetchFeatureFactor,
        Math.max(0.01, profile.prefetchFactor),
      ),
    });
    const priority = options.priority ?? 'foreground';
    const requestedFields = options.requestedFields ?? registration.defaultFields;
    const includeGeometry = options.includeGeometry ?? registration.includeGeometry;
    const density = options.estimatedFeatureDensity ?? registration.estimatedFeatureDensity;
    const planInput: ViewportQueryInput = {
      layerId,
      extent: frame.extent,
      scale: frame.scale,
      pixelWidth: frame.pixelWidth,
      pixelHeight: frame.pixelHeight,
      priority,
      requestedFields,
      includeGeometry,
      moving: frame.moving === true || profile.moving,
      ...(density === undefined ? {} : { estimatedFeatureDensity: density }),
    };
    const plan = policy.plan(planInput);
    const estimatedFeatures = Math.min(
      plan.maxFeatures,
      Math.max(1, plan.estimatedFeatures ?? plan.maxFeatures),
    );
    const estimatedBytes = Math.min(
      this.#governance.budget.maxBytesPerRequest,
      estimatedFeatures * registration.estimatedBytesPerFeature,
    );
    const keySuffix = [
      frame.viewMode,
      plan.key,
      `m${plan.maxFeatures}`,
      `p${priority}`,
    ].join('|');
    const cacheKey = `${layerId}|${keySuffix}`;
    const requestKey = `g${frame.generation}|${cacheKey}`;
    const cacheEnabled = options.cache !== false;
    const timestamp = this.#safeNow();

    this.#pruneExpiredCache(timestamp);
    if (cacheEnabled) {
      const cached = this.#cache.get(cacheKey);
      if (cached && cached.expiresAt > timestamp) {
        this.#touchCache(cacheKey, cached);
        this.#cacheHits += 1;
        return Object.freeze({
          ...(cached.result as ViewportLayerQueryResult<TFeature>),
          source: 'cache',
          generation: frame.generation,
          frameFingerprint: frame.fingerprint,
        });
      }
    }

    this.#activeRequestKeys.add(requestKey);
    try {
      const response = await this.#governance.run(
        {
          key: requestKey,
          kind: 'search',
          priority: normalizePriority(priority),
          estimatedFeatures,
          estimatedBytes,
        },
        async ({ signal, deadline }) => {
          this.#executions += 1;
          return registration.execute(plan, {
            requestKey,
            generation: frame.generation,
            viewMode: frame.viewMode,
            signal,
            deadline,
          });
        },
        options.signal,
      );

      this.#assertActive();
      if (frame.generation !== this.#generation || frame.fingerprint !== this.#frame?.fingerprint) {
        this.#staleResults += 1;
        throw new ViewportQueryStaleError(frame.generation, this.#generation);
      }
      const receivedAt = this.#safeNow();
      const result = this.#validateResponse(
        layerId,
        frame,
        plan,
        response,
        registration.maxResponseBytes,
        registration.estimatedBytesPerFeature,
        receivedAt,
      );

      if (cacheEnabled && result.complete) {
        const ttl = boundedCacheTtl(
          options.cacheTtlMs,
          registration.cacheTtlMs,
          this.#maxCacheTtlMs,
        );
        if (ttl > 0) this.#writeCache(cacheKey, layerId, result, receivedAt + ttl);
      }
      return result;
    } catch (error) {
      if (
        error instanceof SpatialQueryRejectedError
        || error instanceof ViewportQueryResponseBudgetError
      ) {
        this.#rejectedResponses += 1;
      }
      throw error;
    } finally {
      this.#activeRequestKeys.delete(requestKey);
    }
  }

  async queryLayers<TFeature = unknown>(
    layerIds: readonly string[],
    options: Readonly<Record<string, ViewportLayerQueryOptions>> = {},
  ): Promise<ViewportLayerBatchResult<TFeature>> {
    this.#assertActive();
    const frame = this.#requireFrame();
    const unique = new Set<string>();
    for (const layerId of layerIds) {
      unique.add(normalizeLayerId(layerId, this.#maxLayerIdLength));
    }
    if (unique.size > this.#maxLayers) {
      throw new RangeError('viewport query batch exceeds registered layer budget');
    }

    const fulfilled: Record<string, ViewportLayerQueryResult<TFeature>> = Object.create(null) as Record<
      string,
      ViewportLayerQueryResult<TFeature>
    >;
    const rejected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    await Promise.all([...unique].map(async (layerId) => {
      try {
        fulfilled[layerId] = await this.queryLayer<TFeature>(
          layerId,
          options[layerId] ?? {},
        );
      } catch (error) {
        rejected[layerId] = error;
      }
    }));

    return Object.freeze({
      generation: frame.generation,
      frameFingerprint: frame.fingerprint,
      fulfilled: Object.freeze(fulfilled),
      rejected: Object.freeze(rejected),
    });
  }

  invalidateLayer(layerIdInput: string): number {
    this.#assertActive();
    const layerId = normalizeLayerId(layerIdInput, this.#maxLayerIdLength);
    if (!this.#layers.has(layerId)) return 0;
    const removed = this.#invalidateLayerCache(layerId);
    this.#cancelLayerRequests(layerId, 'layer-invalidated');
    this.#invalidations += 1;
    return removed;
  }

  clearCache(): number {
    this.#assertActive();
    const count = this.#cache.size;
    this.#cache.clear();
    this.#cacheFeatures = 0;
    this.#cacheBytes = 0;
    if (count > 0) this.#invalidations += 1;
    return count;
  }

  snapshot(): ViewportQueryOrchestratorSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      generation: this.#generation,
      frame: this.#frame,
      registeredLayers: this.#layers.size,
      activeRequestKeys: this.#activeRequestKeys.size,
      cacheEntries: this.#cache.size,
      cacheFeatures: this.#cacheFeatures,
      cacheBytes: this.#cacheBytes,
      registrations: this.#registrations,
      unregistrations: this.#unregistrations,
      viewportChanges: this.#viewportChanges,
      executions: this.#executions,
      cacheHits: this.#cacheHits,
      cacheWrites: this.#cacheWrites,
      cacheEvictions: this.#cacheEvictions,
      staleResults: this.#staleResults,
      invalidations: this.#invalidations,
      rejectedResponses: this.#rejectedResponses,
      governance: this.#governance.snapshot(),
      budget: this.#budgetController.snapshot(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#governance.dispose(new Error('Viewport query orchestrator disposed'));
    this.#layers.clear();
    this.#cache.clear();
    this.#activeRequestKeys.clear();
    this.#cacheFeatures = 0;
    this.#cacheBytes = 0;
    this.#frame = null;
  }

  #validateResponse<TFeature>(
    layerId: string,
    frame: ViewportFrameState,
    plan: ViewportQueryPlan,
    response: ViewportLayerQueryResponse<TFeature>,
    maximumBytes: number,
    estimatedBytesPerFeature: number,
    receivedAt: number,
  ): ViewportLayerQueryResult<TFeature> {
    if (!Array.isArray(response.features)) {
      throw new ViewportQueryResponseBudgetError('viewport query response features must be an array');
    }
    if (response.features.length > plan.maxFeatures) {
      throw new ViewportQueryResponseBudgetError(
        'viewport query response exceeds the planned feature budget',
      );
    }
    const estimatedBytes = response.estimatedBytes === undefined
      ? Math.min(
        maximumBytes,
        response.features.length * estimatedBytesPerFeature,
      )
      : finiteNonNegative(response.estimatedBytes, 'response estimatedBytes');
    if (estimatedBytes > maximumBytes) {
      throw new ViewportQueryResponseBudgetError(
        'viewport query response exceeds maxResponseBytes',
      );
    }
    const transferLimit = responseTransferLimit(response);
    const complete = responseComplete(response);
    const warnings = [
      ...plan.warnings,
      ...(response.warnings ?? []),
      ...(transferLimit === true ? ['transfer-limit-reached'] : []),
      ...(transferLimit === null && !complete ? ['completion-evidence-missing'] : []),
    ];

    return Object.freeze({
      layerId,
      source: 'executor',
      generation: frame.generation,
      frameFingerprint: frame.fingerprint,
      plan,
      features: Object.freeze([...response.features]),
      complete,
      exceededTransferLimit: transferLimit,
      estimatedBytes: Math.floor(estimatedBytes),
      receivedAt,
      warnings: uniqueWarnings(warnings),
    });
  }

  #writeCache(
    cacheKey: string,
    layerId: string,
    result: ViewportLayerQueryResult<unknown>,
    expiresAt: number,
  ): void {
    const featureCount = result.features.length;
    const estimatedBytes = result.estimatedBytes;
    if (
      featureCount > this.#maxCacheFeatures
      || estimatedBytes > this.#maxCacheBytes
    ) {
      return;
    }

    const previous = this.#cache.get(cacheKey);
    if (previous) this.#removeCacheEntry(cacheKey, previous, false);
    const entry: ViewportCacheEntry = Object.freeze({
      cacheKey,
      layerId,
      result,
      expiresAt,
      featureCount,
      estimatedBytes,
    });
    this.#cache.set(cacheKey, entry);
    this.#cacheFeatures += featureCount;
    this.#cacheBytes += estimatedBytes;
    this.#cacheWrites += 1;
    this.#enforceCacheBudgets();
  }

  #enforceCacheBudgets(): void {
    while (
      this.#cache.size > this.#maxCacheEntries
      || this.#cacheFeatures > this.#maxCacheFeatures
      || this.#cacheBytes > this.#maxCacheBytes
    ) {
      const oldest = this.#cache.entries().next().value as [string, ViewportCacheEntry] | undefined;
      if (!oldest) break;
      this.#removeCacheEntry(oldest[0], oldest[1], true);
    }
  }

  #pruneExpiredCache(timestamp: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt > timestamp) continue;
      this.#removeCacheEntry(key, entry, true);
    }
  }

  #touchCache(cacheKey: string, entry: ViewportCacheEntry): void {
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, entry);
  }

  #removeCacheEntry(
    cacheKey: string,
    entry: ViewportCacheEntry,
    countEviction: boolean,
  ): void {
    if (!this.#cache.delete(cacheKey)) return;
    this.#cacheFeatures = Math.max(0, this.#cacheFeatures - entry.featureCount);
    this.#cacheBytes = Math.max(0, this.#cacheBytes - entry.estimatedBytes);
    if (countEviction) this.#cacheEvictions += 1;
  }

  #invalidateLayerCache(layerId: string): number {
    let removed = 0;
    for (const [key, entry] of [...this.#cache.entries()]) {
      if (entry.layerId !== layerId) continue;
      this.#removeCacheEntry(key, entry, false);
      removed += 1;
    }
    return removed;
  }

  #cancelLayerRequests(layerId: string, reason: string): void {
    const marker = `|${layerId}|`;
    for (const requestKey of [...this.#activeRequestKeys]) {
      if (!requestKey.includes(marker)) continue;
      this.#governance.cancel(requestKey, new Error(reason));
      this.#activeRequestKeys.delete(requestKey);
    }
  }

  #requireFrame(): ViewportFrameState {
    if (!this.#frame) {
      throw new Error('viewport frame must be set before querying layers');
    }
    return this.#frame;
  }

  #safeNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('viewport query clock must return a finite non-negative number');
    }
    return value;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('viewport query orchestrator is disposed');
    }
  }
}

export const createViewportQueryOrchestrator = (
  configuration: ViewportQueryOrchestratorConfiguration = {},
): ViewportQueryOrchestrator => new ViewportQueryOrchestrator(configuration);
