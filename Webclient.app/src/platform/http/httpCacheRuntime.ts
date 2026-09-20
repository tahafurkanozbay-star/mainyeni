import {
  CacheCoordinator,
  type CacheCoordinatorOptions,
} from '../cache/cacheCoordinator';
import {
  CacheFlightRegistry,
} from '../cache/cacheFlightRegistry';
import type { CacheFlightRegistryOptions } from '../cache/cacheFlightContracts';
import {
  createCacheKey,
  type CacheKeyRequest,
} from '../cache/cacheKey';
import type {
  CacheCoordinatorSnapshot,
  CacheResolutionSource,
} from '../cache/cacheCoordinatorContracts';
import {
  isAbortSignalLike,
  type NormalizedRequestConfig,
  type TransportResult,
} from './contracts';
import { serializeQueryParams } from './requestPolicy';

export interface HttpCacheRuntimeOptions {
  readonly coordinator?: CacheCoordinator;
  readonly coordinatorOptions?: CacheCoordinatorOptions;
  readonly dedupeFlights?: CacheFlightRegistry;
  readonly dedupeFlightOptions?: CacheFlightRegistryOptions;
  readonly onEvent?: (eventName: string, metadata: Record<string, unknown>) => void;
}

export interface HttpCacheRuntimeSnapshot {
  readonly cache: CacheCoordinatorSnapshot;
  readonly store: ReturnType<CacheCoordinator['storeSnapshot']>;
  readonly cacheFlights: ReturnType<CacheCoordinator['flightSnapshot']>;
  readonly dedupeFlights: ReturnType<CacheFlightRegistry['snapshot']>;
  readonly totalFlights: number;
}

type Loader<T> = (signal?: AbortSignal) => Promise<TransportResult<T>>;

const DEFAULT_NAMESPACE = 'http';

const emit = (
  listener: HttpCacheRuntimeOptions['onEvent'],
  name: string,
  metadata: Record<string, unknown> = {},
): void => {
  try {
    listener?.(name, metadata);
  } catch {
    // Diagnostics are intentionally best-effort and must never break requests.
  }
};

const withQuery = (config: NormalizedRequestConfig): string => {
  const query = serializeQueryParams(config.params);
  return query ? `${config.url}?${query}` : config.url;
};

export const createHttpCacheKeyRequest = (
  config: NormalizedRequestConfig,
): CacheKeyRequest => Object.freeze({
  namespace: config.cacheNamespace || DEFAULT_NAMESPACE,
  method: config.method,
  url: withQuery(config),
  ...(Object.keys(config.cacheVary).length > 0 ? { vary: config.cacheVary } : {}),
});

export const normalizeHttpCacheInvalidationPrefix = (
  value: unknown,
  namespace = DEFAULT_NAMESPACE,
): string => {
  const prefix = String(value ?? '').trim();
  if (!prefix) return '';
  if (prefix.startsWith(`${namespace}|`)) return prefix;

  const parts = prefix.split('|');
  const method = parts.shift()?.trim();
  const resource = parts.shift()?.trim();
  if (method && resource && /^[a-z-]+$/i.test(method) && resource.startsWith('/')) {
    const query = parts.join('|').trim();
    return `${namespace}|${method.toUpperCase()}|${resource}${query ? `?${query}` : ''}`;
  }

  return `${namespace}|${prefix}`;
};

const cacheMetadata = (
  result: TransportResult<unknown>,
  source: CacheResolutionSource,
): Readonly<Record<string, unknown>> => Object.freeze({
  ...(result.metadata ?? {}),
  cache: source,
});

const decorateCacheResolution = <T>(
  result: TransportResult<T>,
  source: CacheResolutionSource,
): TransportResult<T> => {
  const fromCache = source === 'fresh-cache' || source === 'stale-cache';
  return Object.freeze({
    ...result,
    metadata: cacheMetadata(result as TransportResult<unknown>, source),
    fromCache,
  });
};

const runtimeSignal = (config: NormalizedRequestConfig): AbortSignal | undefined =>
  isAbortSignalLike(config.signal) ? config.signal : undefined;

export class HttpCacheRuntime {
  readonly coordinator: CacheCoordinator;
  readonly dedupeFlights: CacheFlightRegistry;
  readonly #onEvent: HttpCacheRuntimeOptions['onEvent'];

  constructor(options: HttpCacheRuntimeOptions = {}) {
    this.coordinator = options.coordinator ?? new CacheCoordinator(options.coordinatorOptions);
    this.dedupeFlights = options.dedupeFlights
      ?? new CacheFlightRegistry(options.dedupeFlightOptions);
    this.#onEvent = options.onEvent;
  }

  async resolve<T>(
    config: NormalizedRequestConfig,
    loader: Loader<T>,
  ): Promise<TransportResult<T>> {
    const keyRequest = createHttpCacheKeyRequest(config);
    const parsedKey = createCacheKey(keyRequest);
    const signal = runtimeSignal(config);

    if (config.cache) {
      const before = this.coordinator.snapshot();
      const resolution = await this.coordinator.readThrough<TransportResult<T>>({
        key: keyRequest,
        policy: {
          method: config.method,
          classification: config.cacheClassification,
          authenticated: false,
          containsAuthorization: false,
          explicitCacheable: true,
          ttlMs: config.cacheTtlMs,
          staleWhileRevalidateMs: config.cacheStaleWhileRevalidateMs,
        },
        ...(signal ? { signal } : {}),
        ...(config.cacheTags.length > 0 ? { tags: config.cacheTags } : {}),
        loader: ({ signal: operationSignal }) => loader(operationSignal),
      });
      const after = this.coordinator.snapshot();

      emit(this.#onEvent, 'network.cache.resolved', {
        method: config.method,
        url: config.url,
        source: resolution.source,
        cached: resolution.cached,
        cacheWriteIssue: resolution.cacheWriteIssue ?? null,
        sharedLoad: after.sharedLoads > before.sharedLoads,
      });

      if (resolution.revalidation) {
        void resolution.revalidation.then((outcome) => {
          emit(this.#onEvent, 'network.cache.revalidation', {
            method: config.method,
            url: config.url,
            status: outcome.status,
            ...('cached' in outcome ? { cached: outcome.cached } : {}),
            ...('errorName' in outcome ? { errorName: outcome.errorName } : {}),
          });
        });
      }

      return decorateCacheResolution(resolution.value, resolution.source);
    }

    if (!config.dedupe) {
      return loader(signal);
    }

    const joined = this.dedupeFlights.has(parsedKey.serialized);
    emit(this.#onEvent, joined ? 'network.dedupe.join' : 'network.dedupe.start', {
      method: config.method,
      url: config.url,
    });

    try {
      return await this.dedupeFlights.run({
        key: parsedKey.serialized,
        ...(signal ? { signal } : {}),
        operation: (operationSignal) => loader(operationSignal),
      });
    } finally {
      emit(this.#onEvent, 'network.dedupe.release', {
        method: config.method,
        url: config.url,
      });
    }
  }

  clear(): number {
    const removed = this.coordinator.invalidateAll();
    emit(this.#onEvent, 'network.cache.clear', { removed });
    return removed;
  }

  invalidatePrefix(prefix: string): number {
    if (!prefix) return this.clear();
    const canonicalPrefix = normalizeHttpCacheInvalidationPrefix(prefix);
    const removed = this.coordinator.invalidatePrefix(canonicalPrefix);
    emit(this.#onEvent, 'network.cache.invalidate', {
      prefix: canonicalPrefix,
      removed,
    });
    return removed;
  }

  invalidateTags(tags: readonly string[]): number {
    const removed = this.coordinator.invalidateTags(tags);
    emit(this.#onEvent, 'network.cache.invalidate-tags', {
      tagCount: tags.length,
      removed,
    });
    return removed;
  }

  invalidateNamespace(namespace: string): number {
    const removed = this.coordinator.invalidateNamespace(namespace);
    emit(this.#onEvent, 'network.cache.invalidate-namespace', {
      namespace,
      removed,
    });
    return removed;
  }

  cacheSize(): number {
    return this.coordinator.storeSnapshot().entries;
  }

  inFlightSize(): number {
    return this.coordinator.flightSnapshot().flights + this.dedupeFlights.snapshot().flights;
  }

  snapshot(): HttpCacheRuntimeSnapshot {
    const cache = this.coordinator.snapshot();
    const store = this.coordinator.storeSnapshot();
    const cacheFlights = this.coordinator.flightSnapshot();
    const dedupeFlights = this.dedupeFlights.snapshot();
    return Object.freeze({
      cache,
      store,
      cacheFlights,
      dedupeFlights,
      totalFlights: cacheFlights.flights + dedupeFlights.flights,
    });
  }

  dispose(): void {
    this.dedupeFlights.dispose('http-cache-runtime-disposed');
    this.coordinator.dispose();
  }
}

export const createHttpCacheRuntime = (
  options: HttpCacheRuntimeOptions = {},
): HttpCacheRuntime => new HttpCacheRuntime(options);
