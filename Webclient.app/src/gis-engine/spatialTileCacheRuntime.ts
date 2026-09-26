export type SpatialTileCachePressure = 'normal' | 'elevated' | 'critical';

export interface SpatialTileCacheKey {
  readonly layerId: string;
  readonly level: number;
  readonly row: number;
  readonly column: number;
  readonly variant?: string;
}

export interface SpatialTileCacheEntry<T> {
  readonly key: SpatialTileCacheKey;
  readonly value: T;
  readonly byteSize: number;
  readonly insertedAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly expiresAt: number;
  readonly pinned: boolean;
}

export interface SpatialTileCacheLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly maxPinnedEntries: number;
}

export interface SpatialTileCachePutOptions {
  readonly byteSize: number;
  readonly ttlMs?: number;
  readonly pinned?: boolean;
  readonly now?: number;
}

export interface SpatialTileCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly pinnedEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly rejected: number;
  readonly pressure: SpatialTileCachePressure;
}

const DEFAULT_LIMITS: SpatialTileCacheLimits = Object.freeze({
  maxEntries: 512,
  maxBytes: 64 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  defaultTtlMs: 5 * 60_000,
  maxTtlMs: 60 * 60_000,
  maxPinnedEntries: 32,
});

const finite = (value: number): boolean => Number.isFinite(value);
const integer = (value: number): boolean => Number.isInteger(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const cleanSegment = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 160) throw new RangeError(name);
  if (!/^[\p{L}\p{N}_.:@/ -]+$/u.test(normalized)) throw new TypeError(name);
  return normalized;
};

const normalizeKey = (input: SpatialTileCacheKey): SpatialTileCacheKey => {
  const layerId = cleanSegment(input.layerId, 'layerId');
  if (!integer(input.level) || input.level < 0 || input.level > 64) throw new RangeError('level');
  if (!integer(input.row) || input.row < 0 || input.row > 0x7fffffff) throw new RangeError('row');
  if (!integer(input.column) || input.column < 0 || input.column > 0x7fffffff) throw new RangeError('column');
  const variant = input.variant === undefined ? undefined : cleanSegment(input.variant, 'variant');
  return Object.freeze({ layerId, level: input.level, row: input.row, column: input.column, ...(variant ? { variant } : {}) });
};

const fingerprint = (key: SpatialTileCacheKey): string => `${key.layerId}\u0000${key.level}\u0000${key.row}\u0000${key.column}\u0000${key.variant ?? ''}`;

interface MutableEntry<T> {
  key: SpatialTileCacheKey;
  value: T;
  byteSize: number;
  insertedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  expiresAt: number;
  pinned: boolean;
}

/** Transport-neutral bounded cache for already-verified spatial tile payloads. */
export class SpatialTileCacheRuntime<T> {
  readonly #limits: SpatialTileCacheLimits;
  readonly #entries = new Map<string, MutableEntry<T>>();
  #bytes = 0;
  #pinnedEntries = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #expirations = 0;
  #rejected = 0;

  constructor(limits: Partial<SpatialTileCacheLimits> = {}) {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    if (!integer(merged.maxEntries) || merged.maxEntries < 1 || merged.maxEntries > 100_000) throw new RangeError('maxEntries');
    if (!integer(merged.maxBytes) || merged.maxBytes < 1024 || merged.maxBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxBytes');
    if (!integer(merged.maxEntryBytes) || merged.maxEntryBytes < 1 || merged.maxEntryBytes > merged.maxBytes) throw new RangeError('maxEntryBytes');
    if (!finite(merged.defaultTtlMs) || merged.defaultTtlMs < 1 || merged.defaultTtlMs > merged.maxTtlMs) throw new RangeError('defaultTtlMs');
    if (!finite(merged.maxTtlMs) || merged.maxTtlMs < 1) throw new RangeError('maxTtlMs');
    if (!integer(merged.maxPinnedEntries) || merged.maxPinnedEntries < 0 || merged.maxPinnedEntries > merged.maxEntries) throw new RangeError('maxPinnedEntries');
    this.#limits = Object.freeze(merged);
  }

  get size(): number { return this.#entries.size; }
  get byteSize(): number { return this.#bytes; }

  has(key: SpatialTileCacheKey, now = Date.now()): boolean {
    const id = fingerprint(normalizeKey(key));
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (this.#isExpired(entry, now)) { this.#remove(id, 'expiration'); return false; }
    return true;
  }

  get(key: SpatialTileCacheKey, now = Date.now()): T | undefined {
    const id = fingerprint(normalizeKey(key));
    const entry = this.#entries.get(id);
    if (!entry) { this.#misses += 1; return undefined; }
    if (this.#isExpired(entry, now)) { this.#remove(id, 'expiration'); this.#misses += 1; return undefined; }
    entry.lastAccessedAt = now;
    entry.accessCount += 1;
    this.#hits += 1;
    return entry.value;
  }

  peek(key: SpatialTileCacheKey, now = Date.now()): T | undefined {
    const id = fingerprint(normalizeKey(key));
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (this.#isExpired(entry, now)) { this.#remove(id, 'expiration'); return undefined; }
    return entry.value;
  }

  put(key: SpatialTileCacheKey, value: T, options: SpatialTileCachePutOptions): boolean {
    const normalized = normalizeKey(key);
    const now = options.now ?? Date.now();
    if (!finite(now) || now < 0) throw new RangeError('now');
    if (!integer(options.byteSize) || options.byteSize < 0) throw new RangeError('byteSize');
    if (options.byteSize > this.#limits.maxEntryBytes || options.byteSize > this.#limits.maxBytes) { this.#rejected += 1; return false; }
    const ttlMs = clamp(options.ttlMs ?? this.#limits.defaultTtlMs, 1, this.#limits.maxTtlMs);
    if (!finite(ttlMs)) throw new RangeError('ttlMs');
    const id = fingerprint(normalized);
    const existing = this.#entries.get(id);
    const pinned = options.pinned === true;
    const pinnedAfterReplace = this.#pinnedEntries - (existing?.pinned ? 1 : 0) + (pinned ? 1 : 0);
    if (pinnedAfterReplace > this.#limits.maxPinnedEntries) { this.#rejected += 1; return false; }
    const previous = existing ? { ...existing } : undefined;
    if (existing) this.#remove(id, 'replace');
    this.#entries.set(id, { key: normalized, value, byteSize: options.byteSize, insertedAt: now, lastAccessedAt: now, accessCount: 0, expiresAt: now + ttlMs, pinned });
    this.#bytes += options.byteSize;
    if (pinned) this.#pinnedEntries += 1;
    this.pruneExpired(now);
    if (!this.#evictToBudget(id)) {
      this.#remove(id, 'reject');
      if (previous && !this.#isExpired(previous, now)) this.#restore(id, previous);
      this.#rejected += 1;
      return false;
    }
    return true;
  }

  delete(key: SpatialTileCacheKey): boolean { return this.#remove(fingerprint(normalizeKey(key)), 'delete'); }

  clear(options: { readonly includePinned?: boolean } = {}): number {
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (options.includePinned !== true && entry.pinned) continue;
      if (this.#remove(id, 'delete')) removed += 1;
    }
    return removed;
  }

  pruneExpired(now = Date.now()): number {
    if (!finite(now) || now < 0) throw new RangeError('now');
    let removed = 0;
    for (const [id, entry] of this.#entries) if (this.#isExpired(entry, now)) { this.#remove(id, 'expiration'); removed += 1; }
    return removed;
  }

  setPinned(key: SpatialTileCacheKey, pinned: boolean, now = Date.now()): boolean {
    const id = fingerprint(normalizeKey(key));
    const entry = this.#entries.get(id);
    if (!entry || this.#isExpired(entry, now)) { if (entry) this.#remove(id, 'expiration'); return false; }
    if (entry.pinned === pinned) return true;
    if (pinned && this.#pinnedEntries >= this.#limits.maxPinnedEntries) return false;
    entry.pinned = pinned;
    this.#pinnedEntries += pinned ? 1 : -1;
    return true;
  }

  entries(now = Date.now()): readonly SpatialTileCacheEntry<T>[] {
    this.pruneExpired(now);
    return Object.freeze([...this.#entries.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.insertedAt - b.insertedAt || fingerprint(a.key).localeCompare(fingerprint(b.key))).map((entry) => Object.freeze({ ...entry })));
  }

  snapshot(now = Date.now()): SpatialTileCacheSnapshot {
    this.pruneExpired(now);
    const ratio = Math.max(this.#entries.size / this.#limits.maxEntries, this.#bytes / this.#limits.maxBytes);
    return Object.freeze({ entries: this.#entries.size, bytes: this.#bytes, pinnedEntries: this.#pinnedEntries, hits: this.#hits, misses: this.#misses, evictions: this.#evictions, expirations: this.#expirations, rejected: this.#rejected, pressure: ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'elevated' : 'normal' });
  }

  #isExpired(entry: MutableEntry<T>, now: number): boolean { return now >= entry.expiresAt; }
  #restore(id: string, entry: MutableEntry<T>): void { this.#entries.set(id, entry); this.#bytes += entry.byteSize; if (entry.pinned) this.#pinnedEntries += 1; }
  #evictToBudget(protectedId: string): boolean {
    while (this.#entries.size > this.#limits.maxEntries || this.#bytes > this.#limits.maxBytes) {
      const victim = [...this.#entries.entries()]
        .filter(([id, entry]) => id !== protectedId && !entry.pinned)
        .sort(([idA, a], [idB, b]) => a.lastAccessedAt - b.lastAccessedAt || a.insertedAt - b.insertedAt || idA.localeCompare(idB))[0];
      if (!victim) return false;
      this.#remove(victim[0], 'eviction');
    }
    return true;
  }
  #remove(id: string, reason: 'delete' | 'replace' | 'eviction' | 'expiration' | 'reject'): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    this.#bytes -= entry.byteSize;
    if (entry.pinned) this.#pinnedEntries -= 1;
    if (reason === 'eviction') this.#evictions += 1;
    if (reason === 'expiration') this.#expirations += 1;
    return true;
  }
}
