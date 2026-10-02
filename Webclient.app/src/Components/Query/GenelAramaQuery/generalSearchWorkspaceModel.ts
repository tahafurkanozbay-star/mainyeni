import type { NormalizedSearchRecord } from '../_Common/QuerySearchRuntime';

export const GENERAL_SEARCH_WORKSPACE_VERSION = '2026-10-02.v1';
export const GENERAL_SEARCH_DEFAULT_PAGE_SIZE = 24;
export const GENERAL_SEARCH_MAX_PAGE_SIZE = 60;
export const GENERAL_SEARCH_MAX_RESULTS = 5_000;
export const GENERAL_SEARCH_MAX_FACETS = 24;
export const GENERAL_SEARCH_MAX_SUGGESTIONS = 8;
export const GENERAL_SEARCH_MAX_QUERY_LENGTH = 180;

export type GeneralSearchSortMode =
  | 'relevance'
  | 'title'
  | 'category'
  | 'address'
  | 'source-order';

export type GeneralSearchWorkspacePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error';

export interface GeneralSearchFacetBucket {
  readonly value: string;
  readonly normalizedValue: string;
  readonly count: number;
  readonly selected: boolean;
}

export interface GeneralSearchSuggestion {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: 'record' | 'category' | 'type';
  readonly score: number;
}

export interface GeneralSearchWorkspaceOptions {
  readonly pageSize?: number;
  readonly maximumResults?: number;
  readonly maximumFacets?: number;
  readonly maximumSuggestions?: number;
  readonly initialSort?: GeneralSearchSortMode;
}

export interface GeneralSearchWorkspaceFilters {
  readonly text: string;
  readonly categories: readonly string[];
  readonly types: readonly string[];
  readonly sort: GeneralSearchSortMode;
}

export interface GeneralSearchRankedRecord {
  readonly record: NormalizedSearchRecord;
  readonly sourceIndex: number;
  readonly score: number;
  readonly matchedFields: readonly string[];
  readonly normalizedTitle: string;
  readonly normalizedAddress: string;
  readonly normalizedCategory: string;
  readonly normalizedType: string;
  readonly normalizedPhone: string;
}

export interface GeneralSearchPageWindow {
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly items: readonly GeneralSearchRankedRecord[];
}

export interface GeneralSearchWorkspaceDiagnostics {
  readonly version: string;
  readonly inputCount: number;
  readonly admittedCount: number;
  readonly truncatedInputCount: number;
  readonly matchedCount: number;
  readonly filteredOutCount: number;
  readonly categoryCount: number;
  readonly typeCount: number;
  readonly queryTokenCount: number;
  readonly pageCount: number;
  readonly hasActiveFilters: boolean;
  readonly resultFingerprint: string;
}

export interface GeneralSearchWorkspaceSnapshot {
  readonly phase: GeneralSearchWorkspacePhase;
  readonly filters: GeneralSearchWorkspaceFilters;
  readonly totalCount: number;
  readonly matchedCount: number;
  readonly page: GeneralSearchPageWindow;
  readonly categoryFacets: readonly GeneralSearchFacetBucket[];
  readonly typeFacets: readonly GeneralSearchFacetBucket[];
  readonly suggestions: readonly GeneralSearchSuggestion[];
  readonly activeIndex: number;
  readonly activeKey: string | null;
  readonly queryTokens: readonly string[];
  readonly diagnostics: GeneralSearchWorkspaceDiagnostics;
}

interface NormalizedOptions {
  readonly pageSize: number;
  readonly maximumResults: number;
  readonly maximumFacets: number;
  readonly maximumSuggestions: number;
  readonly initialSort: GeneralSearchSortMode;
}

const TURKISH_LOCALE = 'tr-TR';
const COLLATOR = new Intl.Collator(TURKISH_LOCALE, {
  sensitivity: 'base',
  numeric: true,
  usage: 'sort',
});

const clampInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const normalizeOptions = (
  options: GeneralSearchWorkspaceOptions = {},
): NormalizedOptions => Object.freeze({
  pageSize: clampInteger(
    options.pageSize,
    1,
    GENERAL_SEARCH_MAX_PAGE_SIZE,
    GENERAL_SEARCH_DEFAULT_PAGE_SIZE,
  ),
  maximumResults: clampInteger(
    options.maximumResults,
    1,
    GENERAL_SEARCH_MAX_RESULTS,
    GENERAL_SEARCH_MAX_RESULTS,
  ),
  maximumFacets: clampInteger(
    options.maximumFacets,
    1,
    100,
    GENERAL_SEARCH_MAX_FACETS,
  ),
  maximumSuggestions: clampInteger(
    options.maximumSuggestions,
    0,
    20,
    GENERAL_SEARCH_MAX_SUGGESTIONS,
  ),
  initialSort: normalizeSort(options.initialSort),
});

export const normalizeGeneralSearchText = (value: unknown): string => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase(TURKISH_LOCALE)
  .slice(0, GENERAL_SEARCH_MAX_QUERY_LENGTH);

const normalizeFacetValue = (value: unknown): string => normalizeGeneralSearchText(value);

export const tokenizeGeneralSearch = (value: unknown): readonly string[] => {
  const normalized = normalizeGeneralSearchText(value);
  if (!normalized) return Object.freeze([]);
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 12);
  return Object.freeze(Array.from(new Set(tokens)));
};

const normalizeSort = (value: unknown): GeneralSearchSortMode => {
  switch (value) {
    case 'title':
    case 'category':
    case 'address':
    case 'source-order':
    case 'relevance':
      return value;
    default:
      return 'relevance';
  }
};

const uniqueFacetValues = (values: readonly string[]): readonly string[] => Object.freeze(
  Array.from(new Set(values.map(normalizeFacetValue).filter(Boolean))).sort(COLLATOR.compare),
);

export const createGeneralSearchFilters = (
  input: Partial<GeneralSearchWorkspaceFilters> = {},
  fallbackSort: GeneralSearchSortMode = 'relevance',
): GeneralSearchWorkspaceFilters => Object.freeze({
  text: String(input.text ?? '').slice(0, GENERAL_SEARCH_MAX_QUERY_LENGTH),
  categories: uniqueFacetValues(input.categories ?? []),
  types: uniqueFacetValues(input.types ?? []),
  sort: normalizeSort(input.sort ?? fallbackSort),
});

const fieldMatchScore = (
  field: string,
  normalizedValue: string,
  normalizedQuery: string,
  tokens: readonly string[],
  weight: number,
): Readonly<{ score: number; matched: boolean; field: string }> => {
  if (!normalizedValue || !normalizedQuery) {
    return Object.freeze({ score: 0, matched: false, field });
  }

  let score = 0;
  if (normalizedValue === normalizedQuery) score += 140;
  else if (normalizedValue.startsWith(normalizedQuery)) score += 90;
  else if (normalizedValue.includes(normalizedQuery)) score += 55;

  let tokenMatches = 0;
  for (const token of tokens) {
    if (normalizedValue === token) {
      score += 42;
      tokenMatches += 1;
    } else if (normalizedValue.startsWith(token)) {
      score += 28;
      tokenMatches += 1;
    } else if (normalizedValue.includes(token)) {
      score += 15;
      tokenMatches += 1;
    }
  }

  if (tokens.length > 0 && tokenMatches === tokens.length) score += 35;
  return Object.freeze({
    score: score * weight,
    matched: score > 0,
    field,
  });
};

const rankRecord = (
  record: NormalizedSearchRecord,
  sourceIndex: number,
  normalizedQuery: string,
  tokens: readonly string[],
): GeneralSearchRankedRecord => {
  const normalizedTitle = normalizeGeneralSearchText(record.title);
  const normalizedAddress = normalizeGeneralSearchText(record.address);
  const normalizedCategory = normalizeGeneralSearchText(record.category);
  const normalizedType = normalizeGeneralSearchText(record.type);
  const normalizedPhone = normalizeGeneralSearchText(record.phone);

  if (!normalizedQuery) {
    return Object.freeze({
      record,
      sourceIndex,
      score: 1,
      matchedFields: Object.freeze([]),
      normalizedTitle,
      normalizedAddress,
      normalizedCategory,
      normalizedType,
      normalizedPhone,
    });
  }

  const fields = [
    fieldMatchScore('title', normalizedTitle, normalizedQuery, tokens, 8),
    fieldMatchScore('address', normalizedAddress, normalizedQuery, tokens, 5),
    fieldMatchScore('category', normalizedCategory, normalizedQuery, tokens, 4),
    fieldMatchScore('type', normalizedType, normalizedQuery, tokens, 3),
    fieldMatchScore('phone', normalizedPhone, normalizedQuery, tokens, 1),
  ] as const;
  const matchedFields = fields.filter((item) => item.matched).map((item) => item.field);
  const score = fields.reduce((total, item) => total + item.score, 0);

  return Object.freeze({
    record,
    sourceIndex,
    score,
    matchedFields: Object.freeze(matchedFields),
    normalizedTitle,
    normalizedAddress,
    normalizedCategory,
    normalizedType,
    normalizedPhone,
  });
};

const matchesSelectedFacet = (
  value: string,
  selected: readonly string[],
): boolean => selected.length === 0 || selected.includes(value);

const compareRanked = (
  left: GeneralSearchRankedRecord,
  right: GeneralSearchRankedRecord,
  mode: GeneralSearchSortMode,
): number => {
  if (mode === 'title') {
    return COLLATOR.compare(left.record.title, right.record.title)
      || left.sourceIndex - right.sourceIndex;
  }
  if (mode === 'category') {
    return COLLATOR.compare(left.record.category, right.record.category)
      || COLLATOR.compare(left.record.title, right.record.title)
      || left.sourceIndex - right.sourceIndex;
  }
  if (mode === 'address') {
    const leftEmpty = left.normalizedAddress.length === 0;
    const rightEmpty = right.normalizedAddress.length === 0;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    return COLLATOR.compare(left.record.address, right.record.address)
      || COLLATOR.compare(left.record.title, right.record.title)
      || left.sourceIndex - right.sourceIndex;
  }
  if (mode === 'source-order') return left.sourceIndex - right.sourceIndex;
  if (right.score !== left.score) return right.score - left.score;
  return left.sourceIndex - right.sourceIndex
    || COLLATOR.compare(left.record.title, right.record.title);
};

const buildFacetBuckets = (
  records: readonly GeneralSearchRankedRecord[],
  field: 'category' | 'type',
  selected: readonly string[],
  maximum: number,
): readonly GeneralSearchFacetBucket[] => {
  const counts = new Map<string, Readonly<{ value: string; count: number }>>();
  for (const item of records) {
    const raw = field === 'category' ? item.record.category : item.record.type;
    const normalizedValue = field === 'category'
      ? item.normalizedCategory
      : item.normalizedType;
    if (!normalizedValue) continue;
    const previous = counts.get(normalizedValue);
    counts.set(normalizedValue, Object.freeze({
      value: previous?.value ?? raw,
      count: (previous?.count ?? 0) + 1,
    }));
  }

  return Object.freeze(Array.from(counts.entries())
    .map(([normalizedValue, item]) => Object.freeze({
      value: item.value,
      normalizedValue,
      count: item.count,
      selected: selected.includes(normalizedValue),
    }))
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || right.count - left.count
      || COLLATOR.compare(left.value, right.value))
    .slice(0, maximum));
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const resultFingerprint = (
  records: readonly GeneralSearchRankedRecord[],
  filters: GeneralSearchWorkspaceFilters,
): string => hashString(JSON.stringify({
  filters,
  keys: records.slice(0, 256).map((item) => item.record.key),
  count: records.length,
}));

const buildSuggestions = (
  records: readonly GeneralSearchRankedRecord[],
  categoryFacets: readonly GeneralSearchFacetBucket[],
  typeFacets: readonly GeneralSearchFacetBucket[],
  query: string,
  maximum: number,
): readonly GeneralSearchSuggestion[] => {
  if (maximum <= 0 || !normalizeGeneralSearchText(query)) return Object.freeze([]);
  const output: GeneralSearchSuggestion[] = [];
  const seen = new Set<string>();
  const push = (suggestion: GeneralSearchSuggestion): void => {
    if (output.length >= maximum || seen.has(suggestion.id)) return;
    seen.add(suggestion.id);
    output.push(Object.freeze(suggestion));
  };

  for (const item of records.slice(0, maximum)) {
    push({
      id: `record:${item.record.key}`,
      label: item.record.title,
      detail: item.record.address || item.record.category,
      kind: 'record',
      score: item.score,
    });
  }
  for (const facet of categoryFacets) {
    push({
      id: `category:${facet.normalizedValue}`,
      label: facet.value,
      detail: `${facet.count} sonuç`,
      kind: 'category',
      score: facet.count,
    });
  }
  for (const facet of typeFacets) {
    push({
      id: `type:${facet.normalizedValue}`,
      label: facet.value,
      detail: `${facet.count} sonuç`,
      kind: 'type',
      score: facet.count,
    });
  }
  return Object.freeze(output.slice(0, maximum));
};

export const normalizeWorkspacePage = (page: unknown, pageCount: number): number => {
  const normalizedCount = Math.max(1, Math.trunc(pageCount));
  return clampInteger(page, 1, normalizedCount, 1);
};

const createPageWindow = (
  records: readonly GeneralSearchRankedRecord[],
  pageInput: unknown,
  pageSize: number,
): GeneralSearchPageWindow => {
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const page = normalizeWorkspacePage(pageInput, pageCount);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(records.length, startIndex + pageSize);
  return Object.freeze({
    page,
    pageSize,
    pageCount,
    startIndex,
    endIndex,
    items: Object.freeze(records.slice(startIndex, endIndex)),
  });
};

export interface GeneralSearchProjectionInput {
  readonly records: readonly NormalizedSearchRecord[];
  readonly filters?: Partial<GeneralSearchWorkspaceFilters>;
  readonly page?: number;
  readonly activeIndex?: number;
  readonly phase?: GeneralSearchWorkspacePhase;
  readonly options?: GeneralSearchWorkspaceOptions;
}

export const projectGeneralSearchWorkspace = (
  input: GeneralSearchProjectionInput,
): GeneralSearchWorkspaceSnapshot => {
  const options = normalizeOptions(input.options);
  const records = input.records.slice(0, options.maximumResults);
  const truncatedInputCount = Math.max(0, input.records.length - records.length);
  const filters = createGeneralSearchFilters(input.filters, options.initialSort);
  const normalizedQuery = normalizeGeneralSearchText(filters.text);
  const queryTokens = tokenizeGeneralSearch(normalizedQuery);

  const ranked = records.map((record, sourceIndex) => rankRecord(
    record,
    sourceIndex,
    normalizedQuery,
    queryTokens,
  ));
  const queryMatched = normalizedQuery
    ? ranked.filter((item) => item.score > 0)
    : ranked;

  const categoryFacets = buildFacetBuckets(
    queryMatched.filter((item) => matchesSelectedFacet(item.normalizedType, filters.types)),
    'category',
    filters.categories,
    options.maximumFacets,
  );
  const typeFacets = buildFacetBuckets(
    queryMatched.filter((item) => matchesSelectedFacet(item.normalizedCategory, filters.categories)),
    'type',
    filters.types,
    options.maximumFacets,
  );

  const filtered = queryMatched.filter((item) =>
    matchesSelectedFacet(item.normalizedCategory, filters.categories)
    && matchesSelectedFacet(item.normalizedType, filters.types));
  const sorted = [...filtered].sort((left, right) => compareRanked(left, right, filters.sort));
  const page = createPageWindow(sorted, input.page ?? 1, options.pageSize);
  const activeIndex = page.items.length === 0
    ? -1
    : clampInteger(input.activeIndex, 0, page.items.length - 1, 0);
  const activeKey = activeIndex >= 0
    ? page.items[activeIndex]?.record.key ?? null
    : null;

  const hasActiveFilters = Boolean(
    normalizeGeneralSearchText(filters.text)
    || filters.categories.length
    || filters.types.length,
  );
  const derivedPhase: GeneralSearchWorkspacePhase = input.phase
    ?? (records.length === 0 ? 'empty' : 'ready');

  return Object.freeze({
    phase: derivedPhase,
    filters,
    totalCount: records.length,
    matchedCount: sorted.length,
    page,
    categoryFacets,
    typeFacets,
    suggestions: buildSuggestions(
      sorted,
      categoryFacets,
      typeFacets,
      filters.text,
      options.maximumSuggestions,
    ),
    activeIndex,
    activeKey,
    queryTokens,
    diagnostics: Object.freeze({
      version: GENERAL_SEARCH_WORKSPACE_VERSION,
      inputCount: input.records.length,
      admittedCount: records.length,
      truncatedInputCount,
      matchedCount: sorted.length,
      filteredOutCount: Math.max(0, records.length - sorted.length),
      categoryCount: categoryFacets.length,
      typeCount: typeFacets.length,
      queryTokenCount: queryTokens.length,
      pageCount: page.pageCount,
      hasActiveFilters,
      resultFingerprint: resultFingerprint(sorted, filters),
    }),
  });
};

export const toggleFacetValue = (
  values: readonly string[],
  value: unknown,
): readonly string[] => {
  const normalized = normalizeFacetValue(value);
  if (!normalized) return Object.freeze([...values]);
  const current = new Set(values.map(normalizeFacetValue).filter(Boolean));
  if (current.has(normalized)) current.delete(normalized);
  else current.add(normalized);
  return Object.freeze(Array.from(current).sort(COLLATOR.compare));
};

export const moveGeneralSearchActiveIndex = (
  current: number,
  itemCount: number,
  key: string,
  pageStep = 8,
): number => {
  if (itemCount <= 0) return -1;
  const safeCurrent = current < 0 ? 0 : Math.min(itemCount - 1, current);
  switch (key) {
    case 'ArrowDown':
      return Math.min(itemCount - 1, safeCurrent + 1);
    case 'ArrowUp':
      return Math.max(0, safeCurrent - 1);
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    case 'PageDown':
      return Math.min(itemCount - 1, safeCurrent + Math.max(1, pageStep));
    case 'PageUp':
      return Math.max(0, safeCurrent - Math.max(1, pageStep));
    default:
      return safeCurrent;
  }
};

export const generalSearchResultDomId = (key: string): string =>
  `general-search-result-${hashString(key)}`;

export const generalSearchSuggestionDomId = (id: string): string =>
  `general-search-suggestion-${hashString(id)}`;

export const generalSearchSortLabel = (mode: GeneralSearchSortMode): string => {
  switch (mode) {
    case 'title':
      return 'Ada göre';
    case 'category':
      return 'Kategoriye göre';
    case 'address':
      return 'Adrese göre';
    case 'source-order':
      return 'Servis sırasına göre';
    case 'relevance':
    default:
      return 'En ilgili';
  }
};
