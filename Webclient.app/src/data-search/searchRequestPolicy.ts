import type {
  AddressLevel,
  Coordinate,
  SearchFilter,
  SearchRequest,
  SearchSortMode,
} from './contracts';
import { isAbortSignal } from './contracts';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  tokenizeSearchText,
} from './normalization';

export const SEARCH_POLICY_VERSION = '2026-09-24.v1';
export const DEFAULT_MAX_QUERY_CHARACTERS = 320;
export const DEFAULT_MAX_QUERY_TOKENS = 16;
export const DEFAULT_MAX_FILTERS = 20;
export const DEFAULT_MAX_FILTER_VALUES = 80;
export const DEFAULT_MAX_FILTER_VALUE_CHARACTERS = 180;
export const DEFAULT_MAX_FACET_FIELDS = 16;
export const DEFAULT_MAX_PAGE_SIZE = 250;
export const DEFAULT_MAX_OFFSET = 100_000;
export const DEFAULT_MAX_RADIUS_METERS = 100_000;
export const DEFAULT_MAX_COMPLEXITY_SCORE = 1_200;
export const DEFAULT_MAX_SOURCE_KEYS = 12;
export const DEFAULT_MIN_DEADLINE_MS = 100;
export const DEFAULT_MAX_DEADLINE_MS = 30_000;

export type SearchPolicyViolationCode =
  | 'request-not-object'
  | 'query-too-long'
  | 'too-many-query-tokens'
  | 'too-many-filters'
  | 'invalid-filter-field'
  | 'too-many-filter-values'
  | 'filter-value-too-long'
  | 'too-many-facet-fields'
  | 'invalid-facet-field'
  | 'page-size-too-large'
  | 'offset-too-large'
  | 'radius-too-large'
  | 'invalid-center'
  | 'invalid-sort'
  | 'invalid-address-level'
  | 'invalid-signal'
  | 'too-many-source-keys'
  | 'invalid-source-key'
  | 'invalid-deadline'
  | 'complexity-budget-exceeded';

export interface SearchPolicyViolation {
  readonly code: SearchPolicyViolationCode;
  readonly field: string;
  readonly severity: 'warning' | 'error';
  readonly actual: number | string | null;
  readonly limit: number | string | null;
  readonly detail: string;
}

export interface SearchRequestPolicyOptions {
  readonly maxQueryCharacters?: number;
  readonly maxQueryTokens?: number;
  readonly maxFilters?: number;
  readonly maxFilterValues?: number;
  readonly maxFilterValueCharacters?: number;
  readonly maxFacetFields?: number;
  readonly maxPageSize?: number;
  readonly maxOffset?: number;
  readonly maxRadiusMeters?: number;
  readonly maxComplexityScore?: number;
  readonly maxSourceKeys?: number;
  readonly minDeadlineMs?: number;
  readonly maxDeadlineMs?: number;
  readonly rejectUnknownSort?: boolean;
  readonly rejectInvalidCenter?: boolean;
  readonly rejectInvalidSignal?: boolean;
}

export interface SearchRequestPolicyInput {
  readonly request?: SearchRequest | null;
  readonly sourceKeys?: readonly string[] | null;
  readonly deadlineMs?: number | string | null;
}

export interface SearchRequestPolicyDecision {
  readonly version: string;
  readonly allowed: boolean;
  readonly request: SearchRequest;
  readonly sourceKeys: readonly string[];
  readonly deadlineMs: number;
  readonly violations: readonly SearchPolicyViolation[];
  readonly complexityScore: number;
  readonly fingerprint: string;
}

interface NormalizedPolicyOptions {
  readonly maxQueryCharacters: number;
  readonly maxQueryTokens: number;
  readonly maxFilters: number;
  readonly maxFilterValues: number;
  readonly maxFilterValueCharacters: number;
  readonly maxFacetFields: number;
  readonly maxPageSize: number;
  readonly maxOffset: number;
  readonly maxRadiusMeters: number;
  readonly maxComplexityScore: number;
  readonly maxSourceKeys: number;
  readonly minDeadlineMs: number;
  readonly maxDeadlineMs: number;
  readonly rejectUnknownSort: boolean;
  readonly rejectInvalidCenter: boolean;
  readonly rejectInvalidSignal: boolean;
}

const SEARCH_SORTS = new Set<SearchSortMode>([
  'relevance',
  'title',
  'distance',
  'source-order',
]);

const ADDRESS_LEVELS = new Set<AddressLevel>([
  'district',
  'neighborhood',
  'street',
  'building',
  'door',
  'address',
]);

const SAFE_FIELD = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_SOURCE_KEY = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

const normalizedOptions = (
  options: SearchRequestPolicyOptions = {},
): NormalizedPolicyOptions => {
  const minDeadlineMs = normalizeInteger(options.minDeadlineMs, {
    min: 10,
    max: 60_000,
    fallback: DEFAULT_MIN_DEADLINE_MS,
  });
  const maxDeadlineMs = normalizeInteger(options.maxDeadlineMs, {
    min: minDeadlineMs,
    max: 120_000,
    fallback: DEFAULT_MAX_DEADLINE_MS,
  });
  return Object.freeze({
    maxQueryCharacters: normalizeInteger(options.maxQueryCharacters, {
      min: 16,
      max: 8_192,
      fallback: DEFAULT_MAX_QUERY_CHARACTERS,
    }),
    maxQueryTokens: normalizeInteger(options.maxQueryTokens, {
      min: 1,
      max: 128,
      fallback: DEFAULT_MAX_QUERY_TOKENS,
    }),
    maxFilters: normalizeInteger(options.maxFilters, {
      min: 0,
      max: 256,
      fallback: DEFAULT_MAX_FILTERS,
    }),
    maxFilterValues: normalizeInteger(options.maxFilterValues, {
      min: 1,
      max: 1_000,
      fallback: DEFAULT_MAX_FILTER_VALUES,
    }),
    maxFilterValueCharacters: normalizeInteger(options.maxFilterValueCharacters, {
      min: 16,
      max: 8_192,
      fallback: DEFAULT_MAX_FILTER_VALUE_CHARACTERS,
    }),
    maxFacetFields: normalizeInteger(options.maxFacetFields, {
      min: 0,
      max: 128,
      fallback: DEFAULT_MAX_FACET_FIELDS,
    }),
    maxPageSize: normalizeInteger(options.maxPageSize, {
      min: 1,
      max: 2_000,
      fallback: DEFAULT_MAX_PAGE_SIZE,
    }),
    maxOffset: normalizeInteger(options.maxOffset, {
      min: 0,
      max: 10_000_000,
      fallback: DEFAULT_MAX_OFFSET,
    }),
    maxRadiusMeters: normalizeInteger(options.maxRadiusMeters, {
      min: 1,
      max: 2_000_000,
      fallback: DEFAULT_MAX_RADIUS_METERS,
    }),
    maxComplexityScore: normalizeInteger(options.maxComplexityScore, {
      min: 50,
      max: 100_000,
      fallback: DEFAULT_MAX_COMPLEXITY_SCORE,
    }),
    maxSourceKeys: normalizeInteger(options.maxSourceKeys, {
      min: 1,
      max: 128,
      fallback: DEFAULT_MAX_SOURCE_KEYS,
    }),
    minDeadlineMs,
    maxDeadlineMs,
    rejectUnknownSort: options.rejectUnknownSort !== false,
    rejectInvalidCenter: options.rejectInvalidCenter !== false,
    rejectInvalidSignal: options.rejectInvalidSignal !== false,
  });
};

const violation = (
  code: SearchPolicyViolationCode,
  field: string,
  detail: string,
  actual: number | string | null,
  limit: number | string | null,
  severity: SearchPolicyViolation['severity'] = 'error',
): SearchPolicyViolation => Object.freeze({
  code,
  field,
  severity,
  actual,
  limit,
  detail,
});

const normalizeFieldName = (value: unknown): string => normalizeText(value).slice(0, 120);

const normalizeSourceKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/\s+/g, '-')
  .slice(0, 120);

const canonicalUnknown = (value: unknown, maxCharacters: number): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = normalizeText(value);
  return text.slice(0, maxCharacters);
};

const sanitizeFilters = (
  filters: readonly SearchFilter[] | undefined,
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): readonly SearchFilter[] => {
  const source = filters ?? [];
  if (source.length > options.maxFilters) {
    violations.push(violation(
      'too-many-filters',
      'filters',
      'The request contains more filters than the bounded search policy permits.',
      source.length,
      options.maxFilters,
    ));
  }

  const output: SearchFilter[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(source.length, options.maxFilters); index += 1) {
    const current = source[index];
    if (!current) continue;
    const field = normalizeFieldName(current.field);
    if (!field || !SAFE_FIELD.test(field)) {
      violations.push(violation(
        'invalid-filter-field',
        `filters[${index}].field`,
        'Filter field names must use a bounded identifier-safe grammar.',
        field || null,
        'A-Za-z0-9_.:- / <=120 chars',
      ));
      continue;
    }
    const values = Array.isArray(current.values) ? current.values : [];
    if (values.length > options.maxFilterValues) {
      violations.push(violation(
        'too-many-filter-values',
        `filters[${index}].values`,
        'A single filter cannot fan out to an unbounded number of values.',
        values.length,
        options.maxFilterValues,
      ));
    }
    const sanitizedValues: unknown[] = [];
    for (let valueIndex = 0; valueIndex < Math.min(values.length, options.maxFilterValues); valueIndex += 1) {
      const rawValue = values[valueIndex];
      if (typeof rawValue === 'string' && normalizeText(rawValue).length > options.maxFilterValueCharacters) {
        violations.push(violation(
          'filter-value-too-long',
          `filters[${index}].values[${valueIndex}]`,
          'Filter values are length bounded to protect query planning and cache fingerprints.',
          normalizeText(rawValue).length,
          options.maxFilterValueCharacters,
        ));
      }
      sanitizedValues.push(canonicalUnknown(rawValue, options.maxFilterValueCharacters));
    }
    const canonical: SearchFilter = Object.freeze({
      field,
      operator: current.operator,
      values: Object.freeze(sanitizedValues),
      caseSensitive: current.caseSensitive === true,
    });
    const signature = hashFingerprint(canonical);
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push(canonical);
  }
  return Object.freeze(output);
};

const sanitizeFacetFields = (
  facetFields: readonly string[] | undefined,
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): readonly string[] => {
  const source = facetFields ?? [];
  if (source.length > options.maxFacetFields) {
    violations.push(violation(
      'too-many-facet-fields',
      'facetFields',
      'Facet fan-out exceeds the configured response aggregation budget.',
      source.length,
      options.maxFacetFields,
    ));
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const rawField of source.slice(0, options.maxFacetFields)) {
    const field = normalizeFieldName(rawField);
    if (!field || !SAFE_FIELD.test(field)) {
      violations.push(violation(
        'invalid-facet-field',
        'facetFields',
        'Facet fields must use a bounded identifier-safe grammar.',
        field || null,
        'A-Za-z0-9_.:- / <=120 chars',
      ));
      continue;
    }
    if (seen.has(field)) continue;
    seen.add(field);
    output.push(field);
  }
  return Object.freeze(output);
};

const sanitizeCenter = (
  center: SearchRequest['center'],
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): Coordinate | null => {
  if (center === null || center === undefined) return null;
  const normalized = normalizeCoordinates(center);
  if (!normalized && options.rejectInvalidCenter) {
    violations.push(violation(
      'invalid-center',
      'center',
      'Spatial search center must contain finite WGS84 latitude/longitude coordinates.',
      null,
      'latitude[-90,90], longitude[-180,180]',
    ));
  }
  return normalized;
};

const sanitizeSort = (
  sort: SearchRequest['sort'],
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): SearchSortMode => {
  const candidate = normalizeText(sort || 'relevance') as SearchSortMode;
  if (SEARCH_SORTS.has(candidate)) return candidate;
  if (options.rejectUnknownSort) {
    violations.push(violation(
      'invalid-sort',
      'sort',
      'Search sort mode is not part of the supported deterministic ordering contract.',
      candidate,
      Array.from(SEARCH_SORTS).join(','),
    ));
  }
  return 'relevance';
};

const sanitizeLevel = (
  level: SearchRequest['level'],
  violations: SearchPolicyViolation[],
): AddressLevel | null => {
  if (!level) return null;
  const candidate = normalizeSearchText(level) as AddressLevel;
  if (ADDRESS_LEVELS.has(candidate)) return candidate;
  violations.push(violation(
    'invalid-address-level',
    'level',
    'Address hierarchy level is not recognized.',
    candidate,
    Array.from(ADDRESS_LEVELS).join(','),
  ));
  return null;
};

const sanitizeSignal = (
  signal: SearchRequest['signal'],
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): AbortSignal | null => {
  if (signal === null || signal === undefined) return null;
  if (isAbortSignal(signal)) return signal;
  if (options.rejectInvalidSignal) {
    violations.push(violation(
      'invalid-signal',
      'signal',
      'Cancellation must be represented by a valid AbortSignal.',
      null,
      'AbortSignal',
    ));
  }
  return null;
};

const sanitizeSourceKeys = (
  sourceKeys: readonly string[] | null | undefined,
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): readonly string[] => {
  const source = sourceKeys ?? [];
  if (source.length > options.maxSourceKeys) {
    violations.push(violation(
      'too-many-source-keys',
      'sourceKeys',
      'Federated source fan-out exceeds the configured source budget.',
      source.length,
      options.maxSourceKeys,
    ));
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of source.slice(0, options.maxSourceKeys)) {
    const key = normalizeSourceKey(raw);
    if (!SAFE_SOURCE_KEY.test(key)) {
      violations.push(violation(
        'invalid-source-key',
        'sourceKeys',
        'Source keys must use the bounded canonical source-key grammar.',
        key || null,
        'lowercase a-z0-9._:- / <=120 chars',
      ));
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return Object.freeze(output);
};

const sanitizeDeadline = (
  deadlineMs: SearchRequestPolicyInput['deadlineMs'],
  options: NormalizedPolicyOptions,
  violations: SearchPolicyViolation[],
): number => {
  if (deadlineMs === null || deadlineMs === undefined || deadlineMs === '') {
    return Math.min(5_000, options.maxDeadlineMs);
  }
  const parsed = Number(deadlineMs);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)
    || parsed < options.minDeadlineMs || parsed > options.maxDeadlineMs) {
    violations.push(violation(
      'invalid-deadline',
      'deadlineMs',
      'Search deadlines must be finite integers inside the configured bounded interval.',
      Number.isFinite(parsed) ? parsed : String(deadlineMs),
      `${options.minDeadlineMs}-${options.maxDeadlineMs}`,
    ));
  }
  return normalizeInteger(parsed, {
    min: options.minDeadlineMs,
    max: options.maxDeadlineMs,
    fallback: Math.min(5_000, options.maxDeadlineMs),
  });
};

export const calculateSearchComplexity = (
  request: SearchRequest,
  sourceCount: number,
): number => {
  const queryCharacters = normalizeText(request.query).length;
  const queryTokens = tokenizeSearchText(request.query).length;
  const filters = request.filters ?? [];
  const facetCount = request.facetFields?.length ?? 0;
  const filterValues = filters.reduce((sum, filter) => sum + (filter.values?.length ?? 0), 0);
  const filterText = filters.reduce<number>((sum, filter) => sum + (filter.values ?? []).reduce<number>(
    (inner, value) => inner + (typeof value === 'string' ? normalizeText(value).length : 1),
    0,
  ), 0);
  const pageSize = normalizeInteger(request.limit, { min: 1, max: 10_000, fallback: 50 });
  const offset = normalizeInteger(request.offset, { min: 0, max: 10_000_000, fallback: 0 });
  const spatialWeight = request.center ? 25 : 0;
  const radiusWeight = Number(request.radiusMeters) > 0 ? 25 : 0;
  const hierarchyWeight = [request.level, request.district, request.neighborhood, request.street]
    .filter(Boolean).length * 8;
  return Math.ceil(
    queryCharacters * 0.25
      + queryTokens * 8
      + filters.length * 16
      + filterValues * 4
      + filterText * 0.05
      + facetCount * 12
      + Math.min(pageSize, 2_000) * 0.5
      + Math.min(offset, 100_000) * 0.002
      + Math.max(1, sourceCount) * 20
      + spatialWeight
      + radiusWeight
      + hierarchyWeight,
  );
};

export const evaluateSearchRequestPolicy = (
  input: SearchRequestPolicyInput,
  policyOptions: SearchRequestPolicyOptions = {},
): SearchRequestPolicyDecision => {
  const options = normalizedOptions(policyOptions);
  const violations: SearchPolicyViolation[] = [];
  const request = input.request ?? {};
  if (typeof request !== 'object' || Array.isArray(request)) {
    violations.push(violation(
      'request-not-object',
      'request',
      'Search requests must be structured objects.',
      null,
      'object',
    ));
  }

  const query = normalizeText(request.query);
  const tokens = tokenizeSearchText(query);
  if (query.length > options.maxQueryCharacters) {
    violations.push(violation(
      'query-too-long',
      'query',
      'Query text exceeds the bounded parsing/indexing budget.',
      query.length,
      options.maxQueryCharacters,
    ));
  }
  if (tokens.length > options.maxQueryTokens) {
    violations.push(violation(
      'too-many-query-tokens',
      'query',
      'Query token cardinality exceeds the bounded candidate-planning budget.',
      tokens.length,
      options.maxQueryTokens,
    ));
  }

  const limitRaw = Number(request.limit);
  if (Number.isFinite(limitRaw) && limitRaw > options.maxPageSize) {
    violations.push(violation(
      'page-size-too-large',
      'limit',
      'Requested page size exceeds the bounded result budget.',
      limitRaw,
      options.maxPageSize,
    ));
  }
  const offsetRaw = Number(request.offset);
  if (Number.isFinite(offsetRaw) && offsetRaw > options.maxOffset) {
    violations.push(violation(
      'offset-too-large',
      'offset',
      'Deep offset pagination exceeds the configured deterministic work budget.',
      offsetRaw,
      options.maxOffset,
    ));
  }
  const radiusRaw = Number(request.radiusMeters);
  if (Number.isFinite(radiusRaw) && radiusRaw > options.maxRadiusMeters) {
    violations.push(violation(
      'radius-too-large',
      'radiusMeters',
      'Spatial radius exceeds the bounded search envelope.',
      radiusRaw,
      options.maxRadiusMeters,
    ));
  }

  const sourceKeys = sanitizeSourceKeys(input.sourceKeys, options, violations);
  const deadlineMs = sanitizeDeadline(input.deadlineMs, options, violations);
  const sanitized: SearchRequest = Object.freeze({
    query: query.slice(0, options.maxQueryCharacters),
    filters: sanitizeFilters(request.filters, options, violations),
    facetFields: sanitizeFacetFields(request.facetFields, options, violations),
    sort: sanitizeSort(request.sort, options, violations),
    minScore: Number.isFinite(Number(request.minScore)) ? Math.max(0, Number(request.minScore)) : 0,
    offset: normalizeInteger(request.offset, { min: 0, max: options.maxOffset, fallback: 0 }),
    limit: normalizeInteger(request.limit, { min: 1, max: options.maxPageSize, fallback: Math.min(50, options.maxPageSize) }),
    center: sanitizeCenter(request.center, options, violations),
    radiusMeters: Number.isFinite(radiusRaw)
      ? Math.max(0, Math.min(radiusRaw, options.maxRadiusMeters))
      : 0,
    level: sanitizeLevel(request.level, violations),
    district: normalizeText(request.district).slice(0, 180),
    neighborhood: normalizeText(request.neighborhood).slice(0, 180),
    street: normalizeText(request.street).slice(0, 180),
    signal: sanitizeSignal(request.signal, options, violations),
  });

  const complexityScore = calculateSearchComplexity(sanitized, Math.max(1, sourceKeys.length));
  if (complexityScore > options.maxComplexityScore) {
    violations.push(violation(
      'complexity-budget-exceeded',
      'request',
      'Combined query, filter, facet, pagination, spatial and source fan-out cost exceeds policy.',
      complexityScore,
      options.maxComplexityScore,
    ));
  }
  const allowed = !violations.some(item => item.severity === 'error');
  const fingerprint = hashFingerprint({
    version: SEARCH_POLICY_VERSION,
    request: {
      ...sanitized,
      signal: sanitized.signal ? '[AbortSignal]' : null,
    },
    sourceKeys,
    deadlineMs,
  });
  return Object.freeze({
    version: SEARCH_POLICY_VERSION,
    allowed,
    request: sanitized,
    sourceKeys,
    deadlineMs,
    violations: Object.freeze(violations),
    complexityScore,
    fingerprint,
  });
};

export const assertSearchRequestAllowed = (
  input: SearchRequestPolicyInput,
  options: SearchRequestPolicyOptions = {},
): SearchRequestPolicyDecision => {
  const decision = evaluateSearchRequestPolicy(input, options);
  if (decision.allowed) return decision;
  const error = new Error(
    `Search request rejected by bounded policy: ${decision.violations.map(item => item.code).join(', ')}`,
  );
  error.name = 'SearchRequestPolicyError';
  throw error;
};
