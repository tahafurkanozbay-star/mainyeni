import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type SearchCacheEvictionReason =
  | 'expired'
  | 'lru'
  | 'byte-budget'
  | 'dataset-invalidated'
  | 'revision-invalidated'
  | 'manual';

export interface SearchCacheDatasetIdentity {
  readonly datasetKey: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface SearchCacheKeyInput {
  readonly dataset: SearchCacheDatasetIdentity;
  readonly requestFingerprint: string;
  readonly windowFingerprint?: string | null;
  readonly namespace?: string | null;
}

export interface SearchCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly ttlMs?: number;
  readonly maxTtlMs?: number;
  readonly maxDatasets?: number;
  readonly clock?: () => number;
}

export interface SearchCacheEntry<T> {
  readonly key: string;
  readonly dataset: SearchCacheDatasetIdentity;
  readonly requestFingerprint: string;
  readonly windowFingerprint: string;
  readonly namespace: string;
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly estimatedBytes: number;
}

export interface SearchCacheGetResult<T> {
  readonly hit: boolean;
  readonly stale: boolean;
  readonly value: T | null;
  readonly entry: SearchCacheEntry<T> | null;
}

export interface SearchCacheSetResult<T> {
  readonly stored: boolean;
  readonly reason: 'stored' | 'entry-too-large' | 'invalid-identity';
  readonly entry: SearchCacheEntry<T> | null;
  readonly evicted: number;
}

export interface SearchCacheStats {
  readonly entries: number;
  readonly datasets: number;
  readonly estimatedBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly staleMisses: number;
  readonly writes: number;
  readonly rejectedWrites: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly fingerprint: string;
}

interface NormalizedSearchCacheOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly ttlMs: number;
  readonly maxTtlMs: number;
  readonly maxDatasets: number;
  readonly clock: () => number;
}

interface MutableStats {
  hits: number;
  misses: number;
  staleMisses: number;
  writes: number;
  rejectedWrites: number;
  evictions: number;
  invalidations: number;
}

interface InternalEntry<T> {
  readonly key: string;
  readonly dataset: SearchCacheDatasetIdentity;
  readonly requestFingerprint: string;
  readonly windowFingerprint: string;
  readonly namespace: string;
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly estimatedBytes: number;
  lastAccessedAt: number;
  accessCount: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DATASETS = 64;

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const normalizeFingerprint = (value: unknown): string => normalizeText(value).slice(0, 256);

const normalizeNamespace = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120) || 'search';

const normalizeOptions = (
  options: SearchCacheOptions = {},
): NormalizedSearchCacheOptions => {
  const maxBytes = normalizeInteger(options.maxBytes, {
    min: 1_024,
    max: 512 * 1024 * 1024,
    fallback: DEFAULT_MAX_BYTES,
  });
  return Object.freeze({
    maxEntries: normalizeInteger(options.maxEntries, {
      min: 1,
      max: 100_000,
      fallback: DEFAULT_MAX_ENTRIES,
    }),
    maxBytes,
    maxEntryBytes: normalizeInteger(options.maxEntryBytes, {
      min: 256,
      max: maxBytes,
      fallback: Math.min(DEFAULT_MAX_ENTRY_BYTES, maxBytes),
    }),
    ttlMs: normalizeInteger(options.ttlMs, {
      min: 0,
      max: DEFAULT_MAX_TTL_MS,
      fallback: DEFAULT_TTL_MS,
    }),
    maxTtlMs: normalizeInteger(options.maxTtlMs, {
      min: 0,
      max: 24 * 60 * 60 * 1000,
      fallback: DEFAULT_MAX_TTL_MS,
    }),
    maxDatasets: normalizeInteger(options.maxDatasets, {
      min: 1,
      max: 10_000,
      fallback: DEFAULT_MAX_DATASETS,
    }),
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  });
};

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const normalizeIdentity = (
  identity: SearchCacheDatasetIdentity,
): SearchCacheDatasetIdentity | null => {
  const datasetKey = normalizeDatasetKey(identity.datasetKey);
  const fingerprint = normalizeFingerprint(identity.fingerprint);
  const revision = normalizeInteger(identity.revision, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: -1,
  });
  if (!datasetKey || !fingerprint || revision < 0) return null;
  return Object.freeze({ datasetKey, fingerprint, revision });
};

const estimateBytes = (value: unknown): number => {
  try {
    const serialized = stableSerialize(value);
    return Math.max(1, new TextEncoder().encode(serialized).byteLength);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
};

const createKey = (input: SearchCacheKeyInput): string => {
  const dataset = normalizeIdentity(input.dataset);
  if (!dataset) return '';
  const requestFingerprint = normalizeFingerprint(input.requestFingerprint);
  if (!requestFingerprint) return '';
  const windowFingerprint = normalizeFingerprint(input.windowFingerprint) || 'root';
  const namespace = normalizeNamespace(input.namespace);
  return hashFingerprint(stableSerialize({
    namespace,
    datasetKey: dataset.datasetKey,
    revision: dataset.revision,
    datasetFingerprint: dataset.fingerprint,
    requestFingerprint,
    windowFingerprint,
  }));
};

const freezeEntry = <T>(entry: InternalEntry<T>): SearchCacheEntry<T> => Object.freeze({
  key: entry.key,
  dataset: entry.dataset,
  requestFingerprint: entry.requestFingerprint,
  windowFingerprint: entry.windowFingerprint,
  namespace: entry.namespace,
  value: entry.value,
  createdAt: entry.createdAt,
  expiresAt: entry.expiresAt,
  lastAccessedAt: entry.lastAccessedAt,
  accessCount: entry.accessCount,
  estimatedBytes: entry.estimatedBytes,
});

export class RevisionedSearchCache<T> {
  readonly #options: NormalizedSearchCacheOptions;
  readonly #entries = new Map<string, InternalEntry<T>>();
  readonly #datasetKeys = new Map<string, Set<string>>();
  readonly #stats: MutableStats = {
    hits: 0,
    misses: 0,
    staleMisses: 0,
    writes: 0,
    rejectedWrites: 0,
    evictions: 0,
    invalidations: 0,
  };
  #estimatedBytes = 0;

  constructor(options: SearchCacheOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  key(input: SearchCacheKeyInput): string {
    return createKey(input);
  }

  get(input: SearchCacheKeyInput): SearchCacheGetResult<T> {
    const key = createKey(input);
    if (!key) {
      this.#stats.misses += 1;
      return Object.freeze({ hit: false, stale: false, value: null, entry: null });
    }
    const now = safeNow(this.#options.clock);
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#stats.misses += 1;
      return Object.freeze({ hit: false, stale: false, value: null, entry: null });
    }
    if (entry.expiresAt > 0 && now >= entry.expiresAt) {
      this.#removeEntry(entry, 'expired');
      this.#stats.misses += 1;
      this.#stats.staleMisses += 1;
      return Object.freeze({ hit: false, stale: true, value: null, entry: null });
    }
    entry.lastAccessedAt = now;
    entry.accessCount += 1;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#stats.hits += 1;
    return Object.freeze({
      hit: true,
      stale: false,
      value: entry.value,
      entry: freezeEntry(entry),
    });
  }

  set(
    input: SearchCacheKeyInput,
    value: T,
    ttlMsInput?: number,
  ): SearchCacheSetResult<T> {
    const dataset = normalizeIdentity(input.dataset);
    const key = createKey(input);
    const requestFingerprint = normalizeFingerprint(input.requestFingerprint);
    if (!dataset || !key || !requestFingerprint) {
      this.#stats.rejectedWrites += 1;
      return Object.freeze({ stored: false, reason: 'invalid-identity', entry: null, evicted: 0 });
    }

    const estimatedBytes = estimateBytes(value);
    if (estimatedBytes > this.#options.maxEntryBytes || estimatedBytes > this.#options.maxBytes) {
      this.#stats.rejectedWrites += 1;
      return Object.freeze({ stored: false, reason: 'entry-too-large', entry: null, evicted: 0 });
    }

    const now = safeNow(this.#options.clock);
    const requestedTtl = ttlMsInput === undefined
      ? this.#options.ttlMs
      : normalizeInteger(ttlMsInput, {
        min: 0,
        max: this.#options.maxTtlMs,
        fallback: this.#options.ttlMs,
      });
    const expiresAt = requestedTtl > 0 ? now + requestedTtl : 0;
    const namespace = normalizeNamespace(input.namespace);
    const windowFingerprint = normalizeFingerprint(input.windowFingerprint) || 'root';

    const previous = this.#entries.get(key);
    if (previous) this.#removeEntry(previous, 'manual', false);

    this.#ensureDatasetCapacity(dataset.datasetKey);
    const entry: InternalEntry<T> = {
      key,
      dataset,
      requestFingerprint,
      windowFingerprint,
      namespace,
      value,
      createdAt: now,
      expiresAt,
      lastAccessedAt: now,
      accessCount: 0,
      estimatedBytes,
    };
    this.#entries.set(key, entry);
    this.#estimatedBytes += estimatedBytes;
    const datasetEntries = this.#datasetKeys.get(dataset.datasetKey) ?? new Set<string>();
    datasetEntries.add(key);
    this.#datasetKeys.set(dataset.datasetKey, datasetEntries);
    this.#stats.writes += 1;

    const beforeEvictions = this.#stats.evictions;
    this.#enforceBudgets();
    return Object.freeze({
      stored: this.#entries.has(key),
      reason: 'stored',
      entry: this.#entries.has(key) ? freezeEntry(entry) : null,
      evicted: this.#stats.evictions - beforeEvictions,
    });
  }

  has(input: SearchCacheKeyInput): boolean {
    return this.get(input).hit;
  }

  invalidateDataset(datasetKeyInput: unknown): number {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    if (!datasetKey) return 0;
    const keys = [...(this.#datasetKeys.get(datasetKey) ?? [])];
    let removed = 0;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (!entry) continue;
      this.#removeEntry(entry, 'dataset-invalidated');
      removed += 1;
    }
    if (removed) this.#stats.invalidations += 1;
    return removed;
  }

  invalidateRevision(
    datasetKeyInput: unknown,
    revisionInput: unknown,
    fingerprintInput?: unknown,
  ): number {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    const revision = normalizeInteger(revisionInput, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: -1,
    });
    const fingerprint = normalizeFingerprint(fingerprintInput);
    if (!datasetKey || revision < 0) return 0;
    const keys = [...(this.#datasetKeys.get(datasetKey) ?? [])];
    let removed = 0;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (!entry) continue;
      const revisionMismatch = entry.dataset.revision !== revision;
      const fingerprintMismatch = fingerprint
        ? entry.dataset.fingerprint !== fingerprint
        : false;
      if (!revisionMismatch && !fingerprintMismatch) continue;
      this.#removeEntry(entry, 'revision-invalidated');
      removed += 1;
    }
    if (removed) this.#stats.invalidations += 1;
    return removed;
  }

  sweep(): number {
    const now = safeNow(this.#options.clock);
    let removed = 0;
    for (const entry of [...this.#entries.values()]) {
      if (entry.expiresAt <= 0 || now < entry.expiresAt) continue;
      this.#removeEntry(entry, 'expired');
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    const entries = [...this.#entries.values()];
    for (const entry of entries) this.#removeEntry(entry, 'manual');
    this.#datasetKeys.clear();
    this.#estimatedBytes = 0;
  }

  entries(datasetKeyInput?: unknown): readonly SearchCacheEntry<T>[] {
    const datasetKey = datasetKeyInput === undefined
      ? ''
      : normalizeDatasetKey(datasetKeyInput);
    return Object.freeze([...this.#entries.values()]
      .filter(entry => !datasetKey || entry.dataset.datasetKey === datasetKey)
      .map(freezeEntry));
  }

  stats(): SearchCacheStats {
    const fingerprint = hashFingerprint(stableSerialize({
      entries: [...this.#entries.values()].map(entry => [
        entry.key,
        entry.dataset.datasetKey,
        entry.dataset.revision,
        entry.dataset.fingerprint,
        entry.expiresAt,
        entry.estimatedBytes,
      ]),
      counters: this.#stats,
    }));
    return Object.freeze({
      entries: this.#entries.size,
      datasets: this.#datasetKeys.size,
      estimatedBytes: this.#estimatedBytes,
      hits: this.#stats.hits,
      misses: this.#stats.misses,
      staleMisses: this.#stats.staleMisses,
      writes: this.#stats.writes,
      rejectedWrites: this.#stats.rejectedWrites,
      evictions: this.#stats.evictions,
      invalidations: this.#stats.invalidations,
      fingerprint,
    });
  }

  #ensureDatasetCapacity(incomingDatasetKey: string): void {
    if (this.#datasetKeys.has(incomingDatasetKey)) return;
    while (this.#datasetKeys.size >= this.#options.maxDatasets) {
      const oldestEntry = this.#entries.values().next().value as InternalEntry<T> | undefined;
      if (!oldestEntry) break;
      this.invalidateDataset(oldestEntry.dataset.datasetKey);
    }
  }

  #enforceBudgets(): void {
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.values().next().value as InternalEntry<T> | undefined;
      if (!oldest) break;
      this.#removeEntry(oldest, 'lru');
    }
    while (this.#estimatedBytes > this.#options.maxBytes) {
      const oldest = this.#entries.values().next().value as InternalEntry<T> | undefined;
      if (!oldest) break;
      this.#removeEntry(oldest, 'byte-budget');
    }
  }

  #removeEntry(
    entry: InternalEntry<T>,
    _reason: SearchCacheEvictionReason,
    countEviction = true,
  ): void {
    if (!this.#entries.delete(entry.key)) return;
    this.#estimatedBytes = Math.max(0, this.#estimatedBytes - entry.estimatedBytes);
    const datasetEntries = this.#datasetKeys.get(entry.dataset.datasetKey);
    datasetEntries?.delete(entry.key);
    if (datasetEntries && datasetEntries.size === 0) {
      this.#datasetKeys.delete(entry.dataset.datasetKey);
    }
    if (countEviction) this.#stats.evictions += 1;
  }
}

export const createRevisionedSearchCache = <T>(
  options: SearchCacheOptions = {},
): RevisionedSearchCache<T> => new RevisionedSearchCache<T>(options);

export const createSearchCacheKey = (input: SearchCacheKeyInput): string => createKey(input);
