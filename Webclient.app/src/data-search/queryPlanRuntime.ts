import type {
  CandidatePlan,
  DatasetSnapshot,
  NormalizedSearchRequest,
  SearchRequest,
} from './contracts';
import { throwIfAborted } from './contracts';
import { analyzeAddressQuery } from './addressSemantics';
import { planCandidates } from './candidatePlanner';
import { collectSpatialCandidatePositions, createSpatialBounds } from './spatialIndex';
import { normalizeSearchRequest } from './searchRuntime';
import { normalizeInteger, stableSerialize, hashFingerprint } from './normalization';

export type QueryPlanStageKind =
  | 'candidate-index'
  | 'hierarchy-filter'
  | 'record-filter'
  | 'spatial-index'
  | 'scoring'
  | 'sort'
  | 'facet'
  | 'pagination';

export type QueryPlanRisk = 'low' | 'medium' | 'high';

export interface QueryPlanStage {
  readonly order: number;
  readonly kind: QueryPlanStageKind;
  readonly inputEstimate: number;
  readonly outputEstimate: number;
  readonly relativeCost: number;
  readonly bounded: boolean;
  readonly reason: string;
}

export interface CompiledQueryPlan {
  readonly version: 1;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly request: NormalizedSearchRequest;
  readonly candidatePlan: CandidatePlan;
  readonly spatialCandidatePositions: readonly number[] | null;
  readonly stages: readonly QueryPlanStage[];
  readonly estimatedCandidateCount: number;
  readonly estimatedWorkUnits: number;
  readonly estimatedSelectivity: number;
  readonly fullScan: boolean;
  readonly risk: QueryPlanRisk;
  readonly warnings: readonly string[];
  readonly fingerprint: string;
}

export interface QueryPlanOptions {
  readonly maxCandidates?: number;
  readonly highRiskCandidateRatio?: number;
  readonly mediumRiskCandidateRatio?: number;
  readonly maxSpatialCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 10_000;
const DEFAULT_MAX_SPATIAL_CANDIDATES = 25_000;

const clampRatio = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
};

const stage = (
  order: number,
  kind: QueryPlanStageKind,
  inputEstimate: number,
  outputEstimate: number,
  relativeCost: number,
  bounded: boolean,
  reason: string,
): QueryPlanStage => Object.freeze({
  order,
  kind,
  inputEstimate: Math.max(0, Math.trunc(inputEstimate)),
  outputEstimate: Math.max(0, Math.trunc(outputEstimate)),
  relativeCost: Math.max(0, relativeCost),
  bounded,
  reason,
});

const estimateFilterSelectivity = (request: NormalizedSearchRequest): number => {
  let ratio = 1;
  if (request.filters.length) ratio *= Math.max(0.08, Math.pow(0.55, request.filters.length));
  if (request.level) ratio *= 0.35;
  if (request.district) ratio *= 0.45;
  if (request.neighborhood) ratio *= 0.35;
  if (request.street) ratio *= 0.2;
  return Math.min(1, Math.max(0.01, ratio));
};

const planRisk = (
  fullScan: boolean,
  candidateRatio: number,
  options: QueryPlanOptions,
): QueryPlanRisk => {
  const high = clampRatio(options.highRiskCandidateRatio, 0.8);
  const medium = clampRatio(options.mediumRiskCandidateRatio, 0.45);
  if (fullScan && candidateRatio >= high) return 'high';
  if (candidateRatio >= high) return 'high';
  if (fullScan || candidateRatio >= medium) return 'medium';
  return 'low';
};

const intersectSortedPositions = (
  left: readonly number[],
  right: readonly number[],
  maxItems: number,
): readonly number[] => {
  const rightSet = new Set(right);
  const result: number[] = [];
  for (const position of left) {
    if (rightSet.has(position)) result.push(position);
    if (result.length >= maxItems) break;
  }
  return Object.freeze(result);
};

export const compileQueryPlan = (
  dataset: DatasetSnapshot,
  requestInput: SearchRequest = {},
  options: QueryPlanOptions = {},
): CompiledQueryPlan => {
  const request = normalizeSearchRequest(requestInput);
  throwIfAborted(request.signal);
  const maxCandidates = normalizeInteger(options.maxCandidates, {
    min: 1,
    max: 250_000,
    fallback: DEFAULT_MAX_CANDIDATES,
  });
  const maxSpatialCandidates = normalizeInteger(options.maxSpatialCandidates, {
    min: 1,
    max: 250_000,
    fallback: DEFAULT_MAX_SPATIAL_CANDIDATES,
  });
  const address = analyzeAddressQuery(request.query, {
    level: request.level,
    district: request.district,
    neighborhood: request.neighborhood,
    street: request.street,
    center: request.center,
    radiusMeters: request.radiusMeters,
  });
  const candidatePlan = planCandidates(dataset.candidateIndex, {
    query: request.query,
    address,
    signal: request.signal,
  }, {
    maxTokenPostings: maxCandidates,
  });
  throwIfAborted(request.signal);

  let spatialCandidatePositions: readonly number[] | null = null;
  const spatialCenter = request.center;
  if (spatialCenter && request.radiusMeters > 0) {
    const bounds = createSpatialBounds(spatialCenter, request.radiusMeters);
    const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {
      maxCandidates: maxSpatialCandidates,
      signal: request.signal,
    });
    spatialCandidatePositions = Object.freeze([...spatial.positions]);
  }

  const initialCandidates = candidatePlan.candidatePositions.slice(0, maxCandidates);
  const effectiveCandidates = spatialCandidatePositions
    ? intersectSortedPositions(initialCandidates, spatialCandidatePositions, maxCandidates)
    : Object.freeze(initialCandidates);
  const totalRecords = dataset.records.length;
  const selectivity = estimateFilterSelectivity(request);
  const filteredEstimate = Math.ceil(effectiveCandidates.length * selectivity);
  const stages: QueryPlanStage[] = [];
  stages.push(stage(stages.length, 'candidate-index', totalRecords, initialCandidates.length, Math.max(1, candidatePlan.estimatedCost), initialCandidates.length <= maxCandidates, `Candidate planner strategy: ${candidatePlan.strategy}`));
  if (request.level || request.district || request.neighborhood || request.street) {
    stages.push(stage(stages.length, 'hierarchy-filter', effectiveCandidates.length, Math.ceil(effectiveCandidates.length * Math.max(0.05, selectivity)), effectiveCandidates.length, true, 'Apply canonical address hierarchy constraints before scoring'));
  }
  if (request.filters.length) {
    stages.push(stage(stages.length, 'record-filter', effectiveCandidates.length, filteredEstimate, effectiveCandidates.length * request.filters.length, request.filters.length <= 16, `Apply ${request.filters.length} normalized record filter(s)`));
  }
  if (spatialCandidatePositions) {
    stages.push(stage(stages.length, 'spatial-index', initialCandidates.length, effectiveCandidates.length, spatialCandidatePositions.length, spatialCandidatePositions.length <= maxSpatialCandidates, 'Intersect text candidates with bounded spatial-cell candidates, then verify exact distance'));
  }
  stages.push(stage(stages.length, 'scoring', effectiveCandidates.length, filteredEstimate, filteredEstimate * Math.max(1, request.terms.length), effectiveCandidates.length <= maxCandidates, 'Score normalized text and Turkish address evidence'));
  stages.push(stage(stages.length, 'sort', filteredEstimate, filteredEstimate, filteredEstimate > 1 ? filteredEstimate * Math.log2(filteredEstimate) : filteredEstimate, filteredEstimate <= maxCandidates, `Sort by ${request.sort}`));
  if (request.facetFields.length) {
    stages.push(stage(stages.length, 'facet', filteredEstimate, filteredEstimate, filteredEstimate * request.facetFields.length, request.facetFields.length <= 12, `Build ${request.facetFields.length} facet field(s) from matched records`));
  }
  stages.push(stage(stages.length, 'pagination', filteredEstimate, Math.min(request.limit, Math.max(0, filteredEstimate - request.offset)), request.limit, true, `Return offset ${request.offset} with limit ${request.limit}`));

  const estimatedWorkUnits = Math.ceil(stages.reduce((sum, item) => sum + item.relativeCost, 0));
  const fullScan = candidatePlan.strategy === 'all' || candidatePlan.strategy === 'fallback-scan';
  const candidateRatio = totalRecords ? effectiveCandidates.length / totalRecords : 0;
  const risk = planRisk(fullScan, candidateRatio, options);
  const warnings: string[] = [];
  if (initialCandidates.length >= maxCandidates && totalRecords > maxCandidates) warnings.push('candidate-budget-reached');
  if (spatialCandidatePositions && spatialCandidatePositions.length >= maxSpatialCandidates) warnings.push('spatial-candidate-budget-reached');
  if (fullScan && request.normalizedQuery) warnings.push('query-fell-back-to-scan');
  if (request.sort === 'distance' && !request.center) warnings.push('distance-sort-without-center');
  if (risk === 'high') warnings.push('high-cost-query-plan');

  const fingerprint = hashFingerprint(stableSerialize({
    datasetKey: dataset.key,
    revision: dataset.revision,
    fingerprint: dataset.fingerprint,
    request: { query: request.normalizedQuery, terms: request.terms, filters: request.filters, facets: request.facetFields, sort: request.sort, offset: request.offset, limit: request.limit, center: request.center, radiusMeters: request.radiusMeters, level: request.level, district: request.district, neighborhood: request.neighborhood, street: request.street },
    strategy: candidatePlan.strategy,
    candidates: effectiveCandidates.length,
    stages: stages.map(item => [item.kind, item.inputEstimate, item.outputEstimate]),
  }));

  return Object.freeze({
    version: 1 as const,
    datasetKey: dataset.key,
    datasetRevision: dataset.revision,
    datasetFingerprint: dataset.fingerprint,
    request,
    candidatePlan: Object.freeze({ ...candidatePlan, candidatePositions: Object.freeze(effectiveCandidates) }),
    spatialCandidatePositions,
    stages: Object.freeze(stages),
    estimatedCandidateCount: effectiveCandidates.length,
    estimatedWorkUnits,
    estimatedSelectivity: totalRecords ? effectiveCandidates.length / totalRecords : 0,
    fullScan,
    risk,
    warnings: Object.freeze(warnings),
    fingerprint,
  });
};

export const compareQueryPlans = (
  baseline: CompiledQueryPlan,
  candidate: CompiledQueryPlan,
): Readonly<{ workDelta: number; candidateDelta: number; riskChanged: boolean; regressed: boolean }> => {
  const workDelta = candidate.estimatedWorkUnits - baseline.estimatedWorkUnits;
  const candidateDelta = candidate.estimatedCandidateCount - baseline.estimatedCandidateCount;
  const rank: Readonly<Record<QueryPlanRisk, number>> = { low: 0, medium: 1, high: 2 };
  return Object.freeze({
    workDelta,
    candidateDelta,
    riskChanged: baseline.risk !== candidate.risk,
    regressed: rank[candidate.risk] > rank[baseline.risk] || (baseline.estimatedWorkUnits > 0 && candidate.estimatedWorkUnits / baseline.estimatedWorkUnits > 1.5),
  });
};

export const summarizeQueryPlan = (plan: CompiledQueryPlan): Readonly<Record<string, unknown>> => Object.freeze({
  fingerprint: plan.fingerprint,
  datasetKey: plan.datasetKey,
  datasetRevision: plan.datasetRevision,
  strategy: plan.candidatePlan.strategy,
  candidateCount: plan.estimatedCandidateCount,
  workUnits: plan.estimatedWorkUnits,
  selectivity: plan.estimatedSelectivity,
  fullScan: plan.fullScan,
  risk: plan.risk,
  warnings: plan.warnings,
  stages: plan.stages.map(item => Object.freeze({ kind: item.kind, inputEstimate: item.inputEstimate, outputEstimate: item.outputEstimate, bounded: item.bounded })),
});
