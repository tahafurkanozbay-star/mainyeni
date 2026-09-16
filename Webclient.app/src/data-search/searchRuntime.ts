import type {
  CandidateIndex,
  DatasetSnapshot,
  FacetBucket,
  FilterOperator,
  NormalizedRecord,
  NormalizedSearchRequest,
  RegisterDatasetOptions,
  SearchDiagnostics,
  SearchFilter,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchRuntimeOptions,
  SearchRuntimeSnapshot,
  SpatialIndex,
} from './contracts';
import { throwIfAborted } from './contracts';
import {
  buildFacetCounts,
  createDatasetFingerprint,
  createPageInfo,
  normalizeCoordinates,
  normalizeInteger,
  normalizeRecordCollection,
  normalizeSearchText,
  normalizeText,
  tokenizeSearchText,
} from './normalization';
import {
  analyzeAddressQuery,
  matchesAddressHierarchy,
  scoreAddressRecord,
} from './addressSemantics';
import {
  buildCandidateIndex,
  planCandidates,
} from './candidatePlanner';
import {
  buildSpatialIndex,
  haversineDistanceMeters,
  searchRadius,
} from './spatialIndex';

export const DEFAULT_SEARCH_LIMIT = 50;
export const DEFAULT_MAX_SEARCH_LIMIT = 250;
export const DEFAULT_MAX_DATASETS = 12;
export const DEFAULT_CACHE_SIZE = 128;
export const MAX_FILTERS = 16;
export const MAX_FACET_FIELDS = 12;
export const MAX_QUERY_TERMS = 12;

const ALLOWED_FILTER_OPERATORS = new Set<FilterOperator>([
  'eq',
  'neq',
  'in',
  'prefix',
  'contains',
  'exists',
  'gte',
  'lte',
  'between',
]);

const SEARCH_FIELD_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  title: 8,
  address: 5,
  district: 4,
  neighborhood: 4,
  street: 5,
  category: 3,
  type: 3,
  door: 3,
  postalCode: 2,
  phone: 1,
});

interface RuntimeOptionsNormalized {
  readonly maxDatasets: number;
  readonly cacheSize: number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly candidatePlanner: NonNullable<SearchRuntimeOptions['candidatePlanner']>;
  readonly spatial: NonNullable<SearchRuntimeOptions['spatial']>;
  readonly clock: () => number;
}

interface CacheEntry {
  readonly key: string;
  readonly datasetRevision: number;
  readonly response: SearchResponse;
  readonly createdAt: number;
}

interface MutableStats {
  searches: number;
  cacheHits: number;
  cacheMisses: number;
  aborts: number;
  registrations: number;
  replacements: number;
  evictions: number;
}

const normalizeRuntimeOptions = (options: SearchRuntimeOptions = {}): RuntimeOptionsNormalized => ({
  maxDatasets: normalizeInteger(options.maxDatasets, { min: 1, max: 128, fallback: DEFAULT_MAX_DATASETS }),
  cacheSize: normalizeInteger(options.cacheSize, { min: 1, max: 5_000, fallback: DEFAULT_CACHE_SIZE }),
  defaultLimit: normalizeInteger(options.defaultLimit, { min: 1, max: 1_000, fallback: DEFAULT_SEARCH_LIMIT }),
  maxLimit: normalizeInteger(options.maxLimit, { min: 1, max: 1_000, fallback: DEFAULT_MAX_SEARCH_LIMIT }),
  candidatePlanner: options.candidatePlanner ?? {},
  spatial: options.spatial ?? {},
  clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
});

const safeClock = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const normalizeDatasetKey = (value: unknown): string =>
  normalizeSearchText(value)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const normalizeOperator = (value: unknown): FilterOperator => {
  const normalized = normalizeSearchText(value) as FilterOperator;
  return ALLOWED_FILTER_OPERATORS.has(normalized) ? normalized : 'eq';
};

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];

const normalizeFilter = (value: unknown): SearchFilter | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const field = normalizeText(record.field);
  if (!field) return null;
  const operator = normalizeOperator(record.operator);
  const values = asArray(record.values ?? record.value)
    .filter(item => item !== null && item !== undefined && item !== '')
    .slice(0, 100);
  if (operator !== 'exists' && !values.length) return null;
  return Object.freeze({
    field,
    operator,
    values: Object.freeze(values),
    caseSensitive: record.caseSensitive === true,
  });
};

const normalizeFilters = (values: readonly SearchFilter[] | undefined): readonly SearchFilter[] =>
  Object.freeze((values ?? [])
    .map(normalizeFilter)
    .filter((value): value is SearchFilter => value !== null)
    .slice(0, MAX_FILTERS));

export const normalizeSearchRequest = (
  request: SearchRequest = {},
  runtimeOptions: Pick<RuntimeOptionsNormalized, 'defaultLimit' | 'maxLimit'> = {
    defaultLimit: DEFAULT_SEARCH_LIMIT,
    maxLimit: DEFAULT_MAX_SEARCH_LIMIT,
  },
): NormalizedSearchRequest => {
  const query = normalizeText(request.query);
  const normalizedQuery = normalizeSearchText(query);
  const offset = normalizeInteger(request.offset, { min: 0, fallback: 0 });
  const limit = normalizeInteger(request.limit, {
    min: 1,
    max: runtimeOptions.maxLimit,
    fallback: runtimeOptions.defaultLimit,
  });
  const minScoreRaw = Number(request.minScore);
  const radiusRaw = Number(request.radiusMeters);
  const facetFields = Array.from(new Set((request.facetFields ?? [])
    .map(normalizeText)
    .filter(Boolean)))
    .slice(0, MAX_FACET_FIELDS);
  const level = request.level ?? null;
  return Object.freeze({
    query,
    normalizedQuery,
    terms: Object.freeze(tokenizeSearchText(query).slice(0, MAX_QUERY_TERMS)),
    filters: normalizeFilters(request.filters),
    facetFields: Object.freeze(facetFields),
    sort: request.sort ?? 'relevance',
    minScore: Number.isFinite(minScoreRaw) ? Math.max(0, minScoreRaw) : 0,
    offset,
    limit,
    center: normalizeCoordinates(request.center),
    radiusMeters: Number.isFinite(radiusRaw) ? Math.max(0, radiusRaw) : 0,
    level,
    district: normalizeText(request.district),
    neighborhood: normalizeText(request.neighborhood),
    street: normalizeText(request.street),
    signal: request.signal ?? null,
  });
};

const readRecordField = (record: NormalizedRecord, field: string): unknown => {
  const direct = record as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(direct, field)) return direct[field];
  if (Object.prototype.hasOwnProperty.call(record.fields, field)) return record.fields[field];
  return null;
};

const comparable = (value: unknown, caseSensitive: boolean): string | number | boolean | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value);
  return caseSensitive ? text : normalizeSearchText(text);
};

const equalValue = (left: unknown, right: unknown, caseSensitive: boolean): boolean =>
  comparable(left, caseSensitive) === comparable(right, caseSensitive);

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const matchesFilter = (record: NormalizedRecord, filter: SearchFilter): boolean => {
  const raw = readRecordField(record, filter.field);
  const values = filter.values;
  const sensitive = filter.caseSensitive === true;
  switch (filter.operator) {
    case 'exists':
      return raw !== null && raw !== undefined && raw !== '';
    case 'neq':
      return !values.some(value => equalValue(raw, value, sensitive));
    case 'in':
      return values.some(value => equalValue(raw, value, sensitive));
    case 'prefix': {
      const candidate = comparable(raw, sensitive);
      return typeof candidate === 'string' && values.some(value => {
        const expected = comparable(value, sensitive);
        return typeof expected === 'string' && candidate.startsWith(expected);
      });
    }
    case 'contains': {
      const candidate = comparable(raw, sensitive);
      return typeof candidate === 'string' && values.some(value => {
        const expected = comparable(value, sensitive);
        return typeof expected === 'string' && candidate.includes(expected);
      });
    }
    case 'gte': {
      const candidate = finite(raw);
      const minimum = finite(values[0]);
      return candidate !== null && minimum !== null && candidate >= minimum;
    }
    case 'lte': {
      const candidate = finite(raw);
      const maximum = finite(values[0]);
      return candidate !== null && maximum !== null && candidate <= maximum;
    }
    case 'between': {
      const candidate = finite(raw);
      const first = finite(values[0]);
      const second = finite(values[1]);
      return candidate !== null && first !== null && second !== null
        && candidate >= Math.min(first, second)
        && candidate <= Math.max(first, second);
    }
    case 'eq':
    default:
      return values.some(value => equalValue(raw, value, sensitive));
  }
};

const matchesFilters = (record: NormalizedRecord, filters: readonly SearchFilter[]): boolean =>
  filters.every(filter => matchesFilter(record, filter));

const scoreField = (
  value: unknown,
  normalizedQuery: string,
  terms: readonly string[],
): number => {
  const candidate = normalizeSearchText(value);
  if (!candidate) return 0;
  if (!normalizedQuery) return 1;
  let score = 0;
  if (candidate === normalizedQuery) score += 120;
  else if (candidate.startsWith(normalizedQuery)) score += 80;
  else if (candidate.includes(normalizedQuery)) score += 45;
  let matched = 0;
  for (const term of terms) {
    if (candidate === term) {
      score += 35;
      matched += 1;
    } else if (candidate.startsWith(term)) {
      score += 24;
      matched += 1;
    } else if (candidate.includes(term)) {
      score += 12;
      matched += 1;
    }
  }
  if (terms.length && matched === terms.length) score += 40;
  return score;
};

const textScore = (record: NormalizedRecord, request: NormalizedSearchRequest): number => {
  if (!request.normalizedQuery) return 1;
  let score = 0;
  for (const [field, weight] of Object.entries(SEARCH_FIELD_WEIGHTS)) {
    score += scoreField(readRecordField(record, field), request.normalizedQuery, request.terms) * weight;
  }
  if (record.searchText === request.normalizedQuery) score += 140;
  else if (record.searchText.startsWith(request.normalizedQuery)) score += 70;
  else if (record.searchText.includes(request.normalizedQuery)) score += 30;
  return score;
};

const hierarchyMatches = (record: NormalizedRecord, request: NormalizedSearchRequest): boolean =>
  matchesAddressHierarchy(record, {
    level: request.level,
    district: request.district,
    neighborhood: request.neighborhood,
    street: request.street,
  });

const facetBuckets = (
  hits: readonly SearchHit[],
  fields: readonly string[],
): Readonly<Record<string, readonly FacetBucket[]>> => {
  const output: Record<string, readonly FacetBucket[]> = {};
  for (const field of fields) {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const raw = readRecordField(hit.record, field);
      const value = normalizeText(raw);
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    output[field] = Object.freeze(Array.from(counts.entries())
      .map(([value, count]) => Object.freeze({ value, count }))
      .sort((left, right) => right.count - left.count
        || left.value.localeCompare(right.value, 'tr-TR', { sensitivity: 'base', numeric: true })));
  }
  return Object.freeze(output);
};

const searchSignature = (datasetKey: string, revision: number, request: NormalizedSearchRequest): string =>
  JSON.stringify({
    datasetKey,
    revision,
    query: request.normalizedQuery,
    filters: request.filters,
    facets: request.facetFields,
    sort: request.sort,
    minScore: request.minScore,
    offset: request.offset,
    limit: request.limit,
    center: request.center,
    radiusMeters: request.radiusMeters,
    level: request.level,
    district: normalizeSearchText(request.district),
    neighborhood: normalizeSearchText(request.neighborhood),
    street: normalizeSearchText(request.street),
  });

const sortHits = (
  hits: SearchHit[],
  mode: NormalizedSearchRequest['sort'],
): void => {
  hits.sort((left, right) => {
    if (mode === 'distance') {
      const leftDistance = left.distanceMeters ?? Number.POSITIVE_INFINITY;
      const rightDistance = right.distanceMeters ?? Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    if (mode === 'title') {
      const comparison = left.record.title.localeCompare(right.record.title, 'tr-TR', {
        sensitivity: 'base',
        numeric: true,
      });
      if (comparison !== 0) return comparison;
    }
    if (mode === 'source-order') return left.record.sourceIndex - right.record.sourceIndex;
    if (right.score !== left.score) return right.score - left.score;
    const title = left.record.title.localeCompare(right.record.title, 'tr-TR', {
      sensitivity: 'base',
      numeric: true,
    });
    return title || left.record.sourceIndex - right.record.sourceIndex;
  });
};

const immutableHit = (
  record: NormalizedRecord,
  score: number,
  distanceMeters: number | null,
  reasons: readonly string[],
): SearchHit => Object.freeze({
  record,
  score,
  distanceMeters,
  reasons: Object.freeze([...reasons]),
});

const createDatasetSnapshot = (
  key: string,
  revision: number,
  records: readonly NormalizedRecord[],
  quality: DatasetSnapshot['quality'],
  candidateIndex: CandidateIndex,
  spatialIndex: SpatialIndex,
  createdAt: number,
  updatedAt: number,
): DatasetSnapshot => Object.freeze({
  key,
  revision,
  fingerprint: createDatasetFingerprint(records),
  records,
  quality,
  candidateIndex,
  spatialIndex,
  createdAt,
  updatedAt,
});

export class DataSearchRuntime {
  private readonly options: RuntimeOptionsNormalized;
  private readonly datasets = new Map<string, DatasetSnapshot>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly stats: MutableStats = {
    searches: 0,
    cacheHits: 0,
    cacheMisses: 0,
    aborts: 0,
    registrations: 0,
    replacements: 0,
    evictions: 0,
  };

  constructor(options: SearchRuntimeOptions = {}) {
    this.options = normalizeRuntimeOptions(options);
  }

  private now(): number {
    return safeClock(this.options.clock);
  }

  private touchDataset(key: string, snapshot: DatasetSnapshot): void {
    this.datasets.delete(key);
    this.datasets.set(key, snapshot);
  }

  private evictDatasets(): void {
    while (this.datasets.size > this.options.maxDatasets) {
      const oldest = this.datasets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.datasets.delete(oldest);
      this.invalidateCache(oldest);
      this.stats.evictions += 1;
    }
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private cacheGet(key: string, revision: number): SearchResponse | null {
    const entry = this.cache.get(key);
    if (!entry || entry.datasetRevision !== revision) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.response;
  }

  register(
    datasetKeyInput: unknown,
    input: unknown,
    options: RegisterDatasetOptions = {},
  ): DatasetSnapshot {
    const key = normalizeDatasetKey(datasetKeyInput);
    if (!key) throw new TypeError('Dataset key is required');
    const normalized = normalizeRecordCollection(input, options);
    const previous = this.datasets.get(key);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : this.now();
    const revision = (previous?.revision ?? 0) + 1;
    const candidateIndex = buildCandidateIndex(normalized.records, this.options.candidatePlanner);
    const spatialIndex = buildSpatialIndex(normalized.records, this.options.spatial);
    const snapshot = createDatasetSnapshot(
      key,
      revision,
      normalized.records,
      normalized.quality,
      candidateIndex,
      spatialIndex,
      previous?.createdAt ?? now,
      now,
    );
    this.datasets.set(key, snapshot);
    this.touchDataset(key, snapshot);
    this.invalidateCache(key);
    if (previous) this.stats.replacements += 1;
    else this.stats.registrations += 1;
    this.evictDatasets();
    return snapshot;
  }

  get(datasetKeyInput: unknown): DatasetSnapshot | null {
    const key = normalizeDatasetKey(datasetKeyInput);
    const snapshot = key ? this.datasets.get(key) ?? null : null;
    if (snapshot) this.touchDataset(key, snapshot);
    return snapshot;
  }

  remove(datasetKeyInput: unknown): boolean {
    const key = normalizeDatasetKey(datasetKeyInput);
    if (!key) return false;
    this.invalidateCache(key);
    return this.datasets.delete(key);
  }

  clear(): void {
    this.datasets.clear();
    this.cache.clear();
  }

  invalidateCache(datasetKeyInput?: unknown): number {
    if (datasetKeyInput === undefined) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    const key = normalizeDatasetKey(datasetKeyInput);
    let removed = 0;
    for (const cacheKey of [...this.cache.keys()]) {
      if (cacheKey.startsWith(`${key}|`)) {
        this.cache.delete(cacheKey);
        removed += 1;
      }
    }
    return removed;
  }

  search(datasetKeyInput: unknown, requestInput: SearchRequest = {}): SearchResponse {
    const startedAt = this.now();
    const key = normalizeDatasetKey(datasetKeyInput);
    const dataset = this.datasets.get(key);
    if (!dataset) throw new Error(`Unknown dataset: ${key || '<empty>'}`);
    const request = normalizeSearchRequest(requestInput, this.options);
    try {
      throwIfAborted(request.signal);
      this.stats.searches += 1;
      const signature = searchSignature(key, dataset.revision, request);
      const cacheKey = `${key}|${signature}`;
      if (!request.signal) {
        const cached = this.cacheGet(cacheKey, dataset.revision);
        if (cached) {
          this.stats.cacheHits += 1;
          return Object.freeze({
            ...cached,
            diagnostics: Object.freeze({ ...cached.diagnostics, cacheHit: true }),
          });
        }
      }
      this.stats.cacheMisses += 1;

      const addressAnalysis = analyzeAddressQuery(request.query, {
        level: request.level,
        district: request.district,
        neighborhood: request.neighborhood,
        street: request.street,
        center: request.center,
        radiusMeters: request.radiusMeters,
      });
      const plan = planCandidates(dataset.candidateIndex, {
        query: request.query,
        address: addressAnalysis,
        signal: request.signal,
      }, this.options.candidatePlanner);

      const spatialPositions = request.center && request.radiusMeters > 0
        ? new Set(searchRadius(dataset.spatialIndex, request.center, {
          ...this.options.spatial,
          radiusMeters: request.radiusMeters,
          offset: 0,
          limit: Math.max(dataset.records.length, 1),
          signal: request.signal,
        }).items.map(hit => hit.record.sourceIndex))
        : null;

      const hits: SearchHit[] = [];
      let filteredCount = 0;
      for (const position of plan.candidatePositions) {
        throwIfAborted(request.signal);
        const record = dataset.records[position];
        if (!record) continue;
        if (!matchesFilters(record, request.filters)) {
          filteredCount += 1;
          continue;
        }
        if (!hierarchyMatches(record, request)) {
          filteredCount += 1;
          continue;
        }
        if (spatialPositions && !spatialPositions.has(record.sourceIndex)) {
          filteredCount += 1;
          continue;
        }
        const addressScore = scoreAddressRecord(record, addressAnalysis);
        const primaryTextScore = textScore(record, request);
        const score = request.normalizedQuery
          ? Math.max(primaryTextScore, addressScore.score)
          : 1;
        if (score < request.minScore || (request.normalizedQuery && score <= 0)) continue;
        const distanceMeters = request.center && record.coordinates
          ? haversineDistanceMeters(request.center, record.coordinates)
          : null;
        const reasons: string[] = [];
        if (primaryTextScore > 0) reasons.push('text');
        if (addressScore.score > 0) reasons.push('address');
        if (distanceMeters !== null) reasons.push('spatial');
        hits.push(immutableHit(record, score, distanceMeters, reasons));
      }

      sortHits(hits, request.sort);
      const facets = facetBuckets(hits, request.facetFields);
      const pagedHits = hits.slice(request.offset, request.offset + request.limit);
      const page = createPageInfo(
        request.offset,
        request.limit,
        pagedHits.length,
        hits.length,
        this.options.defaultLimit,
      );
      const diagnostics: SearchDiagnostics = Object.freeze({
        datasetKey: key,
        revision: dataset.revision,
        totalRecords: dataset.records.length,
        candidateCount: plan.candidatePositions.length,
        scoredCount: hits.length,
        filteredCount,
        cacheHit: false,
        elapsedMs: Math.max(0, this.now() - startedAt),
        querySignature: signature,
        quality: dataset.quality,
      });
      const response: SearchResponse = Object.freeze({
        results: Object.freeze(pagedHits),
        page,
        facets,
        diagnostics,
      });
      if (!request.signal) {
        this.cacheSet(cacheKey, Object.freeze({
          key: cacheKey,
          datasetRevision: dataset.revision,
          response,
          createdAt: this.now(),
        }));
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') this.stats.aborts += 1;
      throw error;
    }
  }

  facet(datasetKeyInput: unknown, field: keyof NormalizedRecord): readonly FacetBucket[] {
    const dataset = this.get(datasetKeyInput);
    if (!dataset) return Object.freeze([]);
    const counts = buildFacetCounts(dataset.records, field);
    return Object.freeze(Array.from(counts.entries())
      .map(([value, count]) => Object.freeze({ value, count }))
      .sort((left, right) => right.count - left.count
        || left.value.localeCompare(right.value, 'tr-TR', { sensitivity: 'base', numeric: true })));
  }

  snapshot(): SearchRuntimeSnapshot {
    return Object.freeze({
      datasetCount: this.datasets.size,
      cacheEntries: this.cache.size,
      searches: this.stats.searches,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      aborts: this.stats.aborts,
      registrations: this.stats.registrations,
      replacements: this.stats.replacements,
      evictions: this.stats.evictions,
    });
  }
}

export const createDataSearchRuntime = (options: SearchRuntimeOptions = {}): DataSearchRuntime =>
  new DataSearchRuntime(options);
