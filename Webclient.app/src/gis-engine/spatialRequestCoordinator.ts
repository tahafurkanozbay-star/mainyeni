export type SpatialRequestPriority = 'interactive' | 'visible' | 'prefetch';

export type SpatialRequestSnapshot = Readonly<{
  key: string;
  priority: SpatialRequestPriority;
  state: 'queued' | 'running' | 'fulfilled' | 'rejected' | 'cancelled';
  subscribers: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}>;

export type SpatialRequestContext = Readonly<{
  key: string;
  signal: AbortSignal;
}>;

export type SpatialRequestOptions = Readonly<{
  priority?: SpatialRequestPriority;
  signal?: AbortSignal;
  cacheTtlMs?: number;
}>;

export class SpatialRequestCoordinatorError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SPATIAL_REQUEST_COORDINATOR_ERROR') {
    super(message);
    this.name = 'SpatialRequestCoordinatorError';
    this.code = code;
  }
}

type Subscriber<T> = {
  resolve(value: T): void;
  reject(error: unknown): void;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
};

type Entry<T> = {
  key: string;
  priority: SpatialRequestPriority;
  state: SpatialRequestSnapshot['state'];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  controller: AbortController;
  operation: (context: SpatialRequestContext) => Promise<T>;
  subscribers: Set<Subscriber<T>>;
  cacheTtlMs: number;
};

type CachedValue<T> = { value: T; expiresAt: number };

const priorityRank: Readonly<Record<SpatialRequestPriority, number>> = Object.freeze({
  interactive: 3,
  visible: 2,
  prefetch: 1,
});

const normalizedKey = (value: unknown): string => {
  const key = String(value ?? '').trim();
  if (!key || key.length > 1024) throw new SpatialRequestCoordinatorError('Spatial request key must be non-empty and bounded.', 'INVALID_REQUEST_KEY');
  return key;
};

const boundedInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const boundedTtl = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), 300_000);
};

const abortError = (reason: unknown): Error => {
  const error = new Error(String(reason ?? 'Spatial request cancelled'));
  error.name = 'AbortError';
  return error;
};

/**
 * Coordinates expensive spatial/query work without owning network transport.
 * Equal request keys share one execution; subscriber cancellation is isolated,
 * while the underlying work is aborted once its last subscriber leaves.
 * Concurrency and queue cardinality are bounded to cap CPU/network/memory load.
 */
export const createSpatialRequestCoordinator = (options: Readonly<{
  concurrency?: number;
  maximumQueued?: number;
  maximumCacheEntries?: number;
  now?: () => number;
}> = {}): Readonly<{
  run<T>(key: string, operation: (context: SpatialRequestContext) => Promise<T>, requestOptions?: SpatialRequestOptions): Promise<T>;
  cancel(key: string, reason?: unknown): boolean;
  invalidate(key?: string): number;
  snapshot(key: string): SpatialRequestSnapshot | null;
  snapshots(): readonly SpatialRequestSnapshot[];
  dispose(): void;
}> => {
  const concurrency = boundedInteger(options.concurrency, 6, 64);
  const maximumQueued = boundedInteger(options.maximumQueued, 256, 4096);
  const maximumCacheEntries = boundedInteger(options.maximumCacheEntries, 128, 2048);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry<unknown>>();
  const cache = new Map<string, CachedValue<unknown>>();
  let running = 0;
  let disposed = false;

  const snapshotEntry = (entry: Entry<unknown>): SpatialRequestSnapshot => Object.freeze({
    key: entry.key,
    priority: entry.priority,
    state: entry.state,
    subscribers: entry.subscribers.size,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  });

  const cleanupSubscriber = (subscriber: Subscriber<unknown>): void => {
    if (subscriber.signal && subscriber.abortListener) subscriber.signal.removeEventListener('abort', subscriber.abortListener);
    subscriber.abortListener = null;
  };

  const settleSubscribers = (entry: Entry<unknown>, value: unknown, error: unknown): void => {
    for (const subscriber of entry.subscribers) {
      cleanupSubscriber(subscriber);
      if (error === null) subscriber.resolve(value);
      else subscriber.reject(error);
    }
    entry.subscribers.clear();
  };

  const trimCache = (): void => {
    const timestamp = now();
    for (const [key, item] of cache) if (item.expiresAt <= timestamp) cache.delete(key);
    while (cache.size > maximumCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const pickNext = (): Entry<unknown> | null => {
    let selected: Entry<unknown> | null = null;
    for (const entry of entries.values()) {
      if (entry.state !== 'queued' || entry.subscribers.size === 0) continue;
      if (!selected || priorityRank[entry.priority] > priorityRank[selected.priority] || (
        priorityRank[entry.priority] === priorityRank[selected.priority] && entry.createdAt < selected.createdAt
      )) selected = entry;
    }
    return selected;
  };

  const pump = (): void => {
    if (disposed) return;
    while (running < concurrency) {
      const entry = pickNext();
      if (!entry) break;
      entry.state = 'running';
      entry.startedAt = now();
      running += 1;
      void Promise.resolve(entry.operation({ key: entry.key, signal: entry.controller.signal })).then((value) => {
        if (entry.controller.signal.aborted) throw abortError(entry.controller.signal.reason);
        entry.state = 'fulfilled';
        entry.finishedAt = now();
        if (entry.cacheTtlMs > 0) {
          cache.delete(entry.key);
          cache.set(entry.key, { value, expiresAt: entry.finishedAt + entry.cacheTtlMs });
          trimCache();
        }
        settleSubscribers(entry, value, null);
      }).catch((error: unknown) => {
        entry.state = entry.controller.signal.aborted ? 'cancelled' : 'rejected';
        entry.finishedAt = now();
        settleSubscribers(entry, undefined, entry.controller.signal.aborted ? abortError(entry.controller.signal.reason) : error);
      }).finally(() => {
        running -= 1;
        entries.delete(entry.key);
        pump();
      });
    }
  };

  const run = <T>(
    rawKey: string,
    operation: (context: SpatialRequestContext) => Promise<T>,
    requestOptions: SpatialRequestOptions = {},
  ): Promise<T> => {
    if (disposed) return Promise.reject(new SpatialRequestCoordinatorError('Spatial request coordinator is disposed.', 'DISPOSED'));
    const key = normalizedKey(rawKey);
    if (typeof operation !== 'function') return Promise.reject(new SpatialRequestCoordinatorError('Spatial request operation is required.', 'MISSING_OPERATION'));
    trimCache();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value as T);

    let entry = entries.get(key) as Entry<T> | undefined;
    if (!entry) {
      const queuedCount = Array.from(entries.values()).filter((candidate) => candidate.state === 'queued').length;
      if (running >= concurrency && queuedCount >= maximumQueued) {
        return Promise.reject(new SpatialRequestCoordinatorError('Spatial request queue budget exceeded.', 'QUEUE_BUDGET_EXCEEDED'));
      }
      entry = {
        key,
        priority: requestOptions.priority ?? 'visible',
        state: 'queued',
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        controller: new AbortController(),
        operation,
        subscribers: new Set(),
        cacheTtlMs: boundedTtl(requestOptions.cacheTtlMs),
      };
      entries.set(key, entry as Entry<unknown>);
    } else if (priorityRank[requestOptions.priority ?? 'visible'] > priorityRank[entry.priority]) {
      entry.priority = requestOptions.priority ?? 'visible';
    }

    return new Promise<T>((resolve, reject) => {
      const signal = requestOptions.signal ?? null;
      if (signal?.aborted) {
        reject(abortError(signal.reason));
        return;
      }
      const subscriber: Subscriber<T> = { resolve, reject, signal, abortListener: null };
      const abortListener = (): void => {
        entry?.subscribers.delete(subscriber);
        cleanupSubscriber(subscriber as Subscriber<unknown>);
        reject(abortError(signal?.reason));
        if (entry && entry.subscribers.size === 0) {
          entry.controller.abort('No spatial request subscribers remain');
          if (entry.state === 'queued') {
            entry.state = 'cancelled';
            entry.finishedAt = now();
            entries.delete(entry.key);
          }
        }
      };
      subscriber.abortListener = abortListener;
      signal?.addEventListener('abort', abortListener, { once: true });
      entry?.subscribers.add(subscriber);
      pump();
    });
  };

  const cancel = (rawKey: string, reason: unknown = 'Spatial request cancelled'): boolean => {
    const key = normalizedKey(rawKey);
    const entry = entries.get(key);
    if (!entry) return false;
    entry.controller.abort(reason);
    if (entry.state === 'queued') {
      entry.state = 'cancelled';
      entry.finishedAt = now();
      settleSubscribers(entry, undefined, abortError(reason));
      entries.delete(key);
    }
    return true;
  };

  const invalidate = (rawKey?: string): number => {
    if (rawKey !== undefined) return cache.delete(normalizedKey(rawKey)) ? 1 : 0;
    const count = cache.size;
    cache.clear();
    return count;
  };

  const snapshot = (rawKey: string): SpatialRequestSnapshot | null => {
    const entry = entries.get(normalizedKey(rawKey));
    return entry ? snapshotEntry(entry) : null;
  };

  const snapshots = (): readonly SpatialRequestSnapshot[] => Object.freeze(Array.from(entries.values(), snapshotEntry));

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cache.clear();
    for (const entry of entries.values()) {
      entry.controller.abort('Spatial request coordinator disposed');
      settleSubscribers(entry, undefined, abortError('Spatial request coordinator disposed'));
    }
    entries.clear();
  };

  return Object.freeze({ run, cancel, invalidate, snapshot, snapshots, dispose });
};
