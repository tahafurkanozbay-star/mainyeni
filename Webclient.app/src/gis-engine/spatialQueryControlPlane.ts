import {
  QueryLifecycleCoordinator,
  QueryLifecycleError,
  type QueryLifecyclePolicy,
  type QueryLifecycleSnapshot,
  type QueryPriority,
} from './queryLifecycle';
import {
  createSpatialQueryCacheRuntime,
  normalizeSpatialQueryCacheRuntimePolicy,
  type SpatialQueryCacheRuntimePolicy,
  type SpatialQueryCacheRuntimeSnapshot,
  type SpatialQueryExecution,
} from './spatialQueryCacheRuntime';
import {
  createSpatialQueryExecutionSupervisor,
  SpatialQuerySupervisionError,
  type SpatialQueryExecutionSupervisorPolicy,
  type SpatialQueryExecutionSupervisorSnapshot,
} from './spatialQueryExecutionSupervisor';
import {
  createSpatialQueryLifecycleRuntime,
  normalizeSpatialQueryLifecycleConfig,
  type SpatialQueryLifecycleConfig,
  type SpatialQueryLifecycleRecord,
  type SpatialQueryLifecycleSnapshot,
} from './spatialQueryLifecycleRuntime';
import {
  createSpatialCacheKey,
  type SpatialCacheKeyInput,
} from './spatialResultCache';

export type SpatialQueryControlHealth = 'healthy' | 'degraded' | 'blocked';

export type SpatialQueryControlEventType =
  | 'execution-started'
  | 'execution-completed'
  | 'execution-failed'
  | 'execution-cancelled'
  | 'execution-timeout'
  | 'cache-hit'
  | 'cache-stale-hit'
  | 'shared-request'
  | 'layer-invalidated'
  | 'service-invalidated'
  | 'cache-invalidated'
  | 'disposed';

export type SpatialQueryControlErrorCode =
  | 'DISPOSED'
  | 'INVALID_REQUEST'
  | 'QUEUE_REJECTED'
  | 'SUPERVISION_REJECTED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OPERATION_FAILED';

export interface SpatialQueryControlCacheOptions {
  readonly ttlMs?: number;
  readonly allowStale?: boolean;
  readonly bypassCache?: boolean;
  readonly refresh?: boolean;
  readonly tags?: readonly string[];
}

export interface SpatialQueryControlRequest<T> {
  readonly ownerId: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly operation: string;
  readonly priority?: QueryPriority;
  readonly estimatedFeatures?: number;
  readonly estimatedBytes?: number;
  readonly estimatedCpuMs?: number;
  readonly estimatedGpuBytes?: number;
  readonly key?: Omit<SpatialCacheKeyInput, 'serviceId' | 'layerId' | 'operation'>;
  readonly cache?: SpatialQueryControlCacheOptions;
  readonly signal?: AbortSignal;
  readonly execute: (context: SpatialQueryControlExecutionContext) => Promise<T>;
}

export interface SpatialQueryControlExecutionContext {
  readonly signal: AbortSignal;
  readonly cacheKey: string;
  readonly controlId: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly ownerId: string;
}

export interface SpatialQueryControlResult<T> {
  readonly value: T;
  readonly source: SpatialQueryExecution<T>['source'];
  readonly cacheKey: string;
  readonly controlId: string;
  readonly sharedRequest: boolean;
}

export interface SpatialQueryControlEvent {
  readonly sequence: number;
  readonly type: SpatialQueryControlEventType;
  readonly at: number;
  readonly controlId: string;
  readonly ownerFingerprint: string;
  readonly serviceFingerprint: string;
  readonly layerId: number;
  readonly code: string | null;
  readonly durationMs: number | null;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
}

export interface SpatialQueryControlPlanePolicy {
  readonly queue: Partial<QueryLifecyclePolicy>;
  readonly lifecycle: Partial<SpatialQueryLifecycleConfig>;
  readonly cache: Partial<SpatialQueryCacheRuntimePolicy>;
  readonly supervision: Partial<SpatialQueryExecutionSupervisorPolicy>;
  readonly maxHistory: number;
  readonly maxOwnerIdLength: number;
  readonly maxServiceIdLength: number;
  readonly maxOperationLength: number;
  readonly maxTags: number;
  readonly maxTagLength: number;
  readonly degradedQueueRatio: number;
  readonly blockedQueueRatio: number;
  readonly degradedFailureRatio: number;
  readonly blockedFailureRatio: number;
  readonly failureWindow: number;
}

export interface SpatialQueryControlPlaneSnapshot {
  readonly disposed: boolean;
  readonly health: SpatialQueryControlHealth;
  readonly executions: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly cacheHits: number;
  readonly staleCacheHits: number;
  readonly operationResults: number;
  readonly sharedRequests: number;
  readonly layerInvalidations: number;
  readonly serviceInvalidations: number;
  readonly cacheInvalidations: number;
  readonly activeExecutions: number;
  readonly historySize: number;
  readonly queue: QueryLifecycleSnapshot;
  readonly lifecycle: SpatialQueryLifecycleSnapshot;
  readonly supervision: SpatialQueryExecutionSupervisorSnapshot;
  readonly cache: SpatialQueryCacheRuntimeSnapshot;
}

export interface SpatialQueryControlPlane {
  execute<T>(request: SpatialQueryControlRequest<T>): Promise<SpatialQueryControlResult<T>>;
  invalidateLayer(serviceId: string, layerId: number, reason?: string): Readonly<{
    aborted: number;
    cacheEntries: number;
  }>;
  invalidateService(serviceId: string, reason?: string): Readonly<{
    aborted: number;
    cacheEntries: number;
    advancedLayers: number;
  }>;
  invalidateCache(): number;
  events(limit?: number): readonly SpatialQueryControlEvent[];
  snapshot(): SpatialQueryControlPlaneSnapshot;
  dispose(reason?: string): void;
}

interface NormalizedRequest<T> {
  readonly ownerId: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly operation: string;
  readonly priority: QueryPriority;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
  readonly estimatedCpuMs: number;
  readonly estimatedGpuBytes: number;
  readonly keyInput: SpatialCacheKeyInput;
  readonly cache: SpatialQueryControlCacheOptions;
  readonly signal?: AbortSignal;
  readonly execute: (context: SpatialQueryControlExecutionContext) => Promise<T>;
}

interface ActiveExecution {
  readonly numericId: number;
  readonly controlId: string;
  readonly queueKey: string;
  readonly ownerId: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly controller: AbortController;
  readonly startedAt: number;
}

const DEFAULT_POLICY: SpatialQueryControlPlanePolicy = Object.freeze({
  queue: Object.freeze({
    maxConcurrent: 6,
    maxQueued: 128,
    timeoutMs: 30_000,
    dedupeTtlMs: 0,
    maxRecentEntries: 64,
    maxSubscribersPerQuery: 64,
    maxKeyLength: 2_048,
  }),
  lifecycle: Object.freeze({
    maxTrackedQueries: 2_048,
    maxEvents: 4_096,
    maxPagesPerQuery: 128,
    maxFeaturesPerQuery: 100_000,
    maxLifetimeMs: 120_000,
    maxExecutionMs: 60_000,
    maxTerminalAgeMs: 30_000,
    maxRequestKeyLength: 512,
    maxOwnerIdLength: 128,
    maxServiceIdLength: 256,
  }),
  cache: Object.freeze({
    cacheMaxEntries: 256,
    cacheMaxEstimatedBytes: 16 * 1024 * 1024,
    cacheDefaultTtlMs: 30_000,
    cacheMaxTtlMs: 5 * 60_000,
    coordinatePrecision: 6,
    requestConcurrency: 6,
    requestMaximumQueued: 128,
    requestMaximumCacheEntries: 1,
  }),
  supervision: Object.freeze({}),
  maxHistory: 1_024,
  maxOwnerIdLength: 128,
  maxServiceIdLength: 256,
  maxOperationLength: 128,
  maxTags: 32,
  maxTagLength: 128,
  degradedQueueRatio: 0.6,
  blockedQueueRatio: 0.9,
  degradedFailureRatio: 0.2,
  blockedFailureRatio: 0.6,
  failureWindow: 32,
});

const positiveInteger = (
  value: number,
  name: string,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

const boundedRatio = (
  value: number,
  name: string,
): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
};

const nonNegativeFinite = (
  value: number | undefined,
  name: string,
  maximum: number,
): number => {
  const normalized = value ?? 0;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > maximum) {
    throw new RangeError(`${name} must be finite, non-negative, and no greater than ${maximum}`);
  }
  return normalized;
};

const normalizeIdentifier = (
  value: string,
  name: string,
  maximumLength: number,
): string => {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new TypeError(`${name} is required`);
  if (normalized.length > maximumLength) {
    throw new RangeError(`${name} cannot exceed ${maximumLength} characters`);
  }
  return normalized;
};

const normalizeLayerId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('layerId must be a non-negative safe integer');
  }
  return value;
};

const normalizePriority = (value: QueryPriority | undefined): QueryPriority => {
  const normalized = value ?? 'foreground';
  if (
    normalized !== 'interactive'
    && normalized !== 'foreground'
    && normalized !== 'background'
  ) {
    throw new TypeError('priority is invalid');
  }
  return normalized;
};

const normalizeTags = (
  tags: readonly string[] | undefined,
  maximum: number,
  maximumLength: number,
): readonly string[] => {
  const unique = new Set<string>();
  for (const value of tags ?? []) {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    if (!normalized) continue;
    if (normalized.length > maximumLength) {
      throw new RangeError(`cache tag cannot exceed ${maximumLength} characters`);
    }
    unique.add(normalized);
    if (unique.size > maximum) {
      throw new RangeError(`cache tags cannot exceed ${maximum} unique values`);
    }
  }
  return Object.freeze([...unique].sort((left, right) => left.localeCompare(right)));
};

const freezeCacheOptions = (
  input: SpatialQueryControlCacheOptions | undefined,
  policy: SpatialQueryControlPlanePolicy,
): SpatialQueryControlCacheOptions => {
  const tags = normalizeTags(input?.tags, policy.maxTags, policy.maxTagLength);
  return Object.freeze({
    ...(input?.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input?.allowStale === undefined ? {} : { allowStale: input.allowStale }),
    ...(input?.bypassCache === undefined ? {} : { bypassCache: input.bypassCache }),
    ...(input?.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(tags.length === 0 ? {} : { tags }),
  });
};

const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
};

const fingerprint = (
  namespace: string,
  value: string,
): string => `${namespace}-${hashString(value)}`;

export const deriveSpatialLayerNumericId = (
  value: string | number,
): number => {
  if (typeof value === 'number') return normalizeLayerId(value);
  const normalized = normalizeIdentifier(value, 'layerId', 512);
  const hashed = Number.parseInt(hashString(normalized), 36);
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, hashed));
};

const mapSupervisorPriority = (
  value: QueryPriority,
): 'interactive' | 'normal' | 'background' => (
  value === 'foreground' ? 'normal' : value
);

const classifyError = (
  error: unknown,
): Readonly<{
  code: SpatialQueryControlErrorCode;
  event: Extract<
    SpatialQueryControlEventType,
    'execution-failed' | 'execution-cancelled' | 'execution-timeout'
  >;
  detail: string;
}> => {
  if (error instanceof QueryLifecycleError) {
    if (error.code === 'timeout') {
      return Object.freeze({
        code: 'TIMEOUT',
        event: 'execution-timeout',
        detail: error.code,
      });
    }
    if (error.code === 'cancelled' || error.code === 'disposed') {
      return Object.freeze({
        code: error.code === 'disposed' ? 'DISPOSED' : 'CANCELLED',
        event: 'execution-cancelled',
        detail: error.code,
      });
    }
    return Object.freeze({
      code: 'QUEUE_REJECTED',
      event: 'execution-failed',
      detail: error.code,
    });
  }

  if (error instanceof SpatialQuerySupervisionError) {
    if (error.code === 'ABORTED') {
      return Object.freeze({
        code: 'CANCELLED',
        event: 'execution-cancelled',
        detail: error.code,
      });
    }
    return Object.freeze({
      code: 'SUPERVISION_REJECTED',
      event: 'execution-failed',
      detail: error.code,
    });
  }

  if (
    error
    && typeof error === 'object'
    && String((error as Readonly<Record<string, unknown>>).name ?? '') === 'AbortError'
  ) {
    return Object.freeze({
      code: 'CANCELLED',
      event: 'execution-cancelled',
      detail: 'AbortError',
    });
  }

  return Object.freeze({
    code: 'OPERATION_FAILED',
    event: 'execution-failed',
    detail: 'operation-failed',
  });
};

export class SpatialQueryControlPlaneError extends Error {
  public constructor(
    public readonly code: SpatialQueryControlErrorCode,
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = 'SpatialQueryControlPlaneError';
  }
}

export const normalizeSpatialQueryControlPlanePolicy = (
  input: Partial<SpatialQueryControlPlanePolicy> = {},
): SpatialQueryControlPlanePolicy => {
  const queue = Object.freeze({ ...DEFAULT_POLICY.queue, ...input.queue });
  const lifecycle = normalizeSpatialQueryLifecycleConfig({
    ...DEFAULT_POLICY.lifecycle,
    ...input.lifecycle,
  });
  const cache = normalizeSpatialQueryCacheRuntimePolicy({
    ...DEFAULT_POLICY.cache,
    ...input.cache,
  });
  const maxHistory = positiveInteger(
    input.maxHistory ?? DEFAULT_POLICY.maxHistory,
    'maxHistory',
    100_000,
  );
  const maxOwnerIdLength = positiveInteger(
    input.maxOwnerIdLength ?? DEFAULT_POLICY.maxOwnerIdLength,
    'maxOwnerIdLength',
    2_048,
  );
  const maxServiceIdLength = positiveInteger(
    input.maxServiceIdLength ?? DEFAULT_POLICY.maxServiceIdLength,
    'maxServiceIdLength',
    4_096,
  );
  const maxOperationLength = positiveInteger(
    input.maxOperationLength ?? DEFAULT_POLICY.maxOperationLength,
    'maxOperationLength',
    2_048,
  );
  const maxTags = positiveInteger(
    input.maxTags ?? DEFAULT_POLICY.maxTags,
    'maxTags',
    512,
  );
  const maxTagLength = positiveInteger(
    input.maxTagLength ?? DEFAULT_POLICY.maxTagLength,
    'maxTagLength',
    2_048,
  );
  const degradedQueueRatio = boundedRatio(
    input.degradedQueueRatio ?? DEFAULT_POLICY.degradedQueueRatio,
    'degradedQueueRatio',
  );
  const blockedQueueRatio = boundedRatio(
    input.blockedQueueRatio ?? DEFAULT_POLICY.blockedQueueRatio,
    'blockedQueueRatio',
  );
  const degradedFailureRatio = boundedRatio(
    input.degradedFailureRatio ?? DEFAULT_POLICY.degradedFailureRatio,
    'degradedFailureRatio',
  );
  const blockedFailureRatio = boundedRatio(
    input.blockedFailureRatio ?? DEFAULT_POLICY.blockedFailureRatio,
    'blockedFailureRatio',
  );
  const failureWindow = positiveInteger(
    input.failureWindow ?? DEFAULT_POLICY.failureWindow,
    'failureWindow',
    maxHistory,
  );

  if (degradedQueueRatio > blockedQueueRatio) {
    throw new RangeError('degradedQueueRatio cannot exceed blockedQueueRatio');
  }
  if (degradedFailureRatio > blockedFailureRatio) {
    throw new RangeError('degradedFailureRatio cannot exceed blockedFailureRatio');
  }

  return Object.freeze({
    queue,
    lifecycle,
    cache,
    supervision: Object.freeze({
      ...DEFAULT_POLICY.supervision,
      ...input.supervision,
    }),
    maxHistory,
    maxOwnerIdLength,
    maxServiceIdLength,
    maxOperationLength,
    maxTags,
    maxTagLength,
    degradedQueueRatio,
    blockedQueueRatio,
    degradedFailureRatio,
    blockedFailureRatio,
    failureWindow,
  });
};

const normalizeRequest = <T>(
  request: SpatialQueryControlRequest<T>,
  policy: SpatialQueryControlPlanePolicy,
): NormalizedRequest<T> => {
  if (typeof request.execute !== 'function') {
    throw new TypeError('execute is required');
  }

  const ownerId = normalizeIdentifier(
    request.ownerId,
    'ownerId',
    policy.maxOwnerIdLength,
  );
  const serviceId = normalizeIdentifier(
    request.serviceId,
    'serviceId',
    policy.maxServiceIdLength,
  );
  const layerId = normalizeLayerId(request.layerId);
  const operation = normalizeIdentifier(
    request.operation,
    'operation',
    policy.maxOperationLength,
  );
  const priority = normalizePriority(request.priority);
  const estimatedFeatures = nonNegativeFinite(
    request.estimatedFeatures,
    'estimatedFeatures',
    100_000_000,
  );
  const estimatedBytes = nonNegativeFinite(
    request.estimatedBytes,
    'estimatedBytes',
    4 * 1024 * 1024 * 1024,
  );
  const estimatedCpuMs = nonNegativeFinite(
    request.estimatedCpuMs,
    'estimatedCpuMs',
    60 * 60_000,
  );
  const estimatedGpuBytes = nonNegativeFinite(
    request.estimatedGpuBytes,
    'estimatedGpuBytes',
    4 * 1024 * 1024 * 1024,
  );
  const keyInput: SpatialCacheKeyInput = Object.freeze({
    serviceId,
    layerId,
    operation,
    ...request.key,
  });
  const cache = freezeCacheOptions(request.cache, policy);

  return Object.freeze({
    ownerId,
    serviceId,
    layerId,
    operation,
    priority,
    estimatedFeatures,
    estimatedBytes,
    estimatedCpuMs,
    estimatedGpuBytes,
    keyInput,
    cache,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    execute: request.execute,
  });
};

export const createSpatialQueryControlPlane = (
  policyInput: Partial<SpatialQueryControlPlanePolicy> = {},
  now: () => number = () => Date.now(),
): SpatialQueryControlPlane => {
  const policy = normalizeSpatialQueryControlPlanePolicy(policyInput);
  const queue = new QueryLifecycleCoordinator(policy.queue, now);
  const lifecycle = createSpatialQueryLifecycleRuntime(policy.lifecycle);
  const cache = createSpatialQueryCacheRuntime(policy.cache);
  const supervisor = createSpatialQueryExecutionSupervisor(policy.supervision);
  const active = new Map<number, ActiveExecution>();
  const history: SpatialQueryControlEvent[] = [];

  let disposed = false;
  let eventSequence = 0;
  let activeSequence = 0;
  let executions = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let timedOut = 0;
  let cacheHits = 0;
  let staleCacheHits = 0;
  let operationResults = 0;
  let sharedRequests = 0;
  let layerInvalidations = 0;
  let serviceInvalidations = 0;
  let cacheInvalidations = 0;

  const recordEvent = (
    type: SpatialQueryControlEventType,
    request: Pick<
      NormalizedRequest<unknown>,
      'ownerId' | 'serviceId' | 'layerId' | 'estimatedFeatures' | 'estimatedBytes'
    >,
    controlId: string,
    input: Readonly<{
      code?: string | null;
      durationMs?: number | null;
    }> = {},
  ): void => {
    const event: SpatialQueryControlEvent = Object.freeze({
      sequence: ++eventSequence,
      type,
      at: now(),
      controlId,
      ownerFingerprint: fingerprint('owner', request.ownerId),
      serviceFingerprint: fingerprint('service', request.serviceId),
      layerId: request.layerId,
      code: input.code ?? null,
      durationMs: input.durationMs ?? null,
      estimatedFeatures: request.estimatedFeatures,
      estimatedBytes: request.estimatedBytes,
    });
    history.push(event);
    while (history.length > policy.maxHistory) history.shift();
  };

  const assertActive = (): void => {
    if (!disposed) return;
    throw new SpatialQueryControlPlaneError(
      'DISPOSED',
      'Spatial query control plane is disposed.',
    );
  };

  const registerLifecycle = (
    request: NormalizedRequest<unknown>,
    controlId: string,
  ): SpatialQueryLifecycleRecord => {
    const at = now();
    const record = lifecycle.register({
      serviceId: request.serviceId,
      layerId: request.layerId,
      ownerId: request.ownerId,
      requestKey: controlId,
      priority: mapSupervisorPriority(request.priority),
      expectedPages: 1,
      expectedFeatures: Math.floor(request.estimatedFeatures),
      expectedBytes: Math.floor(request.estimatedBytes),
      now: at,
    });
    lifecycle.admit(record.id, at);
    return lifecycle.start(record.id, at);
  };

  const execute = async <T>(
    requestInput: SpatialQueryControlRequest<T>,
  ): Promise<SpatialQueryControlResult<T>> => {
    assertActive();
    const request = normalizeRequest(requestInput, policy);
    if (request.signal?.aborted) {
      cancelled += 1;
      throw new SpatialQueryControlPlaneError(
        'CANCELLED',
        'Spatial query subscriber was already cancelled.',
        request.signal.reason,
      );
    }

    const cacheKey = createSpatialCacheKey(
      request.keyInput,
      policy.cache.coordinatePrecision,
    );
    const controlId = fingerprint('query', cacheKey);
    executions += 1;

    try {
      const execution = await queue.execute({
        key: cacheKey,
        priority: request.priority,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        execute: async (queueSignal) => {
          const startedAt = now();
          const lifecycleRecord = registerLifecycle(
            request as NormalizedRequest<unknown>,
            controlId,
          );
          const controller = new AbortController();
          const onQueueAbort = (): void => controller.abort(queueSignal.reason);
          if (queueSignal.aborted) controller.abort(queueSignal.reason);
          else queueSignal.addEventListener('abort', onQueueAbort, { once: true });

          const numericId = ++activeSequence;
          active.set(numericId, {
            numericId,
            controlId,
            queueKey: cacheKey,
            ownerId: request.ownerId,
            serviceId: request.serviceId,
            layerId: request.layerId,
            controller,
            startedAt,
          });
          recordEvent(
            'execution-started',
            request as NormalizedRequest<unknown>,
            controlId,
          );

          try {
            const tags = Object.freeze([
              `service:${request.serviceId}`,
              `layer:${request.serviceId}:${request.layerId}`,
              ...(request.cache.tags ?? []),
            ]);

            const cachedExecution = await cache.execute<T>(
              request.keyInput,
              async (cacheContext) => supervisor.run(
                {
                  owner: request.ownerId,
                  serviceId: request.serviceId,
                  layerId: request.layerId,
                  priority: mapSupervisorPriority(request.priority),
                  estimatedFeatures: request.estimatedFeatures,
                  estimatedBytes: request.estimatedBytes,
                  estimatedCpuMs: request.estimatedCpuMs,
                  estimatedGpuBytes: request.estimatedGpuBytes,
                  signal: cacheContext.signal,
                },
                async (supervisionContext) => request.execute({
                  signal: supervisionContext.signal,
                  cacheKey: cacheContext.cacheKey,
                  controlId,
                  serviceId: request.serviceId,
                  layerId: request.layerId,
                  ownerId: request.ownerId,
                }),
              ),
              {
                signal: controller.signal,
                priority: request.priority === 'interactive'
                  ? 'interactive'
                  : request.priority === 'background'
                    ? 'prefetch'
                    : 'visible',
                ...(request.cache.ttlMs === undefined
                  ? {}
                  : { ttlMs: request.cache.ttlMs }),
                estimatedBytes: request.estimatedBytes,
                tags,
                ...(request.cache.allowStale === undefined
                  ? {}
                  : { allowStale: request.cache.allowStale }),
                ...(request.cache.bypassCache === undefined
                  ? {}
                  : { bypassCache: request.cache.bypassCache }),
                ...(request.cache.refresh === undefined
                  ? {}
                  : { refresh: request.cache.refresh }),
              },
            );

            lifecycle.complete(lifecycleRecord.id, now());
            const durationMs = Math.max(0, now() - startedAt);

            if (cachedExecution.source === 'cache') {
              cacheHits += 1;
              recordEvent(
                'cache-hit',
                request as NormalizedRequest<unknown>,
                controlId,
                { durationMs },
              );
            } else if (cachedExecution.source === 'stale-cache') {
              staleCacheHits += 1;
              recordEvent(
                'cache-stale-hit',
                request as NormalizedRequest<unknown>,
                controlId,
                { durationMs },
              );
            } else {
              operationResults += 1;
            }
            if (cachedExecution.sharedRequest) {
              sharedRequests += 1;
              recordEvent(
                'shared-request',
                request as NormalizedRequest<unknown>,
                controlId,
                { durationMs },
              );
            }

            recordEvent(
              'execution-completed',
              request as NormalizedRequest<unknown>,
              controlId,
              { durationMs },
            );

            return Object.freeze({
              value: cachedExecution.value,
              source: cachedExecution.source,
              cacheKey: cachedExecution.cacheKey,
              controlId,
              sharedRequest: cachedExecution.sharedRequest,
            });
          } catch (error) {
            const classified = classifyError(error);
            const at = now();
            const current = lifecycle.get(lifecycleRecord.id);
            if (current && (
              current.phase === 'registered'
              || current.phase === 'admitted'
              || current.phase === 'executing'
            )) {
              if (
                classified.code === 'CANCELLED'
                || classified.code === 'TIMEOUT'
                || classified.code === 'DISPOSED'
              ) {
                lifecycle.cancel(lifecycleRecord.id, at);
              } else {
                lifecycle.fail(lifecycleRecord.id, at);
              }
            }

            if (classified.code === 'CANCELLED' || classified.code === 'DISPOSED') {
              cancelled += 1;
            } else if (classified.code === 'TIMEOUT') {
              timedOut += 1;
            } else {
              failed += 1;
            }

            recordEvent(
              classified.event,
              request as NormalizedRequest<unknown>,
              controlId,
              {
                code: classified.detail,
                durationMs: Math.max(0, at - startedAt),
              },
            );
            throw error;
          } finally {
            queueSignal.removeEventListener('abort', onQueueAbort);
            active.delete(numericId);
          }
        },
      });

      completed += 1;
      return execution;
    } catch (error) {
      if (
        error instanceof QueryLifecycleError
        && (error.code === 'queue-full' || error.code === 'subscriber-limit')
      ) {
        failed += 1;
      }
      const classified = classifyError(error);
      throw new SpatialQueryControlPlaneError(
        classified.code,
        `Spatial query execution failed (${classified.detail}).`,
        error,
      );
    }
  };

  const abortMatching = (
    predicate: (entry: ActiveExecution) => boolean,
    reason: SpatialQueryControlPlaneError,
  ): number => {
    let aborted = 0;
    for (const entry of active.values()) {
      if (!predicate(entry) || entry.controller.signal.aborted) continue;
      entry.controller.abort(reason);
      queue.cancel(entry.queueKey, reason.message);
      aborted += 1;
    }
    return aborted;
  };

  const invalidateLayer = (
    serviceIdInput: string,
    layerIdInput: number,
    reason = 'layer-invalidated',
  ): Readonly<{ aborted: number; cacheEntries: number }> => {
    assertActive();
    const serviceId = normalizeIdentifier(
      serviceIdInput,
      'serviceId',
      policy.maxServiceIdLength,
    );
    const layerId = normalizeLayerId(layerIdInput);
    const error = new SpatialQueryControlPlaneError(
      'CANCELLED',
      `Spatial query layer invalidated (${reason}).`,
    );
    const aborted = abortMatching(
      (entry) => entry.serviceId === serviceId && entry.layerId === layerId,
      error,
    );
    supervisor.advanceLayer(serviceId, layerId);
    const cacheEntries = cache.invalidateTag(`layer:${serviceId}:${layerId}`);
    cacheInvalidations += cacheEntries;
    layerInvalidations += 1;
    const eventRequest = {
      ownerId: 'system',
      serviceId,
      layerId,
      estimatedFeatures: 0,
      estimatedBytes: 0,
    };
    recordEvent(
      'layer-invalidated',
      eventRequest,
      fingerprint('query', `${serviceId}|${layerId}|${reason}`),
      { code: reason },
    );
    return Object.freeze({ aborted, cacheEntries });
  };

  const invalidateService = (
    serviceIdInput: string,
    reason = 'service-invalidated',
  ): Readonly<{
    aborted: number;
    cacheEntries: number;
    advancedLayers: number;
  }> => {
    assertActive();
    const serviceId = normalizeIdentifier(
      serviceIdInput,
      'serviceId',
      policy.maxServiceIdLength,
    );
    const error = new SpatialQueryControlPlaneError(
      'CANCELLED',
      `Spatial query service invalidated (${reason}).`,
    );
    const layers = new Set<number>();
    for (const entry of active.values()) {
      if (entry.serviceId === serviceId) layers.add(entry.layerId);
    }
    const aborted = abortMatching(
      (entry) => entry.serviceId === serviceId,
      error,
    );
    for (const layerId of layers) supervisor.advanceLayer(serviceId, layerId);
    const cacheEntries = cache.invalidateTag(`service:${serviceId}`);
    cacheInvalidations += cacheEntries;
    serviceInvalidations += 1;
    const eventRequest = {
      ownerId: 'system',
      serviceId,
      layerId: 0,
      estimatedFeatures: 0,
      estimatedBytes: 0,
    };
    recordEvent(
      'service-invalidated',
      eventRequest,
      fingerprint('query', `${serviceId}|${reason}`),
      { code: reason },
    );
    return Object.freeze({
      aborted,
      cacheEntries,
      advancedLayers: layers.size,
    });
  };

  const invalidateCache = (): number => {
    assertActive();
    const removed = cache.invalidate();
    queue.invalidate();
    cacheInvalidations += removed;
    const eventRequest = {
      ownerId: 'system',
      serviceId: 'all-services',
      layerId: 0,
      estimatedFeatures: 0,
      estimatedBytes: 0,
    };
    recordEvent(
      'cache-invalidated',
      eventRequest,
      fingerprint('query', `global|${eventSequence}`),
      { code: 'global' },
    );
    return removed;
  };

  const events = (limitInput = policy.maxHistory): readonly SpatialQueryControlEvent[] => {
    const limit = positiveInteger(
      Math.min(limitInput, policy.maxHistory),
      'limit',
      policy.maxHistory,
    );
    return Object.freeze(history.slice(Math.max(0, history.length - limit)));
  };

  const health = (
    queueSnapshot: QueryLifecycleSnapshot,
  ): SpatialQueryControlHealth => {
    if (disposed) return 'blocked';

    const queueCapacity = Math.max(1, queue.policy.maxQueued);
    const queueRatio = queueSnapshot.queued / queueCapacity;
    const terminalEvents = history
      .filter((event) => (
        event.type === 'execution-completed'
        || event.type === 'execution-failed'
        || event.type === 'execution-cancelled'
        || event.type === 'execution-timeout'
      ))
      .slice(-policy.failureWindow);
    const failures = terminalEvents.filter((event) => (
      event.type === 'execution-failed'
      || event.type === 'execution-timeout'
    )).length;
    const failureRatio = terminalEvents.length === 0
      ? 0
      : failures / terminalEvents.length;

    if (
      queueRatio >= policy.blockedQueueRatio
      || (
        terminalEvents.length >= Math.min(5, policy.failureWindow)
        && failureRatio >= policy.blockedFailureRatio
      )
    ) {
      return 'blocked';
    }

    if (
      queueRatio >= policy.degradedQueueRatio
      || (
        terminalEvents.length >= Math.min(5, policy.failureWindow)
        && failureRatio >= policy.degradedFailureRatio
      )
    ) {
      return 'degraded';
    }

    return 'healthy';
  };

  const snapshot = (): SpatialQueryControlPlaneSnapshot => {
    const queueSnapshot = queue.snapshot();
    return Object.freeze({
      disposed,
      health: health(queueSnapshot),
      executions,
      completed,
      failed,
      cancelled,
      timedOut,
      cacheHits,
      staleCacheHits,
      operationResults,
      sharedRequests,
      layerInvalidations,
      serviceInvalidations,
      cacheInvalidations,
      activeExecutions: active.size,
      historySize: history.length,
      queue: queueSnapshot,
      lifecycle: lifecycle.snapshot(),
      supervision: supervisor.snapshot(),
      cache: cache.snapshot(),
    });
  };

  const dispose = (reason = 'control-plane-disposed'): void => {
    if (disposed) return;
    disposed = true;
    const error = new SpatialQueryControlPlaneError(
      'DISPOSED',
      `Spatial query control plane disposed (${reason}).`,
    );
    for (const entry of active.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(error);
    }
    queue.dispose(error.message);
    cache.dispose();
    supervisor.dispose();
    lifecycle.dispose();
    active.clear();
    const eventRequest = {
      ownerId: 'system',
      serviceId: 'control-plane',
      layerId: 0,
      estimatedFeatures: 0,
      estimatedBytes: 0,
    };
    recordEvent(
      'disposed',
      eventRequest,
      fingerprint('query', reason),
      { code: reason },
    );
  };

  return Object.freeze({
    execute,
    invalidateLayer,
    invalidateService,
    invalidateCache,
    events,
    snapshot,
    dispose,
  });
};
