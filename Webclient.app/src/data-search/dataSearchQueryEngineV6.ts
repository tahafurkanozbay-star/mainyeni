import type { NormalizedRecord, SearchFilter } from './contracts';
import { hashFingerprint, normalizeInteger, stableSerialize } from './normalization';
import {
  FilterIndexRuntime,
  defaultSearchFilterFields,
  type FilterExecutionPlan,
  type FilterIndexFieldConfig,
  type FilterIndexOptions,
} from './filterIndexRuntime';
import { matchesFilter } from './searchRuntime';
import {
  FacetAggregationRuntime,
  type FacetAggregationPolicy,
  type FacetAggregationResult,
  type FacetAggregationSelection,
} from './facetAggregationRuntime';
import {
  RelevanceIndexRuntime,
  type RelevanceHit,
  type RelevanceIndexPolicy,
  type RelevanceSearchDiagnostics,
} from './relevanceIndexRuntime';
import {
  SearchSuggestionRuntime,
  type SearchSuggestionPolicy,
  type SearchSuggestionResult,
} from './searchSuggestionRuntime';
import {
  TextQueryAnalysisRuntime,
  type TextQueryAnalysis,
  type TextQueryAnalysisPolicy,
} from './textQueryAnalysisRuntime';

export interface DataSearchQueryEnginePolicy {
  readonly maximumRecords: number;
  readonly maximumFilters: number;
  readonly maximumRerankDocuments: number;
  readonly defaultLimit: number;
  readonly maximumLimit: number;
  readonly maximumOffset: number;
  readonly analyzer: Partial<TextQueryAnalysisPolicy>;
  readonly relevance: Partial<RelevanceIndexPolicy>;
  readonly facets: Partial<FacetAggregationPolicy>;
  readonly suggestions: Partial<SearchSuggestionPolicy>;
  readonly filterIndex: FilterIndexOptions;
}

export interface DataSearchQueryRequestV6 {
  readonly query?: unknown;
  readonly filters?: readonly SearchFilter[];
  readonly offset?: number;
  readonly limit?: number;
  readonly includeFacets?: boolean;
  readonly facetSelection?: FacetAggregationSelection;
}

export interface DataSearchQueryPageV6 {
  readonly offset: number;
  readonly limit: number;
  readonly count: number;
  readonly totalRanked: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface DataSearchQueryDiagnosticsV6 {
  readonly fingerprint: string;
  readonly datasetRevision: string;
  readonly querySignature: string;
  readonly filterPlan: FilterExecutionPlan;
  readonly filterCandidates: number;
  readonly residualFiltered: number;
  readonly rerankDocuments: number;
  readonly blocked: boolean;
  readonly blockReason: string | null;
  readonly relevance: RelevanceSearchDiagnostics;
}

export interface DataSearchQueryResponseV6 {
  readonly analysis: TextQueryAnalysis;
  readonly hits: readonly RelevanceHit[];
  readonly page: DataSearchQueryPageV6;
  readonly facets: FacetAggregationResult | null;
  readonly diagnostics: DataSearchQueryDiagnosticsV6;
}

export interface DataSearchQueryEngineSnapshotV6 {
  readonly version: 6;
  readonly datasetRevision: string;
  readonly recordCount: number;
  readonly filterIndexFingerprint: string;
  readonly relevanceDistinctTerms: number;
  readonly suggestionTerms: number;
  readonly queries: number;
  readonly blockedQueries: number;
  readonly filteredQueries: number;
}

const DEFAULT_POLICY: DataSearchQueryEnginePolicy = Object.freeze({
  maximumRecords: 200_000,
  maximumFilters: 32,
  maximumRerankDocuments: 25_000,
  defaultLimit: 25,
  maximumLimit: 500,
  maximumOffset: 100_000,
  analyzer: Object.freeze({}),
  relevance: Object.freeze({}),
  facets: Object.freeze({}),
  suggestions: Object.freeze({}),
  filterIndex: Object.freeze({}),
});

const EMPTY_RELEVANCE_DIAGNOSTICS: RelevanceSearchDiagnostics = Object.freeze({
  candidateCount: 0,
  scoredCount: 0,
  rejectedRequired: 0,
  rejectedExcluded: 0,
  rejectedField: 0,
  rejectedPhrase: 0,
  prefixExpansions: 0,
  candidateTruncated: false,
  resultTruncated: false,
});

const normalizePositiveInteger = (value: number | undefined, fallback: number, maximum: number): number => normalizeInteger(value, {
  min: 1,
  max: maximum,
  fallback,
});

const normalizePolicy = (input: Partial<DataSearchQueryEnginePolicy>): DataSearchQueryEnginePolicy => Object.freeze({
  maximumRecords: normalizePositiveInteger(input.maximumRecords, DEFAULT_POLICY.maximumRecords, 1_000_000),
  maximumFilters: normalizePositiveInteger(input.maximumFilters, DEFAULT_POLICY.maximumFilters, 256),
  maximumRerankDocuments: normalizePositiveInteger(input.maximumRerankDocuments, DEFAULT_POLICY.maximumRerankDocuments, 250_000),
  defaultLimit: normalizePositiveInteger(input.defaultLimit, DEFAULT_POLICY.defaultLimit, 10_000),
  maximumLimit: normalizePositiveInteger(input.maximumLimit, DEFAULT_POLICY.maximumLimit, 10_000),
  maximumOffset: normalizeInteger(input.maximumOffset, { min: 0, max: 10_000_000, fallback: DEFAULT_POLICY.maximumOffset }),
  analyzer: Object.freeze({ ...input.analyzer }),
  relevance: Object.freeze({ ...input.relevance }),
  facets: Object.freeze({ ...input.facets }),
  suggestions: Object.freeze({ ...input.suggestions }),
  filterIndex: Object.freeze({ ...input.filterIndex }),
});

const normalizeRequest = (
  request: DataSearchQueryRequestV6,
  policy: DataSearchQueryEnginePolicy,
): Required<Pick<DataSearchQueryRequestV6, 'offset' | 'limit' | 'includeFacets'>> & DataSearchQueryRequestV6 => {
  const maximumLimit = Math.max(policy.defaultLimit, policy.maximumLimit);
  return Object.freeze({
    query: request.query ?? '',
    filters: Object.freeze((request.filters ?? []).slice(0, policy.maximumFilters)),
    offset: normalizeInteger(request.offset, { min: 0, max: policy.maximumOffset, fallback: 0 }),
    limit: normalizeInteger(request.limit, { min: 1, max: maximumLimit, fallback: policy.defaultLimit }),
    includeFacets: request.includeFacets !== false,
    facetSelection: request.facetSelection ?? Object.freeze({}),
  });
};

const recordAt = (records: readonly NormalizedRecord[], position: number): NormalizedRecord | null => records[position] ?? null;

const recordsForPositions = (
  records: readonly NormalizedRecord[],
  positions: readonly number[],
  maximum: number,
): readonly NormalizedRecord[] => {
  const result: NormalizedRecord[] = [];
  for (const position of positions) {
    const record = recordAt(records, position);
    if (!record) continue;
    result.push(record);
    if (result.length >= maximum) break;
  }
  return Object.freeze(result);
};

const matchesAllFilters = (record: NormalizedRecord, filters: readonly SearchFilter[]): boolean => {
  for (const filter of filters) if (!matchesFilter(record, filter)) return false;
  return true;
};

const residualFilterRecords = (
  records: readonly NormalizedRecord[],
  filters: readonly SearchFilter[],
): readonly NormalizedRecord[] => {
  if (filters.length === 0) return records;
  const result: NormalizedRecord[] = [];
  for (const record of records) if (matchesAllFilters(record, filters)) result.push(record);
  return Object.freeze(result);
};

const selectionFromFilters = (filters: readonly SearchFilter[]): FacetAggregationSelection => {
  const mutable: Partial<Record<'category' | 'type' | 'district' | 'neighborhood' | 'street' | 'postalCode', string[]>> = {};
  for (const filter of filters) {
    const field = filter.field;
    if (field !== 'category' && field !== 'type' && field !== 'district' && field !== 'neighborhood' && field !== 'street' && field !== 'postalCode') continue;
    if (filter.operator !== 'eq' && filter.operator !== 'in' && filter.operator !== 'prefix') continue;
    const values = mutable[field] ?? [];
    for (const value of filter.values) values.push(String(value));
    mutable[field] = values;
  }
  const result: {
    category?: readonly string[];
    type?: readonly string[];
    district?: readonly string[];
    neighborhood?: readonly string[];
    street?: readonly string[];
    postalCode?: readonly string[];
  } = {};
  if (mutable.category) result.category = Object.freeze(mutable.category.slice());
  if (mutable.type) result.type = Object.freeze(mutable.type.slice());
  if (mutable.district) result.district = Object.freeze(mutable.district.slice());
  if (mutable.neighborhood) result.neighborhood = Object.freeze(mutable.neighborhood.slice());
  if (mutable.street) result.street = Object.freeze(mutable.street.slice());
  if (mutable.postalCode) result.postalCode = Object.freeze(mutable.postalCode.slice());
  return Object.freeze(result);
};

const mergeSelection = (
  filterSelection: FacetAggregationSelection,
  explicitSelection: FacetAggregationSelection | undefined,
): FacetAggregationSelection => {
  const explicit = explicitSelection ?? {};
  const result: {
    category?: readonly string[];
    type?: readonly string[];
    district?: readonly string[];
    neighborhood?: readonly string[];
    street?: readonly string[];
    postalCode?: readonly string[];
  } = {};
  const assign = (field: keyof typeof result): void => {
    const combined = [...(filterSelection[field] ?? []), ...(explicit[field] ?? [])];
    if (combined.length > 0) result[field] = Object.freeze(Array.from(new Set(combined)));
  };
  assign('category');
  assign('type');
  assign('district');
  assign('neighborhood');
  assign('street');
  assign('postalCode');
  return Object.freeze(result);
};

const createPage = (
  offset: number,
  limit: number,
  totalRanked: number,
  count: number,
): DataSearchQueryPageV6 => {
  const next = offset + count;
  return Object.freeze({
    offset,
    limit,
    count,
    totalRanked,
    hasMore: next < totalRanked,
    nextOffset: next < totalRanked ? next : null,
  });
};

const emptyResponse = (
  analysis: TextQueryAnalysis,
  plan: FilterExecutionPlan,
  datasetRevision: string,
  request: ReturnType<typeof normalizeRequest>,
  filterCandidates: number,
  residualFiltered: number,
  reason: string,
): DataSearchQueryResponseV6 => {
  const fingerprint = hashFingerprint(stableSerialize({ datasetRevision, query: analysis.signature, filter: plan.fingerprint, reason }));
  return Object.freeze({
    analysis,
    hits: Object.freeze([]),
    page: createPage(request.offset, request.limit, 0, 0),
    facets: null,
    diagnostics: Object.freeze({
      fingerprint,
      datasetRevision,
      querySignature: analysis.signature,
      filterPlan: plan,
      filterCandidates,
      residualFiltered,
      rerankDocuments: 0,
      blocked: true,
      blockReason: reason,
      relevance: EMPTY_RELEVANCE_DIAGNOSTICS,
    }),
  });
};

const sliceHits = (hits: readonly RelevanceHit[], offset: number, limit: number): readonly RelevanceHit[] => Object.freeze(hits.slice(offset, offset + limit));

const executeRelevance = (
  records: readonly NormalizedRecord[],
  analysis: TextQueryAnalysis,
  policy: DataSearchQueryEnginePolicy,
): { readonly hits: readonly RelevanceHit[]; readonly diagnostics: RelevanceSearchDiagnostics } => {
  const runtime = new RelevanceIndexRuntime(records, 'query-subset', {
    ...policy.relevance,
    maximumRecords: Math.min(policy.maximumRerankDocuments, policy.maximumRecords),
    maximumResults: Math.min(10_000, Math.max(policy.maximumLimit + policy.maximumOffset, policy.maximumLimit)),
    maximumCandidates: Math.min(policy.maximumRerankDocuments, policy.maximumRecords),
  });
  return runtime.search(analysis, Math.min(10_000, Math.max(policy.maximumLimit + policy.maximumOffset, policy.maximumLimit)));
};

export class DataSearchQueryEngineV6 {
  readonly #policy: DataSearchQueryEnginePolicy;
  readonly #records: readonly NormalizedRecord[];
  readonly #datasetRevision: string;
  readonly #analyzer: TextQueryAnalysisRuntime;
  readonly #filterIndex: FilterIndexRuntime;
  readonly #globalRelevance: RelevanceIndexRuntime;
  readonly #facets: FacetAggregationRuntime;
  readonly #suggestions: SearchSuggestionRuntime;
  #queries = 0;
  #blockedQueries = 0;
  #filteredQueries = 0;

  constructor(
    records: readonly NormalizedRecord[],
    datasetRevision: string,
    policyInput: Partial<DataSearchQueryEnginePolicy> = {},
    filterFields: readonly FilterIndexFieldConfig[] = defaultSearchFilterFields(),
  ) {
    this.#policy = normalizePolicy(policyInput);
    if (records.length > this.#policy.maximumRecords) {
      throw new RangeError(`record count exceeds maximumRecords=${this.#policy.maximumRecords}`);
    }
    this.#records = Object.freeze(records.slice());
    this.#datasetRevision = String(datasetRevision || '1');
    this.#analyzer = new TextQueryAnalysisRuntime(this.#policy.analyzer);
    this.#filterIndex = new FilterIndexRuntime(this.#records, filterFields, this.#policy.filterIndex);
    this.#globalRelevance = new RelevanceIndexRuntime(this.#records, this.#datasetRevision, {
      ...this.#policy.relevance,
      maximumRecords: this.#policy.maximumRecords,
      maximumResults: Math.min(10_000, Math.max(this.#policy.maximumLimit + this.#policy.maximumOffset, this.#policy.maximumLimit)),
    });
    this.#facets = new FacetAggregationRuntime(this.#policy.facets);
    this.#suggestions = new SearchSuggestionRuntime(this.#records, this.#policy.suggestions);
  }

  policy(): DataSearchQueryEnginePolicy {
    return this.#policy;
  }

  snapshot(): DataSearchQueryEngineSnapshotV6 {
    return Object.freeze({
      version: 6,
      datasetRevision: this.#datasetRevision,
      recordCount: this.#records.length,
      filterIndexFingerprint: this.#filterIndex.snapshot().fingerprint,
      relevanceDistinctTerms: this.#globalRelevance.snapshot().distinctTerms,
      suggestionTerms: this.#suggestions.snapshot().termCount,
      queries: this.#queries,
      blockedQueries: this.#blockedQueries,
      filteredQueries: this.#filteredQueries,
    });
  }

  suggest(input: unknown, limit?: number): SearchSuggestionResult {
    return this.#suggestions.suggest(input, limit);
  }

  search(requestInput: DataSearchQueryRequestV6 = {}): DataSearchQueryResponseV6 {
    const request = normalizeRequest(requestInput, this.#policy);
    const analysis = this.#analyzer.analyze(request.query);
    const filters = request.filters ?? Object.freeze([]);
    const plan = this.#filterIndex.plan(filters);
    this.#queries += 1;
    if (filters.length > 0) this.#filteredQueries += 1;
    if (plan.truncated) {
      this.#blockedQueries += 1;
      return emptyResponse(analysis, plan, this.#datasetRevision, request, plan.positions.length, 0, 'filter-plan-truncated');
    }
    const plannedRecords = recordsForPositions(this.#records, plan.positions, this.#policy.maximumRerankDocuments + 1);
    if (plannedRecords.length > this.#policy.maximumRerankDocuments) {
      this.#blockedQueries += 1;
      return emptyResponse(analysis, plan, this.#datasetRevision, request, plan.positions.length, 0, 'rerank-budget-exceeded');
    }
    const filteredRecords = residualFilterRecords(plannedRecords, filters);
    if (filteredRecords.length > this.#policy.maximumRerankDocuments) {
      this.#blockedQueries += 1;
      return emptyResponse(analysis, plan, this.#datasetRevision, request, plan.positions.length, filteredRecords.length, 'residual-filter-budget-exceeded');
    }
    const relevance = filters.length === 0
      ? this.#globalRelevance.search(analysis, Math.min(10_000, request.offset + request.limit))
      : executeRelevance(filteredRecords, analysis, this.#policy);
    const pageHits = sliceHits(relevance.hits, request.offset, request.limit);
    const filterSelection = selectionFromFilters(filters);
    const selection = mergeSelection(filterSelection, request.facetSelection);
    const facets = request.includeFacets
      ? this.#facets.aggregateRecords(filteredRecords, selection)
      : null;
    const fingerprint = hashFingerprint(stableSerialize({
      datasetRevision: this.#datasetRevision,
      query: analysis.signature,
      filter: plan.fingerprint,
      offset: request.offset,
      limit: request.limit,
    }));
    return Object.freeze({
      analysis,
      hits: pageHits,
      page: createPage(request.offset, request.limit, relevance.hits.length, pageHits.length),
      facets,
      diagnostics: Object.freeze({
        fingerprint,
        datasetRevision: this.#datasetRevision,
        querySignature: analysis.signature,
        filterPlan: plan,
        filterCandidates: plan.positions.length,
        residualFiltered: filteredRecords.length,
        rerankDocuments: filteredRecords.length,
        blocked: false,
        blockReason: null,
        relevance: relevance.diagnostics,
      }),
    });
  }
}
