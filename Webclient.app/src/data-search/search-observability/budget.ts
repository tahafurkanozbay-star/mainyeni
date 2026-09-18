import {
  normalizeFiniteNumber,
  normalizeInteger,
} from '../../Toolbox/DataIntegrityHelper';
import {
  SEARCH_METRICS,
  type DebounceRecommendationInput,
  type SearchBudgetEvaluation,
  type SearchBudgetFinding,
  type SearchPerformanceBudget,
  type SearchTelemetrySnapshot,
} from './contracts';
import {
  aggregateMetric,
} from './collector';
import {
  safeRatio,
} from './statistics';

export const DEFAULT_SEARCH_PERFORMANCE_BUDGET:
Readonly<SearchPerformanceBudget> = Object.freeze({
  searchP95Ms: 120,
  searchP99Ms: 250,
  indexBuildP95Ms: 500,
  candidateP95: 10_000,
  maxErrorRatio: 0.01,
  maxCancellationRatio: 0.5,
  minCacheHitRatio: 0,
  minimumSamples: 5,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const normalizeSearchPerformanceBudget = (
  budget: Partial<SearchPerformanceBudget> | null | undefined,
): SearchPerformanceBudget => {
  const input = budget ?? {};
  return {
    searchP95Ms: Math.max(
      1,
      normalizeFiniteNumber(input.searchP95Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP95Ms)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP95Ms,
    ),
    searchP99Ms: Math.max(
      1,
      normalizeFiniteNumber(input.searchP99Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP99Ms)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.searchP99Ms,
    ),
    indexBuildP95Ms: Math.max(
      1,
      normalizeFiniteNumber(input.indexBuildP95Ms, DEFAULT_SEARCH_PERFORMANCE_BUDGET.indexBuildP95Ms)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.indexBuildP95Ms,
    ),
    candidateP95: Math.max(
      1,
      normalizeFiniteNumber(input.candidateP95, DEFAULT_SEARCH_PERFORMANCE_BUDGET.candidateP95)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.candidateP95,
    ),
    maxErrorRatio: clamp(
      normalizeFiniteNumber(input.maxErrorRatio, DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxErrorRatio)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxErrorRatio,
      0,
      1,
    ),
    maxCancellationRatio: clamp(
      normalizeFiniteNumber(
        input.maxCancellationRatio,
        DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxCancellationRatio,
      ) ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.maxCancellationRatio,
      0,
      1,
    ),
    minCacheHitRatio: clamp(
      normalizeFiniteNumber(input.minCacheHitRatio, DEFAULT_SEARCH_PERFORMANCE_BUDGET.minCacheHitRatio)
        ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.minCacheHitRatio,
      0,
      1,
    ),
    minimumSamples: normalizeInteger(input.minimumSamples, {
      min: 1,
      max: 10_000,
      fallback: DEFAULT_SEARCH_PERFORMANCE_BUDGET.minimumSamples,
    }) ?? DEFAULT_SEARCH_PERFORMANCE_BUDGET.minimumSamples,
  };
};

const createBudgetFinding = (
  level: SearchBudgetFinding['level'],
  code: string,
  actual: number,
  threshold: number,
  message: string,
): SearchBudgetFinding => ({
  level,
  code,
  actual,
  threshold,
  message,
});

const comparable = (value: number | null): number =>
  value ?? 0;

export const evaluateSearchPerformanceBudget = (
  snapshot: SearchTelemetrySnapshot,
  budget: Partial<SearchPerformanceBudget> = DEFAULT_SEARCH_PERFORMANCE_BUDGET,
): SearchBudgetEvaluation => {
  const policy = normalizeSearchPerformanceBudget(budget);
  const duration = aggregateMetric(snapshot, SEARCH_METRICS.SearchDurationMs);
  const indexBuild = aggregateMetric(snapshot, SEARCH_METRICS.IndexBuildDurationMs);
  const candidates = aggregateMetric(snapshot, SEARCH_METRICS.CandidateCount);
  const errors = aggregateMetric(snapshot, SEARCH_METRICS.Error);
  const cancellations = aggregateMetric(snapshot, SEARCH_METRICS.Cancellation);
  const cacheHits = aggregateMetric(snapshot, SEARCH_METRICS.CacheHit);
  const cacheMisses = aggregateMetric(snapshot, SEARCH_METRICS.CacheMiss);
  const attempts = Math.max(duration.count, errors.count, cancellations.count);
  const errorRatio = safeRatio(errors.sum || errors.count, attempts);
  const cancellationRatio = safeRatio(cancellations.sum || cancellations.count, attempts);
  const cacheTotal = cacheHits.count + cacheMisses.count;
  const hitCount = cacheHits.sum || cacheHits.count;
  const missCount = cacheMisses.sum || cacheMisses.count;
  const cacheHitRatio = safeRatio(hitCount, hitCount + missCount || cacheTotal);
  const findings: SearchBudgetFinding[] = [];
  const representative = duration.count >= policy.minimumSamples;

  if (!representative && duration.count > 0) {
    findings.push(createBudgetFinding(
      'warning',
      'sample-size-low',
      duration.count,
      policy.minimumSamples,
      'Search performance sample is not yet representative',
    ));
  }
  if (representative && comparable(duration.p95) > policy.searchP95Ms) {
    findings.push(createBudgetFinding('block', 'search-p95', comparable(duration.p95), policy.searchP95Ms, 'Search p95 duration exceeds the production budget'));
  }
  if (representative && comparable(duration.p99) > policy.searchP99Ms) {
    findings.push(createBudgetFinding('block', 'search-p99', comparable(duration.p99), policy.searchP99Ms, 'Search p99 duration exceeds the production budget'));
  }
  if (indexBuild.count >= policy.minimumSamples
    && comparable(indexBuild.p95) > policy.indexBuildP95Ms) {
    findings.push(createBudgetFinding('block', 'index-build-p95', comparable(indexBuild.p95), policy.indexBuildP95Ms, 'Index build p95 duration exceeds the production budget'));
  }
  if (candidates.count >= policy.minimumSamples
    && comparable(candidates.p95) > policy.candidateP95) {
    findings.push(createBudgetFinding('warning', 'candidate-p95', comparable(candidates.p95), policy.candidateP95, 'Candidate scan p95 exceeds the configured efficiency budget'));
  }
  if (attempts >= policy.minimumSamples && errorRatio > policy.maxErrorRatio) {
    findings.push(createBudgetFinding('block', 'error-ratio', errorRatio, policy.maxErrorRatio, 'Search error ratio exceeds the configured budget'));
  }
  if (attempts >= policy.minimumSamples
    && cancellationRatio > policy.maxCancellationRatio) {
    findings.push(createBudgetFinding('warning', 'cancellation-ratio', cancellationRatio, policy.maxCancellationRatio, 'Search cancellation ratio indicates excessive superseded work'));
  }
  if (cacheTotal >= policy.minimumSamples && cacheHitRatio < policy.minCacheHitRatio) {
    findings.push(createBudgetFinding('warning', 'cache-hit-ratio', cacheHitRatio, policy.minCacheHitRatio, 'Search cache hit ratio is below the configured target'));
  }

  const blocked = findings.some(finding => finding.level === 'block');
  const warned = findings.some(finding => finding.level === 'warning');

  return {
    level: blocked ? 'block' : warned ? 'warning' : 'pass',
    withinBudget: !blocked,
    representative,
    findings,
    metrics: {
      duration,
      indexBuild,
      candidates,
      errorRatio,
      cancellationRatio,
      cacheHitRatio,
    },
    budget: policy,
  };
};

export const recommendSearchDebounceMs = ({
  searchP95Ms = 0,
  recordCount = 0,
  queryLength = 0,
  min = 80,
  max = 600,
}: DebounceRecommendationInput = {}): number => {
  const p95 = Math.max(0, normalizeFiniteNumber(searchP95Ms, 0) ?? 0);
  const records = Math.max(0, normalizeFiniteNumber(recordCount, 0) ?? 0);
  const length = Math.max(
    0,
    normalizeInteger(queryLength, { min: 0, fallback: 0 }) ?? 0,
  );
  const latencyWeight = Math.min(300, p95 * 0.75);
  const dataWeight = records > 100_000
    ? 140
    : records > 25_000
      ? 90
      : records > 5_000
        ? 40
        : 0;
  const shortQueryWeight = length <= 1 ? 120 : length === 2 ? 50 : 0;
  return Math.round(clamp(
    min + latencyWeight + dataWeight + shortQueryWeight,
    min,
    max,
  ));
};
