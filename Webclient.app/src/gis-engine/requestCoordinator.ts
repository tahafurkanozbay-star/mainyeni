/**
 * Bounded request scheduler for ArcGIS runtime work.
 *
 * The coordinator deliberately knows nothing about URLs or HTTP. Callers provide
 * a deterministic key and a work function. That keeps service ownership in the
 * existing catalog/adapter layer while centralising concurrency, de-duplication,
 * cancellation, cache pressure and stale-generation semantics.
 */

export type RequestPriority = 'critical' | 'interactive' | 'background';

export interface RequestCoordinatorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly cacheEntries?: number;
  readonly cacheBytes?: number;
  readonly defaultTtlMs?: number;
  readonly now?: () => number;
  readonly estimateBytes?: (value: unknown) => number;
}

export interface CoordinatedRequestOptions {
  readonly signal?: AbortSignal;
  readonly priority?: RequestPriority;
  readonly cache?: boolean;
  readonly ttlMs?: number;
  readonly generation?: string | number;
  readonly namespace?: string;
}

export interface RequestExecutionContext {
  readonly signal: AbortSignal;
  readonly key: string;
  readonly namespace: string;
  readonly generation: string | number | null;
}

export interface RequestCoordinatorSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly inflight: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly deduped: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly evicted: number;
  readonly rejectedQueueFull: number;
  readonly staleSuppressed: number;
}

export interface RequestCoordinator {
  run<T>(
    key: string,
    work: (context: RequestExecutionContext) => Promise<T> | T,
    options?: CoordinatedRequestOptions,
  ): Promise<T>;
  invalidate(key?: string, namespace?: string): number;
  advanceGeneration(namespace: string, generation: string | number): void;
  cancelNamespace(namespace: string, reason?: unknown): number;
  cancelAll(reason?: unknown): number;
  snapshot(): RequestCoordinatorSnapshot;
  destroy(reason?: unknown): void;
}

export class RequestCoordinatorError extends Error {
  readonly code: string;

  constructor(message: string, code = 'REQUEST_COORDINATOR_ERROR') {
    super(message);
    this.name = 'RequestCoordinatorError';
    this.code = code;
  }
}

interface NormalizedOptions {
  readonly priority: RequestPriority;
  readonly cache: boolean;
  readonly ttlMs: number;
  readonly generation: string | number | null;
  readonly namespace: string;
}

interface CacheEntry {
  readonly key: string;
  readonly namespace: string;
  readonly value: unknown;
  readonly expiresAt: number;
  readonly bytes: number;
  touchedAt: number;
}

interface Consumer<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  abortHandler: (() => void) | null;
  settled: boolean;
}

interface SharedRequest<T = unknown> {
  readonly id: number;
  readonly key: string;
  readonly namespace: string;
  readonly cacheKey: string;
  readonly priority: RequestPriority;
  readonly generation: string | number | null;
  readonly cache: boolean;
  readonly ttlMs: number;
  readonly controller: AbortController;
  readonly work: (context: RequestExecutionContext) => Promise<T> | T;
  readonly consumers: Set<Consumer<T>>;
  queuedAt: number;
  startedAt: number | null;
  completed: boolean;
}

interface MutableStats {
  cacheHits: number;
  cacheMisses: number;
  deduped: number;
  completed: number;
  failed: number;
  cancelled: number;
  evicted: number;
  rejectedQueueFull: number;
  staleSuppressed: number;
}

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_MAX_QUEUED = 128;
const DEFAULT_CACHE_ENTRIES = 128;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 10 * 60_000;

const priorityWeight: Readonly<Record<RequestPriority, number>> = Object.freeze({
  critical: 0,
  interactive: 1,
  background: 2,
});

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
};

const normalizeNamespace = (value: unknown): string => {
  const text = String(value ?? 'default').trim();
  return text || 'default';
};

const normalizeKey = (value: unknown): string => {
  const key = String(value ?? '').trim();
  if (!key) throw new RequestCoordinatorError('Request key must not be empty.', 'EMPTY_REQUEST_KEY');
  if (key.length > 4096) throw new RequestCoordinatorError('Request key is too long.', 'REQUEST_KEY_TOO_LONG');
  return key;
};

const defaultEstimateBytes = (value: unknown): number => {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? serialized.length * 2 : 64;
  } catch {
    return 1024;
  }
};

const abortError = (reason?: unknown): Error => {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') return new DOMException('Request was aborted.', 'AbortError');
  const error = new Error('Request was aborted.');
  error.name = 'AbortError';
  return error;
};

const staleError = (namespace: string): RequestCoordinatorError => new RequestCoordinatorError(
  `Request result for namespace "${namespace}" belongs to a stale generation.`,
  'STALE_GENERATION',
);

const initialStats = (): MutableStats => ({
  cacheHits: 0,
  cacheMisses: 0,
  deduped: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  evicted: 0,
  rejectedQueueFull: 0,
  staleSuppressed: 0,
});

export class BoundedRequestCoordinator implements RequestCoordinator {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly cacheEntriesLimit: number;
  private readonly cacheBytesLimit: number;
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;
  private readonly estimateBytes: (value: unknown) => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, SharedRequest>();
  private readonly generations = new Map<string, string | number>();
  private readonly queue: SharedRequest[] = [];
  private readonly stats = initialStats();
  private active = 0;
  private cacheBytes = 0;
  private requestSequence = 0;
  private destroyed = false;

  constructor(options: RequestCoordinatorOptions = {}) {
    this.maxConcurrent = boundedInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 64);
    this.maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 1, 10_000);
    this.cacheEntriesLimit = boundedInteger(options.cacheEntries, DEFAULT_CACHE_ENTRIES, 0, 10_000);
    this.cacheBytesLimit = boundedInteger(options.cacheBytes, DEFAULT_CACHE_BYTES, 0, 1024 * 1024 * 1024);
    this.defaultTtlMs = boundedInteger(options.defaultTtlMs, DEFAULT_TTL_MS, 0, MAX_TTL_MS);
    this.clock = options.now ?? (() => Date.now());
    this.estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
  }

  run<T>(
    rawKey: string,
    work: (context: RequestExecutionContext) => Promise<T> | T,
    options: CoordinatedRequestOptions = {},
  ): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new RequestCoordinatorError('Request coordinator is destroyed.', 'COORDINATOR_DESTROYED'));
    }
    if (typeof work !== 'function') {
      return Promise.reject(new RequestCoordinatorError('Request work must be a function.', 'INVALID_REQUEST_WORK'));
    }

    const key = normalizeKey(rawKey);
    const normalized = this.normalizeOptions(options);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

    const cacheKey = this.cacheKey(normalized.namespace, key, normalized.generation);
    this.pruneExpiredCache();
    if (normalized.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > this.clock()) {
        cached.touchedAt = this.clock();
        this.stats.cacheHits += 1;
        return Promise.resolve(cached.value as T);
      }
      this.stats.cacheMisses += 1;
    }

    const shared = this.inflight.get(cacheKey) as SharedRequest<T> | undefined;
    if (shared) {
      this.stats.deduped += 1;
      return this.attachConsumer(shared, options.signal);
    }

    if (this.queue.length >= this.maxQueued && this.active >= this.maxConcurrent) {
      this.stats.rejectedQueueFull += 1;
      return Promise.reject(new RequestCoordinatorError('GIS request queue is full.', 'REQUEST_QUEUE_FULL'));
    }

    const request: SharedRequest<T> = {
      id: ++this.requestSequence,
      key,
      namespace: normalized.namespace,
      cacheKey,
      priority: normalized.priority,
      generation: normalized.generation,
      cache: normalized.cache,
      ttlMs: normalized.ttlMs,
      controller: new AbortController(),
      work,
      consumers: new Set<Consumer<T>>(),
      queuedAt: this.clock(),
      startedAt: null,
      completed: false,
    };
    this.inflight.set(cacheKey, request as SharedRequest);
    const promise = this.attachConsumer(request, options.signal);
    this.queue.push(request as SharedRequest);
    this.sortQueue();
    this.drain();
    return promise;
  }

  invalidate(key?: string, namespace?: string): number {
    const targetNamespace = namespace === undefined ? null : normalizeNamespace(namespace);
    const targetKey = key === undefined ? null : normalizeKey(key);
    let removed = 0;
    for (const [cacheKey, entry] of this.cache) {
      if (targetNamespace !== null && entry.namespace !== targetNamespace) continue;
      const keyMatches = targetKey === null || entry.key === targetKey;
      if (!keyMatches) continue;
      this.removeCacheEntry(cacheKey);
      removed += 1;
    }
    return removed;
  }

  advanceGeneration(namespace: string, generation: string | number): void {
    const normalizedNamespace = normalizeNamespace(namespace);
    this.generations.set(normalizedNamespace, generation);
    for (const request of this.inflight.values()) {
      if (request.namespace === normalizedNamespace && request.generation !== null && request.generation !== generation) {
        request.controller.abort(staleError(normalizedNamespace));
      }
    }
    this.invalidate(undefined, normalizedNamespace);
  }

  cancelNamespace(namespace: string, reason?: unknown): number {
    const normalizedNamespace = normalizeNamespace(namespace);
    let cancelled = 0;
    for (const request of this.inflight.values()) {
      if (request.namespace !== normalizedNamespace || request.completed) continue;
      request.controller.abort(reason ?? abortError());
      cancelled += 1;
    }
    return cancelled;
  }

  cancelAll(reason?: unknown): number {
    let cancelled = 0;
    for (const request of this.inflight.values()) {
      if (request.completed) continue;
      request.controller.abort(reason ?? abortError());
      cancelled += 1;
    }
    return cancelled;
  }

  snapshot(): RequestCoordinatorSnapshot {
    this.pruneExpiredCache();
    return Object.freeze({
      active: this.active,
      queued: this.queue.filter((item) => item.startedAt === null && !item.completed).length,
      inflight: this.inflight.size,
      cacheEntries: this.cache.size,
      cacheBytes: this.cacheBytes,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      deduped: this.stats.deduped,
      completed: this.stats.completed,
      failed: this.stats.failed,
      cancelled: this.stats.cancelled,
      evicted: this.stats.evicted,
      rejectedQueueFull: this.stats.rejectedQueueFull,
      staleSuppressed: this.stats.staleSuppressed,
    });
  }

  destroy(reason?: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAll(reason ?? new RequestCoordinatorError('Request coordinator destroyed.', 'COORDINATOR_DESTROYED'));
    this.cache.clear();
    this.cacheBytes = 0;
    this.generations.clear();
  }

  private normalizeOptions(options: CoordinatedRequestOptions): NormalizedOptions {
    const ttlMs = boundedInteger(options.ttlMs, this.defaultTtlMs, 0, MAX_TTL_MS);
    const priority: RequestPriority = options.priority === 'critical' || options.priority === 'background'
      ? options.priority
      : 'interactive';
    const namespace = normalizeNamespace(options.namespace);
    const generation = options.generation ?? this.generations.get(namespace) ?? null;
    return Object.freeze({
      priority,
      cache: options.cache !== false && ttlMs > 0,
      ttlMs,
      generation,
      namespace,
    });
  }

  private cacheKey(namespace: string, key: string, generation: string | number | null): string {
    const generationKey = generation === null ? 'none' : `${typeof generation}:${String(generation)}`;
    return `${namespace.length}:${namespace}|${generationKey.length}:${generationKey}|${key}`;
  }

  private attachConsumer<T>(request: SharedRequest<T>, signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const consumer: Consumer<T> = {
        resolve,
        reject,
        signal,
        abortHandler: null,
        settled: false,
      };
      if (signal) {
        consumer.abortHandler = () => {
          if (consumer.settled) return;
          consumer.settled = true;
          request.consumers.delete(consumer);
          reject(abortError(signal.reason));
          if (!request.completed && request.consumers.size === 0) {
            request.controller.abort(abortError(signal.reason));
          }
        };
        signal.addEventListener('abort', consumer.abortHandler, { once: true });
      }
      request.consumers.add(consumer);
    });
  }

  private settleConsumer<T>(consumer: Consumer<T>, mode: 'resolve' | 'reject', value: T | unknown): void {
    if (consumer.settled) return;
    consumer.settled = true;
    if (consumer.abortHandler && consumer.signal) {
      consumer.signal.removeEventListener('abort', consumer.abortHandler);
    }
    consumer.abortHandler = null;
    if (mode === 'resolve') consumer.resolve(value as T);
    else consumer.reject(value);
  }

  private sortQueue(): void {
    this.queue.sort((left, right) => {
      const priorityDelta = priorityWeight[left.priority] - priorityWeight[right.priority];
      if (priorityDelta !== 0) return priorityDelta;
      if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt;
      return left.id - right.id;
    });
  }

  private drain(): void {
    while (!this.destroyed && this.active < this.maxConcurrent) {
      const index = this.queue.findIndex((item) => item.startedAt === null && !item.completed);
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0];
      if (!request) return;
      if (request.controller.signal.aborted || request.consumers.size === 0) {
        this.finishAbortedBeforeStart(request);
        continue;
      }
      this.start(request);
    }
  }

  private finishAbortedBeforeStart(request: SharedRequest): void {
    request.completed = true;
    this.inflight.delete(request.cacheKey);
    this.stats.cancelled += 1;
    const reason = request.controller.signal.reason ?? abortError();
    for (const consumer of request.consumers) this.settleConsumer(consumer, 'reject', reason);
    request.consumers.clear();
  }

  private start(request: SharedRequest): void {
    request.startedAt = this.clock();
    this.active += 1;
    const context: RequestExecutionContext = Object.freeze({
      signal: request.controller.signal,
      key: request.key,
      namespace: request.namespace,
      generation: request.generation,
    });

    Promise.resolve()
      .then(() => request.work(context))
      .then((value) => this.finishSuccess(request, value))
      .catch((error: unknown) => this.finishFailure(request, error))
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
  }

  private finishSuccess<T>(request: SharedRequest<T>, value: T): void {
    request.completed = true;
    this.inflight.delete(request.cacheKey);
    const currentGeneration = this.generations.get(request.namespace);
    if (
      request.generation !== null &&
      currentGeneration !== undefined &&
      currentGeneration !== request.generation
    ) {
      const error = staleError(request.namespace);
      this.stats.staleSuppressed += 1;
      for (const consumer of request.consumers) this.settleConsumer(consumer, 'reject', error);
      request.consumers.clear();
      return;
    }

    if (request.cache && !request.controller.signal.aborted) {
      this.putCache(request, value);
    }
    this.stats.completed += 1;
    for (const consumer of request.consumers) this.settleConsumer(consumer, 'resolve', value);
    request.consumers.clear();
  }

  private finishFailure(request: SharedRequest, error: unknown): void {
    request.completed = true;
    this.inflight.delete(request.cacheKey);
    if (request.controller.signal.aborted) this.stats.cancelled += 1;
    else this.stats.failed += 1;
    const reason = request.controller.signal.aborted
      ? request.controller.signal.reason ?? abortError()
      : error;
    for (const consumer of request.consumers) this.settleConsumer(consumer, 'reject', reason);
    request.consumers.clear();
  }

  private putCache<T>(request: SharedRequest<T>, value: T): void {
    if (this.cacheEntriesLimit <= 0 || this.cacheBytesLimit <= 0 || request.ttlMs <= 0) return;
    const estimated = boundedInteger(this.estimateBytes(value), 1024, 0, this.cacheBytesLimit + 1);
    if (estimated > this.cacheBytesLimit) return;
    const existing = this.cache.get(request.cacheKey);
    if (existing) this.removeCacheEntry(request.cacheKey);
    const now = this.clock();
    this.cache.set(request.cacheKey, {
      key: request.key,
      namespace: request.namespace,
      value,
      expiresAt: now + request.ttlMs,
      bytes: estimated,
      touchedAt: now,
    });
    this.cacheBytes += estimated;
    this.enforceCacheBudget();
  }

  private enforceCacheBudget(): void {
    while (this.cache.size > this.cacheEntriesLimit || this.cacheBytes > this.cacheBytesLimit) {
      let oldestKey: string | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.touchedAt < oldestTouched) {
          oldestTouched = entry.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.removeCacheEntry(oldestKey);
      this.stats.evicted += 1;
    }
  }

  private pruneExpiredCache(): void {
    const now = this.clock();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.removeCacheEntry(key);
    }
  }

  private removeCacheEntry(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes);
  }
}

export const createRequestCoordinator = (
  options: RequestCoordinatorOptions = {},
): RequestCoordinator => new BoundedRequestCoordinator(options);
