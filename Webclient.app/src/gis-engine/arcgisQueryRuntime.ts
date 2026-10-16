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
  ArcGisFeatureSnapshotError,
  ArcGisFeatureSnapshotSession,
  readArcGisOwnDataProperty,
  type ArcGisFeatureSnapshotBudget,
  type ArcGisFeatureSnapshotPage,
} from './arcgisFeatureSnapshot';
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
  readonly featureSnapshotBudget?: Partial<ArcGisFeatureSnapshotBudget>;
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
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const abort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  timer = setTimeout(finish, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const ownDataValue = (value: unknown, key: string): unknown => {
  try {
    if (!isRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const arcgisErrorMessage = (value: unknown): string | null => {
  try {
    if (!isRecord(value)) return null;
    const rawMessage = ownDataValue(value, 'message');
    const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, 2048) : '';
    const rawDetails = ownDataValue(value, 'details');
    const details = Array.isArray(rawDetails)
      ? rawDetails.filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
        .map((entry) => entry.slice(0, 1024)).join(' ')
      : '';
    return [message, details].filter(Boolean).join(' ') || 'ArcGIS service returned an error object.';
  } catch {
    return 'ArcGIS service returned an invalid error object.';
  }
};

const arcgisErrorCode = (value: unknown): number | null => {
  try {
    if (!isRecord(value)) return null;
    const rawCode = ownDataValue(value, 'code');
    const code = typeof rawCode === 'number' || typeof rawCode === 'string' ? Number(rawCode) : Number.NaN;
    return Number.isSafeInteger(code) ? code : null;
  } catch {
    return null;
  }
};

const retryableStatus = (value: unknown): boolean => {
  const status = isRecord(value) ? Number(value.status ?? value.code) : Number.NaN;
  return status === 408 || status === 429 || status >= 500;
};

const retryableArcgisError = (error: unknown): boolean => {
  const code = arcgisErrorCode(error);
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
): TFeature => Object.freeze({ ...feature, geometry }) as TFeature;

const validateFeatureGeometry = <TFeature extends ArcGisFeature>(
  features: readonly TFeature[],
  geometryBudget: GeometryBudget,
  strict: boolean,
  state: RuntimeState,
  resourceUrl: string,
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
        resourceUrl,
      );
    }
    state.droppedInvalidGeometryCount += 1;
    output.push(cloneFeatureWithGeometry(feature, null));
  }
  return Object.freeze(output);
};

const mergeSignals = (
  external: AbortSignal | undefined,
  internal: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  if (!external) return { signal: internal, dispose: () => undefined };
  if (external.aborted) {
    const controller = new AbortController();
    controller.abort(external.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([external, internal]), dispose: () => undefined };
  }
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(external.reason);
  const abortFromInternal = () => controller.abort(internal.reason);
  external.addEventListener('abort', abortFromExternal, { once: true });
  internal.addEventListener('abort', abortFromInternal, { once: true });
  if (external.aborted) abortFromExternal();
  if (internal.aborted) abortFromInternal();
  return {
    signal: controller.signal,
    dispose: () => {
      external.removeEventListener('abort', abortFromExternal);
      internal.removeEventListener('abort', abortFromInternal);
    },
  };
};

export class ArcGisQueryRuntime<TFeature extends ArcGisFeature = ArcGisFeature> {
  private readonly coordinator: RequestCoordinator;
  private readonly ownsCoordinator: boolean;
  private readonly queryLimits: QueryExecutionLimits;
  private readonly geometryBudget: GeometryBudget;
  private readonly featureSnapshotBudget: Partial<ArcGisFeatureSnapshotBudget>;
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
    this.featureSnapshotBudget = Object.freeze({ ...(options.featureSnapshotBudget ?? {}) });
    new ArcGisFeatureSnapshotSession(this.featureSnapshotBudget);
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
    const namespace = options.namespace ?? metadata.resourceUrl;

    const result = await this.coordinator.run(
      key,
      async ({ signal: internalSignal }) => {
        const merged = mergeSignals(options.signal, internalSignal);
        try {
          return await this.executePlan(metadata, executionPlan, merged.signal, options);
        } finally {
          merged.dispose();
        }
      },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        priority: options.priority ?? (options.purpose === 'analysis' ? 'background' : 'interactive'),
        cache: cacheEligible,
        ttlMs: options.cacheTtlMs ?? this.cacheTtlMs,
        namespace,
        cacheWhen: (value: unknown) => isRecord(value) && isRecord(value.diagnostics) &&
          value.diagnostics.complete === true && value.diagnostics.truncated === false,
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
        cacheEligible: cacheEligible && result.diagnostics.complete && !result.diagnostics.truncated,
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
    const snapshotSession = new ArcGisFeatureSnapshotSession({
      ...this.featureSnapshotBudget,
      maxFeatures: Math.min(this.featureSnapshotBudget.maxFeatures ?? 100_000, executionPlan.maxFeatures),
      maxPages: Math.min(this.featureSnapshotBudget.maxPages ?? 10_000, executionPlan.maxPages),
    });

    if (executionPlan.strategy !== 'offset-pagination') {
      const response = await this.fetchPage(metadata, executionPlan, 0, signal, state);
      const pageSnapshot = this.captureFeatures(snapshotSession, response.features, executionPlan.maxFeatures, true, metadata.resourceUrl, 0);
      const rawFeatures = pageSnapshot.features;
      const features = validateGeometry
        ? validateFeatureGeometry(rawFeatures, this.geometryBudget, strictGeometry, state, metadata.resourceUrl)
        : rawFeatures;
      const truncated = response.exceededTransferLimit === true || pageSnapshot.truncated ||
        features.length >= executionPlan.maxFeatures;
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
        const pageSnapshot = this.captureFeatures(snapshotSession, response.features, limit, false, metadata.resourceUrl, pageIndex);
        const rawFeatures = pageSnapshot.features;
        const features = validateGeometry
          ? validateFeatureGeometry(rawFeatures, this.geometryBudget, strictGeometry, state, metadata.resourceUrl)
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
        let responseError: unknown;
        let responseFeatures: unknown;
        let transferLimit: unknown;
        try {
          responseError = readArcGisOwnDataProperty(response, 'error').value;
          const featureField = readArcGisOwnDataProperty(response, 'features');
          if (!featureField.found || !Array.isArray(featureField.value)) {
            throw new ArcGisFeatureSnapshotError('INVALID_FEATURES', 'ArcGIS response features must be an array.');
          }
          responseFeatures = featureField.value;
          const transferField = readArcGisOwnDataProperty(response, 'exceededTransferLimit');
          transferLimit = transferField.value;
          if (transferField.found && typeof transferLimit !== 'boolean') {
            throw new ArcGisFeatureSnapshotError('INVALID_TRANSFER_LIMIT', 'ArcGIS transfer-limit flag must be boolean.');
          }
        } catch {
          throw new ArcGisQueryRuntimeError(
            'ArcGIS query response contains invalid or unsafe properties.',
            'INVALID_QUERY_RESPONSE',
            metadata.resourceUrl,
            { pageIndex },
          );
        }
        const message = arcgisErrorMessage(responseError);
        if (message) {
          if (attempt < this.maxRetries && retryableArcgisError(responseError)) {
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
        return Object.freeze({
          features: responseFeatures as readonly TFeature[],
          exceededTransferLimit: transferLimit === true,
        });
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

  private captureFeatures(
    session: ArcGisFeatureSnapshotSession,
    input: unknown,
    maxPageFeatures: number,
    truncateExcess: boolean,
    resourceUrl: string,
    pageIndex: number,
  ): ArcGisFeatureSnapshotPage<TFeature> {
    try {
      return session.capturePage<TFeature>(input, maxPageFeatures, truncateExcess);
    } catch (error) {
      const code = error instanceof ArcGisFeatureSnapshotError ? error.code : 'UNSAFE_OBJECT';
      throw new ArcGisQueryRuntimeError(
        'ArcGIS query response failed bounded feature validation.',
        code,
        resourceUrl,
        { pageIndex },
      );
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
  }
}

export const createArcGisQueryRuntime = <TFeature extends ArcGisFeature = ArcGisFeature>(
  transport: ArcGisQueryTransport<TFeature>,
  options: ArcGisQueryRuntimeOptions = {},
): ArcGisQueryRuntime<TFeature> => new ArcGisQueryRuntime(transport, options);
