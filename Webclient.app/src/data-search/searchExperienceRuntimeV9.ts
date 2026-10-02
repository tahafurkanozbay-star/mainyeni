import type {
  FacetBucket,
  PageInfo,
  SearchRequest,
} from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import {
  SearchRecoveryRuntimeV8,
  type SearchRecoveryResultV8,
  type SearchRecoverySnapshotV8,
} from './searchRecoveryRuntimeV8';
import {
  SearchResultPresentationRuntimeV9,
  type SearchResultCardV9,
  type SearchResultPresentationPolicyV9,
  type SearchResultPresentationSnapshotV9,
} from './searchResultPresentationRuntimeV9';
import {
  SearchGroupingRuntimeV9,
  type SearchGroupingModeV9,
  type SearchGroupingPolicyV9,
  type SearchGroupingResultV9,
  type SearchGroupingSnapshotV9,
} from './searchGroupingRuntimeV9';
import {
  SearchGuidanceRuntimeV9,
  applySearchGuidanceActionV9,
  type SearchGuidanceActionV9,
  type SearchGuidancePolicyV9,
  type SearchGuidanceSnapshotV9,
  type SearchGuidanceV9,
} from './searchGuidanceRuntimeV9';
import {
  SearchSelectionRuntimeV9,
  type SearchSelectionPolicyV9,
  type SearchSelectionSnapshotV9,
} from './searchSelectionRuntimeV9';
import {
  SearchHistoryRuntimeV9,
  type SearchHistoryPolicyV9,
  type SearchHistorySnapshotV9,
  type SearchHistorySuggestionV9,
} from './searchHistoryRuntimeV9';

export const SEARCH_EXPERIENCE_VERSION_V9 = 'search-experience-v9' as const;

export interface SearchExperiencePolicyV9 {
  readonly presentation?: SearchResultPresentationPolicyV9;
  readonly grouping?: SearchGroupingPolicyV9;
  readonly guidance?: SearchGuidancePolicyV9;
  readonly selection?: SearchSelectionPolicyV9;
  readonly history?: SearchHistoryPolicyV9;
  readonly defaultGrouping?: SearchGroupingModeV9;
  readonly maxFacetFields?: number;
  readonly maxFacetBucketsPerField?: number;
  readonly maxHistorySuggestions?: number;
}

export interface SearchExperienceSearchOptionsV9 {
  readonly grouping?: SearchGroupingModeV9;
  readonly historyPrefix?: string | null;
  readonly recordHistory?: boolean;
  readonly updateSelection?: boolean;
}

export interface SearchExperiencePaginationV9 {
  readonly offset: number;
  readonly limit: number;
  readonly count: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousOffset: number | null;
  readonly nextOffset: number | null;
}

export interface SearchExperienceRequestSummaryV9 {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly filterCount: number;
  readonly facetCount: number;
  readonly sort: string;
  readonly hasSpatialConstraint: boolean;
  readonly hasAddressScope: boolean;
  readonly offset: number;
  readonly limit: number | null;
}

export interface SearchExperienceFacetV9 {
  readonly field: string;
  readonly buckets: readonly FacetBucket[];
  readonly totalBuckets: number;
  readonly truncated: boolean;
}

export interface SearchExperiencePageModelV9 {
  readonly version: typeof SEARCH_EXPERIENCE_VERSION_V9;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly requestFingerprint: string;
  readonly request: SearchExperienceRequestSummaryV9;
  readonly recovery: SearchRecoveryResultV8;
  readonly cards: readonly SearchResultCardV9[];
  readonly grouping: SearchGroupingResultV9;
  readonly guidance: SearchGuidanceV9;
  readonly selection: SearchSelectionSnapshotV9;
  readonly historySuggestions: readonly SearchHistorySuggestionV9[];
  readonly facets: readonly SearchExperienceFacetV9[];
  readonly pagination: SearchExperiencePaginationV9;
  readonly resultCount: number;
  readonly totalResultCount: number;
  readonly recovered: boolean;
  readonly blocked: boolean;
  readonly cacheHit: boolean;
  readonly fingerprint: string;
}

export interface SearchExperienceSnapshotV9 {
  readonly version: typeof SEARCH_EXPERIENCE_VERSION_V9;
  readonly searches: number;
  readonly modelsBuilt: number;
  readonly recoveredModels: number;
  readonly blockedModels: number;
  readonly emptyModels: number;
  readonly lastDatasetKey: string | null;
  readonly lastRequestFingerprint: string | null;
  readonly recovery: SearchRecoverySnapshotV8;
  readonly presentation: SearchResultPresentationSnapshotV9;
  readonly grouping: SearchGroupingSnapshotV9;
  readonly guidance: SearchGuidanceSnapshotV9;
  readonly selection: SearchSelectionSnapshotV9;
  readonly history: SearchHistorySnapshotV9;
  readonly fingerprint: string;
}

interface NormalizedExperiencePolicyV9 {
  readonly defaultGrouping: SearchGroupingModeV9;
  readonly maxFacetFields: number;
  readonly maxFacetBucketsPerField: number;
  readonly maxHistorySuggestions: number;
}

interface MutableExperienceStatsV9 {
  searches: number;
  modelsBuilt: number;
  recoveredModels: number;
  blockedModels: number;
  emptyModels: number;
  lastDatasetKey: string | null;
  lastRequestFingerprint: string | null;
}

const normalizeGroupingMode = (value: unknown): SearchGroupingModeV9 => {
  const normalized = normalizeSearchText(value);
  if (normalized === 'category'
    || normalized === 'type'
    || normalized === 'district'
    || normalized === 'neighborhood'
    || normalized === 'distance') return normalized;
  return 'none';
};

const normalizePolicy = (
  policy: SearchExperiencePolicyV9,
): NormalizedExperiencePolicyV9 => Object.freeze({
  defaultGrouping: normalizeGroupingMode(policy.defaultGrouping ?? policy.grouping?.mode),
  maxFacetFields: normalizeInteger(policy.maxFacetFields, { min: 0, max: 32, fallback: 12 }),
  maxFacetBucketsPerField: normalizeInteger(policy.maxFacetBucketsPerField, { min: 1, max: 1_000, fallback: 100 }),
  maxHistorySuggestions: normalizeInteger(policy.maxHistorySuggestions, { min: 0, max: 100, fallback: 10 }),
});

const requestSummary = (request: SearchRequest): SearchExperienceRequestSummaryV9 => Object.freeze({
  query: normalizeText(request.query),
  normalizedQuery: normalizeSearchText(request.query),
  filterCount: request.filters?.length ?? 0,
  facetCount: request.facetFields?.length ?? 0,
  sort: normalizeSearchText(request.sort) || 'relevance',
  hasSpatialConstraint: Boolean(request.center
    || (Number.isFinite(Number(request.radiusMeters)) && Number(request.radiusMeters) > 0)),
  hasAddressScope: Boolean(request.level
    || normalizeText(request.district)
    || normalizeText(request.neighborhood)
    || normalizeText(request.street)),
  offset: Math.max(0, Math.trunc(Number(request.offset) || 0)),
  limit: Number.isFinite(Number(request.limit)) && Number(request.limit) > 0
    ? Math.trunc(Number(request.limit))
    : null,
});

const paginationModel = (page: PageInfo): SearchExperiencePaginationV9 => {
  const offset = Math.max(0, Math.trunc(page.offset));
  const limit = Math.max(1, Math.trunc(page.limit));
  const count = Math.max(0, Math.trunc(page.count));
  const total = Math.max(0, Math.trunc(page.total));
  const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;
  const consumed = offset + count;
  const nextOffset = consumed < total ? consumed : null;
  return Object.freeze({
    offset,
    limit,
    count,
    total,
    hasPrevious: previousOffset !== null,
    hasNext: nextOffset !== null,
    previousOffset,
    nextOffset,
  });
};

const facetModels = (
  facets: Readonly<Record<string, readonly FacetBucket[]>>,
  maxFields: number,
  maxBuckets: number,
): readonly SearchExperienceFacetV9[] => {
  if (maxFields <= 0) return Object.freeze([]);
  const fields = Object.keys(facets)
    .map(normalizeText)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'tr-TR', { sensitivity: 'base', numeric: true }))
    .slice(0, maxFields);
  const output: SearchExperienceFacetV9[] = [];
  for (const field of fields) {
    const source = facets[field] ?? [];
    output.push(Object.freeze({
      field,
      buckets: Object.freeze(source.slice(0, maxBuckets)),
      totalBuckets: source.length,
      truncated: source.length > maxBuckets,
    }));
  }
  return Object.freeze(output);
};

const selectionIdentity = (recovery: SearchRecoveryResultV8) => Object.freeze({
  key: recovery.diagnostics.datasetKey,
  revision: recovery.diagnostics.datasetRevision,
  fingerprint: recovery.diagnostics.datasetFingerprint,
});

const modelFingerprint = (
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  grouping: SearchGroupingResultV9,
  guidance: SearchGuidanceV9,
  selection: SearchSelectionSnapshotV9,
  pagination: SearchExperiencePaginationV9,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_EXPERIENCE_VERSION_V9,
  requestFingerprint: recovery.diagnostics.requestFingerprint,
  datasetFingerprint: recovery.diagnostics.datasetFingerprint,
  cardFingerprints: cards.map(card => card.fingerprint),
  grouping: grouping.fingerprint,
  guidance: guidance.fingerprint,
  selection: selection.fingerprint,
  pagination,
}));

export class SearchExperienceRuntimeV9 {
  readonly #recovery: SearchRecoveryRuntimeV8;
  readonly #presentation: SearchResultPresentationRuntimeV9;
  readonly #grouping: SearchGroupingRuntimeV9;
  readonly #guidance: SearchGuidanceRuntimeV9;
  readonly #selection: SearchSelectionRuntimeV9;
  readonly #history: SearchHistoryRuntimeV9;
  readonly #policy: NormalizedExperiencePolicyV9;
  readonly #stats: MutableExperienceStatsV9 = {
    searches: 0,
    modelsBuilt: 0,
    recoveredModels: 0,
    blockedModels: 0,
    emptyModels: 0,
    lastDatasetKey: null,
    lastRequestFingerprint: null,
  };

  constructor(
    recovery: SearchRecoveryRuntimeV8,
    policy: SearchExperiencePolicyV9 = {},
  ) {
    if (!(recovery instanceof SearchRecoveryRuntimeV8)) {
      throw new TypeError('SearchExperienceRuntimeV9 requires the canonical SearchRecoveryRuntimeV8');
    }
    this.#recovery = recovery;
    this.#policy = normalizePolicy(policy);
    this.#presentation = new SearchResultPresentationRuntimeV9(policy.presentation);
    this.#grouping = new SearchGroupingRuntimeV9(policy.grouping);
    this.#guidance = new SearchGuidanceRuntimeV9(policy.guidance);
    this.#selection = new SearchSelectionRuntimeV9(policy.selection);
    this.#history = new SearchHistoryRuntimeV9(policy.history);
  }

  recoveryRuntime(): SearchRecoveryRuntimeV8 {
    return this.#recovery;
  }

  search(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
    options: SearchExperienceSearchOptionsV9 = {},
  ): SearchExperiencePageModelV9 {
    const datasetKey = normalizeSearchText(datasetKeyInput)
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160);
    if (!datasetKey) throw new TypeError('Search experience dataset key is required');
    this.#stats.searches += 1;

    const recovery = this.#recovery.search(datasetKey, request);
    const cards = this.#presentation.cards(request, recovery);
    const groupingMode = options.grouping === undefined
      ? this.#policy.defaultGrouping
      : normalizeGroupingMode(options.grouping);
    const grouping = this.#grouping.group(cards, groupingMode);
    const guidance = this.#guidance.evaluate(request, recovery, cards, grouping);
    if (options.recordHistory !== false) this.#history.record(request, recovery);
    const historyPrefix = options.historyPrefix === undefined
      ? normalizeText(request.query)
      : normalizeText(options.historyPrefix);
    const historySuggestions = this.#policy.maxHistorySuggestions > 0
      ? this.#history.suggestions(datasetKey, historyPrefix, this.#policy.maxHistorySuggestions)
      : Object.freeze([]);

    const selection = options.updateSelection === false
      ? this.#selection.snapshot()
      : this.#selection.setResults(selectionIdentity(recovery), cards);
    const facets = facetModels(
      recovery.response.facets,
      this.#policy.maxFacetFields,
      this.#policy.maxFacetBucketsPerField,
    );
    const pagination = paginationModel(recovery.response.page);
    const blocked = recovery.final.result.diagnostics.blocked;

    this.#stats.modelsBuilt += 1;
    if (recovery.diagnostics.recovered) this.#stats.recoveredModels += 1;
    if (blocked) this.#stats.blockedModels += 1;
    if (!blocked && cards.length === 0) this.#stats.emptyModels += 1;
    this.#stats.lastDatasetKey = datasetKey;
    this.#stats.lastRequestFingerprint = recovery.diagnostics.requestFingerprint;

    return Object.freeze({
      version: SEARCH_EXPERIENCE_VERSION_V9,
      datasetKey: recovery.diagnostics.datasetKey,
      datasetRevision: recovery.diagnostics.datasetRevision,
      datasetFingerprint: recovery.diagnostics.datasetFingerprint,
      requestFingerprint: recovery.diagnostics.requestFingerprint,
      request: requestSummary(request),
      recovery,
      cards,
      grouping,
      guidance,
      selection,
      historySuggestions,
      facets,
      pagination,
      resultCount: cards.length,
      totalResultCount: recovery.response.page.total,
      recovered: recovery.diagnostics.recovered,
      blocked,
      cacheHit: recovery.final.cacheHit,
      fingerprint: modelFingerprint(recovery, cards, grouping, guidance, selection, pagination),
    });
  }

  applyAction(
    request: SearchRequest,
    action: SearchGuidanceActionV9,
  ): SearchRequest {
    return applySearchGuidanceActionV9(request, action);
  }

  select(key?: unknown): SearchSelectionSnapshotV9 {
    return this.#selection.select(key);
  }

  toggleSelection(key?: unknown): SearchSelectionSnapshotV9 {
    return this.#selection.toggle(key);
  }

  setActive(key: unknown): SearchSelectionSnapshotV9 {
    return this.#selection.setActive(key);
  }

  next(): SearchSelectionSnapshotV9 {
    return this.#selection.next();
  }

  previous(): SearchSelectionSnapshotV9 {
    return this.#selection.previous();
  }

  first(): SearchSelectionSnapshotV9 {
    return this.#selection.first();
  }

  last(): SearchSelectionSnapshotV9 {
    return this.#selection.last();
  }

  pageNext(): SearchSelectionSnapshotV9 {
    return this.#selection.pageNext();
  }

  pagePrevious(): SearchSelectionSnapshotV9 {
    return this.#selection.pagePrevious();
  }

  clearSelection(): SearchSelectionSnapshotV9 {
    return this.#selection.clearSelection();
  }

  historySuggestions(
    datasetKey: unknown,
    prefix: unknown = '',
    limit?: unknown,
  ): readonly SearchHistorySuggestionV9[] {
    return this.#history.suggestions(datasetKey, prefix, limit);
  }

  clearHistory(datasetKey?: unknown): number {
    return datasetKey === undefined ? this.#history.clear() : this.#history.clear(datasetKey);
  }

  snapshot(): SearchExperienceSnapshotV9 {
    const recovery = this.#recovery.snapshot();
    const presentation = this.#presentation.snapshot();
    const grouping = this.#grouping.snapshot();
    const guidance = this.#guidance.snapshot();
    const selection = this.#selection.snapshot();
    const history = this.#history.snapshot();
    return Object.freeze({
      version: SEARCH_EXPERIENCE_VERSION_V9,
      searches: this.#stats.searches,
      modelsBuilt: this.#stats.modelsBuilt,
      recoveredModels: this.#stats.recoveredModels,
      blockedModels: this.#stats.blockedModels,
      emptyModels: this.#stats.emptyModels,
      lastDatasetKey: this.#stats.lastDatasetKey,
      lastRequestFingerprint: this.#stats.lastRequestFingerprint,
      recovery,
      presentation,
      grouping,
      guidance,
      selection,
      history,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_EXPERIENCE_VERSION_V9,
        stats: this.#stats,
        recovery: recovery.fingerprint,
        presentation: presentation.fingerprint,
        grouping: grouping.fingerprint,
        guidance: guidance.fingerprint,
        selection: selection.fingerprint,
        history: history.fingerprint,
      })),
    });
  }
}

export const createSearchExperienceRuntimeV9 = (
  recovery: SearchRecoveryRuntimeV8,
  policy: SearchExperiencePolicyV9 = {},
): SearchExperienceRuntimeV9 => new SearchExperienceRuntimeV9(recovery, policy);
