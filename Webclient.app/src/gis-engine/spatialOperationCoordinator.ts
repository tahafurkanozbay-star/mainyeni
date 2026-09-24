export type SpatialOperationPriority = 'background' | 'normal' | 'interactive';
export type SpatialOperationKind = 'buffer' | 'intersect' | 'nearest' | 'project' | 'simplify' | 'union';

export interface SpatialOperationRequest<TInput> {
  readonly key: string;
  readonly kind: SpatialOperationKind;
  readonly input: TInput;
  readonly priority?: SpatialOperationPriority;
  readonly signal?: AbortSignal | undefined;
  readonly cache?: boolean;
}

export interface SpatialOperationContext {
  readonly signal: AbortSignal;
  readonly kind: SpatialOperationKind;
  readonly key: string;
}

export type SpatialOperationExecutor<TInput, TResult> = (
  input: TInput,
  context: SpatialOperationContext,
) => Promise<TResult>;

export interface SpatialOperationCoordinatorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly maxCacheEntries?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export interface SpatialOperationSnapshot {
  readonly running: number;
  readonly queued: number;
  readonly cached: number;
  readonly dedupedSubscribers: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly cacheHits: number;
  readonly evictions: number;
}

interface Subscriber<TResult> {
  readonly id: number;
  readonly resolve: (value: TResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: (() => void) | undefined;
  settled: boolean;
}

interface WorkItem<TInput, TResult> {
  readonly identity: string;
  readonly request: SpatialOperationRequest<TInput>;
  readonly executor: SpatialOperationExecutor<TInput, TResult>;
  readonly controller: AbortController;
  readonly sequence: number;
  readonly subscribers: Map<number, Subscriber<TResult>>;
  state: 'queued' | 'running' | 'settled';
}

interface CacheEntry<TResult> {
  readonly value: TResult;
  readonly expiresAt: number;
  touchedAt: number;
  readonly sequence: number;
}

const PRIORITY_WEIGHT: Readonly<Record<SpatialOperationPriority, number>> = {
  background: 0,
  normal: 1,
  interactive: 2,
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function nonNegativeFinite(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return resolved;
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new TypeError('Spatial operation key must not be empty');
  if (normalized.length > 512) throw new RangeError('Spatial operation key exceeds 512 characters');
  return normalized;
}

function abortError(message = 'Spatial operation cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Transport-neutral scheduler for expensive geometry work. It deliberately does not
 * know ArcGIS endpoints or SDK geometry classes: callers inject the verified worker,
 * SDK or server-side executor. The coordinator only owns bounded scheduling,
 * cancellation, identical-work dedupe and a small TTL result cache.
 */
export class SpatialOperationCoordinator<TInput, TResult> {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly queue: Array<WorkItem<TInput, TResult>> = [];
  private readonly inFlight = new Map<string, WorkItem<TInput, TResult>>();
  private readonly cache = new Map<string, CacheEntry<TResult>>();
  private running = 0;
  private sequence = 0;
  private subscriberSequence = 0;
  private disposed = false;
  private dedupedSubscribers = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private cacheHits = 0;
  private evictions = 0;

  constructor(options: SpatialOperationCoordinatorOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 2, 'maxConcurrent');
    this.maxQueued = positiveInteger(options.maxQueued, 64, 'maxQueued');
    this.maxCacheEntries = positiveInteger(options.maxCacheEntries, 64, 'maxCacheEntries');
    this.cacheTtlMs = nonNegativeFinite(options.cacheTtlMs, 15_000, 'cacheTtlMs');
    this.now = options.now ?? Date.now;
  }

  execute(
    request: SpatialOperationRequest<TInput>,
    executor: SpatialOperationExecutor<TInput, TResult>,
  ): Promise<TResult> {
    if (this.disposed) return Promise.reject(new Error('SpatialOperationCoordinator is disposed'));
    if (request.signal?.aborted) return Promise.reject(abortError());

    const key = normalizeKey(request.key);
    const identity = `${request.kind}:${key}`;
    this.pruneExpiredCache();

    if (request.cache !== false) {
      const cached = this.cache.get(identity);
      if (cached && cached.expiresAt >= this.now()) {
        cached.touchedAt = this.now();
        this.cacheHits += 1;
        return Promise.resolve(cached.value);
      }
    }

    const existing = this.inFlight.get(identity);
    if (existing) {
      this.dedupedSubscribers += 1;
      return this.subscribe(existing, request.signal);
    }

    if (this.queue.length >= this.maxQueued && this.running >= this.maxConcurrent) {
      return Promise.reject(new Error('Spatial operation queue capacity exceeded'));
    }

    const item: WorkItem<TInput, TResult> = {
      identity,
      request: { ...request, key },
      executor,
      controller: new AbortController(),
      sequence: ++this.sequence,
      subscribers: new Map(),
      state: 'queued',
    };
    this.inFlight.set(identity, item);
    const promise = this.subscribe(item, request.signal);
    this.queue.push(item);
    this.sortQueue();
    this.drain();
    return promise;
  }

  invalidate(kind?: SpatialOperationKind, key?: string): number {
    if (key !== undefined && kind === undefined) {
      throw new TypeError('kind is required when invalidating a specific key');
    }
    const identity = kind && key !== undefined ? `${kind}:${normalizeKey(key)}` : undefined;
    let removed = 0;
    for (const cacheKey of this.cache.keys()) {
      if (identity ? cacheKey === identity : kind ? cacheKey.startsWith(`${kind}:`) : true) {
        this.cache.delete(cacheKey);
        removed += 1;
      }
    }
    return removed;
  }

  cancel(kind: SpatialOperationKind, key: string): boolean {
    const identity = `${kind}:${normalizeKey(key)}`;
    const item = this.inFlight.get(identity);
    if (!item) return false;
    this.cancelItem(item, abortError('Spatial operation cancelled by coordinator'));
    return true;
  }

  snapshot(): SpatialOperationSnapshot {
    this.pruneExpiredCache();
    return Object.freeze({
      running: this.running,
      queued: this.queue.filter((item) => item.state === 'queued').length,
      cached: this.cache.size,
      dedupedSubscribers: this.dedupedSubscribers,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      cacheHits: this.cacheHits,
      evictions: this.evictions,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.inFlight.values()) {
      this.cancelItem(item, abortError('Spatial operation coordinator disposed'));
    }
    this.queue.length = 0;
    this.cache.clear();
  }

  private subscribe(item: WorkItem<TInput, TResult>, signal?: AbortSignal): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const subscriber: Subscriber<TResult> = {
        id: ++this.subscriberSequence,
        resolve,
        reject,
        signal,
        settled: false,
      };
      item.subscribers.set(subscriber.id, subscriber);
      if (signal) {
        const onAbort = (): void => this.abortSubscriber(item, subscriber);
        subscriber.abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private abortSubscriber(item: WorkItem<TInput, TResult>, subscriber: Subscriber<TResult>): void {
    if (subscriber.settled) return;
    subscriber.settled = true;
    this.detachAbortListener(subscriber);
    item.subscribers.delete(subscriber.id);
    subscriber.reject(abortError());
    if (item.subscribers.size === 0 && item.state !== 'settled') {
      this.cancelItem(item, abortError('All spatial operation subscribers cancelled'));
    }
  }

  private cancelItem(item: WorkItem<TInput, TResult>, reason: Error): void {
    if (item.state === 'settled') return;
    const wasRunning = item.state === 'running';
    item.state = 'settled';
    item.controller.abort(reason);
    this.inFlight.delete(item.identity);
    const queueIndex = this.queue.indexOf(item);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (wasRunning) this.running = Math.max(0, this.running - 1);
    this.cancelled += 1;
    this.rejectSubscribers(item, reason);
    this.drain();
  }

  private sortQueue(): void {
    this.queue.sort((left, right) => {
      const priority = PRIORITY_WEIGHT[right.request.priority ?? 'normal'] - PRIORITY_WEIGHT[left.request.priority ?? 'normal'];
      return priority || left.sequence - right.sequence;
    });
  }

  private drain(): void {
    if (this.disposed) return;
    while (this.running < this.maxConcurrent) {
      const item = this.queue.find((candidate) => candidate.state === 'queued');
      if (!item) return;
      const index = this.queue.indexOf(item);
      if (index >= 0) this.queue.splice(index, 1);
      if (item.subscribers.size === 0) {
        this.inFlight.delete(item.identity);
        item.state = 'settled';
        continue;
      }
      this.start(item);
    }
  }

  private start(item: WorkItem<TInput, TResult>): void {
    item.state = 'running';
    this.running += 1;
    const context: SpatialOperationContext = Object.freeze({
      signal: item.controller.signal,
      kind: item.request.kind,
      key: item.request.key,
    });
    void Promise.resolve()
      .then(() => item.executor(item.request.input, context))
      .then((value) => this.finishSuccess(item, value))
      .catch((error: unknown) => this.finishFailure(item, error));
  }

  private finishSuccess(item: WorkItem<TInput, TResult>, value: TResult): void {
    if (item.state !== 'running') return;
    item.state = 'settled';
    this.running -= 1;
    this.inFlight.delete(item.identity);
    this.completed += 1;
    if (item.request.cache !== false && this.cacheTtlMs > 0 && item.subscribers.size > 0) {
      this.putCache(item.identity, value);
    }
    for (const subscriber of item.subscribers.values()) {
      if (subscriber.settled) continue;
      subscriber.settled = true;
      this.detachAbortListener(subscriber);
      subscriber.resolve(value);
    }
    item.subscribers.clear();
    this.drain();
  }

  private finishFailure(item: WorkItem<TInput, TResult>, error: unknown): void {
    if (item.state !== 'running') return;
    item.state = 'settled';
    this.running -= 1;
    this.inFlight.delete(item.identity);
    if (item.controller.signal.aborted) this.cancelled += 1;
    else this.failed += 1;
    this.rejectSubscribers(item, error);
    this.drain();
  }

  private rejectSubscribers(item: WorkItem<TInput, TResult>, reason: unknown): void {
    for (const subscriber of item.subscribers.values()) {
      if (subscriber.settled) continue;
      subscriber.settled = true;
      this.detachAbortListener(subscriber);
      subscriber.reject(reason);
    }
    item.subscribers.clear();
  }

  private detachAbortListener(subscriber: Subscriber<TResult>): void {
    if (subscriber.signal && subscriber.abortListener) {
      subscriber.signal.removeEventListener('abort', subscriber.abortListener);
      subscriber.abortListener = undefined;
    }
  }

  private putCache(identity: string, value: TResult): void {
    const now = this.now();
    this.cache.set(identity, {
      value,
      expiresAt: now + this.cacheTtlMs,
      touchedAt: now,
      sequence: ++this.sequence,
    });
    while (this.cache.size > this.maxCacheEntries) {
      let victimKey: string | undefined;
      let victim: CacheEntry<TResult> | undefined;
      for (const [key, entry] of this.cache) {
        if (!victim || entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence)) {
          victim = entry;
          victimKey = key;
        }
      }
      if (!victimKey) break;
      this.cache.delete(victimKey);
      this.evictions += 1;
    }
  }

  private pruneExpiredCache(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) this.cache.delete(key);
    }
  }
}
