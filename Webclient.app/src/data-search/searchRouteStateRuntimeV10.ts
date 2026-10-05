import type {
  AddressLevel,
  Coordinate,
  FilterOperator,
  SearchFilter,
  SearchRequest,
  SearchSortMode,
} from './contracts';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchGroupingModeV9 } from './searchGroupingRuntimeV9';

export const SEARCH_ROUTE_STATE_VERSION_V10 = 'search-route-state-v10' as const;

export interface SearchRouteStatePolicyV10 {
  readonly maximumQueryLength?: number;
  readonly maximumDatasetKeyLength?: number;
  readonly maximumFilters?: number;
  readonly maximumFilterValues?: number;
  readonly maximumFilterFieldLength?: number;
  readonly maximumFilterValueLength?: number;
  readonly maximumFacetFields?: number;
  readonly maximumFacetFieldLength?: number;
  readonly maximumRouteLength?: number;
  readonly maximumRadiusMeters?: number;
  readonly maximumOffset?: number;
  readonly maximumLimit?: number;
}

export interface SearchRouteStateV10 {
  readonly version: typeof SEARCH_ROUTE_STATE_VERSION_V10;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly grouping: SearchGroupingModeV9;
  readonly fingerprint: string;
}

export interface SearchRouteDecodeDiagnosticsV10 {
  readonly inputLength: number;
  readonly routeTruncated: boolean;
  readonly rejectedFilterCount: number;
  readonly acceptedFilterCount: number;
  readonly rejectedFacetCount: number;
  readonly acceptedFacetCount: number;
  readonly invalidCenter: boolean;
  readonly unknownSort: boolean;
  readonly unknownGrouping: boolean;
}

export interface SearchRouteDecodeResultV10 {
  readonly state: SearchRouteStateV10;
  readonly diagnostics: SearchRouteDecodeDiagnosticsV10;
}

interface NormalizedRoutePolicyV10 {
  readonly maximumQueryLength: number;
  readonly maximumDatasetKeyLength: number;
  readonly maximumFilters: number;
  readonly maximumFilterValues: number;
  readonly maximumFilterFieldLength: number;
  readonly maximumFilterValueLength: number;
  readonly maximumFacetFields: number;
  readonly maximumFacetFieldLength: number;
  readonly maximumRouteLength: number;
  readonly maximumRadiusMeters: number;
  readonly maximumOffset: number;
  readonly maximumLimit: number;
}

const SORTS = new Set<SearchSortMode>(['relevance', 'distance', 'title', 'source-order']);
const GROUPINGS = new Set<SearchGroupingModeV9>([
  'none',
  'category',
  'type',
  'district',
  'neighborhood',
  'distance',
]);
const OPERATORS = new Set<FilterOperator>([
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
const LEVELS = new Set<AddressLevel>([
  'district',
  'neighborhood',
  'street',
  'building',
  'door',
  'address',
]);

const normalizePolicy = (
  policy: SearchRouteStatePolicyV10 = {},
): NormalizedRoutePolicyV10 => Object.freeze({
  maximumQueryLength: normalizeInteger(policy.maximumQueryLength, { min: 32, max: 4_096, fallback: 512 }),
  maximumDatasetKeyLength: normalizeInteger(policy.maximumDatasetKeyLength, { min: 16, max: 256, fallback: 160 }),
  maximumFilters: normalizeInteger(policy.maximumFilters, { min: 0, max: 64, fallback: 16 }),
  maximumFilterValues: normalizeInteger(policy.maximumFilterValues, { min: 1, max: 256, fallback: 32 }),
  maximumFilterFieldLength: normalizeInteger(policy.maximumFilterFieldLength, { min: 8, max: 256, fallback: 96 }),
  maximumFilterValueLength: normalizeInteger(policy.maximumFilterValueLength, { min: 8, max: 2_048, fallback: 256 }),
  maximumFacetFields: normalizeInteger(policy.maximumFacetFields, { min: 0, max: 64, fallback: 12 }),
  maximumFacetFieldLength: normalizeInteger(policy.maximumFacetFieldLength, { min: 8, max: 256, fallback: 96 }),
  maximumRouteLength: normalizeInteger(policy.maximumRouteLength, { min: 256, max: 65_536, fallback: 8_192 }),
  maximumRadiusMeters: normalizeInteger(policy.maximumRadiusMeters, { min: 100, max: 2_000_000, fallback: 250_000 }),
  maximumOffset: normalizeInteger(policy.maximumOffset, { min: 100, max: 10_000_000, fallback: 100_000 }),
  maximumLimit: normalizeInteger(policy.maximumLimit, { min: 1, max: 2_000, fallback: 250 }),
});

const canonicalDatasetKey = (value: unknown, maximum: number): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, maximum);

const boundedText = (value: unknown, maximum: number): string => normalizeText(value).slice(0, maximum);

const boundedSearchText = (value: unknown, maximum: number): string => normalizeSearchText(value).slice(0, maximum);

const parseSort = (value: unknown): SearchSortMode => {
  const normalized = boundedSearchText(value, 32) as SearchSortMode;
  return SORTS.has(normalized) ? normalized : 'relevance';
};

const parseGrouping = (value: unknown): SearchGroupingModeV9 => {
  const normalized = boundedSearchText(value, 32) as SearchGroupingModeV9;
  return GROUPINGS.has(normalized) ? normalized : 'none';
};

const parseLevel = (value: unknown): AddressLevel | null => {
  const normalized = boundedSearchText(value, 32) as AddressLevel;
  return LEVELS.has(normalized) ? normalized : null;
};

const parseFinite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeFilterValue = (value: unknown, maximum: number): string | number | boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = boundedText(value, maximum);
  return text ? text : null;
};

const normalizeFilter = (
  input: unknown,
  policy: NormalizedRoutePolicyV10,
): SearchFilter | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const object = input as Record<string, unknown>;
  const field = boundedText(object.field, policy.maximumFilterFieldLength);
  const operator = boundedSearchText(object.operator, 32) as FilterOperator;
  if (!field || !OPERATORS.has(operator)) return null;
  const rawValues = Array.isArray(object.values)
    ? object.values
    : object.value === undefined
      ? []
      : [object.value];
  const values = rawValues
    .slice(0, policy.maximumFilterValues)
    .map(value => normalizeFilterValue(value, policy.maximumFilterValueLength))
    .filter((value): value is string | number | boolean => value !== null);
  if (operator !== 'exists' && values.length === 0) return null;
  if (operator === 'between' && values.length < 2) return null;
  return Object.freeze({
    field,
    operator,
    values: Object.freeze(values),
    ...(object.caseSensitive === true ? { caseSensitive: true } : {}),
  });
};

const uniqueStrings = (
  values: readonly string[],
  maximumCount: number,
  maximumLength: number,
): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const value = boundedText(input, maximumLength);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= maximumCount) break;
  }
  return Object.freeze(output);
};

const routeInput = (value: unknown, maximum: number): Readonly<{ source: string; truncated: boolean }> => {
  const raw = typeof value === 'string' ? value : '';
  const withoutQuestion = raw.startsWith('?') ? raw.slice(1) : raw;
  const truncated = withoutQuestion.length > maximum;
  return Object.freeze({
    source: withoutQuestion.slice(0, maximum),
    truncated,
  });
};

const parseFilterParams = (
  params: URLSearchParams,
  policy: NormalizedRoutePolicyV10,
): Readonly<{ filters: readonly SearchFilter[]; rejected: number }> => {
  const output: SearchFilter[] = [];
  let rejected = 0;
  for (const encoded of params.getAll('f').slice(0, policy.maximumFilters * 2 + 8)) {
    if (output.length >= policy.maximumFilters) {
      rejected += 1;
      continue;
    }
    if (encoded.length > policy.maximumFilterValueLength * policy.maximumFilterValues + 512) {
      rejected += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(encoded) as unknown;
      const filter = normalizeFilter(parsed, policy);
      if (filter) output.push(filter);
      else rejected += 1;
    } catch {
      rejected += 1;
    }
  }
  return Object.freeze({ filters: Object.freeze(output), rejected });
};

const parseFacetParams = (
  params: URLSearchParams,
  policy: NormalizedRoutePolicyV10,
): Readonly<{ fields: readonly string[]; rejected: number }> => {
  const raw = params.getAll('facet');
  const fields = uniqueStrings(raw, policy.maximumFacetFields, policy.maximumFacetFieldLength);
  return Object.freeze({ fields, rejected: Math.max(0, raw.length - fields.length) });
};

const parseCenter = (
  params: URLSearchParams,
): Readonly<{ center: Coordinate | null; invalid: boolean }> => {
  const latitude = parseFinite(params.get('lat'));
  const longitude = parseFinite(params.get('lon'));
  const supplied = latitude !== null || longitude !== null;
  if (latitude === null || longitude === null) {
    return Object.freeze({ center: null, invalid: supplied });
  }
  const center = normalizeCoordinates([longitude, latitude]);
  return Object.freeze({ center, invalid: supplied && center === null });
};

const stateFingerprint = (
  datasetKey: string,
  request: SearchRequest,
  grouping: SearchGroupingModeV9,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_ROUTE_STATE_VERSION_V10,
  datasetKey,
  request,
  grouping,
}));

const freezeRequest = (request: SearchRequest): SearchRequest => Object.freeze({
  ...request,
  ...(request.filters ? { filters: Object.freeze([...request.filters]) } : {}),
  ...(request.facetFields ? { facetFields: Object.freeze([...request.facetFields]) } : {}),
});

export const decodeSearchRouteStateV10 = (
  input: unknown,
  policyInput: SearchRouteStatePolicyV10 = {},
): SearchRouteDecodeResultV10 => {
  const policy = normalizePolicy(policyInput);
  const route = routeInput(input, policy.maximumRouteLength);
  const params = new URLSearchParams(route.source);
  const datasetKey = canonicalDatasetKey(params.get('dataset'), policy.maximumDatasetKeyLength);
  const query = boundedText(params.get('q'), policy.maximumQueryLength);
  const sortRaw = boundedSearchText(params.get('sort'), 32);
  const groupingRaw = boundedSearchText(params.get('group'), 32);
  const sort = parseSort(sortRaw);
  const grouping = parseGrouping(groupingRaw);
  const filters = parseFilterParams(params, policy);
  const facets = parseFacetParams(params, policy);
  const centerResult = parseCenter(params);
  const offset = normalizeInteger(params.get('offset'), {
    min: 0,
    max: policy.maximumOffset,
    fallback: 0,
  });
  const limitRaw = params.get('limit');
  const limit = limitRaw === null
    ? null
    : normalizeInteger(limitRaw, { min: 1, max: policy.maximumLimit, fallback: policy.maximumLimit });
  const radiusRaw = parseFinite(params.get('radius'));
  const radiusMeters = radiusRaw === null
    ? null
    : Math.min(policy.maximumRadiusMeters, Math.max(0, radiusRaw));
  const minScoreRaw = parseFinite(params.get('minScore'));
  const level = parseLevel(params.get('level'));
  const district = boundedText(params.get('district'), policy.maximumQueryLength);
  const neighborhood = boundedText(params.get('neighborhood'), policy.maximumQueryLength);
  const street = boundedText(params.get('street'), policy.maximumQueryLength);
  const request: SearchRequest = freezeRequest({
    ...(query ? { query } : {}),
    ...(filters.filters.length ? { filters: filters.filters } : {}),
    ...(facets.fields.length ? { facetFields: facets.fields } : {}),
    sort,
    offset,
    ...(limit === null ? {} : { limit }),
    ...(minScoreRaw === null ? {} : { minScore: Math.max(0, minScoreRaw) }),
    ...(centerResult.center ? { center: centerResult.center } : {}),
    ...(radiusMeters === null ? {} : { radiusMeters }),
    ...(level ? { level } : {}),
    ...(district ? { district } : {}),
    ...(neighborhood ? { neighborhood } : {}),
    ...(street ? { street } : {}),
  });
  const state: SearchRouteStateV10 = Object.freeze({
    version: SEARCH_ROUTE_STATE_VERSION_V10,
    datasetKey,
    request,
    grouping,
    fingerprint: stateFingerprint(datasetKey, request, grouping),
  });
  return Object.freeze({
    state,
    diagnostics: Object.freeze({
      inputLength: typeof input === 'string' ? input.length : 0,
      routeTruncated: route.truncated,
      rejectedFilterCount: filters.rejected,
      acceptedFilterCount: filters.filters.length,
      rejectedFacetCount: facets.rejected,
      acceptedFacetCount: facets.fields.length,
      invalidCenter: centerResult.invalid,
      unknownSort: Boolean(sortRaw && !SORTS.has(sortRaw as SearchSortMode)),
      unknownGrouping: Boolean(groupingRaw && !GROUPINGS.has(groupingRaw as SearchGroupingModeV9)),
    }),
  });
};

const serializeFilter = (filter: SearchFilter): string => JSON.stringify({
  field: normalizeText(filter.field),
  operator: filter.operator,
  values: filter.values,
  ...(filter.caseSensitive === true ? { caseSensitive: true } : {}),
});

export const encodeSearchRouteStateV10 = (
  state: Pick<SearchRouteStateV10, 'datasetKey' | 'request' | 'grouping'>,
  policyInput: SearchRouteStatePolicyV10 = {},
): string => {
  const policy = normalizePolicy(policyInput);
  const params = new URLSearchParams();
  const datasetKey = canonicalDatasetKey(state.datasetKey, policy.maximumDatasetKeyLength);
  const request = state.request;
  const query = boundedText(request.query, policy.maximumQueryLength);
  if (datasetKey) params.set('dataset', datasetKey);
  if (query) params.set('q', query);
  const sort = parseSort(request.sort);
  if (sort !== 'relevance') params.set('sort', sort);
  const grouping = parseGrouping(state.grouping);
  if (grouping !== 'none') params.set('group', grouping);
  const normalizedFilters: SearchFilter[] = [];
  for (const raw of request.filters ?? []) {
    const filter = normalizeFilter(raw, policy);
    if (!filter) continue;
    normalizedFilters.push(filter);
    if (normalizedFilters.length >= policy.maximumFilters) break;
  }
  for (const filter of normalizedFilters) params.append('f', serializeFilter(filter));
  for (const field of uniqueStrings(
    request.facetFields ?? [],
    policy.maximumFacetFields,
    policy.maximumFacetFieldLength,
  )) params.append('facet', field);
  const offset = normalizeInteger(request.offset, { min: 0, max: policy.maximumOffset, fallback: 0 });
  if (offset > 0) params.set('offset', String(offset));
  if (request.limit !== undefined) {
    const limit = normalizeInteger(request.limit, { min: 1, max: policy.maximumLimit, fallback: policy.maximumLimit });
    params.set('limit', String(limit));
  }
  const center = normalizeCoordinates(request.center);
  if (center) {
    params.set('lat', String(center.latitude));
    params.set('lon', String(center.longitude));
  }
  if (request.radiusMeters !== undefined) {
    const radius = Math.min(policy.maximumRadiusMeters, Math.max(0, Number(request.radiusMeters) || 0));
    if (radius > 0) params.set('radius', String(radius));
  }
  if (request.minScore !== undefined) {
    const minScore = Math.max(0, Number(request.minScore) || 0);
    if (minScore > 0) params.set('minScore', String(minScore));
  }
  const level = parseLevel(request.level);
  if (level) params.set('level', level);
  const district = boundedText(request.district, policy.maximumQueryLength);
  const neighborhood = boundedText(request.neighborhood, policy.maximumQueryLength);
  const street = boundedText(request.street, policy.maximumQueryLength);
  if (district) params.set('district', district);
  if (neighborhood) params.set('neighborhood', neighborhood);
  if (street) params.set('street', street);
  const encoded = params.toString();
  return encoded.length <= policy.maximumRouteLength
    ? encoded
    : encoded.slice(0, policy.maximumRouteLength);
};

export const canonicalizeSearchRouteStateV10 = (
  input: unknown,
  policy: SearchRouteStatePolicyV10 = {},
): Readonly<{ route: string; result: SearchRouteDecodeResultV10 }> => {
  const result = decodeSearchRouteStateV10(input, policy);
  return Object.freeze({
    route: encodeSearchRouteStateV10(result.state, policy),
    result,
  });
};

export const searchRouteStateEqualsV10 = (
  left: SearchRouteStateV10,
  right: SearchRouteStateV10,
): boolean => left.fingerprint === right.fingerprint;
