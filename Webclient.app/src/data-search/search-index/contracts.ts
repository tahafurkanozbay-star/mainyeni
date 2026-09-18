export type UnknownRecord = Record<string, unknown>;

export interface IndexedSearchDocument extends UnknownRecord {
  id: string;
  title: string;
  address: string;
  category: string;
  categoryKey: string;
  type: string;
  typeKey: string;
  district: string;
  districtKey: string;
  neighborhood: string;
  neighborhoodKey: string;
  street: string;
  streetKey: string;
  searchText: string;
  tokens: readonly string[];
  sourceIndex: number;
}

export interface SearchIndexDiagnostics {
  inputCount: number;
  indexedCount: number;
  uniqueIdCount: number;
  duplicateIds: readonly string[];
  tokenCount: number;
  prefixCount: number;
  categoryCount: number;
  typeCount: number;
  districtCount: number;
  neighborhoodCount: number;
  streetCount: number;
}

export interface InvertedSearchIndex {
  documents: IndexedSearchDocument[];
  byId: Map<string, number>;
  tokenPostings: Map<string, Set<number>>;
  prefixPostings: Map<string, Set<number>>;
  categoryPostings: Map<string, Set<number>>;
  typePostings: Map<string, Set<number>>;
  districtPostings: Map<string, Set<number>>;
  neighborhoodPostings: Map<string, Set<number>>;
  streetPostings: Map<string, Set<number>>;
  prefixLength: number;
  diagnostics: SearchIndexDiagnostics;
}

export interface SearchFilterInput {
  categories?: readonly unknown[];
  types?: readonly unknown[];
  districts?: readonly unknown[];
  neighborhoods?: readonly unknown[];
  streets?: readonly unknown[];
  ids?: readonly unknown[];
}

export interface NormalizedSearchFilters {
  categories: string[];
  types: string[];
  districts: string[];
  neighborhoods: string[];
  streets: string[];
  ids: string[];
}

export interface IndexedSearchOptions {
  offset?: unknown;
  limit?: unknown;
  fuzzyDistance?: unknown;
  minScore?: unknown;
  filters?: SearchFilterInput;
  facetFields?: readonly string[];
  cacheTtlMs?: unknown;
}

export interface NormalizedIndexedSearchOptions {
  offset: number;
  limit: number;
  fuzzyDistance: number;
  minScore: number;
  filters: NormalizedSearchFilters;
  facetFields: string[];
}

export interface FacetBucket {
  key: string;
  label: string;
  count: number;
}

export interface ScoredSearchDocument {
  document: IndexedSearchDocument;
  position: number;
  score: number;
}

export interface IndexedSearchPage {
  offset: number;
  limit: number;
  count: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface IndexedSearchResult {
  results: ScoredSearchDocument[];
  facets: Record<string, FacetBucket[]>;
  page: IndexedSearchPage;
  diagnostics: {
    candidateCount: number;
    matchedCount: number;
    queryTokenCount: number;
  };
}

export interface InvertedSearchIndexOptions {
  prefixLength?: unknown;
}

export interface QueryCacheOptions {
  maxEntries?: unknown;
  ttlMs?: unknown;
}

export interface QueryCache<T = unknown> {
  get(key: string, now?: number): T | undefined;
  set(key: string, value: T, customTtlMs?: unknown, now?: number): T;
  delete(key: string): boolean;
  clear(): void;
  has(key: string, now?: number): boolean;
  size(now?: number): number;
  keys(now?: number): string[];
}

export interface CachedSearcherOptions {
  cache?: QueryCache<IndexedSearchResult>;
  cacheOptions?: QueryCacheOptions;
}

export interface CachedIndexSearcher {
  search(query: unknown, searchOptions?: IndexedSearchOptions): IndexedSearchResult;
  invalidate(): void;
  cache: QueryCache<IndexedSearchResult>;
}

export interface SerializedSearchIndex {
  version: 1;
  prefixLength: number;
  documents: UnknownRecord[];
  diagnostics: SearchIndexDiagnostics;
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
