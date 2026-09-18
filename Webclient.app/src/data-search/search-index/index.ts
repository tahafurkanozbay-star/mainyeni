export * from './contracts';
export * from './tokenization';
export * from './indexing';
export * from './search';
export * from './cache';

import {
  DEFAULT_CACHE_SIZE,
  DEFAULT_CACHE_TTL_MS,
  createBoundedQueryCache,
  createCachedIndexSearcher,
  createQueryCacheKey,
  hydrateSearchIndex,
  serializeSearchIndex,
} from './cache';
import {
  createInvertedSearchIndex,
  intersectPostings,
  normalizeSearchDocument,
  unionPostings,
} from './indexing';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  createFacetSummary,
  getFilterCandidatePositions,
  getQueryCandidatePositions,
  normalizeIndexedSearchOptions,
  normalizeSearchFilters,
  scoreSearchDocument,
  searchInvertedIndex,
} from './search';
import {
  DEFAULT_PREFIX_LENGTH,
  boundedLevenshtein,
  createTokenPrefixes,
  tokenizeSearchText,
} from './tokenization';

export const SearchIndexRuntime = {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  DEFAULT_PREFIX_LENGTH,
  DEFAULT_CACHE_SIZE,
  DEFAULT_CACHE_TTL_MS,
  tokenizeSearchText,
  createTokenPrefixes,
  boundedLevenshtein,
  normalizeSearchDocument,
  createInvertedSearchIndex,
  intersectPostings,
  unionPostings,
  normalizeSearchFilters,
  getFilterCandidatePositions,
  getQueryCandidatePositions,
  scoreSearchDocument,
  createFacetSummary,
  normalizeIndexedSearchOptions,
  searchInvertedIndex,
  createQueryCacheKey,
  createBoundedQueryCache,
  createCachedIndexSearcher,
  serializeSearchIndex,
  hydrateSearchIndex,
};
