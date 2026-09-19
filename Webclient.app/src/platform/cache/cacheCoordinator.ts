import { BoundedMemoryCache, type BoundedMemoryCacheOptions } from './boundedMemoryCache';
import { CacheContractError } from './cacheContracts';
import { createCacheKey } from './cacheKey';
import { CacheFlightError, type CacheFlightRegistryOptions } from './cacheFlightContracts';
import { CacheFlightRegistry } from './cacheFlightRegistry';
import { evaluateCachePolicy } from './cachePolicy';
import type {
  CacheCoordinatorSnapshot,
  CacheReadThroughRequest,
  CacheResolution,
  CacheRevalidationOutcome,
} from './cacheCoordinatorContracts';

export interface CacheCoordinatorOptions {
  readonly store?: BoundedMemoryCache;
  readonly storeOptions?: BoundedMemoryCacheOptions;
  readonly flights?: CacheFlightRegistry;
  readonly flightOptions?: CacheFlightRegistryOptions;
}

interface MutableCoordinatorStats {
  reads: number;
  freshHits: number;
  staleHits: number;
  misses: number;
  networkOnly: number;
  loads: number;
  sharedLoads: number;
  writes: number;
  writeIssues: number;
  revalidationFailures: number;
}

export class CacheCoordinator {
  readonly #store: BoundedMemoryCache;
  readonly #flights: CacheFlightRegistry;
  readonly #stats: MutableCoordinatorStats = {
    reads: 0,
    freshHits: 0,
    staleHits: 0,
    misses: 0,
    networkOnly: 0,
    loads: 0,
    sharedLoads: 0,
    writes: 0,
    writeIssues: 0,
    revalidationFailures: 0,
  };
  #disposed = false;

  constructor(options: CacheCoordinatorOptions = {}) {
    this.#store = options.store ?? new BoundedMemoryCache(options.storeOptions);
    this.#flights = options.flights ?? new CacheFlightRegistry(options.flightOptions);
  }

  async readThrough<T>(request: CacheReadThroughRequest<T>): Promise<CacheResolution<T>> {
    this.#assertOpen();
    this.#stats.reads += 1;
    const parsedKey = createCacheKey(request.key);
    const policy = evaluateCachePolicy(request.policy);

    if (!policy.cacheable) {
      this.#stats.networkOnly += 1;
      this.#stats.loads += 1;
      const controller = linkedController(request.signal);
      try {
        const value = await request.loader({
          signal: controller.signal,
          key: parsedKey.serialized,
          namespace: parsedKey.namespace,
        });
        return Object.freeze({
          value,
          source: 'network-only',
          cached: false,
          key: parsedKey.serialized,
        });
      } finally {
        controller.dispose();
      }
    }

    const cached = this.#store.get<T>(parsedKey.serialized, true);
    if (cached.hit && cached.state === 'fresh' && cached.entry) {
      this.#stats.freshHits += 1;
      return Object.freeze({
        value: cached.entry.value,
        source: 'fresh-cache',
        cached: true,
        key: parsedKey.serialized,
      });
    }

    if (cached.hit && cached.state === 'stale' && cached.entry) {
      this.#stats.staleHits += 1;
      const revalidation = this.#revalidate(request, parsedKey.serialized, parsedKey.namespace);
      return Object.freeze({
        value: cached.entry.value,
        source: 'stale-cache',
        cached: true,
        key: parsedKey.serialized,
        revalidation,
      });
    }

    this.#stats.misses += 1;
    const joined = this.#flights.has(parsedKey.serialized);
    if (joined) this.#stats.sharedLoads += 1;
    else this.#stats.loads += 1;

    const value = await this.#flights.run({
      key: parsedKey.serialized,
      ...(request.signal ? { signal: request.signal } : {}),
      operation: (signal) => request.loader({
        signal,
        key: parsedKey.serialized,
        namespace: parsedKey.namespace,
      }),
    });

    const issue = this.#write(
      parsedKey.serialized,
      parsedKey.namespace,
      value,
      request,
      policy.ttlMs,
      policy.staleWhileRevalidateMs,
    );
    return Object.freeze({
      value,
      source: 'shared-loader',
      cached: issue === undefined,
      key: parsedKey.serialized,
      ...(issue ? { cacheWriteIssue: issue } : {}),
    });
  }

  invalidateTags(tags: readonly string[]): number {
    this.#assertOpen();
    return this.#store.invalidateTags(tags);
  }

  invalidateNamespace(namespace: string): number {
    this.#assertOpen();
    return this.#store.invalidateNamespace(namespace);
  }

  pruneExpired(limit?: number): number {
    this.#assertOpen();
    return limit === undefined ? this.#store.pruneExpired() : this.#store.pruneExpired(limit);
  }

  snapshot(): CacheCoordinatorSnapshot {
    return Object.freeze({ ...this.#stats });
  }

  storeSnapshot() {
    return this.#store.snapshot();
  }

  flightSnapshot() {
    return this.#flights.snapshot();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#flights.dispose('cache-coordinator-disposed');
    this.#store.dispose();
  }

  #revalidate<T>(
    request: CacheReadThroughRequest<T>,
    key: string,
    namespace: string,
  ): Promise<CacheRevalidationOutcome> {
    const joined = this.#flights.has(key);
    if (joined) this.#stats.sharedLoads += 1;
    else this.#stats.loads += 1;

    return this.#flights.run({
      key,
      ...(request.signal ? { signal: request.signal } : {}),
      operation: (signal) => request.loader({ signal, key, namespace }),
    }).then(
      (value) => {
        const policy = evaluateCachePolicy(request.policy);
        const issue = this.#write(
          key,
          namespace,
          value,
          request,
          policy.ttlMs,
          policy.staleWhileRevalidateMs,
        );
        return Object.freeze({ status: 'updated', cached: issue === undefined });
      },
      (error: unknown) => {
        if (error instanceof CacheFlightError && (
          error.code === 'subscriber-aborted' || error.code === 'operation-cancelled'
        )) {
          return Object.freeze({ status: 'cancelled' });
        }
        this.#stats.revalidationFailures += 1;
        return Object.freeze({ status: 'failed', errorName: errorName(error) });
      },
    );
  }

  #write<T>(
    key: string,
    namespace: string,
    value: T,
    request: CacheReadThroughRequest<T>,
    ttlMs: number,
    staleWhileRevalidateMs: number,
  ): string | undefined {
    try {
      this.#store.put({
        key,
        namespace,
        value,
        ttlMs,
        staleWhileRevalidateMs,
        ...(request.tags ? { tags: request.tags } : {}),
        ...(request.byteSize === undefined ? {} : { byteSize: request.byteSize }),
      });
      this.#stats.writes += 1;
      return undefined;
    } catch (error) {
      this.#stats.writeIssues += 1;
      if (error instanceof CacheContractError || error instanceof RangeError) {
        return error.name + ':' + ('code' in error ? String(error.code) : error.message);
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new CacheContractError('disposed', 'cache coordinator is disposed');
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error && error.name ? error.name.slice(0, 80) : 'UnknownError';

interface LinkedController {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

const linkedController = (signal?: AbortSignal): LinkedController => {
  const controller = new AbortController();
  if (!signal) return Object.freeze({ signal: controller.signal, dispose: () => undefined });
  if (signal.aborted) {
    controller.abort(signal.reason);
    return Object.freeze({ signal: controller.signal, dispose: () => undefined });
  }
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose: () => signal.removeEventListener('abort', abort),
  });
};
