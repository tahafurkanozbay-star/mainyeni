export interface PlanAskiCategoryCacheEntry {
  readonly tur: number;
  readonly body: string;
  readonly storedAt: number;
  readonly byteSize: number;
}

export interface PlanAskiCategoryCacheStore {
  get(tur: number): Promise<unknown | null>;
  put(entry: PlanAskiCategoryCacheEntry): Promise<void>;
  delete(tur: number): Promise<void>;
}

export interface PlanAskiCategoryCacheHit {
  readonly body: string;
  readonly storedAt: number;
  readonly ageMs: number;
  readonly fresh: boolean;
}

export interface PlanAskiCategoryCacheOptions {
  readonly store?: PlanAskiCategoryCacheStore;
  readonly freshTtlMs?: number;
  readonly staleIfErrorMs?: number;
  readonly maxEntryBytes?: number;
  readonly clock?: () => number;
}

const CACHE_DB_NAME = 'kent-rehberi-planaski-cache-v1';
const CACHE_STORE_NAME = 'category-responses';
const CACHE_DB_VERSION = 1;
const MIN_TYPE = 0;
const MAX_TYPE = 42;
const DEFAULT_FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_CACHE_ENTRIES = MAX_TYPE - MIN_TYPE + 1;

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const validType = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_TYPE && value <= MAX_TYPE;

const validEntry = (value: unknown): value is PlanAskiCategoryCacheEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!validType(entry.tur) || typeof entry.body !== 'string'
    || typeof entry.storedAt !== 'number' || !Number.isSafeInteger(entry.storedAt) || entry.storedAt < 0
    || typeof entry.byteSize !== 'number' || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 1) {
    return false;
  }
  return byteLength(entry.body) === entry.byteSize;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
});

/** IndexedDB storage is an optional accelerator: all storage failures fail open to the network. */
export class IndexedDbPlanAskiCategoryCacheStore implements PlanAskiCategoryCacheStore {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBDatabase | null> | undefined;

  constructor(databaseName = CACHE_DB_NAME) {
    const normalized = databaseName.trim();
    if (!normalized || normalized.length > 120) throw new TypeError('databaseName must be bounded text.');
    this.#databaseName = normalized;
  }

  async get(tur: number): Promise<unknown | null> {
    if (!validType(tur)) return null;
    const database = await this.#openDatabase();
    if (!database) return null;
    try {
      const transaction = database.transaction(CACHE_STORE_NAME, 'readonly');
      return await requestResult(transaction.objectStore(CACHE_STORE_NAME).get(tur)) as unknown ?? null;
    } catch {
      return null;
    }
  }

  async put(entry: PlanAskiCategoryCacheEntry): Promise<void> {
    if (!validEntry(entry) || entry.byteSize > DEFAULT_MAX_ENTRY_BYTES) return;
    const database = await this.#openDatabase();
    if (!database) return;
    try {
      const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(CACHE_STORE_NAME);
      const allRequest = store.getAll();
      allRequest.onsuccess = () => {
        const existing = (allRequest.result as unknown[]).filter(validEntry);
        const retained = existing.filter((item) => item.tur !== entry.tur);
        let bytes = retained.reduce((total, item) => total + item.byteSize, 0);
        retained.sort((left, right) => left.storedAt - right.storedAt || left.tur - right.tur);
        while (
          retained.length > 0
          && (retained.length >= MAX_CACHE_ENTRIES || bytes + entry.byteSize > MAX_CACHE_BYTES)
        ) {
          const removed = retained.shift();
          if (!removed) break;
          bytes = Math.max(0, bytes - removed.byteSize);
          store.delete(removed.tur);
        }
        if (bytes + entry.byteSize <= MAX_CACHE_BYTES) store.put(entry);
      };
      await transactionDone(transaction);
    } catch {
      // Quota, private browsing, a blocked database, or structured-clone failures
      // must not prevent a valid live PlanASKI response from reaching the map.
    }
  }

  async delete(tur: number): Promise<void> {
    if (!validType(tur)) return;
    const database = await this.#openDatabase();
    if (!database) return;
    try {
      const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
      transaction.objectStore(CACHE_STORE_NAME).delete(tur);
      await transactionDone(transaction);
    } catch {
      // Persistent cache invalidation is best effort; callers still validate every body.
    }
  }

  async #openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    if (this.#databasePromise) return this.#databasePromise;
    this.#databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      const finish = (database: IDBDatabase | null): void => {
        if (settled) {
          database?.close();
          return;
        }
        settled = true;
        resolve(database);
      };
      try {
        const request = indexedDB.open(this.#databaseName, CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
            database.createObjectStore(CACHE_STORE_NAME, { keyPath: 'tur' });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          finish(database);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch {
        finish(null);
      }
    });
    return this.#databasePromise;
  }
}

/**
 * Bounded, versioned persistent cache for the official public POI responses.
 * Fresh snapshots avoid repeat API calls. Expired snapshots are used only as a
 * validated fallback when the upstream service fails.
 */
export class PlanAskiPersistentCategoryCache {
  readonly #store: PlanAskiCategoryCacheStore;
  readonly #freshTtlMs: number;
  readonly #staleIfErrorMs: number;
  readonly #maxEntryBytes: number;
  readonly #clock: () => number;

  constructor(options: PlanAskiCategoryCacheOptions = {}) {
    this.#store = options.store ?? new IndexedDbPlanAskiCategoryCacheStore();
    this.#freshTtlMs = this.#boundedInteger(
      'freshTtlMs',
      options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS,
      60_000,
      7 * 24 * 60 * 60 * 1000,
    );
    this.#staleIfErrorMs = this.#boundedInteger(
      'staleIfErrorMs',
      options.staleIfErrorMs ?? DEFAULT_STALE_IF_ERROR_MS,
      this.#freshTtlMs,
      30 * 24 * 60 * 60 * 1000,
    );
    this.#maxEntryBytes = this.#boundedInteger(
      'maxEntryBytes',
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      1_024,
      DEFAULT_MAX_ENTRY_BYTES,
    );
    this.#clock = options.clock ?? Date.now;
  }

  async read(tur: number): Promise<PlanAskiCategoryCacheHit | null> {
    if (!validType(tur)) return null;
    let candidate: unknown;
    try {
      candidate = await this.#store.get(tur);
    } catch {
      return null;
    }
    if (candidate === null || candidate === undefined) return null;
    if (!validEntry(candidate) || candidate.tur !== tur || candidate.byteSize > this.#maxEntryBytes) {
      await this.#safeDelete(tur);
      return null;
    }
    const ageMs = this.#clock() - candidate.storedAt;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.#staleIfErrorMs) {
      await this.#safeDelete(tur);
      return null;
    }
    return Object.freeze({
      body: candidate.body,
      storedAt: candidate.storedAt,
      ageMs,
      fresh: ageMs <= this.#freshTtlMs,
    });
  }

  async write(tur: number, body: string): Promise<void> {
    if (!validType(tur) || typeof body !== 'string') return;
    const byteSize = byteLength(body);
    if (byteSize < 1 || byteSize > this.#maxEntryBytes) return;
    try {
      await this.#store.put(Object.freeze({
        tur,
        body,
        storedAt: this.#clock(),
        byteSize,
      }));
    } catch {
      // Keep persistence optional; callers still use the current validated response.
    }
  }

  async remove(tur: number): Promise<void> {
    await this.#safeDelete(tur);
  }

  #boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(name + ' is outside its allowed range.');
    }
    return value;
  }

  async #safeDelete(tur: number): Promise<void> {
    try {
      await this.#store.delete(tur);
    } catch {
      // Invalid or expired disk entries are never trusted, even if deletion fails.
    }
  }
}

export const planAskiPersistentCategoryCache = new PlanAskiPersistentCategoryCache();
