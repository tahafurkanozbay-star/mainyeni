import {
  DEFAULT_QUERY_CLOCK,
  DEFAULT_QUERY_POLICY,
  BusinessAbortError,
  BusinessContractError,
  BusinessTimeoutError,
  ServiceNotFoundError,
  type ArcGisQueryOptions,
  type BusinessCacheEntry,
  type BusinessDiagnostic,
  type BusinessRuntimeDependencies,
  type BusinessRuntimeSnapshot,
  type FastAccessQuery,
  type QueryBusiness,
  type QueryExecutionControl,
  type QueryPolicy,
  type QueryRuntimeClock,
  errorCode,
  isAbortError,
  queryFeatureCount,
  serviceUrl,
  throwIfAborted,
} from './contracts';
import {
  compileFastAccessQuery,
  createQueryPolicy,
  normalizeCacheTtlMs,
  normalizeTimeoutMs,
  queryIsLocationBound,
  validateServiceUrl,
} from './queryPolicy';

interface RuntimeCounters {
  active: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  cacheHits: number;
  deduplicated: number;
}

interface PendingTask<TValue> {
  readonly id: string;
  readonly key: string;
  readonly serviceKey: string;
  readonly operation: string;
  readonly createdAt: number;
  readonly execute: () => Promise<TValue>;
  readonly resolve: (value: TValue | PromiseLike<TValue>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  started: boolean;
  cancelled: boolean;
  cleanup?: () => void;
}

interface InflightEntry<TValue> {
  readonly key: string;
  readonly promise: Promise<TValue>;
  readonly createdAt: number;
  readonly serviceKey: string;
}

export interface BusinessQueryRuntime {
  readonly query: (
    serviceKey: string,
    query?: FastAccessQuery,
    returnGeometry?: boolean,
    control?: QueryExecutionControl,
  ) => Promise<unknown>;
  readonly createBusiness: (serviceKey: string) => QueryBusiness;
  readonly clearCache: (serviceKey?: string) => number;
  readonly cancelQueued: (predicate?: (serviceKey: string) => boolean) => number;
  readonly snapshot: () => BusinessRuntimeSnapshot;
  readonly dispose: () => void;
}

export interface BusinessQueryRuntimeOptions {
  readonly policy?: Partial<QueryPolicy>;
}

const safePositiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(numeric)));
};

const makeAbortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) return signal.reason;
  return new BusinessAbortError();
};

const createRequestIdFactory = (): (() => string) => {
  let sequence = 0;
  return () => {
    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    return `business-${Date.now().toString(36)}-${sequence.toString(36)}`;
  };
};

const freezeDiagnostic = (diagnostic: BusinessDiagnostic): BusinessDiagnostic => Object.freeze({ ...diagnostic });

const boundedPush = <TValue>(target: TValue[], value: TValue, maximum: number): void => {
  target.push(value);
  if (target.length > maximum) target.splice(0, target.length - maximum);
};

const createCacheKey = (serviceKey: string, fingerprint: string): string => `${serviceKey}:${fingerprint}`;

const isExpired = (entry: BusinessCacheEntry<unknown>, now: number): boolean => entry.expiresAt <= now;

const cloneSnapshot = (
  startedAt: number,
  counters: RuntimeCounters,
  diagnostics: readonly BusinessDiagnostic[],
): BusinessRuntimeSnapshot => Object.freeze({
  startedAt,
  active: counters.active,
  queued: counters.queued,
  completed: counters.completed,
  failed: counters.failed,
  cancelled: counters.cancelled,
  timedOut: counters.timedOut,
  cacheHits: counters.cacheHits,
  deduplicated: counters.deduplicated,
  diagnostics: Object.freeze([...diagnostics]),
});

const normalizeDependencies = (dependencies: BusinessRuntimeDependencies) => {
  const clock: QueryRuntimeClock = dependencies.clock ?? DEFAULT_QUERY_CLOCK;
  return Object.freeze({
    resolver: dependencies.resolveService,
    executor: dependencies.executor,
    clock,
    maxDiagnostics: safePositiveInteger(dependencies.maxDiagnostics, 100, 1000),
    maxCacheEntries: safePositiveInteger(dependencies.maxCacheEntries, 100, 2000),
    maxConcurrent: safePositiveInteger(dependencies.maxConcurrent, 6, 32),
  });
};

const resolveServiceUrl = (
  serviceKey: string,
  resolver: BusinessRuntimeDependencies['resolveService'],
): string => {
  const service = resolver.find(serviceKey);
  if (!service) throw new ServiceNotFoundError(serviceKey);
  const raw = resolver.resolveUrl(service) ?? serviceUrl(service);
  const url = validateServiceUrl(raw);
  if (!url) throw new BusinessContractError('SERVICE_URL_INVALID', `Servis adresi geçersiz (${serviceKey})`, false);
  return url;
};

const createQueryOptions = (
  url: string,
  compiled: ReturnType<typeof compileFastAccessQuery>,
  returnGeometry: boolean,
): ArcGisQueryOptions => {
  const common: ArcGisQueryOptions = {
    url,
    where: compiled.where,
    returnGeometry,
    orderByFields: Object.freeze(['adi']),
    outFields: Object.freeze(['*']),
  };
  if (!compiled.spatial) return common;
  return {
    ...common,
    geometry: compiled.geometry,
    distance: compiled.distance,
    units: compiled.units,
    spatialRelationship: compiled.spatialRelationship,
  };
};

export const createBusinessQueryRuntime = (
  dependencies: BusinessRuntimeDependencies,
  options: BusinessQueryRuntimeOptions = {},
): BusinessQueryRuntime => {
  const normalized = normalizeDependencies(dependencies);
  const policy = createQueryPolicy(options.policy ?? DEFAULT_QUERY_POLICY);
  const startedAt = normalized.clock.now();
  const diagnostics: BusinessDiagnostic[] = [];
  const cache = new Map<string, BusinessCacheEntry<unknown>>();
  const inflight = new Map<string, InflightEntry<unknown>>();
  const queue: PendingTask<unknown>[] = [];
  const nextId = createRequestIdFactory();
  let disposed = false;
  const counters: RuntimeCounters = {
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    cacheHits: 0,
    deduplicated: 0,
  };

  const remember = (
    id: string,
    operation: string,
    status: BusinessDiagnostic['status'],
    started: number,
    extras: Partial<Omit<BusinessDiagnostic, 'id' | 'operation' | 'status' | 'startedAt' | 'completedAt' | 'durationMs'>> = {},
  ): void => {
    const completedAt = normalized.clock.now();
    const value: BusinessDiagnostic = {
      id,
      operation,
      status,
      startedAt: started,
      completedAt,
      durationMs: Math.max(0, completedAt - started),
      ...extras,
    };
    boundedPush(diagnostics, freezeDiagnostic(value), normalized.maxDiagnostics);
  };

  const pruneCache = (): void => {
    const now = normalized.clock.now();
    for (const [key, entry] of cache.entries()) {
      if (isExpired(entry, now)) cache.delete(key);
    }
    while (cache.size > normalized.maxCacheEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const readCache = (key: string): unknown | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    const now = normalized.clock.now();
    if (isExpired(entry, now)) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  };

  const writeCache = (key: string, serviceKey: string, value: unknown, ttlMs: number): void => {
    if (ttlMs <= 0) return;
    const now = normalized.clock.now();
    cache.delete(key);
    cache.set(key, Object.freeze({
      key,
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      serviceKey,
    }));
    pruneCache();
  };

  const pump = (): void => {
    if (disposed) return;
    while (counters.active < normalized.maxConcurrent && queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      counters.queued = Math.max(0, counters.queued - 1);
      task.cleanup?.();
      task.cleanup = undefined;

      if (task.cancelled || task.signal?.aborted) {
        counters.cancelled += 1;
        task.reject(makeAbortError(task.signal));
        remember(task.id, task.operation, 'cancelled', task.createdAt, { serviceKey: task.serviceKey });
        continue;
      }

      task.started = true;
      counters.active += 1;
      void task.execute()
        .then(task.resolve, task.reject)
        .finally(() => {
          counters.active = Math.max(0, counters.active - 1);
          pump();
        });
    }
  };

  const schedule = <TValue>(
    serviceKey: string,
    operation: string,
    signal: AbortSignal | undefined,
    execute: () => Promise<TValue>,
  ): Promise<TValue> => {
    if (disposed) return Promise.reject(new BusinessContractError('RUNTIME_DISPOSED', 'Business runtime kapatıldı.'));
    throwIfAborted(signal);

    const id = nextId();
    const createdAt = normalized.clock.now();
    return new Promise<TValue>((resolve, reject) => {
      const task: PendingTask<TValue> = {
        id,
        key: id,
        serviceKey,
        operation,
        createdAt,
        execute,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        started: false,
        cancelled: false,
      };

      if (signal) {
        const onAbort = (): void => {
          if (task.started || task.cancelled) return;
          task.cancelled = true;
          const index = queue.indexOf(task as PendingTask<unknown>);
          if (index >= 0) {
            queue.splice(index, 1);
            counters.queued = Math.max(0, counters.queued - 1);
          }
          task.cleanup?.();
          counters.cancelled += 1;
          reject(makeAbortError(signal));
          remember(id, operation, 'cancelled', createdAt, { serviceKey });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        task.cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      queue.push(task as PendingTask<unknown>);
      counters.queued += 1;
      pump();
    });
  };

  const withDeadline = async <TValue>(
    operation: () => Promise<TValue>,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<TValue> => {
    throwIfAborted(parentSignal);
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(parentSignal?.reason ?? new BusinessAbortError());
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = normalized.clock.setTimeout(() => {
        const error = new BusinessTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer !== null) normalized.clock.clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  };

  const query = async (
    serviceKey: string,
    queryInput: FastAccessQuery = {},
    returnGeometry = false,
    control: QueryExecutionControl = {},
  ): Promise<unknown> => {
    if (disposed) throw new BusinessContractError('RUNTIME_DISPOSED', 'Business runtime kapatıldı.');
    throwIfAborted(control.signal);

    const url = resolveServiceUrl(serviceKey, normalized.resolver);
    const compiled = compileFastAccessQuery(serviceKey, queryInput, returnGeometry, policy);
    const requestKey = control.requestKey ?? createCacheKey(serviceKey, compiled.fingerprint);
    const useCache = control.cache !== false && !queryIsLocationBound(queryInput);
    const deduplicate = control.deduplicate !== false;
    const ttlMs = normalizeCacheTtlMs(control.cacheTtlMs, policy);
    const timeoutMs = normalizeTimeoutMs(control.timeoutMs, policy);
    const operation = compiled.spatial ? 'fast-access-spatial-query' : 'fast-access-query';
    const diagnosticId = nextId();
    const diagnosticStarted = normalized.clock.now();

    if (useCache) {
      const cached = readCache(requestKey);
      if (cached !== undefined) {
        counters.cacheHits += 1;
        remember(diagnosticId, operation, 'cache-hit', diagnosticStarted, {
          serviceKey,
          cacheKey: requestKey,
          featureCount: queryFeatureCount(cached),
        });
        return cached;
      }
    }

    if (deduplicate) {
      const current = inflight.get(requestKey);
      if (current) {
        counters.deduplicated += 1;
        remember(diagnosticId, operation, 'deduplicated', diagnosticStarted, {
          serviceKey,
          cacheKey: requestKey,
        });
        return current.promise;
      }
    }

    const optionsForArcGis = createQueryOptions(url, compiled, returnGeometry);
    const execute = (): Promise<unknown> => schedule(
      serviceKey,
      operation,
      control.signal,
      async () => withDeadline(
        () => compiled.spatial
          ? normalized.executor.executeSpatial(optionsForArcGis, control)
          : normalized.executor.execute(optionsForArcGis, control),
        timeoutMs,
        control.signal,
      ),
    );

    const promise = execute()
      .then((value) => {
        counters.completed += 1;
        if (useCache) writeCache(requestKey, serviceKey, value, ttlMs);
        remember(diagnosticId, operation, 'success', diagnosticStarted, {
          serviceKey,
          cacheKey: requestKey,
          featureCount: queryFeatureCount(value),
        });
        return value;
      })
      .catch((error: unknown) => {
        if (error instanceof BusinessTimeoutError) {
          counters.timedOut += 1;
          remember(diagnosticId, operation, 'timeout', diagnosticStarted, {
            serviceKey,
            cacheKey: requestKey,
            code: error.code,
          });
        } else if (isAbortError(error)) {
          counters.cancelled += 1;
          remember(diagnosticId, operation, 'cancelled', diagnosticStarted, {
            serviceKey,
            cacheKey: requestKey,
            code: errorCode(error),
          });
        } else {
          counters.failed += 1;
          remember(diagnosticId, operation, 'failure', diagnosticStarted, {
            serviceKey,
            cacheKey: requestKey,
            code: errorCode(error),
          });
        }
        throw error;
      })
      .finally(() => {
        const current = inflight.get(requestKey);
        if (current?.promise === promise) inflight.delete(requestKey);
      });

    if (deduplicate) {
      inflight.set(requestKey, Object.freeze({
        key: requestKey,
        promise,
        createdAt: normalized.clock.now(),
        serviceKey,
      }));
    }

    return promise;
  };

  const createBusiness = (serviceKey: string): QueryBusiness => Object.freeze({
    Query: (
      queryInput: FastAccessQuery = {},
      returnGeometry = false,
      control: QueryExecutionControl = {},
    ) => query(serviceKey, queryInput, returnGeometry, control),
  });

  const clearCache = (serviceKey?: string): number => {
    if (!serviceKey) {
      const removed = cache.size;
      cache.clear();
      return removed;
    }
    let removed = 0;
    for (const [key, entry] of cache.entries()) {
      if (entry.serviceKey !== serviceKey) continue;
      cache.delete(key);
      removed += 1;
    }
    return removed;
  };

  const cancelQueued = (predicate: (serviceKey: string) => boolean = () => true): number => {
    let cancelled = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const task = queue[index];
      if (!task || !predicate(task.serviceKey)) continue;
      queue.splice(index, 1);
      task.cancelled = true;
      task.cleanup?.();
      counters.queued = Math.max(0, counters.queued - 1);
      counters.cancelled += 1;
      cancelled += 1;
      task.reject(new BusinessAbortError('Kuyruktaki işlem iptal edildi.'));
      remember(task.id, task.operation, 'cancelled', task.createdAt, { serviceKey: task.serviceKey });
    }
    return cancelled;
  };

  const snapshot = (): BusinessRuntimeSnapshot => cloneSnapshot(startedAt, counters, diagnostics);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelQueued();
    cache.clear();
    inflight.clear();
  };

  return Object.freeze({ query, createBusiness, clearCache, cancelQueued, snapshot, dispose });
};
