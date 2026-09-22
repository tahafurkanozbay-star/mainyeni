export type SpatialCachePriority = "background" | "normal" | "important" | "critical";

export interface SpatialCachePolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly ttlMs: number;
  readonly staleWhileRevalidateMs: number;
  readonly maxKeyLength: number;
}

export interface SpatialCacheWrite<T> {
  readonly key: string;
  readonly value: T;
  readonly byteSize: number;
  readonly priority?: SpatialCachePriority;
  readonly tags?: readonly string[];
  readonly ttlMs?: number;
}

export interface SpatialCacheEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly byteSize: number;
  readonly priority: SpatialCachePriority;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly sequence: number;
}

export interface SpatialCacheLookup<T> {
  readonly status: "hit" | "stale" | "miss";
  readonly entry?: SpatialCacheEntry<T>;
}

export interface SpatialCacheMetrics {
  readonly hits: number;
  readonly staleHits: number;
  readonly misses: number;
  readonly writes: number;
  readonly replacements: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly invalidations: number;
  readonly rejections: number;
}

export interface SpatialCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly disposed: boolean;
  readonly keys: readonly string[];
}

export interface SpatialResultCache<T> {
  get(key: string, now?: number): SpatialCacheLookup<T>;
  set(write: SpatialCacheWrite<T>, now?: number): boolean;
  delete(key: string): boolean;
  invalidateTag(tag: string): number;
  sweep(now?: number): number;
  clear(): void;
  snapshot(): SpatialCacheSnapshot;
  metrics(): SpatialCacheMetrics;
  dispose(): void;
}

export const DEFAULT_SPATIAL_CACHE_POLICY: SpatialCachePolicy = Object.freeze({
  maxEntries: 256,
  maxBytes: 32 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  ttlMs: 30_000,
  staleWhileRevalidateMs: 15_000,
  maxKeyLength: 240,
});

const PRIORITY_WEIGHT: Readonly<Record<SpatialCachePriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  important: 2,
  critical: 3,
});

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function validPolicy(policy: SpatialCachePolicy): boolean {
  return positiveInteger(policy.maxEntries)
    && positiveInteger(policy.maxBytes)
    && positiveInteger(policy.maxEntryBytes)
    && policy.maxEntryBytes <= policy.maxBytes
    && nonNegative(policy.ttlMs)
    && nonNegative(policy.staleWhileRevalidateMs)
    && positiveInteger(policy.maxKeyLength);
}

function normalizeKey(key: string, maxLength: number): string | null {
  if (typeof key !== "string") return null;
  const normalized = key.trim();
  if (normalized.length === 0 || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] | null {
  if (!tags) return Object.freeze([]);
  if (tags.length > 32) return null;
  const unique = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== "string") return null;
    const tag = raw.trim();
    if (tag.length === 0 || tag.length > 80) return null;
    unique.add(tag);
  }
  return Object.freeze(Array.from(unique).sort());
}

export function createSpatialResultCache<T>(
  policy: SpatialCachePolicy = DEFAULT_SPATIAL_CACHE_POLICY,
): SpatialResultCache<T> {
  if (!validPolicy(policy)) throw new Error("Invalid spatial cache policy");

  const entries = new Map<string, SpatialCacheEntry<T>>();
  let bytes = 0;
  let sequence = 0;
  let disposed = false;
  const counters = {
    hits: 0,
    staleHits: 0,
    misses: 0,
    writes: 0,
    replacements: 0,
    evictions: 0,
    expirations: 0,
    invalidations: 0,
    rejections: 0,
  };

  const remove = (key: string, reason: "eviction" | "expiration" | "invalidation" | "delete"): boolean => {
    const existing = entries.get(key);
    if (!existing) return false;
    entries.delete(key);
    bytes = Math.max(0, bytes - existing.byteSize);
    if (reason === "eviction") counters.evictions += 1;
    if (reason === "expiration") counters.expirations += 1;
    if (reason === "invalidation") counters.invalidations += 1;
    return true;
  };

  const expired = (entry: SpatialCacheEntry<T>, now: number): boolean => now > entry.staleUntil;

  const evictionCandidates = (incomingPriority: SpatialCachePriority): SpatialCacheEntry<T>[] => {
    const incomingWeight = PRIORITY_WEIGHT[incomingPriority];
    return Array.from(entries.values())
      .filter((entry) => PRIORITY_WEIGHT[entry.priority] <= incomingWeight)
      .sort((left, right) => {
        const priorityDelta = PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority];
        if (priorityDelta !== 0) return priorityDelta;
        if (left.lastAccessedAt !== right.lastAccessedAt) return left.lastAccessedAt - right.lastAccessedAt;
        if (left.accessCount !== right.accessCount) return left.accessCount - right.accessCount;
        return left.sequence - right.sequence;
      });
  };

  const get = (rawKey: string, now = Date.now()): SpatialCacheLookup<T> => {
    if (disposed || !finite(now)) {
      counters.misses += 1;
      return { status: "miss" };
    }
    const key = normalizeKey(rawKey, policy.maxKeyLength);
    if (!key) {
      counters.misses += 1;
      return { status: "miss" };
    }
    const entry = entries.get(key);
    if (!entry) {
      counters.misses += 1;
      return { status: "miss" };
    }
    if (expired(entry, now)) {
      remove(key, "expiration");
      counters.misses += 1;
      return { status: "miss" };
    }
    const next: SpatialCacheEntry<T> = {
      ...entry,
      lastAccessedAt: Math.max(entry.lastAccessedAt, now),
      accessCount: entry.accessCount + 1,
    };
    entries.set(key, next);
    if (now > entry.expiresAt) {
      counters.staleHits += 1;
      return { status: "stale", entry: next };
    }
    counters.hits += 1;
    return { status: "hit", entry: next };
  };

  const set = (write: SpatialCacheWrite<T>, now = Date.now()): boolean => {
    if (disposed || !finite(now)) return false;
    const key = normalizeKey(write.key, policy.maxKeyLength);
    const priority = write.priority ?? "normal";
    const tags = normalizeTags(write.tags);
    const ttlMs = write.ttlMs ?? policy.ttlMs;
    if (!key || !(priority in PRIORITY_WEIGHT) || !tags || !positiveInteger(write.byteSize)
      || write.byteSize > policy.maxEntryBytes || !nonNegative(ttlMs)) {
      counters.rejections += 1;
      return false;
    }

    const existing = entries.get(key);
    const existingBytes = existing?.byteSize ?? 0;
    let projectedBytes = bytes - existingBytes + write.byteSize;
    let projectedEntries = entries.size + (existing ? 0 : 1);
    const victims: string[] = [];

    if (projectedBytes > policy.maxBytes || projectedEntries > policy.maxEntries) {
      for (const candidate of evictionCandidates(priority)) {
        if (candidate.key === key) continue;
        victims.push(candidate.key);
        projectedBytes -= candidate.byteSize;
        projectedEntries -= 1;
        if (projectedBytes <= policy.maxBytes && projectedEntries <= policy.maxEntries) break;
      }
    }

    if (projectedBytes > policy.maxBytes || projectedEntries > policy.maxEntries) {
      counters.rejections += 1;
      return false;
    }

    for (const victim of victims) remove(victim, "eviction");
    if (existing) {
      entries.delete(key);
      bytes -= existing.byteSize;
      counters.replacements += 1;
    }

    const expiresAt = now + ttlMs;
    const entry: SpatialCacheEntry<T> = Object.freeze({
      key,
      value: write.value,
      byteSize: write.byteSize,
      priority,
      tags,
      createdAt: now,
      expiresAt,
      staleUntil: expiresAt + policy.staleWhileRevalidateMs,
      lastAccessedAt: now,
      accessCount: 0,
      sequence: ++sequence,
    });
    entries.set(key, entry);
    bytes += write.byteSize;
    counters.writes += 1;
    return true;
  };

  const deleteEntry = (rawKey: string): boolean => {
    if (disposed) return false;
    const key = normalizeKey(rawKey, policy.maxKeyLength);
    return key ? remove(key, "delete") : false;
  };

  const invalidateTag = (rawTag: string): number => {
    if (disposed || typeof rawTag !== "string") return 0;
    const tag = rawTag.trim();
    if (!tag) return 0;
    const keys: string[] = [];
    for (const entry of entries.values()) {
      if (entry.tags.includes(tag)) keys.push(entry.key);
    }
    for (const key of keys) remove(key, "invalidation");
    return keys.length;
  };

  const sweep = (now = Date.now()): number => {
    if (disposed || !finite(now)) return 0;
    const keys: string[] = [];
    for (const entry of entries.values()) {
      if (expired(entry, now)) keys.push(entry.key);
    }
    for (const key of keys) remove(key, "expiration");
    return keys.length;
  };

  const clear = (): void => {
    if (disposed) return;
    entries.clear();
    bytes = 0;
  };

  const snapshot = (): SpatialCacheSnapshot => ({
    entries: entries.size,
    bytes,
    disposed,
    keys: Array.from(entries.keys()).sort(),
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    entries.clear();
    bytes = 0;
  };

  return {
    get,
    set,
    delete: deleteEntry,
    invalidateTag,
    sweep,
    clear,
    snapshot,
    metrics: () => ({ ...counters }),
    dispose,
  };
}
