import { createSpatialCacheKey, SpatialResultCache, type SpatialCacheKeyInput, type SpatialCacheLookup } from './spatialResultCache';
import { createSpatialRequestCoordinator, type SpatialRequestContext, type SpatialRequestPriority } from './spatialRequestCoordinator';

export interface SpatialQueryCacheRuntimePolicy {
  readonly cacheMaxEntries: number;
  readonly cacheMaxEstimatedBytes: number;
  readonly cacheDefaultTtlMs: number;
  readonly cacheMaxTtlMs: number;
  readonly coordinatePrecision: number;
  readonly requestConcurrency: number;
  readonly requestMaximumQueued: number;
  readonly requestMaximumCacheEntries: number;
}

export interface SpatialQueryExecutionOptions {
  readonly signal?: AbortSignal;
  readonly priority?: SpatialRequestPriority;
  readonly ttlMs?: number;
  readonly estimatedBytes?: number;
  readonly tags?: readonly string[];
  readonly allowStale?: boolean;
  readonly bypassCache?: boolean;
  readonly refresh?: boolean;
}

export interface SpatialQueryExecutionContext extends SpatialRequestContext {
  readonly cacheKey: string;
}

export interface SpatialQueryExecution<T> {
  readonly value: T;
  readonly source: 'cache' | 'stale-cache' | 'operation';
  readonly cacheKey: string;
  readonly sharedRequest: boolean;
}

export interface SpatialQueryCacheRuntimeSnapshot {
  readonly disposed: boolean;
  readonly executions: number;
  readonly cacheServed: number;
  readonly staleServed: number;
  readonly operationServed: number;
  readonly refreshes: number;
  readonly bypasses: number;
  readonly invalidations: number;
  readonly cache: ReturnType<SpatialResultCache<unknown>['snapshot']>;
  readonly requests: ReturnType<ReturnType<typeof createSpatialRequestCoordinator>['snapshots']>;
}

const DEFAULT_POLICY: SpatialQueryCacheRuntimePolicy = {
  cacheMaxEntries: 256,
  cacheMaxEstimatedBytes: 16 * 1024 * 1024,
  cacheDefaultTtlMs: 30_000,
  cacheMaxTtlMs: 5 * 60_000,
  coordinatePrecision: 6,
  requestConcurrency: 6,
  requestMaximumQueued: 128,
  requestMaximumCacheEntries: 1,
};

const positiveInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

export const normalizeSpatialQueryCacheRuntimePolicy = (
  policy: Partial<SpatialQueryCacheRuntimePolicy> = {},
): SpatialQueryCacheRuntimePolicy => {
  const normalized = { ...DEFAULT_POLICY, ...policy };
  positiveInteger(normalized.cacheMaxEntries, 'cacheMaxEntries', 100_000);
  positiveInteger(normalized.cacheMaxEstimatedBytes, 'cacheMaxEstimatedBytes', 512 * 1024 * 1024);
  positiveInteger(normalized.cacheDefaultTtlMs, 'cacheDefaultTtlMs', 60 * 60_000);
  positiveInteger(normalized.cacheMaxTtlMs, 'cacheMaxTtlMs', 60 * 60_000);
  if (normalized.cacheDefaultTtlMs > normalized.cacheMaxTtlMs) {
    throw new RangeError('cacheDefaultTtlMs cannot exceed cacheMaxTtlMs');
  }
  if (!Number.isSafeInteger(normalized.coordinatePrecision) || normalized.coordinatePrecision < 0 || normalized.coordinatePrecision > 10) {
    throw new RangeError('coordinatePrecision must be an integer between 0 and 10');
  }
  positiveInteger(normalized.requestConcurrency, 'requestConcurrency', 64);
  positiveInteger(normalized.requestMaximumQueued, 'requestMaximumQueued', 4096);
  positiveInteger(normalized.requestMaximumCacheEntries, 'requestMaximumCacheEntries', 2048);
  return Object.freeze(normalized);
};

const abortError = (reason: unknown): Error => {
  const error = new Error(String(reason ?? 'Spatial query cancelled'));
  error.name = 'AbortError';
  return error;
};

const executionResult = <T>(
  value: T,
  source: SpatialQueryExecution<T>['source'],
  cacheKey: string,
  sharedRequest: boolean,
): SpatialQueryExecution<T> => Object.freeze({ value, source, cacheKey, sharedRequest });

export const createSpatialQueryCacheRuntime = (
  policyInput: Partial<SpatialQueryCacheRuntimePolicy> = {},
): Readonly<{
  execute<T>(keyInput: SpatialCacheKeyInput, operation: (context: SpatialQueryExecutionContext) => Promise<T>, options?: SpatialQueryExecutionOptions): Promise<SpatialQueryExecution<T>>;
  lookup<T>(keyInput: SpatialCacheKeyInput, allowStale?: boolean): SpatialCacheLookup<T>;
  invalidate(keyInput?: SpatialCacheKeyInput): number;
  invalidateTag(tag: string): number;
  sweepExpired(now?: number): number;
  snapshot(): SpatialQueryCacheRuntimeSnapshot;
  dispose(): void;
}> => {
  const policy = normalizeSpatialQueryCacheRuntimePolicy(policyInput);
  const cache = new SpatialResultCache<unknown>({
    maxEntries: policy.cacheMaxEntries,
    maxEstimatedBytes: policy.cacheMaxEstimatedBytes,
    defaultTtlMs: policy.cacheDefaultTtlMs,
    maxTtlMs: policy.cacheMaxTtlMs,
    coordinatePrecision: policy.coordinatePrecision,
  });
  const requests = createSpatialRequestCoordinator({
    concurrency: policy.requestConcurrency,
    maximumQueued: policy.requestMaximumQueued,
    maximumCacheEntries: policy.requestMaximumCacheEntries,
  });
  let disposed = false;
  let executions = 0;
  let cacheServed = 0;
  let staleServed = 0;
  let operationServed = 0;
  let refreshes = 0;
  let bypasses = 0;
  let invalidations = 0;

  const keyFor = (input: SpatialCacheKeyInput): string => createSpatialCacheKey(input, policy.coordinatePrecision);

  const assertActive = (): void => {
    if (disposed) throw new Error('Spatial query cache runtime is disposed');
  };

  const execute = async <T>(
    keyInput: SpatialCacheKeyInput,
    operation: (context: SpatialQueryExecutionContext) => Promise<T>,
    options: SpatialQueryExecutionOptions = {},
  ): Promise<SpatialQueryExecution<T>> => {
    assertActive();
    if (typeof operation !== 'function') throw new TypeError('operation is required');
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const cacheKey = keyFor(keyInput);
    executions += 1;

    if (options.bypassCache) {
      bypasses += 1;
      const value = await operation({ key: cacheKey, cacheKey, signal: options.signal ?? new AbortController().signal });
      operationServed += 1;
      return executionResult(value, 'operation', cacheKey, false);
    }

    if (!options.refresh) {
      const cached = cache.get(cacheKey, options.allowStale === undefined ? {} : { allowStale: options.allowStale });
      if (cached.status === 'hit') {
        cacheServed += 1;
        return executionResult(cached.value as T, 'cache', cacheKey, false);
      }
      if (cached.status === 'stale') {
        staleServed += 1;
        return executionResult(cached.value as T, 'stale-cache', cacheKey, false);
      }
    } else {
      refreshes += 1;
    }

    let operationInvoked = false;
    const value = await requests.run<T>(cacheKey, async (context) => {
      operationInvoked = true;
      const result = await operation({ ...context, cacheKey });
      if (!context.signal.aborted) {
        cache.put(cacheKey, result, {
          ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
          ...(options.estimatedBytes === undefined ? {} : { estimatedBytes: options.estimatedBytes }),
          ...(options.tags === undefined ? {} : { tags: options.tags }),
        });
      }
      return result;
    }, {
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    operationServed += 1;
    return executionResult(value, 'operation', cacheKey, !operationInvoked);
  };

  const lookup = <T>(keyInput: SpatialCacheKeyInput, allowStale = false): SpatialCacheLookup<T> => {
    assertActive();
    return cache.get(keyFor(keyInput), { allowStale }) as SpatialCacheLookup<T>;
  };

  const invalidate = (keyInput?: SpatialCacheKeyInput): number => {
    assertActive();
    let removed: number;
    if (keyInput) {
      removed = cache.delete(keyFor(keyInput)) ? 1 : 0;
      requests.invalidate(keyFor(keyInput));
    } else {
      removed = cache.snapshot().entries;
      cache.clear();
      requests.invalidate();
    }
    invalidations += removed;
    return removed;
  };

  const invalidateTag = (tag: string): number => {
    assertActive();
    const removed = cache.invalidateTag(tag);
    invalidations += removed;
    return removed;
  };

  const sweepExpired = (now?: number): number => {
    assertActive();
    return now === undefined ? cache.sweepExpired() : cache.sweepExpired(now);
  };

  const snapshot = (): SpatialQueryCacheRuntimeSnapshot => Object.freeze({
    disposed,
    executions,
    cacheServed,
    staleServed,
    operationServed,
    refreshes,
    bypasses,
    invalidations,
    cache: cache.snapshot(),
    requests: requests.snapshots(),
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    requests.dispose();
    cache.clear();
  };

  return Object.freeze({ execute, lookup, invalidate, invalidateTag, sweepExpired, snapshot, dispose });
};
