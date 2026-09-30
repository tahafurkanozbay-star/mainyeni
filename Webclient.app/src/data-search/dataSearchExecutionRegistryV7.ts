import type {
  DatasetSnapshot,
  SearchRequest,
  SearchResponse,
} from './contracts';
import {
  normalizeInteger,
  normalizeSearchText,
} from './normalization';
import {
  RevisionedSearchCache,
  type SearchCacheOptions,
} from './revisionedSearchCache';
import {
  createSearchSession,
  type SearchSession,
  type SearchSessionOptions,
} from './searchSession';
import {
  DataSearchExecutionRuntimeV7,
  type DataSearchExecutionPolicyV7,
  type DataSearchExecutionResultV7,
  type DataSearchExecutionSnapshotV7,
} from './dataSearchExecutionRuntimeV7';

export interface DataSearchExecutionRegistryOptionsV7 {
  readonly maximumDatasets?: number;
  readonly execution?: DataSearchExecutionPolicyV7;
  readonly cache?: SearchCacheOptions;
}

export interface DataSearchExecutionRegistrationV7 {
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly replaced: boolean;
  readonly runtimeRebuilt: boolean;
  readonly invalidatedCacheEntries: number;
  readonly evictedDatasetKey: string | null;
}

export interface DataSearchExecutionLookupV7 {
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly runtime: DataSearchExecutionRuntimeV7;
}

export interface DataSearchExecutionSearchResultV7 {
  readonly result: DataSearchExecutionResultV7;
  readonly cacheHit: boolean;
  readonly cacheStored: boolean;
  readonly cacheRejected: boolean;
}

export interface DataSearchExecutionRegistryDatasetSnapshotV7 {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly recordCount: number;
  readonly runtime: DataSearchExecutionSnapshotV7;
}

export interface DataSearchExecutionRegistrySnapshotV7 {
  readonly version: 7;
  readonly datasets: number;
  readonly sessions: number;
  readonly registrations: number;
  readonly replacements: number;
  readonly removals: number;
  readonly searches: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheRejectedWrites: number;
  readonly runtimeRebuilds: number;
  readonly datasetsState: readonly DataSearchExecutionRegistryDatasetSnapshotV7[];
  readonly cache: ReturnType<RevisionedSearchCache<DataSearchExecutionResultV7>['stats']>;
}

interface NormalizedRegistryOptionsV7 {
  readonly maximumDatasets: number;
  readonly execution: DataSearchExecutionPolicyV7;
  readonly cache: SearchCacheOptions;
}

interface RegistryEntryV7 {
  readonly dataset: DatasetSnapshot;
  readonly runtime: DataSearchExecutionRuntimeV7;
}

interface MutableRegistryStatsV7 {
  registrations: number;
  replacements: number;
  removals: number;
  searches: number;
  cacheHits: number;
  cacheMisses: number;
  cacheRejectedWrites: number;
  runtimeRebuilds: number;
}

const VERSION = 7 as const;
const CACHE_NAMESPACE = 'data-search-v7';

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const normalizeOptions = (
  options: DataSearchExecutionRegistryOptionsV7 = {},
): NormalizedRegistryOptionsV7 => Object.freeze({
  maximumDatasets: normalizeInteger(options.maximumDatasets, {
    min: 1,
    max: 1_024,
    fallback: 32,
  }),
  execution: Object.freeze({ ...options.execution }),
  cache: Object.freeze({
    maxDatasets: options.cache?.maxDatasets ?? options.maximumDatasets ?? 32,
    ...options.cache,
  }),
});

const sameDataset = (left: DatasetSnapshot, right: DatasetSnapshot): boolean =>
  left.key === right.key
  && left.revision === right.revision
  && left.fingerprint === right.fingerprint;

const cacheIdentity = (dataset: DatasetSnapshot): Readonly<{
  datasetKey: string;
  revision: number;
  fingerprint: string;
}> => Object.freeze({
  datasetKey: normalizeDatasetKey(dataset.key),
  revision: dataset.revision,
  fingerprint: dataset.fingerprint,
});

const withCacheHit = (
  result: DataSearchExecutionResultV7,
): DataSearchExecutionResultV7 => Object.freeze({
  ...result,
  response: Object.freeze({
    ...result.response,
    diagnostics: Object.freeze({
      ...result.response.diagnostics,
      cacheHit: true,
      elapsedMs: 0,
    }),
  }),
});

const cacheKeyInput = (
  dataset: DatasetSnapshot,
  requestFingerprint: string,
): Readonly<{
  dataset: ReturnType<typeof cacheIdentity>;
  requestFingerprint: string;
  namespace: string;
}> => Object.freeze({
  dataset: cacheIdentity(dataset),
  requestFingerprint,
  namespace: CACHE_NAMESPACE,
});

const comparableDatasetKeys = (entries: ReadonlyMap<string, RegistryEntryV7>): readonly string[] =>
  Object.freeze(Array.from(entries.keys()));

export class DataSearchExecutionRegistryV7 {
  readonly #options: NormalizedRegistryOptionsV7;
  readonly #entries = new Map<string, RegistryEntryV7>();
  readonly #cache: RevisionedSearchCache<DataSearchExecutionResultV7>;
  readonly #sessions = new Set<SearchSession>();
  readonly #stats: MutableRegistryStatsV7 = {
    registrations: 0,
    replacements: 0,
    removals: 0,
    searches: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheRejectedWrites: 0,
    runtimeRebuilds: 0,
  };
  #disposed = false;

  constructor(options: DataSearchExecutionRegistryOptionsV7 = {}) {
    this.#options = normalizeOptions(options);
    this.#cache = new RevisionedSearchCache<DataSearchExecutionResultV7>(this.#options.cache);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('DataSearchExecutionRegistryV7 has been disposed');
  }

  #require(keyInput: unknown): RegistryEntryV7 {
    const key = normalizeDatasetKey(keyInput);
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Unknown v7 data-search dataset: ${key || '<empty>'}`);
    this.#touch(key, entry);
    return entry;
  }

  #touch(key: string, entry: RegistryEntryV7): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #evictIfRequired(): string | null {
    if (this.#entries.size < this.#options.maximumDatasets) return null;
    const oldestKey = this.#entries.keys().next().value as string | undefined;
    if (!oldestKey) return null;
    this.#entries.delete(oldestKey);
    this.#cache.invalidateDataset(oldestKey);
    return oldestKey;
  }

  register(dataset: DatasetSnapshot): DataSearchExecutionRegistrationV7 {
    this.#ensureActive();
    const key = normalizeDatasetKey(dataset.key);
    if (!key) throw new TypeError('v7 execution dataset key is required');
    const existing = this.#entries.get(key) ?? null;
    if (existing && sameDataset(existing.dataset, dataset)) {
      this.#touch(key, existing);
      return Object.freeze({
        datasetKey: key,
        datasetRevision: dataset.revision,
        datasetFingerprint: dataset.fingerprint,
        replaced: false,
        runtimeRebuilt: false,
        invalidatedCacheEntries: 0,
        evictedDatasetKey: null,
      });
    }

    const evictedDatasetKey = existing ? null : this.#evictIfRequired();
    const invalidatedCacheEntries = existing
      ? this.#cache.invalidateRevision(key, dataset.revision, dataset.fingerprint)
      : 0;
    const runtime = new DataSearchExecutionRuntimeV7(dataset, this.#options.execution);
    this.#entries.delete(key);
    this.#entries.set(key, Object.freeze({ dataset, runtime }));
    this.#stats.runtimeRebuilds += 1;
    if (existing) this.#stats.replacements += 1;
    else this.#stats.registrations += 1;
    return Object.freeze({
      datasetKey: key,
      datasetRevision: dataset.revision,
      datasetFingerprint: dataset.fingerprint,
      replaced: Boolean(existing),
      runtimeRebuilt: true,
      invalidatedCacheEntries,
      evictedDatasetKey,
    });
  }

  has(datasetKeyInput: unknown): boolean {
    this.#ensureActive();
    return this.#entries.has(normalizeDatasetKey(datasetKeyInput));
  }

  get(datasetKeyInput: unknown): DataSearchExecutionLookupV7 | null {
    this.#ensureActive();
    const key = normalizeDatasetKey(datasetKeyInput);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#touch(key, entry);
    return Object.freeze({
      datasetKey: key,
      datasetRevision: entry.dataset.revision,
      datasetFingerprint: entry.dataset.fingerprint,
      runtime: entry.runtime,
    });
  }

  search(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
  ): DataSearchExecutionSearchResultV7 {
    this.#ensureActive();
    const entry = this.#require(datasetKeyInput);
    const fingerprint = entry.runtime.fingerprint(request);
    const key = cacheKeyInput(entry.dataset, fingerprint);
    this.#stats.searches += 1;

    if (!request.signal) {
      const cached = this.#cache.get(key);
      if (cached.hit && cached.value) {
        this.#stats.cacheHits += 1;
        return Object.freeze({
          result: withCacheHit(cached.value),
          cacheHit: true,
          cacheStored: true,
          cacheRejected: false,
        });
      }
    }

    this.#stats.cacheMisses += 1;
    const result = entry.runtime.search(request);
    if (request.signal || result.diagnostics.blocked) {
      return Object.freeze({
        result,
        cacheHit: false,
        cacheStored: false,
        cacheRejected: false,
      });
    }
    const stored = this.#cache.set(key, result);
    if (!stored.stored) this.#stats.cacheRejectedWrites += 1;
    return Object.freeze({
      result,
      cacheHit: false,
      cacheStored: stored.stored,
      cacheRejected: !stored.stored,
    });
  }

  searchResponse(datasetKeyInput: unknown, request: SearchRequest = {}): SearchResponse {
    return this.search(datasetKeyInput, request).result.response;
  }

  createSession(options: SearchSessionOptions = {}): SearchSession {
    this.#ensureActive();
    const session = createSearchSession(
      (datasetKey, request) => this.searchResponse(datasetKey, request),
      options,
    );
    this.#sessions.add(session);
    const dispose = session.dispose.bind(session);
    session.dispose = (): void => {
      dispose();
      this.#sessions.delete(session);
    };
    return session;
  }

  invalidate(datasetKeyInput: unknown): number {
    this.#ensureActive();
    const key = normalizeDatasetKey(datasetKeyInput);
    return key ? this.#cache.invalidateDataset(key) : 0;
  }

  remove(datasetKeyInput: unknown): boolean {
    this.#ensureActive();
    const key = normalizeDatasetKey(datasetKeyInput);
    if (!key) return false;
    this.#cache.invalidateDataset(key);
    const removed = this.#entries.delete(key);
    if (removed) this.#stats.removals += 1;
    return removed;
  }

  datasetKeys(): readonly string[] {
    this.#ensureActive();
    return comparableDatasetKeys(this.#entries);
  }

  cache(): RevisionedSearchCache<DataSearchExecutionResultV7> {
    this.#ensureActive();
    return this.#cache;
  }

  snapshot(): DataSearchExecutionRegistrySnapshotV7 {
    this.#ensureActive();
    const datasetsState = Object.freeze(Array.from(this.#entries.entries())
      .map(([key, entry]) => Object.freeze({
        key,
        revision: entry.dataset.revision,
        fingerprint: entry.dataset.fingerprint,
        recordCount: entry.dataset.records.length,
        runtime: entry.runtime.snapshot(),
      })));
    return Object.freeze({
      version: VERSION,
      datasets: this.#entries.size,
      sessions: this.#sessions.size,
      registrations: this.#stats.registrations,
      replacements: this.#stats.replacements,
      removals: this.#stats.removals,
      searches: this.#stats.searches,
      cacheHits: this.#stats.cacheHits,
      cacheMisses: this.#stats.cacheMisses,
      cacheRejectedWrites: this.#stats.cacheRejectedWrites,
      runtimeRebuilds: this.#stats.runtimeRebuilds,
      datasetsState,
      cache: this.#cache.stats(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const session of this.#sessions) session.dispose();
    this.#sessions.clear();
    this.#cache.clear();
    this.#entries.clear();
    this.#disposed = true;
  }
}

export const createDataSearchExecutionRegistryV7 = (
  options: DataSearchExecutionRegistryOptionsV7 = {},
): DataSearchExecutionRegistryV7 => new DataSearchExecutionRegistryV7(options);
