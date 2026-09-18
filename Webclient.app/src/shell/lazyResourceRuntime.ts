export type LazyResourceLoader<T> = (
  key: string,
  context: { readonly signal: AbortSignal },
) => Promise<T>;

export interface LazyResourceLoadOptions {
  readonly signal?: AbortSignal;
  readonly ttlMs?: number | null;
  readonly forceRefresh?: boolean;
}

export interface LazyResourceEntrySnapshot {
  readonly key: string;
  readonly status: 'loading' | 'ready';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly hits: number;
}

export interface LazyResourceRuntimeSnapshot {
  readonly capacity: number;
  readonly entryCount: number;
  readonly totalLoads: number;
  readonly cacheHits: number;
  readonly dedupedLoads: number;
  readonly failures: number;
  readonly evictions: number;
  readonly entries: readonly LazyResourceEntrySnapshot[];
}

export interface LazyResourceRuntime<T> {
  readonly load: (
    key: string,
    loader: LazyResourceLoader<T>,
    options?: LazyResourceLoadOptions,
  ) => Promise<T>;
  readonly has: (key: string) => boolean;
  readonly evict: (key: string) => boolean;
  readonly clear: () => number;
  readonly snapshot: () => LazyResourceRuntimeSnapshot;
  readonly destroy: () => void;
}

export interface LazyResourceRuntimeOptions {
  readonly capacity?: number;
  readonly defaultTtlMs?: number | null;
  readonly now?: () => number;
}

interface Entry<T> {
  key: string;
  status: 'loading' | 'ready';
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  hits: number;
  promise: Promise<T>;
  value?: T;
  controller: AbortController;
}

const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const keyOf = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Lazy resource key must be a string.');
  const normalized = value.trim();
  if (!normalized) throw new TypeError('Lazy resource key cannot be empty.');
  if (normalized.length > 200) throw new RangeError('Lazy resource key exceeds 200 characters.');
  return normalized;
};

const abortError = (): DOMException => new DOMException('Lazy resource load aborted.', 'AbortError');

const wrapSubscriber = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
};

export const createLazyResourceRuntime = <T>(
  options: LazyResourceRuntimeOptions = {},
): LazyResourceRuntime<T> => {
  const capacity = integer(options.capacity, 32, 1, 256);
  const defaultTtlMs = options.defaultTtlMs === null
    ? null
    : integer(options.defaultTtlMs, 300_000, 250, 86_400_000);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry<T>>();
  let destroyed = false;
  let totalLoads = 0;
  let cacheHits = 0;
  let dedupedLoads = 0;
  let failures = 0;
  let evictions = 0;

  const timestamp = (): number => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('Lazy resource clock must be finite.');
    return value;
  };

  const assertActive = (): void => {
    if (destroyed) throw new Error('Lazy resource runtime is destroyed.');
  };

  const ttlFor = (value: number | null | undefined): number | null => {
    if (value === null) return null;
    if (value === undefined) return defaultTtlMs;
    return integer(value, defaultTtlMs ?? 300_000, 250, 86_400_000);
  };

  const expired = (entry: Entry<T>, at: number): boolean =>
    entry.status === 'ready' && entry.expiresAt !== null && entry.expiresAt <= at;

  const removeEntry = (key: string, abort = false): Entry<T> | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    if (abort && entry.status === 'loading') entry.controller.abort();
    return entry;
  };

  const purgeExpired = (at: number): void => {
    for (const [key, entry] of entries) {
      if (expired(entry, at)) removeEntry(key);
    }
  };

  const enforceCapacity = (): void => {
    while (entries.size > capacity) {
      const candidate = [...entries.values()]
        .filter((entry) => entry.status === 'ready')
        .sort((left, right) =>
          left.updatedAt - right.updatedAt
          || left.createdAt - right.createdAt
          || left.key.localeCompare(right.key))[0];
      if (!candidate) {
        throw new Error('Lazy resource capacity exceeded by in-flight work.');
      }
      removeEntry(candidate.key);
      evictions += 1;
    }
  };

  const load = async (
    keyInput: string,
    loader: LazyResourceLoader<T>,
    loadOptions: LazyResourceLoadOptions = {},
  ): Promise<T> => {
    assertActive();
    if (typeof loader !== 'function') throw new TypeError('Lazy resource loader must be a function.');
    const key = keyOf(keyInput);
    const at = timestamp();
    purgeExpired(at);

    const existing = entries.get(key);
    if (existing && loadOptions.forceRefresh !== true) {
      existing.hits += 1;
      existing.updatedAt = at;
      if (existing.status === 'ready') cacheHits += 1;
      else dedupedLoads += 1;
      return wrapSubscriber(existing.promise, loadOptions.signal);
    }

    if (existing && loadOptions.forceRefresh === true) {
      removeEntry(key, true);
    }

    if (entries.size >= capacity) {
      enforceCapacity();
      if (entries.size >= capacity) {
        const candidate = [...entries.values()]
          .filter((entry) => entry.status === 'ready')
          .sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (candidate) {
          removeEntry(candidate.key);
          evictions += 1;
        } else {
          throw new Error('Lazy resource capacity exceeded by in-flight work.');
        }
      }
    }

    const controller = new AbortController();
    const ttlMs = ttlFor(loadOptions.ttlMs);
    totalLoads += 1;

    const entry: Entry<T> = {
      key,
      status: 'loading',
      createdAt: at,
      updatedAt: at,
      expiresAt: null,
      hits: 0,
      controller,
      promise: Promise.resolve(undefined as T),
    };

    const promise = Promise.resolve()
      .then(() => loader(key, { signal: controller.signal }))
      .then((value) => {
        if (destroyed || controller.signal.aborted) throw abortError();
        const current = entries.get(key);
        if (current !== entry) return value;
        const completedAt = timestamp();
        entry.status = 'ready';
        entry.value = value;
        entry.updatedAt = completedAt;
        entry.expiresAt = ttlMs === null ? null : completedAt + ttlMs;
        entry.promise = Promise.resolve(value);
        enforceCapacity();
        return value;
      })
      .catch((error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        if (!(error instanceof DOMException && error.name === 'AbortError')) failures += 1;
        throw error;
      });

    entry.promise = promise;
    entries.set(key, entry);
    enforceCapacity();
    return wrapSubscriber(promise, loadOptions.signal);
  };

  const has = (keyInput: string): boolean => {
    assertActive();
    const key = keyOf(keyInput);
    const at = timestamp();
    const entry = entries.get(key);
    if (!entry) return false;
    if (expired(entry, at)) {
      entries.delete(key);
      return false;
    }
    return true;
  };

  const evict = (keyInput: string): boolean => {
    assertActive();
    const removed = removeEntry(keyOf(keyInput), true);
    if (!removed) return false;
    evictions += 1;
    return true;
  };

  const clear = (): number => {
    assertActive();
    const count = entries.size;
    for (const entry of entries.values()) {
      if (entry.status === 'loading') entry.controller.abort();
    }
    entries.clear();
    evictions += count;
    return count;
  };

  const snapshot = (): LazyResourceRuntimeSnapshot => {
    assertActive();
    purgeExpired(timestamp());
    return Object.freeze({
      capacity,
      entryCount: entries.size,
      totalLoads,
      cacheHits,
      dedupedLoads,
      failures,
      evictions,
      entries: Object.freeze([...entries.values()]
        .map((entry) => Object.freeze({
          key: entry.key,
          status: entry.status,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          expiresAt: entry.expiresAt,
          hits: entry.hits,
        }))
        .sort((left, right) => left.key.localeCompare(right.key))),
    });
  };

  const destroy = (): void => {
    if (destroyed) return;
    for (const entry of entries.values()) {
      if (entry.status === 'loading') entry.controller.abort();
    }
    entries.clear();
    destroyed = true;
  };

  return Object.freeze({ load, has, evict, clear, snapshot, destroy });
};
