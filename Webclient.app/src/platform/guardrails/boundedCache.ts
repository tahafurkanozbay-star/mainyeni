export interface BoundedCachePolicy {
  readonly capacity: number;
  readonly ttlMs: number;
  readonly maxKeyLength: number;
  readonly maxEstimatedWeight: number;
  readonly maxEntryWeight: number;
}

export interface BoundedCacheEntrySnapshot {
  readonly key: string;
  readonly createdAt: number;
  readonly touchedAt: number;
  readonly expiresAt: number;
  readonly estimatedWeight: number;
  readonly hits: number;
}

export interface BoundedCacheSnapshot {
  readonly size: number;
  readonly estimatedWeight: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly entries: readonly BoundedCacheEntrySnapshot[];
}

export interface BoundedCacheSetOptions {
  readonly ttlMs?: number;
  readonly estimatedWeight?: number;
}

export interface BoundedCache<K extends string, V> {
  readonly get: (key: K, at?: number) => V | undefined;
  readonly peek: (key: K, at?: number) => V | undefined;
  readonly set: (key: K, value: V, options?: BoundedCacheSetOptions, at?: number) => boolean;
  readonly has: (key: K, at?: number) => boolean;
  readonly delete: (key: K) => boolean;
  readonly sweep: (at?: number) => number;
  readonly snapshot: () => BoundedCacheSnapshot;
  readonly clear: () => void;
  readonly dispose: () => void;
}

export const DEFAULT_BOUNDED_CACHE_POLICY: BoundedCachePolicy = Object.freeze({
  capacity: 256,
  ttlMs: 60_000,
  maxKeyLength: 256,
  maxEstimatedWeight: 8 * 1024 * 1024,
  maxEntryWeight: 512 * 1024,
});

interface MutableEntry<V> {
  key: string;
  value: V;
  createdAt: number;
  touchedAt: number;
  expiresAt: number;
  estimatedWeight: number;
  hits: number;
  sequence: number;
}

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

export const normalizeBoundedCachePolicy = (
  input: Partial<BoundedCachePolicy> = {},
): BoundedCachePolicy => Object.freeze({
  capacity: positiveInt(input.capacity ?? DEFAULT_BOUNDED_CACHE_POLICY.capacity, DEFAULT_BOUNDED_CACHE_POLICY.capacity),
  ttlMs: positiveInt(input.ttlMs ?? DEFAULT_BOUNDED_CACHE_POLICY.ttlMs, DEFAULT_BOUNDED_CACHE_POLICY.ttlMs),
  maxKeyLength: positiveInt(input.maxKeyLength ?? DEFAULT_BOUNDED_CACHE_POLICY.maxKeyLength, DEFAULT_BOUNDED_CACHE_POLICY.maxKeyLength),
  maxEstimatedWeight: positiveInt(
    input.maxEstimatedWeight ?? DEFAULT_BOUNDED_CACHE_POLICY.maxEstimatedWeight,
    DEFAULT_BOUNDED_CACHE_POLICY.maxEstimatedWeight,
  ),
  maxEntryWeight: positiveInt(
    input.maxEntryWeight ?? DEFAULT_BOUNDED_CACHE_POLICY.maxEntryWeight,
    DEFAULT_BOUNDED_CACHE_POLICY.maxEntryWeight,
  ),
});

const snapshotEntry = <V>(entry: MutableEntry<V>): BoundedCacheEntrySnapshot =>
  Object.freeze({
    key: entry.key,
    createdAt: entry.createdAt,
    touchedAt: entry.touchedAt,
    expiresAt: entry.expiresAt,
    estimatedWeight: entry.estimatedWeight,
    hits: entry.hits,
  });

export const createBoundedCache = <K extends string, V>(
  policyInput: Partial<BoundedCachePolicy> = {},
  now: () => number = Date.now,
): BoundedCache<K, V> => {
  const policy = normalizeBoundedCachePolicy(policyInput);
  const entries = new Map<string, MutableEntry<V>>();
  let estimatedWeight = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expirations = 0;
  let sequence = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Bounded cache is disposed.');
  };

  const timestamp = (value?: number): number => {
    if (value !== undefined && Number.isFinite(value)) return value;
    return now();
  };

  const normalizeKey = (input: string): string =>
    input.trim().slice(0, policy.maxKeyLength);

  const removeEntry = (key: string, reason: 'delete' | 'evict' | 'expire'): boolean => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    estimatedWeight = Math.max(0, estimatedWeight - entry.estimatedWeight);
    if (reason === 'evict') evictions += 1;
    if (reason === 'expire') expirations += 1;
    return true;
  };

  const isExpired = (entry: MutableEntry<V>, at: number): boolean =>
    at >= entry.expiresAt;

  const sweep = (atInput?: number): number => {
    assertActive();
    const at = timestamp(atInput);
    let removed = 0;
    for (const [key, entry] of [...entries]) {
      if (!isExpired(entry, at)) continue;
      if (removeEntry(key, 'expire')) removed += 1;
    }
    return removed;
  };

  const evictionCandidate = (excludedKey?: string): MutableEntry<V> | null => {
    let candidate: MutableEntry<V> | null = null;
    for (const entry of entries.values()) {
      if (entry.key === excludedKey) continue;
      if (!candidate) {
        candidate = entry;
        continue;
      }
      if (entry.touchedAt < candidate.touchedAt) {
        candidate = entry;
        continue;
      }
      if (entry.touchedAt === candidate.touchedAt && entry.sequence < candidate.sequence) {
        candidate = entry;
      }
    }
    return candidate;
  };

  const ensureCapacity = (incomingWeight: number, replacingKey?: string): boolean => {
    const replacing = replacingKey ? entries.get(replacingKey) : undefined;
    const existingWeight = replacing?.estimatedWeight ?? 0;

    while (
      entries.size - (replacing ? 1 : 0) >= policy.capacity ||
      estimatedWeight - existingWeight + incomingWeight > policy.maxEstimatedWeight
    ) {
      const candidate = evictionCandidate(replacingKey);
      if (!candidate) return false;
      removeEntry(candidate.key, 'evict');
    }
    return true;
  };

  const get = (keyInput: K, atInput?: number): V | undefined => {
    assertActive();
    const key = normalizeKey(keyInput);
    const entry = entries.get(key);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    const at = timestamp(atInput);
    if (isExpired(entry, at)) {
      removeEntry(key, 'expire');
      misses += 1;
      return undefined;
    }
    entry.touchedAt = Math.max(entry.touchedAt, at);
    entry.hits += 1;
    hits += 1;
    return entry.value;
  };

  const peek = (keyInput: K, atInput?: number): V | undefined => {
    assertActive();
    const key = normalizeKey(keyInput);
    const entry = entries.get(key);
    if (!entry) return undefined;
    const at = timestamp(atInput);
    if (isExpired(entry, at)) {
      removeEntry(key, 'expire');
      return undefined;
    }
    return entry.value;
  };

  const set = (
    keyInput: K,
    value: V,
    options: BoundedCacheSetOptions = {},
    atInput?: number,
  ): boolean => {
    assertActive();
    const key = normalizeKey(keyInput);
    if (key.length === 0) return false;
    const at = timestamp(atInput);
    const ttlMs = positiveInt(options.ttlMs ?? policy.ttlMs, policy.ttlMs);
    const weight = positiveInt(options.estimatedWeight ?? 1, 1);

    if (weight > policy.maxEntryWeight || weight > policy.maxEstimatedWeight) {
      return false;
    }

    sweep(at);
    if (!ensureCapacity(weight, key)) return false;

    const existing = entries.get(key);
    if (!existing && entries.size >= policy.capacity) return false;

    const currentWeight = existing?.estimatedWeight ?? 0;
    if (estimatedWeight - currentWeight + weight > policy.maxEstimatedWeight) {
      return false;
    }

    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    const entry: MutableEntry<V> = {
      key,
      value,
      createdAt: existing?.createdAt ?? at,
      touchedAt: at,
      expiresAt: at + ttlMs,
      estimatedWeight: weight,
      hits: existing?.hits ?? 0,
      sequence,
    };
    entries.set(key, entry);
    estimatedWeight = estimatedWeight - currentWeight + weight;
    return true;
  };

  const has = (key: K, at?: number): boolean => peek(key, at) !== undefined;

  const deleteEntry = (keyInput: K): boolean => {
    assertActive();
    return removeEntry(normalizeKey(keyInput), 'delete');
  };

  const snapshot = (): BoundedCacheSnapshot => {
    assertActive();
    const values = [...entries.values()]
      .sort((left, right) =>
        right.touchedAt - left.touchedAt || right.sequence - left.sequence,
      )
      .map(snapshotEntry);
    return Object.freeze({
      size: entries.size,
      estimatedWeight,
      hits,
      misses,
      evictions,
      expirations,
      entries: Object.freeze(values),
    });
  };

  const clear = (): void => {
    assertActive();
    entries.clear();
    estimatedWeight = 0;
    hits = 0;
    misses = 0;
    evictions = 0;
    expirations = 0;
  };

  const dispose = (): void => {
    entries.clear();
    estimatedWeight = 0;
    disposed = true;
  };

  return Object.freeze({
    get,
    peek,
    set,
    has,
    delete: deleteEntry,
    sweep,
    snapshot,
    clear,
    dispose,
  });
};
