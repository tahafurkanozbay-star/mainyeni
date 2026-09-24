export type SpatialQueryPriority = 'background' | 'normal' | 'interactive';

export interface SpatialQueryRequest<T> {
  readonly key: string;
  readonly priority?: SpatialQueryPriority;
  readonly signal?: AbortSignal;
  readonly execute: (signal: AbortSignal) => Promise<T>;
}

export interface SpatialQueryCoordinatorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly maxSettledCache?: number;
  readonly cacheTtlMs?: number;
}

export interface SpatialQuerySnapshot {
  readonly active: number;
  readonly queued: number;
  readonly cached: number;
  readonly dedupedSubscribers: number;
  readonly revision: number;
}

type Subscriber<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal | undefined;
  abort?: (() => void) | undefined;
};

type Work<T> = {
  key: string;
  priority: number;
  sequence: number;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<T>;
  subscribers: Set<Subscriber<T>>;
  started: boolean;
};

type CacheEntry = { value: unknown; expiresAt: number; sequence: number };

const priorityValue = (priority: SpatialQueryPriority | undefined): number =>
  priority === 'interactive' ? 2 : priority === 'normal' || priority === undefined ? 1 : 0;

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const nonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
};

/**
 * Transport-neutral bounded coordinator for ArcGIS query adapters. Callers own
 * query construction and service verification; this primitive only controls
 * concurrency, identical-request dedupe, subscriber cancellation and a small
 * settled-result cache. No endpoint or fetch implementation is embedded here.
 */
export class SpatialQueryRequestCoordinator {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxSettledCache: number;
  private readonly cacheTtlMs: number;
  private readonly pending = new Map<string, Work<unknown>>();
  private readonly queue: Work<unknown>[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private active = 0;
  private sequence = 0;
  private cacheSequence = 0;
  private revision = 0;
  private dedupedSubscribers = 0;
  private disposed = false;

  constructor(options: SpatialQueryCoordinatorOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 6, 'maxConcurrent');
    this.maxQueued = positiveInteger(options.maxQueued ?? 128, 'maxQueued');
    this.maxSettledCache = positiveInteger(options.maxSettledCache ?? 64, 'maxSettledCache');
    this.cacheTtlMs = nonNegative(options.cacheTtlMs ?? 15_000, 'cacheTtlMs');
  }

  request<T>(request: SpatialQueryRequest<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('spatial query coordinator disposed'));
    const key = request.key.trim();
    if (!key) return Promise.reject(new Error('spatial query key must not be empty'));
    if (request.signal?.aborted) return Promise.reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));

    this.pruneCache();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt >= Date.now()) return Promise.resolve(cached.value as T);

    const existing = this.pending.get(key);
    if (existing) {
      this.dedupedSubscribers += 1;
      this.revision += 1;
      return this.subscribe(existing as Work<T>, request.signal);
    }

    if (this.queue.length >= this.maxQueued && this.active >= this.maxConcurrent) {
      return Promise.reject(new Error('spatial query queue capacity exhausted'));
    }

    const work: Work<T> = {
      key,
      priority: priorityValue(request.priority),
      sequence: ++this.sequence,
      controller: new AbortController(),
      execute: request.execute,
      subscribers: new Set(),
      started: false,
    };
    this.pending.set(key, work as Work<unknown>);
    const promise = this.subscribe(work, request.signal);
    this.queue.push(work as Work<unknown>);
    this.revision += 1;
    this.pump();
    return promise;
  }

  invalidate(keyInput: string): boolean {
    const key = keyInput.trim();
    if (!key) return false;
    const removed = this.cache.delete(key);
    if (removed) this.revision += 1;
    return removed;
  }

  clearCache(): void {
    if (this.cache.size === 0) return;
    this.cache.clear();
    this.revision += 1;
  }

  snapshot(): SpatialQuerySnapshot {
    this.pruneCache();
    return Object.freeze({
      active: this.active,
      queued: this.queue.length,
      cached: this.cache.size,
      dedupedSubscribers: this.dedupedSubscribers,
      revision: this.revision,
    });
  }

  dispose(reason: unknown = new Error('spatial query coordinator disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const work of this.pending.values()) {
      work.controller.abort(reason);
      this.rejectSubscribers(work, reason);
    }
    this.pending.clear();
    this.queue.length = 0;
    this.cache.clear();
    this.active = 0;
    this.revision += 1;
  }

  private subscribe<T>(work: Work<T>, signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const subscriber: Subscriber<T> = { resolve, reject, signal };
      if (signal) {
        subscriber.abort = () => {
          if (!work.subscribers.delete(subscriber)) return;
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          this.revision += 1;
          if (work.subscribers.size === 0) {
            work.controller.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            if (!work.started) {
              const index = this.queue.indexOf(work as Work<unknown>);
              if (index >= 0) this.queue.splice(index, 1);
              this.pending.delete(work.key);
            }
          }
        };
        signal.addEventListener('abort', subscriber.abort, { once: true });
      }
      work.subscribers.add(subscriber);
    });
  }

  private pump(): void {
    if (this.disposed) return;
    this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence || a.key.localeCompare(b.key));
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const work = this.queue.shift();
      if (!work || work.subscribers.size === 0) continue;
      work.started = true;
      this.active += 1;
      this.revision += 1;
      void this.run(work);
    }
  }

  private async run(work: Work<unknown>): Promise<void> {
    try {
      const value = await work.execute(work.controller.signal);
      if (!work.controller.signal.aborted && work.subscribers.size > 0) {
        this.putCache(work.key, value);
        for (const subscriber of work.subscribers) {
          this.detach(subscriber);
          subscriber.resolve(value);
        }
      }
    } catch (error) {
      if (work.subscribers.size > 0) this.rejectSubscribers(work, error);
    } finally {
      work.subscribers.clear();
      this.pending.delete(work.key);
      this.active = Math.max(0, this.active - 1);
      this.revision += 1;
      this.pump();
    }
  }

  private rejectSubscribers(work: Work<unknown>, reason: unknown): void {
    for (const subscriber of work.subscribers) {
      this.detach(subscriber);
      subscriber.reject(reason);
    }
    work.subscribers.clear();
  }

  private detach(subscriber: Subscriber<unknown>): void {
    if (subscriber.signal && subscriber.abort) subscriber.signal.removeEventListener('abort', subscriber.abort);
    subscriber.abort = undefined;
  }

  private putCache(key: string, value: unknown): void {
    if (this.cacheTtlMs === 0) return;
    this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs, sequence: ++this.cacheSequence });
    if (this.cache.size <= this.maxSettledCache) return;
    let oldestKey: string | undefined;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [candidateKey, entry] of this.cache) {
      if (entry.sequence < oldestSequence) {
        oldestSequence = entry.sequence;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey !== undefined) this.cache.delete(oldestKey);
  }

  private pruneCache(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
        changed = true;
      }
    }
    if (changed) this.revision += 1;
  }
}
