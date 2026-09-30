import type {
  CandidatePlan,
  CandidatePlannerOptions,
  DatasetSnapshot,
  FacetBucket,
  NormalizedRecord,
  NormalizedSearchRequest,
  SearchHit,
  SearchRequest,
  SearchResponse,
  SearchSortMode,
  SpatialIndexOptions,
} from './contracts';
import { throwIfAborted } from './contracts';
import {
  matchesAddressHierarchy,
  scoreAddressRecord,
  type AddressScore,
} from './addressSemantics';
import { planCandidates } from './candidatePlanner';
import {
  createPageInfo,
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import {
  collectSpatialCandidatePositions,
  createSpatialBounds,
  haversineDistanceMeters,
} from './spatialIndex';
import {
  matchesFilter,
  normalizeSearchRequest,
} from './searchRuntime';
import {
  DataSearchQueryEngineV6,
  type DataSearchQueryEnginePolicy,
  type DataSearchQueryResponseV6,
  type RelevanceHit,
} from './dataSearchQueryEngineV6';
import {
  analyzeSearchIntentV7,
  searchIntentRequiresAddressV7,
  searchIntentRequiresSpatialV7,
  searchIntentRequiresTextV7,
  type SearchIntentAnalysisV7,
  type SearchIntentKindV7,
  type SearchIntentPolicyV7,
} from './searchIntentRuntimeV7';

export interface DataSearchExecutionPolicyV7 {
  readonly defaultLimit?: number;
  readonly maximumLimit?: number;
  readonly maximumCandidates?: number;
  readonly maximumResultWindow?: number;
  readonly maximumFacetFields?: number;
  readonly maximumFacetBuckets?: number;
  readonly defaultRadiusMeters?: number;
  readonly maximumRadiusMeters?: number;
  readonly minimumAddressScore?: number;
  readonly intent?: SearchIntentPolicyV7;
  readonly candidatePlanner?: CandidatePlannerOptions;
  readonly spatial?: SpatialIndexOptions;
  readonly text?: Partial<DataSearchQueryEnginePolicy>;
  readonly clock?: () => number;
}

export interface DataSearchExecutionEvidenceV7 {
  readonly textScore: number;
  readonly addressScore: number;
  readonly distanceMeters: number | null;
  readonly textSignal: number;
  readonly addressSignal: number;
  readonly distanceSignal: number;
}

export interface DataSearchExecutionHitV7 extends SearchHit {
  readonly evidence: DataSearchExecutionEvidenceV7;
}

export type DataSearchExecutionBlockReasonV7 =
  | 'invalid-explicit-center'
  | 'address-candidate-budget-exceeded'
  | 'spatial-candidate-budget-exceeded'
  | 'text-execution-blocked'
  | 'result-window-offset-exceeded';

export interface DataSearchExecutionDiagnosticsV7 {
  readonly version: 7;
  readonly datasetFingerprint: string;
  readonly requestFingerprint: string;
  readonly intentKind: SearchIntentKindV7;
  readonly blocked: boolean;
  readonly blockReason: DataSearchExecutionBlockReasonV7 | null;
  readonly candidateBudget: number;
  readonly addressCandidateCount: number;
  readonly spatialCandidateCount: number;
  readonly textCandidateCount: number;
  readonly evaluatedCount: number;
  readonly matchedCount: number;
  readonly resultWindowCount: number;
  readonly resultWindowTruncated: boolean;
  readonly textUsed: boolean;
  readonly addressUsed: boolean;
  readonly spatialUsed: boolean;
  readonly textBlocked: boolean;
  readonly addressPlanStrategy: CandidatePlan['strategy'] | null;
  readonly radiusMeters: number;
  readonly elapsedMs: number;
}

export interface DataSearchExecutionResultV7 {
  readonly response: SearchResponse;
  readonly hits: readonly DataSearchExecutionHitV7[];
  readonly intent: SearchIntentAnalysisV7;
  readonly diagnostics: DataSearchExecutionDiagnosticsV7;
}

export interface DataSearchExecutionSnapshotV7 {
  readonly version: 7;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly recordCount: number;
  readonly searches: number;
  readonly blockedSearches: number;
  readonly textSearches: number;
  readonly addressSearches: number;
  readonly coordinateSearches: number;
  readonly hybridSearches: number;
  readonly emptySearches: number;
  readonly maximumObservedCandidates: number;
}

interface NormalizedExecutionPolicyV7 {
  readonly defaultLimit: number;
  readonly maximumLimit: number;
  readonly maximumCandidates: number;
  readonly maximumResultWindow: number;
  readonly maximumFacetFields: number;
  readonly maximumFacetBuckets: number;
  readonly defaultRadiusMeters: number;
  readonly maximumRadiusMeters: number;
  readonly minimumAddressScore: number;
  readonly intent: SearchIntentPolicyV7;
  readonly candidatePlanner: CandidatePlannerOptions;
  readonly spatial: SpatialIndexOptions;
  readonly text: Partial<DataSearchQueryEnginePolicy>;
  readonly clock: () => number;
}

interface MutableExecutionStatsV7 {
  searches: number;
  blockedSearches: number;
  textSearches: number;
  addressSearches: number;
  coordinateSearches: number;
  hybridSearches: number;
  emptySearches: number;
  maximumObservedCandidates: number;
}

interface LocalEvaluationV7 {
  readonly hit: DataSearchExecutionHitV7;
  readonly address: AddressScore | null;
  readonly text: RelevanceHit | null;
}

interface CandidateResolutionV7 {
  readonly positions: readonly number[];
  readonly addressPlan: CandidatePlan | null;
  readonly addressCandidateCount: number;
  readonly spatialCandidateCount: number;
  readonly blocked: DataSearchExecutionBlockReasonV7 | null;
}

const VERSION = 7 as const;
const CACHE_SAFE_NAMESPACE = 'data-search-execution-v7';

const normalizeFinite = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const normalizePolicy = (
  policy: DataSearchExecutionPolicyV7 = {},
): NormalizedExecutionPolicyV7 => {
  const maximumLimit = normalizeInteger(policy.maximumLimit, {
    min: 1,
    max: 1_000,
    fallback: 250,
  });
  const maximumRadiusMeters = normalizeInteger(policy.maximumRadiusMeters, {
    min: 100,
    max: 1_000_000,
    fallback: 100_000,
  });
  return Object.freeze({
    defaultLimit: normalizeInteger(policy.defaultLimit, {
      min: 1,
      max: maximumLimit,
      fallback: Math.min(50, maximumLimit),
    }),
    maximumLimit,
    maximumCandidates: normalizeInteger(policy.maximumCandidates, {
      min: 100,
      max: 250_000,
      fallback: 25_000,
    }),
    maximumResultWindow: normalizeInteger(policy.maximumResultWindow, {
      min: 100,
      max: 10_000,
      fallback: 2_000,
    }),
    maximumFacetFields: normalizeInteger(policy.maximumFacetFields, {
      min: 0,
      max: 32,
      fallback: 12,
    }),
    maximumFacetBuckets: normalizeInteger(policy.maximumFacetBuckets, {
      min: 1,
      max: 1_000,
      fallback: 100,
    }),
    defaultRadiusMeters: normalizeInteger(policy.defaultRadiusMeters, {
      min: 1,
      max: maximumRadiusMeters,
      fallback: Math.min(5_000, maximumRadiusMeters),
    }),
    maximumRadiusMeters,
    minimumAddressScore: normalizeFinite(policy.minimumAddressScore, 1, 0, 100_000),
    intent: Object.freeze({ ...policy.intent }),
    candidatePlanner: Object.freeze({ ...policy.candidatePlanner }),
    spatial: Object.freeze({ ...policy.spatial }),
    text: Object.freeze({ ...policy.text }),
    clock: typeof policy.clock === 'function' ? policy.clock : () => Date.now(),
  });
};

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
};

const normalizedRequest = (
  request: SearchRequest,
  policy: NormalizedExecutionPolicyV7,
): NormalizedSearchRequest => normalizeSearchRequest(request, {
  defaultLimit: policy.defaultLimit,
  maxLimit: policy.maximumLimit,
});

const canonicalDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const requestFingerprint = (
  dataset: DatasetSnapshot,
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
): string => hashFingerprint(stableSerialize({
  namespace: CACHE_SAFE_NAMESPACE,
  datasetKey: canonicalDatasetKey(dataset.key),
  revision: dataset.revision,
  datasetFingerprint: dataset.fingerprint,
  intentSignature: intent.signature,
  filters: request.filters,
  facetFields: request.facetFields,
  sort: request.sort,
  minScore: request.minScore,
  offset: request.offset,
  limit: request.limit,
  radiusMeters: request.radiusMeters,
  level: request.level,
  district: normalizeSearchText(request.district),
  neighborhood: normalizeSearchText(request.neighborhood),
  street: normalizeSearchText(request.street),
}));

const matchesFilters = (
  record: NormalizedRecord,
  request: NormalizedSearchRequest,
): boolean => request.filters.every(filter => matchesFilter(record, filter));

const matchesHierarchy = (
  record: NormalizedRecord,
  request: NormalizedSearchRequest,
): boolean => matchesAddressHierarchy(record, {
  level: request.level,
  district: request.district,
  neighborhood: request.neighborhood,
  street: request.street,
});

const readRecordField = (record: NormalizedRecord, field: string): unknown => {
  const direct = record as unknown as Readonly<Record<string, unknown>>;
  if (Object.prototype.hasOwnProperty.call(direct, field)) return direct[field];
  if (Object.prototype.hasOwnProperty.call(record.fields, field)) return record.fields[field];
  return null;
};

const facetBuckets = (
  hits: readonly DataSearchExecutionHitV7[],
  fields: readonly string[],
  policy: NormalizedExecutionPolicyV7,
): Readonly<Record<string, readonly FacetBucket[]>> => {
  const output: Record<string, readonly FacetBucket[]> = {};
  const boundedFields = Array.from(new Set(fields.map(normalizeText).filter(Boolean)))
    .slice(0, policy.maximumFacetFields);
  for (const field of boundedFields) {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const value = normalizeText(readRecordField(hit.record, field));
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    output[field] = Object.freeze(Array.from(counts.entries())
      .map(([value, count]) => Object.freeze({ value, count }))
      .sort((left, right) => right.count - left.count
        || left.value.localeCompare(right.value, 'tr-TR', { sensitivity: 'base', numeric: true }))
      .slice(0, policy.maximumFacetBuckets));
  }
  return Object.freeze(output);
};

const textSignal = (score: number): number => score <= 0
  ? 0
  : 1 - Math.exp(-score / 8);

const addressSignal = (score: number): number => score <= 0
  ? 0
  : 1 - Math.exp(-score / 400);

const distanceSignal = (
  distanceMeters: number | null,
  radiusMeters: number,
): number => {
  if (distanceMeters === null) return 0;
  if (radiusMeters <= 0) return 1 / (1 + distanceMeters / 1_000);
  return Math.max(0, 1 - Math.min(1, distanceMeters / radiusMeters));
};

const scoreWeights = (
  kind: SearchIntentKindV7,
): Readonly<{ text: number; address: number; distance: number }> => {
  if (kind === 'text') return Object.freeze({ text: 1, address: 0, distance: 0 });
  if (kind === 'address') return Object.freeze({ text: 0.25, address: 0.75, distance: 0 });
  if (kind === 'coordinate') return Object.freeze({ text: 0, address: 0, distance: 1 });
  if (kind === 'hybrid') return Object.freeze({ text: 0.35, address: 0.4, distance: 0.25 });
  return Object.freeze({ text: 0, address: 0, distance: 0 });
};

const weightedScore = (
  kind: SearchIntentKindV7,
  textScoreValue: number,
  addressScoreValue: number,
  distanceMeters: number | null,
  radiusMeters: number,
): DataSearchExecutionEvidenceV7 & { readonly score: number } => {
  const text = textSignal(textScoreValue);
  const address = addressSignal(addressScoreValue);
  const distance = distanceSignal(distanceMeters, radiusMeters);
  const weights = scoreWeights(kind);
  const denominator = (text > 0 ? weights.text : 0)
    + (address > 0 ? weights.address : 0)
    + (distanceMeters !== null ? weights.distance : 0);
  const normalized = denominator > 0
    ? (text * weights.text + address * weights.address + distance * weights.distance) / denominator
    : 0;
  const score = Math.round(normalized * 1_000_000) / 1_000;
  return Object.freeze({
    score,
    textScore: textScoreValue,
    addressScore: addressScoreValue,
    distanceMeters,
    textSignal: text,
    addressSignal: address,
    distanceSignal: distance,
  });
};

const immutableHit = (
  record: NormalizedRecord,
  evidence: ReturnType<typeof weightedScore>,
  reasons: readonly string[],
): DataSearchExecutionHitV7 => Object.freeze({
  record,
  score: evidence.score,
  distanceMeters: evidence.distanceMeters,
  reasons: Object.freeze([...reasons]),
  evidence: Object.freeze({
    textScore: evidence.textScore,
    addressScore: evidence.addressScore,
    distanceMeters: evidence.distanceMeters,
    textSignal: evidence.textSignal,
    addressSignal: evidence.addressSignal,
    distanceSignal: evidence.distanceSignal,
  }),
});

const compareTitle = (left: DataSearchExecutionHitV7, right: DataSearchExecutionHitV7): number =>
  left.record.title.localeCompare(right.record.title, 'tr-TR', {
    sensitivity: 'base',
    numeric: true,
  });

const compareDistance = (left: DataSearchExecutionHitV7, right: DataSearchExecutionHitV7): number =>
  (left.distanceMeters ?? Number.POSITIVE_INFINITY) - (right.distanceMeters ?? Number.POSITIVE_INFINITY);

const compareRelevance = (left: DataSearchExecutionHitV7, right: DataSearchExecutionHitV7): number => {
  const score = right.score - left.score;
  if (Math.abs(score) > 0.000001) return score;
  const source = left.record.sourceIndex - right.record.sourceIndex;
  if (source !== 0) return source;
  const title = compareTitle(left, right);
  if (title !== 0) return title;
  return left.record.fingerprint.localeCompare(right.record.fingerprint);
};

const sortHits = (
  hits: DataSearchExecutionHitV7[],
  sort: SearchSortMode,
): void => {
  hits.sort((left, right) => {
    if (sort === 'distance') {
      const distance = compareDistance(left, right);
      if (distance !== 0) return distance;
      return compareRelevance(left, right);
    }
    if (sort === 'title') {
      const title = compareTitle(left, right);
      if (title !== 0) return title;
      return left.record.sourceIndex - right.record.sourceIndex;
    }
    if (sort === 'source-order') {
      const source = left.record.sourceIndex - right.record.sourceIndex;
      if (source !== 0) return source;
      return compareTitle(left, right);
    }
    return compareRelevance(left, right);
  });
};

const radiusFor = (
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
  policy: NormalizedExecutionPolicyV7,
): number => {
  if (!intent.center) return 0;
  if (request.radiusMeters > 0) {
    return Math.min(policy.maximumRadiusMeters, request.radiusMeters);
  }
  return policy.defaultRadiusMeters;
};

const textResponseFor = (
  engine: DataSearchQueryEngineV6,
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
  policy: NormalizedExecutionPolicyV7,
): DataSearchQueryResponseV6 | null => {
  if (!searchIntentRequiresTextV7(intent)) return null;
  return engine.search({
    query: intent.residualQuery,
    filters: request.filters,
    offset: 0,
    limit: policy.maximumResultWindow,
    includeFacets: false,
  });
};

const textHitMap = (
  response: DataSearchQueryResponseV6 | null,
): ReadonlyMap<string, RelevanceHit> => {
  const map = new Map<string, RelevanceHit>();
  for (const hit of response?.hits ?? []) map.set(hit.record.fingerprint, hit);
  return map;
};

const allPositions = (count: number): readonly number[] => Object.freeze(
  Array.from({ length: Math.max(0, count) }, (_value, index) => index),
);

const candidatePositions = (
  dataset: DatasetSnapshot,
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
  policy: NormalizedExecutionPolicyV7,
): CandidateResolutionV7 => {
  const requiresSpatial = searchIntentRequiresSpatialV7(intent);
  if (requiresSpatial && intent.center) {
    const radiusMeters = radiusFor(request, intent, policy);
    const bounds = createSpatialBounds(intent.center, radiusMeters);
    if (!bounds) {
      return Object.freeze({
        positions: Object.freeze([]),
        addressPlan: null,
        addressCandidateCount: 0,
        spatialCandidateCount: 0,
        blocked: null,
      });
    }
    const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {
      ...policy.spatial,
      maxCandidates: policy.maximumCandidates,
      signal: request.signal,
    });
    if (spatial.truncated) {
      return Object.freeze({
        positions: Object.freeze([]),
        addressPlan: null,
        addressCandidateCount: 0,
        spatialCandidateCount: spatial.positions.length,
        blocked: 'spatial-candidate-budget-exceeded',
      });
    }
    return Object.freeze({
      positions: spatial.positions,
      addressPlan: null,
      addressCandidateCount: 0,
      spatialCandidateCount: spatial.positions.length,
      blocked: null,
    });
  }

  if (searchIntentRequiresAddressV7(intent)) {
    const plan = planCandidates(dataset.candidateIndex, {
      query: intent.residualQuery,
      address: intent.address,
      signal: request.signal,
    }, policy.candidatePlanner);
    if (plan.candidatePositions.length > policy.maximumCandidates) {
      return Object.freeze({
        positions: Object.freeze([]),
        addressPlan: plan,
        addressCandidateCount: plan.candidatePositions.length,
        spatialCandidateCount: 0,
        blocked: 'address-candidate-budget-exceeded',
      });
    }
    return Object.freeze({
      positions: plan.candidatePositions,
      addressPlan: plan,
      addressCandidateCount: plan.candidatePositions.length,
      spatialCandidateCount: 0,
      blocked: null,
    });
  }

  if (intent.kind === 'empty') {
    const positions = allPositions(dataset.records.length);
    if (positions.length > policy.maximumCandidates) {
      return Object.freeze({
        positions: Object.freeze([]),
        addressPlan: null,
        addressCandidateCount: 0,
        spatialCandidateCount: 0,
        blocked: 'address-candidate-budget-exceeded',
      });
    }
    return Object.freeze({
      positions,
      addressPlan: null,
      addressCandidateCount: 0,
      spatialCandidateCount: 0,
      blocked: null,
    });
  }

  return Object.freeze({
    positions: Object.freeze([]),
    addressPlan: null,
    addressCandidateCount: 0,
    spatialCandidateCount: 0,
    blocked: null,
  });
};

const reasonList = (
  intent: SearchIntentAnalysisV7,
  text: RelevanceHit | null,
  address: AddressScore | null,
  distanceMeters: number | null,
  hierarchyApplied: boolean,
): readonly string[] => {
  const reasons: string[] = [`intent:${intent.kind}`];
  if (text && text.score > 0) reasons.push('text-relevance-v6');
  if (address && address.score > 0) reasons.push('address-semantics-v4');
  if (distanceMeters !== null) reasons.push('spatial-index');
  if (hierarchyApplied) reasons.push('address-hierarchy');
  return Object.freeze(reasons);
};

const hierarchyApplied = (request: NormalizedSearchRequest): boolean => Boolean(
  request.level
  || request.district
  || request.neighborhood
  || request.street,
);

const shouldRequireAddressScore = (
  intent: SearchIntentAnalysisV7,
): boolean => searchIntentRequiresAddressV7(intent)
  && intent.address.canonicalTokens.length > 0;

const qualifiesHybridText = (
  intent: SearchIntentAnalysisV7,
  text: RelevanceHit | null,
  address: AddressScore | null,
): boolean => {
  if (intent.kind !== 'hybrid' || !intent.evidence.hasResidualText) return true;
  if (intent.diagnostics.addressEvidenceAccepted) return Boolean(text || (address && address.score > 0));
  return Boolean(text);
};

const evaluateLocalCandidates = (
  dataset: DatasetSnapshot,
  positions: readonly number[],
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
  textMap: ReadonlyMap<string, RelevanceHit>,
  radiusMeters: number,
  policy: NormalizedExecutionPolicyV7,
): Readonly<{ hits: readonly DataSearchExecutionHitV7[]; filteredCount: number; evaluatedCount: number }> => {
  const hits: DataSearchExecutionHitV7[] = [];
  let filteredCount = 0;
  let evaluatedCount = 0;
  const requireAddressScore = shouldRequireAddressScore(intent);
  const requiresSpatial = searchIntentRequiresSpatialV7(intent);
  const hasHierarchy = hierarchyApplied(request);

  for (const position of positions) {
    throwIfAborted(request.signal);
    const record = dataset.records[position];
    if (!record) continue;
    if (!matchesFilters(record, request)) {
      filteredCount += 1;
      continue;
    }
    if (!matchesHierarchy(record, request)) {
      filteredCount += 1;
      continue;
    }
    evaluatedCount += 1;
    const text = textMap.get(record.fingerprint) ?? null;
    const address = searchIntentRequiresAddressV7(intent)
      ? scoreAddressRecord(record, intent.address)
      : null;
    if (requireAddressScore && (!address || address.score < policy.minimumAddressScore)) {
      filteredCount += 1;
      continue;
    }
    if (!qualifiesHybridText(intent, text, address)) {
      filteredCount += 1;
      continue;
    }
    const distanceMeters = intent.center && record.coordinates
      ? haversineDistanceMeters(intent.center, record.coordinates)
      : null;
    if (requiresSpatial && (distanceMeters === null || distanceMeters > radiusMeters)) {
      filteredCount += 1;
      continue;
    }
    const evidence = weightedScore(
      intent.kind,
      text?.score ?? 0,
      address?.score ?? (hasHierarchy ? 1 : 0),
      distanceMeters,
      radiusMeters,
    );
    if (evidence.score < request.minScore) continue;
    hits.push(immutableHit(
      record,
      evidence,
      reasonList(intent, text, address, distanceMeters, hasHierarchy),
    ));
  }
  return Object.freeze({
    hits: Object.freeze(hits),
    filteredCount,
    evaluatedCount,
  });
};

const textOnlyHits = (
  response: DataSearchQueryResponseV6,
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
): readonly DataSearchExecutionHitV7[] => Object.freeze(response.hits
  .map(hit => {
    const evidence = weightedScore(intent.kind, hit.score, 0, null, 0);
    return immutableHit(hit.record, evidence, Object.freeze(['intent:text', 'text-relevance-v6']));
  })
  .filter(hit => hit.score >= request.minScore));

const emptyDiagnostics = (
  dataset: DatasetSnapshot,
  requestFingerprintValue: string,
  intent: SearchIntentAnalysisV7,
  policy: NormalizedExecutionPolicyV7,
  startedAt: number,
  reason: DataSearchExecutionBlockReasonV7 | null,
  clock: () => number,
): DataSearchExecutionDiagnosticsV7 => Object.freeze({
  version: VERSION,
  datasetFingerprint: dataset.fingerprint,
  requestFingerprint: requestFingerprintValue,
  intentKind: intent.kind,
  blocked: reason !== null,
  blockReason: reason,
  candidateBudget: policy.maximumCandidates,
  addressCandidateCount: 0,
  spatialCandidateCount: 0,
  textCandidateCount: 0,
  evaluatedCount: 0,
  matchedCount: 0,
  resultWindowCount: 0,
  resultWindowTruncated: false,
  textUsed: false,
  addressUsed: false,
  spatialUsed: false,
  textBlocked: false,
  addressPlanStrategy: null,
  radiusMeters: 0,
  elapsedMs: Math.max(0, safeNow(clock) - startedAt),
});

const emptyResponse = (
  dataset: DatasetSnapshot,
  request: NormalizedSearchRequest,
  fingerprint: string,
  elapsedMs: number,
): SearchResponse => Object.freeze({
  results: Object.freeze([]),
  page: createPageInfo(request.offset, request.limit, 0, 0),
  facets: Object.freeze({}),
  diagnostics: Object.freeze({
    datasetKey: dataset.key,
    revision: dataset.revision,
    totalRecords: dataset.records.length,
    candidateCount: 0,
    scoredCount: 0,
    filteredCount: 0,
    cacheHit: false,
    elapsedMs,
    querySignature: fingerprint,
    quality: dataset.quality,
  }),
});

const resultForBlocked = (
  dataset: DatasetSnapshot,
  request: NormalizedSearchRequest,
  intent: SearchIntentAnalysisV7,
  fingerprint: string,
  policy: NormalizedExecutionPolicyV7,
  startedAt: number,
  reason: DataSearchExecutionBlockReasonV7,
): DataSearchExecutionResultV7 => {
  const diagnostics = emptyDiagnostics(
    dataset,
    fingerprint,
    intent,
    policy,
    startedAt,
    reason,
    policy.clock,
  );
  return Object.freeze({
    response: emptyResponse(dataset, request, fingerprint, diagnostics.elapsedMs),
    hits: Object.freeze([]),
    intent,
    diagnostics,
  });
};

const updateStatsForIntent = (
  stats: MutableExecutionStatsV7,
  kind: SearchIntentKindV7,
): void => {
  if (kind === 'text') stats.textSearches += 1;
  else if (kind === 'address') stats.addressSearches += 1;
  else if (kind === 'coordinate') stats.coordinateSearches += 1;
  else if (kind === 'hybrid') stats.hybridSearches += 1;
  else stats.emptySearches += 1;
};

export class DataSearchExecutionRuntimeV7 {
  readonly #dataset: DatasetSnapshot;
  readonly #policy: NormalizedExecutionPolicyV7;
  readonly #textEngine: DataSearchQueryEngineV6;
  readonly #stats: MutableExecutionStatsV7 = {
    searches: 0,
    blockedSearches: 0,
    textSearches: 0,
    addressSearches: 0,
    coordinateSearches: 0,
    hybridSearches: 0,
    emptySearches: 0,
    maximumObservedCandidates: 0,
  };

  constructor(
    dataset: DatasetSnapshot,
    policyInput: DataSearchExecutionPolicyV7 = {},
  ) {
    this.#dataset = dataset;
    this.#policy = normalizePolicy(policyInput);
    this.#textEngine = new DataSearchQueryEngineV6(
      dataset.records,
      String(dataset.revision),
      {
        ...this.#policy.text,
        maximumRecords: Math.max(1, dataset.records.length),
        defaultLimit: Math.min(this.#policy.defaultLimit, this.#policy.maximumResultWindow),
        maximumLimit: this.#policy.maximumResultWindow,
        maximumOffset: this.#policy.maximumResultWindow,
      },
    );
  }

  dataset(): DatasetSnapshot {
    return this.#dataset;
  }

  policy(): DataSearchExecutionPolicyV7 {
    return Object.freeze({
      defaultLimit: this.#policy.defaultLimit,
      maximumLimit: this.#policy.maximumLimit,
      maximumCandidates: this.#policy.maximumCandidates,
      maximumResultWindow: this.#policy.maximumResultWindow,
      maximumFacetFields: this.#policy.maximumFacetFields,
      maximumFacetBuckets: this.#policy.maximumFacetBuckets,
      defaultRadiusMeters: this.#policy.defaultRadiusMeters,
      maximumRadiusMeters: this.#policy.maximumRadiusMeters,
      minimumAddressScore: this.#policy.minimumAddressScore,
      intent: this.#policy.intent,
      candidatePlanner: this.#policy.candidatePlanner,
      spatial: this.#policy.spatial,
      text: this.#policy.text,
      clock: this.#policy.clock,
    });
  }

  analyze(request: SearchRequest = {}): SearchIntentAnalysisV7 {
    return analyzeSearchIntentV7(request, this.#policy.intent);
  }

  fingerprint(request: SearchRequest = {}): string {
    const normalized = normalizedRequest(request, this.#policy);
    const intent = this.analyze(request);
    return requestFingerprint(this.#dataset, normalized, intent);
  }

  search(requestInput: SearchRequest = {}): DataSearchExecutionResultV7 {
    const startedAt = safeNow(this.#policy.clock);
    const request = normalizedRequest(requestInput, this.#policy);
    throwIfAborted(request.signal);
    const intent = this.analyze(requestInput);
    const fingerprint = requestFingerprint(this.#dataset, request, intent);
    this.#stats.searches += 1;
    updateStatsForIntent(this.#stats, intent.kind);

    if (intent.diagnostics.invalidExplicitCenter) {
      this.#stats.blockedSearches += 1;
      return resultForBlocked(
        this.#dataset,
        request,
        intent,
        fingerprint,
        this.#policy,
        startedAt,
        'invalid-explicit-center',
      );
    }
    if (request.offset >= this.#policy.maximumResultWindow) {
      this.#stats.blockedSearches += 1;
      return resultForBlocked(
        this.#dataset,
        request,
        intent,
        fingerprint,
        this.#policy,
        startedAt,
        'result-window-offset-exceeded',
      );
    }

    const textResponse = textResponseFor(this.#textEngine, request, intent, this.#policy);
    const textBlocked = textResponse?.diagnostics.blocked === true;
    if (textBlocked && intent.kind === 'text') {
      this.#stats.blockedSearches += 1;
      return resultForBlocked(
        this.#dataset,
        request,
        intent,
        fingerprint,
        this.#policy,
        startedAt,
        'text-execution-blocked',
      );
    }

    let allHits: readonly DataSearchExecutionHitV7[];
    let filteredCount = 0;
    let evaluatedCount = 0;
    let candidateResolution: CandidateResolutionV7 = Object.freeze({
      positions: Object.freeze([]),
      addressPlan: null,
      addressCandidateCount: 0,
      spatialCandidateCount: 0,
      blocked: null,
    });
    const radiusMeters = radiusFor(request, intent, this.#policy);

    if (intent.kind === 'text' && textResponse) {
      allHits = textOnlyHits(textResponse, request, intent);
      evaluatedCount = textResponse.diagnostics.relevance.scoredCount;
      filteredCount = Math.max(0, textResponse.diagnostics.filterCandidates - allHits.length);
    } else {
      candidateResolution = candidatePositions(this.#dataset, request, intent, this.#policy);
      if (candidateResolution.blocked) {
        this.#stats.blockedSearches += 1;
        return resultForBlocked(
          this.#dataset,
          request,
          intent,
          fingerprint,
          this.#policy,
          startedAt,
          candidateResolution.blocked,
        );
      }
      const textMap = textHitMap(textResponse);
      const local = evaluateLocalCandidates(
        this.#dataset,
        candidateResolution.positions,
        request,
        intent,
        textMap,
        radiusMeters,
        this.#policy,
      );
      const mutable = [...local.hits];
      sortHits(mutable, request.sort);
      allHits = Object.freeze(mutable);
      filteredCount = local.filteredCount;
      evaluatedCount = local.evaluatedCount;
    }

    this.#stats.maximumObservedCandidates = Math.max(
      this.#stats.maximumObservedCandidates,
      candidateResolution.positions.length,
      textResponse?.diagnostics.filterCandidates ?? 0,
    );

    const resultWindowTruncated = allHits.length > this.#policy.maximumResultWindow
      || textResponse?.diagnostics.relevance.resultTruncated === true;
    const window = Object.freeze(allHits.slice(0, this.#policy.maximumResultWindow));
    const pageHits = Object.freeze(window.slice(request.offset, request.offset + request.limit));
    const facets = facetBuckets(window, request.facetFields, this.#policy);
    const elapsedMs = Math.max(0, safeNow(this.#policy.clock) - startedAt);
    const response: SearchResponse = Object.freeze({
      results: pageHits,
      page: createPageInfo(
        request.offset,
        request.limit,
        pageHits.length,
        window.length,
        this.#policy.defaultLimit,
      ),
      facets,
      diagnostics: Object.freeze({
        datasetKey: this.#dataset.key,
        revision: this.#dataset.revision,
        totalRecords: this.#dataset.records.length,
        candidateCount: intent.kind === 'text'
          ? textResponse?.diagnostics.filterCandidates ?? 0
          : candidateResolution.positions.length,
        scoredCount: window.length,
        filteredCount,
        cacheHit: false,
        elapsedMs,
        querySignature: fingerprint,
        quality: this.#dataset.quality,
      }),
    });
    const diagnostics: DataSearchExecutionDiagnosticsV7 = Object.freeze({
      version: VERSION,
      datasetFingerprint: this.#dataset.fingerprint,
      requestFingerprint: fingerprint,
      intentKind: intent.kind,
      blocked: false,
      blockReason: null,
      candidateBudget: this.#policy.maximumCandidates,
      addressCandidateCount: candidateResolution.addressCandidateCount,
      spatialCandidateCount: candidateResolution.spatialCandidateCount,
      textCandidateCount: textResponse?.diagnostics.filterCandidates ?? 0,
      evaluatedCount,
      matchedCount: allHits.length,
      resultWindowCount: window.length,
      resultWindowTruncated,
      textUsed: textResponse !== null,
      addressUsed: searchIntentRequiresAddressV7(intent),
      spatialUsed: searchIntentRequiresSpatialV7(intent),
      textBlocked,
      addressPlanStrategy: candidateResolution.addressPlan?.strategy ?? null,
      radiusMeters,
      elapsedMs,
    });
    return Object.freeze({
      response,
      hits: window,
      intent,
      diagnostics,
    });
  }

  searchResponse(request: SearchRequest = {}): SearchResponse {
    return this.search(request).response;
  }

  snapshot(): DataSearchExecutionSnapshotV7 {
    return Object.freeze({
      version: VERSION,
      datasetKey: this.#dataset.key,
      datasetRevision: this.#dataset.revision,
      datasetFingerprint: this.#dataset.fingerprint,
      recordCount: this.#dataset.records.length,
      searches: this.#stats.searches,
      blockedSearches: this.#stats.blockedSearches,
      textSearches: this.#stats.textSearches,
      addressSearches: this.#stats.addressSearches,
      coordinateSearches: this.#stats.coordinateSearches,
      hybridSearches: this.#stats.hybridSearches,
      emptySearches: this.#stats.emptySearches,
      maximumObservedCandidates: this.#stats.maximumObservedCandidates,
    });
  }
}

export const createDataSearchExecutionRuntimeV7 = (
  dataset: DatasetSnapshot,
  policy: DataSearchExecutionPolicyV7 = {},
): DataSearchExecutionRuntimeV7 => new DataSearchExecutionRuntimeV7(dataset, policy);
