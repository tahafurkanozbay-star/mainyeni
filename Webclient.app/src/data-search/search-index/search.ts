import {
  normalizeCategoryKey,
  normalizeFiniteNumber,
  normalizeInteger,
  normalizePagination,
  normalizeSearchText,
  normalizeText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  type FacetBucket,
  type IndexedSearchDocument,
  type IndexedSearchOptions,
  type IndexedSearchResult,
  type InvertedSearchIndex,
  type NormalizedIndexedSearchOptions,
  type NormalizedSearchFilters,
  type SearchFilterInput,
} from './contracts';
import {
  intersectPostings,
  unionPostings,
} from './indexing';
import {
  boundedLevenshtein,
  tokenizeSearchText,
  uniqueSearchTokens,
} from './tokenization';

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 500;

export const normalizeSearchFilters = (
  filters: SearchFilterInput = {},
): NormalizedSearchFilters => ({
  categories: uniqueSearchTokens((filters.categories ?? []).map(normalizeCategoryKey).filter(Boolean)),
  types: uniqueSearchTokens((filters.types ?? []).map(normalizeCategoryKey).filter(Boolean)),
  districts: uniqueSearchTokens((filters.districts ?? []).map(normalizeCategoryKey).filter(Boolean)),
  neighborhoods: uniqueSearchTokens((filters.neighborhoods ?? []).map(normalizeCategoryKey).filter(Boolean)),
  streets: uniqueSearchTokens((filters.streets ?? []).map(normalizeCategoryKey).filter(Boolean)),
  ids: uniqueSearchTokens((filters.ids ?? []).map(value => normalizeText(value)).filter(Boolean)),
});

const collectFilterPostings = (
  values: readonly string[],
  postingsMap: ReadonlyMap<string, Set<number>>,
): Set<number> | null =>
  values.length
    ? unionPostings(values.map(value => postingsMap.get(value)))
    : null;

export const getFilterCandidatePositions = (
  index: InvertedSearchIndex,
  filters: SearchFilterInput = {},
): Set<number> | null => {
  const normalized = normalizeSearchFilters(filters);
  const postingSets: (Set<number> | null)[] = [
    collectFilterPostings(normalized.categories, index.categoryPostings),
    collectFilterPostings(normalized.types, index.typePostings),
    collectFilterPostings(normalized.districts, index.districtPostings),
    collectFilterPostings(normalized.neighborhoods, index.neighborhoodPostings),
    collectFilterPostings(normalized.streets, index.streetPostings),
  ].filter((set): set is Set<number> => set instanceof Set);

  if (normalized.ids.length) {
    const idPositions = normalized.ids
      .map(id => index.byId.get(id))
      .filter((position): position is number => Number.isInteger(position));
    postingSets.push(new Set(idPositions));
  }

  return intersectPostings(postingSets);
};

export const getQueryCandidatePositions = (
  index: InvertedSearchIndex,
  query: unknown,
): Set<number> | null => {
  const tokens = tokenizeSearchText(query);
  if (!tokens.length) return null;

  return intersectPostings(tokens.map(token =>
    index.tokenPostings.get(token)
    ?? index.prefixPostings.get(token)
    ?? new Set<number>()));
};

const scoreSingleToken = (
  documentToken: string,
  queryToken: string,
  fuzzyDistance: number,
): number => {
  if (documentToken === queryToken) return 100;
  if (documentToken.startsWith(queryToken)) return 70;
  if (documentToken.includes(queryToken)) return 35;

  if (fuzzyDistance > 0 && queryToken.length >= 4 && documentToken.length >= 4) {
    const distance = boundedLevenshtein(documentToken, queryToken, fuzzyDistance);
    if (distance <= fuzzyDistance) {
      return Math.max(10, 30 - distance * 8);
    }
  }

  return 0;
};

export const scoreSearchDocument = (
  document: IndexedSearchDocument,
  query: unknown,
  options: Pick<IndexedSearchOptions, 'fuzzyDistance'> = {},
): number => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 1;

  const queryTokens = tokenizeSearchText(normalizedQuery);
  if (!queryTokens.length) return 1;

  const fuzzyDistance = normalizeInteger(options.fuzzyDistance, {
    min: 0,
    max: 3,
    fallback: 1,
  }) ?? 1;

  let score = 0;
  let matched = 0;

  for (const queryToken of queryTokens) {
    const best = document.tokens.reduce(
      (maximum, documentToken) => Math.max(
        maximum,
        scoreSingleToken(documentToken, queryToken, fuzzyDistance),
      ),
      0,
    );
    if (best > 0) matched += 1;
    score += best;
  }

  if (document.searchText === normalizedQuery) score += 500;
  else if (document.searchText.startsWith(normalizedQuery)) score += 220;
  else if (document.searchText.includes(normalizedQuery)) score += 100;

  const normalizedTitle = normalizeSearchText(document.title);
  if (normalizedTitle === normalizedQuery) score += 400;
  else if (normalizedTitle.startsWith(normalizedQuery)) score += 160;

  if (matched === queryTokens.length) score += 120;
  else score -= (queryTokens.length - matched) * 50;

  return Math.max(0, score);
};

export const createFacetSummary = (
  documents: readonly IndexedSearchDocument[],
  fields: readonly string[] = ['category', 'type', 'district'],
): Record<string, FacetBucket[]> => {
  const result: Record<string, FacetBucket[]> = {};

  for (const field of fields) {
    const counts = new Map<string, FacetBucket>();

    for (const document of documents) {
      const label = normalizeText(document[field]);
      if (!label) continue;
      const key = normalizeCategoryKey(label) || normalizeSearchText(label);
      const current = counts.get(key) ?? { key, label, count: 0 };
      counts.set(key, { ...current, count: current.count + 1 });
    }

    result[field] = Array.from(counts.values())
      .sort((left, right) =>
        right.count - left.count
        || left.label.localeCompare(right.label, 'tr-TR'));
  }

  return result;
};

export const normalizeIndexedSearchOptions = (
  options: IndexedSearchOptions = {},
): NormalizedIndexedSearchOptions => {
  const page = normalizePagination({
    offset: options.offset,
    limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
  });
  const rawLimit = normalizeFiniteNumber(options.limit, null);
  const limit = rawLimit === null || rawLimit <= 0
    ? DEFAULT_SEARCH_LIMIT
    : Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(rawLimit)));

  return {
    offset: page.offset,
    limit,
    fuzzyDistance: normalizeInteger(options.fuzzyDistance, {
      min: 0,
      max: 3,
      fallback: 1,
    }) ?? 1,
    minScore: Math.max(0, normalizeFiniteNumber(options.minScore, 1) ?? 1),
    filters: normalizeSearchFilters(options.filters),
    facetFields: Array.isArray(options.facetFields)
      ? options.facetFields.filter(Boolean)
      : ['category', 'type', 'district'],
  };
};

const mergeCandidateSets = (
  documentCount: number,
  queryCandidates: Set<number> | null,
  filterCandidates: Set<number> | null,
): Set<number> => {
  if (queryCandidates && filterCandidates) {
    return intersectPostings([queryCandidates, filterCandidates]) ?? new Set<number>();
  }
  if (queryCandidates) return new Set(queryCandidates);
  if (filterCandidates) return new Set(filterCandidates);
  return new Set(Array.from({ length: documentCount }, (_, index) => index));
};

export const searchInvertedIndex = (
  index: InvertedSearchIndex,
  query: unknown,
  options: IndexedSearchOptions = {},
): IndexedSearchResult => {
  const normalizedOptions = normalizeIndexedSearchOptions(options);
  const queryCandidates = getQueryCandidatePositions(index, query);
  const filterCandidates = getFilterCandidatePositions(index, normalizedOptions.filters);
  let candidatePositions = mergeCandidateSets(
    index.documents.length,
    queryCandidates,
    filterCandidates,
  );

  if (queryCandidates && queryCandidates.size === 0 && normalizeSearchText(query)) {
    candidatePositions = new Set(index.documents.map((_document, position) => position));
    if (filterCandidates) {
      candidatePositions =
        intersectPostings([candidatePositions, filterCandidates]) ?? new Set<number>();
    }
  }

  const scored = Array.from(candidatePositions)
    .map(position => {
      const document = index.documents[position];
      if (!document) return null;
      return {
        document,
        position,
        score: scoreSearchDocument(document, query, normalizedOptions),
      };
    })
    .filter((item): item is NonNullable<typeof item> =>
      item !== null && item.score >= normalizedOptions.minScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const titleOrder = left.document.title.localeCompare(
        right.document.title,
        'tr-TR',
        { sensitivity: 'base', numeric: true },
      );
      return titleOrder || left.position - right.position;
    });

  const matchedDocuments = scored.map(item => item.document);
  const pageItems = scored.slice(
    normalizedOptions.offset,
    normalizedOptions.offset + normalizedOptions.limit,
  );
  const nextOffset = normalizedOptions.offset + pageItems.length;

  return {
    results: pageItems,
    facets: createFacetSummary(matchedDocuments, normalizedOptions.facetFields),
    page: {
      offset: normalizedOptions.offset,
      limit: normalizedOptions.limit,
      count: pageItems.length,
      total: scored.length,
      hasMore: nextOffset < scored.length,
      nextOffset: nextOffset < scored.length ? nextOffset : null,
    },
    diagnostics: {
      candidateCount: candidatePositions.size,
      matchedCount: scored.length,
      queryTokenCount: tokenizeSearchText(query).length,
    },
  };
};
