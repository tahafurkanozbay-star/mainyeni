export type QueryPriority = 'interactive' | 'foreground' | 'background';

export interface QueryLifecyclePolicy {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly timeoutMs: number;
  readonly dedupeTtlMs: number;
  readonly maxRecentEntries: number;
  readonly maxSubscribersPerQuery: number;
  readonly maxKeyLength: number;
}

export interface QueryRequest<T> {
  readonly key: string;
  readonly priority: QueryPriority;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}

export interface QueryLifecycleSnapshot {
  readonly disposed: boolean;
  readonly active: number;
  readonly queued: number;
  readonly inflight: number;
  readonly recentEntries: number;
  readonly activeSubscribers: number;
  readonly dedupedSubscribers: number;
  readonly priorityPromotions: number;
  readonly cacheHits: number;
  readonly cacheEvictions: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelledQueries: number;
  readonly cancelledSubscribers: number;
  readonly timedOut: number;
  readonly rejected: number;
}

export type QueryLifecycleErrorCode =
  | 'invalid-key'
  | 'queue-full'
  | 'subscriber-limit'
  | 'cancelled'
  | 'timeout'
  | 'disposed';

export class QueryLifecycleError extends Error {
  public constructor(
    public readonly code: QueryLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QueryLifecycleError';
  }
}

interface Subscriber<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

interface WorkItem<T> {
  readonly key: string;
  priority: QueryPriority;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber<T>>;
  readonly sequence: number;
  readonly queuedAt: number;
  started: boolean;
  startedAt: number | null;
}

interface RecentEntry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly sequence: number;
}

const PRIORITY_WEIGHT: Readonly<Record<QueryPriority, number>> = Object.freeze({
  interactive: 0,
  foreground: 1,
  background: 2,
});

const DEFAULT_POLICY: QueryLifecyclePolicy = Object.freeze({
  maxConcurrent: 6,
  maxQueued: 128,
  timeoutMs: 30_000,
  dedupeTtlMs: 250,
  maxRecentEntries: 256,
  maxSubscribersPerQuery: 64,
  maxKeyLength: 512,
});

const positiveInteger = (
  value: number,
  fallback: number,
  maximum: number,
): number => (
  Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback
);

const nonNegativeInteger = (
  value: number,
  fallback: number,
  maximum: number,
): number => (
  Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback
);

export const normalizeQueryLifecyclePolicy = (
  input: Partial<QueryLifecyclePolicy> = {},
): QueryLifecyclePolicy => {
  const merged = { ...DEFAULT_POLICY, ...input };
  return Object.freeze({
    maxConcurrent: positiveInteger(merged.maxConcurrent, DEFAULT_POLICY.maxConcurrent, 128),
    maxQueued: positiveInteger(merged.maxQueued, DEFAULT_POLICY.maxQueued, 100_000),
    timeoutMs: positiveInteger(merged.timeoutMs, DEFAULT_POLICY.timeoutMs, 10 * 60_000),
    dedupeTtlMs: nonNegativeInteger(merged.dedupeTtlMs, DEFAULT_POLICY.dedupeTtlMs, 10 * 60_000),
    maxRecentEntries: positiveInteger(
      merged.maxRecentEntries,
      DEFAULT_POLICY.maxRecentEntries,
      100_000,
    ),
    maxSubscribersPerQuery: positiveInteger(
      merged.maxSubscribersPerQuery,
      DEFAULT_POLICY.maxSubscribersPerQuery,
      10_000,
    ),
    maxKeyLength: positiveInteger(merged.maxKeyLength, DEFAULT_POLICY.maxKeyLength, 16_384),
  });
};

const queueOrder = (left: WorkItem<unknown>, right: WorkItem<unknown>): number => (
  PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority]
  || left.sequence - right.sequence
);

const errorForCancellation = (message: string): QueryLifecycleError => (
  new QueryLifecycleError('cancelled', message)
);

export class QueryLifecycleCoordinator {
  readonly #policy: QueryLifecyclePolicy;
  readonly #now: () => number;
  readonly #inflight = new Map<string, WorkItem<unknown>>();
  readonly #recent = new Map<string, RecentEntry>();
  readonly #queue: WorkItem<unknown>[] = [];

  #active = 0;
  #sequence = 0;
  #recentSequence = 0;
  #disposed = false;
  #completed = 0;
  #failed = 0;
  #cancelledQueries = 0;
  #cancelledSubscribers = 0;
  #timedOut = 0;
  #rejected = 0;
  #dedupedSubscribers = 0;
  #priorityPromotions = 0;
  #cacheHits = 0;
  #cacheEvictions = 0;

  public constructor(
    policy: Partial<QueryLifecyclePolicy> = {},
    now: () => number = () => Date.now(),
  ) {
    this.#policy = normalizeQueryLifecyclePolicy(policy);
    this.#now = now;
  }

  public get policy(): QueryLifecyclePolicy {
    return this.#policy;
  }

  public execute<T>(request: QueryRequest<T>): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new QueryLifecycleError(
        'disposed',
        'Query lifecycle coordinator is disposed.',
      ));
    }

    const key = request.key.trim();
    if (key.length === 0 || key.length > this.#policy.maxKeyLength) {
      this.#rejected += 1;
      return Promise.reject(new QueryLifecycleError(
        'invalid-key',
        `Query key must contain 1-${this.#policy.maxKeyLength} characters.`,
      ));
    }

    if (request.signal?.aborted) {
      this.#cancelledSubscribers += 1;
      return Promise.reject(errorForCancellation('Query subscriber was already cancelled.'));
    }

    const now = this.#now();
    this.#pruneRecent(now);
    const cached = this.#recent.get(key);
    if (cached) {
      this.#cacheHits += 1;
      return Promise.resolve(cached.value as T);
    }

    const existing = this.#inflight.get(key) as WorkItem<T> | undefined;
    if (existing) {
      if (!existing.started && PRIORITY_WEIGHT[request.priority] < PRIORITY_WEIGHT[existing.priority]) {
        existing.priority = request.priority;
        this.#priorityPromotions += 1;
        this.#queue.sort(queueOrder);
      }
      const subscribed = this.#subscribe(existing, request.signal);
      if (subscribed) {
        this.#dedupedSubscribers += 1;
        return subscribed;
      }
      this.#rejected += 1;
      return Promise.reject(new QueryLifecycleError(
        'subscriber-limit',
        `GIS query subscriber limit of ${this.#policy.maxSubscribersPerQuery} was reached.`,
      ));
    }

    if (
      this.#active >= this.#policy.maxConcurrent
      && this.#queue.length >= this.#policy.maxQueued
    ) {
      this.#rejected += 1;
      return Promise.reject(new QueryLifecycleError(
        'queue-full',
        'Bounded GIS query queue is full.',
      ));
    }

    const item: WorkItem<T> = {
      key,
      priority: request.priority,
      execute: request.execute,
      controller: new AbortController(),
      subscribers: new Set(),
      sequence: this.#sequence++,
      queuedAt: now,
      started: false,
      startedAt: null,
    };

    const promise = this.#subscribe(item, request.signal);
    if (!promise) {
      this.#rejected += 1;
      return Promise.reject(new QueryLifecycleError(
        'subscriber-limit',
        `GIS query subscriber limit of ${this.#policy.maxSubscribersPerQuery} was reached.`,
      ));
    }

    this.#inflight.set(key, item as WorkItem<unknown>);
    this.#queue.push(item as WorkItem<unknown>);
    this.#queue.sort(queueOrder);
    this.#drain();
    return promise;
  }

  public invalidate(keyInput?: string): number {
    if (keyInput === undefined) {
      const removed = this.#recent.size;
      this.#recent.clear();
      return removed;
    }
    const key = keyInput.trim();
    return this.#recent.delete(key) ? 1 : 0;
  }

  public cancel(keyInput: string, reason = 'GIS query cancelled.'): boolean {
    const key = keyInput.trim();
    const item = this.#inflight.get(key);
    if (!item) return false;
    const error = errorForCancellation(reason);
    item.controller.abort(error);
    if (!item.started) {
      const index = this.#queue.indexOf(item);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#inflight.delete(key);
      this.#cancelledQueries += 1;
      this.#settleSubscribers(item, 'reject', error);
      this.#drain();
    }
    return true;
  }

  public snapshot(): QueryLifecycleSnapshot {
    let activeSubscribers = 0;
    for (const item of this.#inflight.values()) activeSubscribers += item.subscribers.size;
    return Object.freeze({
      disposed: this.#disposed,
      active: this.#active,
      queued: this.#queue.length,
      inflight: this.#inflight.size,
      recentEntries: this.#recent.size,
      activeSubscribers,
      dedupedSubscribers: this.#dedupedSubscribers,
      priorityPromotions: this.#priorityPromotions,
      cacheHits: this.#cacheHits,
      cacheEvictions: this.#cacheEvictions,
      completed: this.#completed,
      failed: this.#failed,
      cancelledQueries: this.#cancelledQueries,
      cancelledSubscribers: this.#cancelledSubscribers,
      timedOut: this.#timedOut,
      rejected: this.#rejected,
    });
  }

  public dispose(reason = 'GIS query lifecycle disposed.'): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new QueryLifecycleError('disposed', reason);
    for (const item of this.#inflight.values()) {
      item.controller.abort(error);
      this.#settleSubscribers(item, 'reject', error);
    }
    this.#cancelledQueries += this.#inflight.size;
    this.#inflight.clear();
    this.#queue.length = 0;
    this.#recent.clear();
    this.#active = 0;
  }

  #subscribe<T>(
    item: WorkItem<T>,
    signal?: AbortSignal,
  ): Promise<T> | null {
    if (item.subscribers.size >= this.#policy.maxSubscribersPerQuery) return null;

    return new Promise<T>((resolve, reject) => {
      const subscriber: Subscriber<T> = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        settled: false,
      };

      if (signal) {
        subscriber.abortListener = () => {
          if (subscriber.settled) return;
          subscriber.settled = true;
          item.subscribers.delete(subscriber);
          this.#cancelledSubscribers += 1;
          reject(errorForCancellation('GIS query subscriber cancelled.'));

          if (item.subscribers.size === 0) {
            const error = errorForCancellation('All GIS query subscribers cancelled.');
            item.controller.abort(error);
            if (!item.started) {
              const index = this.#queue.indexOf(item as WorkItem<unknown>);
              if (index >= 0) this.#queue.splice(index, 1);
              this.#inflight.delete(item.key);
              this.#cancelledQueries += 1;
              this.#drain();
            }
          }
        };
        signal.addEventListener('abort', subscriber.abortListener, { once: true });
      }

      item.subscribers.add(subscriber);
    });
  }

  #drain(): void {
    while (
      !this.#disposed
      && this.#active < this.#policy.maxConcurrent
      && this.#queue.length > 0
    ) {
      const item = this.#queue.shift();
      if (!item || item.subscribers.size === 0) continue;
      item.started = true;
      item.startedAt = this.#now();
      this.#active += 1;
      void this.#run(item);
    }
  }

  async #run(item: WorkItem<unknown>): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          const error = new QueryLifecycleError(
            'timeout',
            `GIS query exceeded ${this.#policy.timeoutMs}ms.`,
          );
          item.controller.abort(error);
          reject(error);
        }, this.#policy.timeoutMs);
      });

      const value = await Promise.race([
        item.execute(item.controller.signal),
        timeout,
      ]);

      if (this.#policy.dedupeTtlMs > 0 && !item.controller.signal.aborted) {
        this.#putRecent(item.key, value, this.#now());
      }

      this.#completed += 1;
      this.#settleSubscribers(item, 'resolve', value);
    } catch (error) {
      if (timedOut) {
        this.#timedOut += 1;
      } else if (item.controller.signal.aborted) {
        this.#cancelledQueries += 1;
      } else {
        this.#failed += 1;
      }
      this.#settleSubscribers(item, 'reject', error);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.#inflight.delete(item.key);
      this.#active = Math.max(0, this.#active - 1);
      this.#drain();
    }
  }

  #settleSubscribers(
    item: WorkItem<unknown>,
    mode: 'resolve' | 'reject',
    payload: unknown,
  ): void {
    for (const subscriber of item.subscribers) {
      if (subscriber.settled) continue;
      subscriber.settled = true;
      if (subscriber.signal && subscriber.abortListener) {
        subscriber.signal.removeEventListener('abort', subscriber.abortListener);
      }
      if (mode === 'resolve') subscriber.resolve(payload);
      else subscriber.reject(payload);
    }
    item.subscribers.clear();
  }

  #putRecent(key: string, value: unknown, now: number): void {
    this.#pruneRecent(now);
    if (this.#recent.has(key)) this.#recent.delete(key);

    while (this.#recent.size >= this.#policy.maxRecentEntries) {
      const oldest = this.#recent.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#recent.delete(oldest);
      this.#cacheEvictions += 1;
    }

    this.#recent.set(key, {
      value,
      expiresAt: now + this.#policy.dedupeTtlMs,
      sequence: this.#recentSequence++,
    });
  }

  #pruneRecent(now: number): void {
    for (const [key, entry] of this.#recent) {
      if (entry.expiresAt > now) continue;
      this.#recent.delete(key);
    }
  }
}
