import type { DatasetSnapshot, SearchRequest, SearchResponse } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  stableSerialize,
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
  QueryResilienceRuntimeV8,
  type QueryResiliencePolicyV8,
  type QueryResilienceResultV8,
  type QueryResilienceSnapshotV8,
} from './queryResilienceRuntimeV8';

export interface QueryResilienceRegistryOptionsV8 {
  readonly maximumDatasets?: number;
  readonly resilience?: QueryResiliencePolicyV8;
  readonly cache?: SearchCacheOptions;
}

export interface QueryResilienceRegistrationV8 {
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly replaced: boolean;
  readonly runtimeRebuilt: boolean;
  readonly invalidatedCacheEntries: number;
  readonly evictedDatasetKey: string | null;
}

export interface QueryResilienceRegistrySearchResultV8 {
  readonly result: QueryResilienceResultV8;
  readonly cacheHit: boolean;
  readonly cacheStored: boolean;
  readonly cacheRejected: boolean;
}

export interface QueryResilienceRegistryDatasetSnapshotV8 {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly recordCount: number;
  readonly runtime: QueryResilienceSnapshotV8;
}

export interface QueryResilienceRegistrySnapshotV8 {
  readonly version: 8;
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
  readonly datasetsState: readonly QueryResilienceRegistryDatasetSnapshotV8[];
  readonly cache: ReturnType<RevisionedSearchCache<QueryResilienceResultV8>['stats']>;
}

interface NormalizedRegistryOptionsV8 {
  readonly maximumDatasets: number;
  readonly resilience: QueryResiliencePolicyV8;
  readonly cache: SearchCacheOptions;
}

interface RegistryEntryV8 {
  readonly dataset: DatasetSnapshot;
  readonly runtime: QueryResilienceRuntimeV8;
}

interface MutableRegistryStatsV8 {
  registrations: number;
  replacements: number;
  removals: number;
  searches: number;
  cacheHits: number;
  cacheMisses: number;
  cacheRejectedWrites: number;
  runtimeRebuilds: number;
}

const VERSION = 8 as const;
const CACHE_NAMESPACE = 'data-search-v8-resilience';

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const normalizeOptions = (
  input: QueryResilienceRegistryOptionsV8 = {},
): NormalizedRegistryOptionsV8 => Object.freeze({
  maximumDatasets: normalizeInteger(input.maximumDatasets, {
    min: 1,
    max: 1_024,
    fallback: 32,
  }),
  resilience: Object.freeze({ ...input.resilience }),
  cache: Object.freeze({
    maxDatasets: input.cache?.maxDatasets ?? input.maximumDatasets ?? 32,
    ...input.cache,
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

const normalizeRequestFingerprint = (request: SearchRequest): string => hashFingerprint(stableSerialize({
  query: normalizeSearchText(request.query),
  filters: request.filters ?? [],
  facetFields: request.facetFields ?? [],
  sort: request.sort ?? 'relevance',
  minScore: request.minScore ?? 0,
  offset: request.offset ?? 0,
  limit: request.limit ?? null,
  center: request.center ?? null,
  radiusMeters: request.radiusMeters ?? 0,
  level: request.level ?? null,
  district: normalizeSearchText(request.district),
  neighborhood: normalizeSearchText(request.neighborhood),
  street: normalizeSearchText(request.street),
}));

const cacheInput = (
  dataset: DatasetSnapshot,
  request: SearchRequest,
): Readonly<{
  dataset: ReturnType<typeof cacheIdentity>;
  requestFingerprint: string;
  namespace: string;
}> => Object.freeze({
  dataset: cacheIdentity(dataset),
  requestFingerprint: normalizeRequestFingerprint(request),
  namespace: CACHE_NAMESPACE,
});

const withCachedResponse = (
  result: QueryResilienceResultV8,
): QueryResilienceResultV8 => {
  const response: SearchResponse = Object.freeze({
    ...result.response,
    diagnostics: Object.freeze({
      ...result.response.diagnostics,
      cacheHit: true,
      elapsedMs: 0,
    }),
  });
  return Object.freeze({ ...result, response });
};

const comparableKeys = (entries: ReadonlyMap<string, RegistryEntryV8>): readonly string[] =>
  Object.freeze(Array.from(entries.keys()));

export class QueryResilienceRegistryV8 {
  readonly #options: NormalizedRegistryOptionsV8;
  readonly #entries = new Map<string, RegistryEntryV8>();
  readonly #cache: RevisionedSearchCache<QueryResilienceResultV8>;
  readonly #sessions = new Set<SearchSession>();
  readonly #stats: MutableRegistryStatsV8 = {
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

  constructor(options: QueryResilienceRegistryOptionsV8 = {}) {
    this.#options = normalizeOptions(options);
    this.#cache = new RevisionedSearchCache<QueryResilienceResultV8>(this.#options.cache);
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('QueryResilienceRegistryV8 has been disposed');
  }

  #touch(key: string, entry: RegistryEntryV8): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #require(keyInput: unknown): RegistryEntryV8 {
    const key = normalizeDatasetKey(keyInput);
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Unknown v8 resilient-search dataset: ${key || '<empty>'}`);
    this.#touch(key, entry);
    return entry;
  }

  #evictIfRequired(): string | null {
    if (this.#entries.size < this.#options.maximumDatasets) return null;
    const oldest = this.#entries.keys().next().value as string | undefined;
    if (!oldest) return null;
    this.#entries.delete(oldest);
    this.#cache.invalidateDataset(oldest);
    return oldest;
  }

  register(dataset: DatasetSnapshot): QueryResilienceRegistrationV8 {
    this.#ensureActive();
    const key = normalizeDatasetKey(dataset.key);
    if (!key) throw new TypeError('v8 resilience dataset key is required');
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
    const runtime = new QueryResilienceRuntimeV8(dataset, this.#options.resilience);
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

  runtime(datasetKeyInput: unknown): QueryResilienceRuntimeV8 {
    this.#ensureActive();
    return this.#require(datasetKeyInput).runtime;
  }

  remove(datasetKeyInput: unknown): boolean {
    this.#ensureActive();
    const key = normalizeDatasetKey(datasetKeyInput);
    if (!key) return false;
    const removed = this.#entries.delete(key);
    if (removed) {
      this.#cache.invalidateDataset(key);
      this.#stats.removals += 1;
    }
    return removed;
  }

  search(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
  ): QueryResilienceRegistrySearchResultV8 {
    this.#ensureActive();
    const entry = this.#require(datasetKeyInput);
    this.#stats.searches += 1;
    const cacheable = !request.signal;
    const keyInput = cacheInput(entry.dataset, request);
    if (cacheable) {
      const cached = this.#cache.get(keyInput);
      if (cached.hit && cached.value) {
        this.#stats.cacheHits += 1;
        return Object.freeze({
          result: withCachedResponse(cached.value),
          cacheHit: true,
          cacheStored: false,
          cacheRejected: false,
        });
      }
    }
    this.#stats.cacheMisses += 1;
    const result = entry.runtime.search(request);
    if (!cacheable || result.selected.diagnostics.blocked) {
      return Object.freeze({
        result,
        cacheHit: false,
        cacheStored: false,
        cacheRejected: false,
      });
    }
    const write = this.#cache.set(keyInput, result);
    if (!write.stored) this.#stats.cacheRejectedWrites += 1;
    return Object.freeze({
      result,
      cacheHit: false,
      cacheStored: write.stored,
      cacheRejected: !write.stored,
    });
  }

  searchResponse(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
  ): SearchResponse {
    return this.search(datasetKeyInput, request).result.response;
  }

  createSession(options: SearchSessionOptions = {}): SearchSession {
    this.#ensureActive();
    const session = createSearchSession(
      (datasetKey, request) => this.searchResponse(datasetKey, request),
      options,
    );
    this.#sessions.add(session);
    const originalDispose = session.dispose.bind(session);
    session.dispose = (): void => {
      originalDispose();
      this.#sessions.delete(session);
    };
    return session;
  }

  keys(): readonly string[] {
    this.#ensureActive();
    return comparableKeys(this.#entries);
  }

  clear(): void {
    this.#ensureActive();
    for (const session of this.#sessions) session.dispose();
    this.#sessions.clear();
    this.#entries.clear();
    this.#cache.clear();
  }

  snapshot(): QueryResilienceRegistrySnapshotV8 {
    const datasetsState = Array.from(this.#entries.entries()).map(([key, entry]) => Object.freeze({
      key,
      revision: entry.dataset.revision,
      fingerprint: entry.dataset.fingerprint,
      recordCount: entry.dataset.records.length,
      runtime: entry.runtime.snapshot(),
    }));
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
      datasetsState: Object.freeze(datasetsState),
      cache: this.#cache.stats(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const session of this.#sessions) session.dispose();
    this.#sessions.clear();
    this.#entries.clear();
    this.#cache.clear();
    this.#disposed = true;
  }
}

export const createQueryResilienceRegistryV8 = (
  options: QueryResilienceRegistryOptionsV8 = {},
): QueryResilienceRegistryV8 => new QueryResilienceRegistryV8(options);
