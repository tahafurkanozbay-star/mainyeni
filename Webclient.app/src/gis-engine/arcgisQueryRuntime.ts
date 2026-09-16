import {
  createArcGisQueryPlan,
  ArcGisQueryContractError,
  type ArcGisQueryPlan,
  type ArcGisQuerySpec,
} from './arcgisQueryContract';
import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { readArcgisFeatureWindow, type FeatureWindowResult } from './arcgisFeatureWindow';
import { inspectGeometry, type GeometryBudget } from './geometryGuard';
import {
  createQueryExecutionPlan,
  type QueryExecutionLimits,
  type QueryExecutionRequest,
  type QueryExecutionPlan,
} from './queryExecutionPlanner';
import {
  createRequestCoordinator,
  type CoordinatedRequestOptions,
  type RequestCoordinator,
  type RequestCoordinatorOptions,
} from './requestCoordinator';

/**
 * Capability-aware ArcGIS query runtime.
 *
 * Transport is injected: this module only executes query plans produced from
 * verified layer metadata. It does not discover services and does not create a
 * new endpoint family. Bounded pagination, cancellation, de-duplication and
 * geometry integrity are enforced before data reaches UI/state consumers.
 */

export interface ArcGisFeature {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
  readonly [key: string]: unknown;
}

export interface ArcGisQueryResponse<TFeature extends ArcGisFeature = ArcGisFeature> {
  readonly features?: readonly TFeature[];
  readonly exceededTransferLimit?: boolean;
  readonly objectIdFieldName?: string;
  readonly fields?: readonly unknown[];
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface ArcGisTransportContext {
  readonly signal: AbortSignal;
  readonly requestKey: string;
  readonly pageIndex: number;
  readonly attempt: number;
}

export type ArcGisQueryTransport<TFeature extends ArcGisFeature = ArcGisFeature> = (
  plan: ArcGisQueryPlan,
  context: ArcGisTransportContext,
) => Promise<ArcGisQueryResponse<TFeature>>;

export interface ArcGisQueryRuntimeOptions {
  readonly coordinator?: RequestCoordinator;
  readonly coordinatorOptions?: RequestCoordinatorOptions;
  readonly queryLimits?: QueryExecutionLimits;
  readonly geometryBudget?: GeometryBudget;
  readonly cacheTtlMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
}

export interface ExecuteArcGisQueryOptions extends QueryExecutionRequest {
  readonly signal?: AbortSignal;
  readonly namespace?: string;
  readonly generation?: string | number;
  readonly cache?: boolean;
  readonly cacheTtlMs?: number;
  readonly priority?: CoordinatedRequestOptions['priority'];
  readonly validateGeometry?: boolean;
  readonly strictGeometry?: boolean;
}

export interface ArcGisQueryRuntimeDiagnostics {
  readonly requestKey: string;
  readonly strategy: QueryExecutionPlan['strategy'];
  readonly pages: number;
  readonly duplicateCount: number;
  readonly invalidGeometryCount: number;
  readonly droppedInvalidGeometryCount: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly retries: number;
  readonly cacheEligible: boolean;
}

export interface ArcGisQueryRuntimeResult<TFeature extends ArcGisFeature = ArcGisFeature> {
  readonly features: readonly TFeature[];
  readonly executionPlan: QueryExecutionPlan;
  readonly diagnostics: ArcGisQueryRuntimeDiagnostics;
}

export class ArcGisQueryRuntimeError extends Error {
  readonly code: string;
  readonly resourceUrl: string;
  readonly cause?: unknown;
  readonly pageIndex?: number;

  constructor(
    message: string,
    code: string,
    resourceUrl: string,
    details: { cause?: unknown; pageIndex?: number } = {},
  ) {
    super(message);
    this.name = 'ArcGisQueryRuntimeError';
    this.code = code;
    this.resourceUrl = resourceUrl;
    if ('cause' in details) this.cause = details.cause;
    if (details.pageIndex !== undefined) this.pageIndex = details.pageIndex;
  }
}

interface RuntimeState {
  retries: number;
  invalidGeometryCount: number;
  droppedInvalidGeometryCount: number;
}

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(maximum, Math.floor(numeric));
};

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return;
  }
  const timer = setTimeout(resolve, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const arcgisErrorMessage = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  const details = Array.isArray(value.details)
    ? value.details.filter((entry): entry is string => typeof entry === 'string').join(' ')
    : '';
  return [message, details].filter(Boolean).join(' ') || 'ArcGIS service returned an error object.';
};

const arcgisErrorCode = (value: unknown): number | null => {
  if (!isRecord(value)) return null;
  const code = Number(value.code);
  return Number.isFinite(code) ? code : null;
};

const retryableStatus = (value: unknown): boolean => {
  const status = isRecord(value) ? Number(value.status ?? value.code) : Number.NaN;
  return status === 408 || status === 429 || status >= 500;
};

const retryableArcgisError = (response: ArcGisQueryResponse): boolean => {
  const code = arcgisErrorCode(response.error);
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
};

const requestKey = (metadata: ArcGisMetadataContract, plan: QueryExecutionPlan): string => (
  `${metadata.resourceUrl}|${plan.signature}|${plan.strategy}|${plan.maxFeatures}|${plan.maxPages}`
);

const featureIdentity = <TFeature extends ArcGisFeature>(
  feature: TFeature,
  objectIdField: string | null,
): string | number | undefined => {
  if (!objectIdField || !feature.attributes) return undefined;
  const value = feature.attributes[objectIdField];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
};

const cloneFeatureWithGeometry = <TFeature extends ArcGisFeature>(
  feature: TFeature,
  geometry: unknown,
): TFeature => ({ ...feature, geometry } as TFeature);

const validateFeatureGeometry = <TFeature extends ArcGisFeature>(
  features: readonly TFeature[],
  geometryBudget: GeometryBudget,
  strict: boolean,
  state: RuntimeState,
): readonly TFeature[] => {
  const output: TFeature[] = [];
  for (const feature of features) {
    if (feature.geometry === null || feature.geometry === undefined) {
      output.push(feature);
      continue;
    }
    const inspection = inspectGeometry(feature.geometry, geometryBudget);
    if (inspection.valid) {
      output.push(feature);
      continue;
    }
    state.invalidGeometryCount += 1;
    if (strict) {
      const first = inspection.issues.find((entry) => entry.severity === 'error');
      throw new ArcGisQueryRuntimeError(
        first?.message ?? 'ArcGIS feature geometry failed integrity validation.',
        'INVALID_FEATURE_GEOMETRY',
        '',
      );
    }
    state.droppedInvalidGeometryCount += 1;
    output.push(cloneFeatureWithGeometry(feature, null));
  }
  return Object.freeze(output);
};

const mergeSignals = (external: AbortSignal | undefined, internal: AbortSignal): AbortSignal => {
  if (!external) return internal;
  if (external.aborted) {
    const controller = new AbortController();
    controller.abort(external.reason);
    return controller.signal;
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([external, internal]);
  }
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(external.reason);
  const abortFromInternal = () => controller.abort(internal.reason);
  external.addEventListener('abort', abortFromExternal, { once: true });
  internal.addEventListener('abort', abortFromInternal, { once: true });
  return controller.signal;
};

export class ArcGisQueryRuntime<TFeature extends ArcGisFeature = ArcGisFeature> {
  private readonly coordinator: RequestCoordinator;
  private readonly ownsCoordinator: boolean;
  private readonly queryLimits: QueryExecutionLimits;
  private readonly geometryBudget: GeometryBudget;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private destroyed = false;

  constructor(
    private readonly transport: ArcGisQueryTransport<TFeature>,
    options: ArcGisQueryRuntimeOptions = {},
  ) {
    if (typeof transport !== 'function') {
      throw new TypeError('ArcGisQueryRuntime requires an injected transport function.');
    }
    this.coordinator = options.coordinator ?? createRequestCoordinator(options.coordinatorOptions);
    this.ownsCoordinator = !options.coordinator;
    this.queryLimits = Object.freeze({ ...(options.queryLimits ?? {}) });
    this.geometryBudget = Object.freeze({ ...(options.geometryBudget ?? {}) });
    this.cacheTtlMs = positiveInteger(options.cacheTtlMs, 15_000, 600_000);
    this.maxRetries = positiveInteger(options.maxRetries, 2, 5);
    this.retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs, 250, 10_000);
    this.retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs, 2_000, 30_000);
  }

  async execute(
    metadata: ArcGisMetadataContract,
    options: ExecuteArcGisQueryOptions = {},
  ): Promise<ArcGisQueryRuntimeResult<TFeature>> {
    if (this.destroyed) {
      throw new ArcGisQueryRuntimeError('ArcGIS query runtime is destroyed.', 'RUNTIME_DESTROYED', metadata.resourceUrl);
    }
    const executionPlan = createQueryExecutionPlan(metadata, options, this.queryLimits);
    const key = requestKey(metadata, executionPlan);
    const startedAt = Date.now();
    const cacheEligible = options.cache !== false && options.purpose !== 'export';

    const result = await this.coordinator.run(
      key,
      async ({ signal: internalSignal }) => {
        const signal = mergeSignals(options.signal, internalSignal);
        return this.executePlan(metadata, executionPlan, signal, options);
      },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        priority: options.priority ?? (options.purpose === 'analysis' ? 'background' : 'interactive'),
        cache: cacheEligible,
        ttlMs: options.cacheTtlMs ?? this.cacheTtlMs,
        namespace: options.namespace ?? metadata.resourceUrl,
        ...(options.generation !== undefined ? { generation: options.generation } : {}),
      },
    );

    return Object.freeze({
      features: result.features,
      executionPlan,
      diagnostics: Object.freeze({
        ...result.diagnostics,
        requestKey: key,
        strategy: executionPlan.strategy,
        durationMs: Date.now() - startedAt,
        cacheEligible,
      }),
    });
  }

  advanceGeneration(namespace: string, generation: string | number): void {
    this.coordinator.advanceGeneration(namespace, generation);
  }

  invalidate(resourceUrl?: string): number {
    return resourceUrl ? this.coordinator.invalidate(undefined, resourceUrl) : this.coordinator.invalidate();
  }

  cancelResource(resourceUrl: string, reason?: unknown): number {
    return this.coordinator.cancelNamespace(resourceUrl, reason);
  }

  snapshot(): ReturnType<RequestCoordinator['snapshot']> {
    return this.coordinator.snapshot();
  }

  destroy(reason?: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ownsCoordinator) this.coordinator.destroy(reason);
  }

  private async executePlan(
    metadata: ArcGisMetadataContract,
    executionPlan: QueryExecutionPlan,
    signal: AbortSignal,
    options: ExecuteArcGisQueryOptions,
  ): Promise<{
    readonly features: readonly TFeature[];
    readonly diagnostics: Omit<
      ArcGisQueryRuntimeDiagnostics,
      'requestKey' | 'strategy' | 'durationMs' | 'cacheEligible'
    >;
  }> {
    const state: RuntimeState = {
      retries: 0,
      invalidGeometryCount: 0,
      droppedInvalidGeometryCount: 0,
    };
    const validateGeometry = options.validateGeometry !== false && executionPlan.query.returnGeometry;
    const strictGeometry = options.strictGeometry === true;

    if (executionPlan.strategy !== 'offset-pagination') {
      const response = await this.fetchPage(metadata, executionPlan, 0, signal, state);
      const rawFeatures = Object.freeze([...(response.features ?? [])]);
      const features = validateGeometry
        ? validateFeatureGeometry(rawFeatures, this.geometryBudget, strictGeometry, state)
        : rawFeatures;
      const truncated = response.exceededTransferLimit === true || features.length >= executionPlan.maxFeatures;
      return Object.freeze({
        features: Object.freeze(features.slice(0, executionPlan.maxFeatures)),
        diagnostics: Object.freeze({
          pages: 1,
          duplicateCount: 0,
          invalidGeometryCount: state.invalidGeometryCount,
          droppedInvalidGeometryCount: state.droppedInvalidGeometryCount,
          complete: !truncated,
          truncated,
          retries: state.retries,
        }),
      });
    }

    const window: FeatureWindowResult<TFeature> = await readArcgisFeatureWindow<TFeature>({
      pageSize: executionPlan.pageSize,
      maxFeatures: executionPlan.maxFeatures,
      maxPages: executionPlan.maxPages,
      identity: (feature) => featureIdentity(feature, metadata.objectIdField),
      fetchPage: async (offset, limit, pageSignal) => {
        const pageIndex = Math.max(0, Math.floor((offset - executionPlan.initialOffset) / executionPlan.pageSize));
        const spec: ArcGisQuerySpec = Object.freeze({
          ...executionPlan.query,
          window: Object.freeze({ resultOffset: offset, resultRecordCount: limit }),
        });
        const response = await this.fetchSpec(metadata, executionPlan, spec, pageIndex, pageSignal, state);
        const rawFeatures = Object.freeze([...(response.features ?? [])]);
        const features = validateGeometry
          ? validateFeatureGeometry(rawFeatures, this.geometryBudget, strictGeometry, state)
          : rawFeatures;
        return Object.freeze({
          features,
          exceededTransferLimit: response.exceededTransferLimit === true,
          nextOffset: offset + rawFeatures.length,
        });
      },
    }, signal);

    return Object.freeze({
      features: window.features,
      diagnostics: Object.freeze({
        pages: window.pages,
        duplicateCount: window.duplicateCount,
        invalidGeometryCount: state.invalidGeometryCount,
        droppedInvalidGeometryCount: state.droppedInvalidGeometryCount,
        complete: window.complete,
        truncated: window.truncated,
        retries: state.retries,
      }),
    });
  }

  private fetchPage(
    metadata: ArcGisMetadataContract,
    executionPlan: QueryExecutionPlan,
    pageIndex: number,
    signal: AbortSignal,
    state: RuntimeState,
  ): Promise<ArcGisQueryResponse<TFeature>> {
    return this.fetchSpec(metadata, executionPlan, executionPlan.pageSpec(pageIndex), pageIndex, signal, state);
  }

  private async fetchSpec(
    metadata: ArcGisMetadataContract,
    executionPlan: QueryExecutionPlan,
    spec: ArcGisQuerySpec,
    pageIndex: number,
    signal: AbortSignal,
    state: RuntimeState,
  ): Promise<ArcGisQueryResponse<TFeature>> {
    let arcgisPlan: ArcGisQueryPlan;
    try {
      arcgisPlan = createArcGisQueryPlan(metadata, spec);
    } catch (error) {
      if (error instanceof ArcGisQueryContractError) {
        throw new ArcGisQueryRuntimeError(error.message, error.code, metadata.resourceUrl, { cause: error, pageIndex });
      }
      throw error;
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const attemptNumber = attempt + 1;
      try {
        const response = await this.transport(arcgisPlan, {
          signal,
          requestKey: executionPlan.signature,
          pageIndex,
          attempt: attemptNumber,
        });
        const message = arcgisErrorMessage(response.error);
        if (message) {
          if (attempt < this.maxRetries && retryableArcgisError(response)) {
            attempt += 1;
            state.retries += 1;
            await wait(this.backoff(attempt), signal);
            continue;
          }
          throw new ArcGisQueryRuntimeError(
            message,
            'ARCGIS_SERVICE_ERROR',
            metadata.resourceUrl,
            { pageIndex },
          );
        }
        if (!Array.isArray(response.features)) {
          throw new ArcGisQueryRuntimeError(
            'ArcGIS query response does not contain a features array.',
            'INVALID_QUERY_RESPONSE',
            metadata.resourceUrl,
            { pageIndex },
          );
        }
        return response;
      } catch (error) {
        if (error instanceof ArcGisQueryRuntimeError) throw error;
        if (signal.aborted) throw signal.reason ?? error;
        if (attempt < this.maxRetries && retryableStatus(error)) {
          attempt += 1;
          state.retries += 1;
          await wait(this.backoff(attempt), signal);
          continue;
        }
        throw new ArcGisQueryRuntimeError(
          error instanceof Error ? error.message : 'ArcGIS transport failed.',
          'TRANSPORT_ERROR',
          metadata.resourceUrl,
          { cause: error, pageIndex },
        );
      }
    }
    throw new ArcGisQueryRuntimeError(
      'ArcGIS query exhausted retry budget.',
      'RETRY_EXHAUSTED',
      metadata.resourceUrl,
      { pageIndex },
    );
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
  }
}

export const createArcGisQueryRuntime = <TFeature extends ArcGisFeature = ArcGisFeature>(
  transport: ArcGisQueryTransport<TFeature>,
  options: ArcGisQueryRuntimeOptions = {},
): ArcGisQueryRuntime<TFeature> => new ArcGisQueryRuntime(transport, options);
