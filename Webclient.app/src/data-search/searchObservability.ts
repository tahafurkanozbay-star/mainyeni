import type { IntegrityReport } from './dataIntegrity';
import type { CompiledQueryPlan, QueryPlanRisk } from './queryPlanRuntime';
import type { SearchResponse } from './contracts';
import { normalizeInteger, normalizeSearchText } from './normalization';

export type SearchMetricOperation =
  | 'register'
  | 'search'
  | 'search-page'
  | 'geocode-forward'
  | 'geocode-reverse'
  | 'schema-profile'
  | 'integrity';

export interface SearchMetricSample {
  readonly timestamp: number;
  readonly operation: SearchMetricOperation;
  readonly durationMs: number;
  readonly datasetBucket: string;
  readonly queryLengthBucket: string;
  readonly candidateCount: number;
  readonly resultCount: number;
  readonly cacheHit: boolean;
  readonly aborted: boolean;
  readonly failed: boolean;
  readonly planRisk: QueryPlanRisk | null;
  readonly quarantinedCount: number;
  readonly rejectedCount: number;
}

export interface SearchObservabilityBudget {
  readonly p95SearchMs?: number;
  readonly p99SearchMs?: number;
  readonly maxCandidateRatio?: number;
  readonly maxHighRiskPlanRatio?: number;
  readonly maxFailureRatio?: number;
  readonly maxAbortRatio?: number;
  readonly maxQuarantineRatio?: number;
}

export interface SearchObservabilityEvaluation {
  readonly withinBudget: boolean;
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
}

export interface SearchObservabilitySnapshot {
  readonly sampleCount: number;
  readonly searchCount: number;
  readonly failureCount: number;
  readonly abortCount: number;
  readonly cacheHitCount: number;
  readonly highRiskPlanCount: number;
  readonly p50SearchMs: number;
  readonly p95SearchMs: number;
  readonly p99SearchMs: number;
  readonly averageCandidateCount: number;
  readonly averageResultCount: number;
  readonly maxCandidateCount: number;
  readonly quarantineCount: number;
  readonly rejectedCount: number;
  readonly operationCounts: Readonly<Record<string, number>>;
  readonly datasetBuckets: Readonly<Record<string, number>>;
}

export interface SearchObservabilityOptions {
  readonly maxSamples?: number;
  readonly clock?: () => number;
  readonly budget?: SearchObservabilityBudget;
}

const DEFAULT_MAX_SAMPLES = 1_000;
const DEFAULT_BUDGET: Required<SearchObservabilityBudget> = Object.freeze({
  p95SearchMs: 250,
  p99SearchMs: 600,
  maxCandidateRatio: 0.8,
  maxHighRiskPlanRatio: 0.15,
  maxFailureRatio: 0.03,
  maxAbortRatio: 0.5,
  maxQuarantineRatio: 0.1,
});

const clampRatio = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
};

const normalizeBudget = (budget: SearchObservabilityBudget = {}): Required<SearchObservabilityBudget> => Object.freeze({
  p95SearchMs: Math.max(1, Number(budget.p95SearchMs) || DEFAULT_BUDGET.p95SearchMs),
  p99SearchMs: Math.max(1, Number(budget.p99SearchMs) || DEFAULT_BUDGET.p99SearchMs),
  maxCandidateRatio: clampRatio(budget.maxCandidateRatio, DEFAULT_BUDGET.maxCandidateRatio),
  maxHighRiskPlanRatio: clampRatio(budget.maxHighRiskPlanRatio, DEFAULT_BUDGET.maxHighRiskPlanRatio),
  maxFailureRatio: clampRatio(budget.maxFailureRatio, DEFAULT_BUDGET.maxFailureRatio),
  maxAbortRatio: clampRatio(budget.maxAbortRatio, DEFAULT_BUDGET.maxAbortRatio),
  maxQuarantineRatio: clampRatio(budget.maxQuarantineRatio, DEFAULT_BUDGET.maxQuarantineRatio),
});

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const finiteNonNegative = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

export const queryLengthBucket = (lengthInput: unknown): string => {
  const length = Math.max(0, Math.trunc(Number(lengthInput) || 0));
  if (length === 0) return 'empty';
  if (length <= 2) return '1-2';
  if (length <= 5) return '3-5';
  if (length <= 10) return '6-10';
  if (length <= 20) return '11-20';
  if (length <= 40) return '21-40';
  return '41+';
};

export const datasetMetricBucket = (datasetKeyInput: unknown): string => {
  const key = normalizeSearchText(datasetKeyInput);
  if (!key) return 'unknown';
  // Keep diagnostics useful without retaining a raw free-form dataset label.
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `dataset-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const percentile = (values: readonly number[], fraction: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
};

const increment = (target: Record<string, number>, key: string): void => {
  target[key] = (target[key] ?? 0) + 1;
};

export class SearchObservability {
  private readonly samples: SearchMetricSample[] = [];
  private readonly maxSamples: number;
  private readonly clock: () => number;
  private readonly budget: Required<SearchObservabilityBudget>;

  constructor(options: SearchObservabilityOptions = {}) {
    this.maxSamples = normalizeInteger(options.maxSamples, {
      min: 10,
      max: 100_000,
      fallback: DEFAULT_MAX_SAMPLES,
    });
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.budget = normalizeBudget(options.budget);
  }

  record(sample: Omit<SearchMetricSample, 'timestamp'> & { readonly timestamp?: number }): SearchMetricSample {
    const normalized = Object.freeze({
      timestamp: Number.isFinite(Number(sample.timestamp)) ? Math.trunc(Number(sample.timestamp)) : safeNow(this.clock),
      operation: sample.operation,
      durationMs: finiteNonNegative(sample.durationMs),
      datasetBucket: sample.datasetBucket || 'unknown',
      queryLengthBucket: sample.queryLengthBucket || 'empty',
      candidateCount: Math.trunc(finiteNonNegative(sample.candidateCount)),
      resultCount: Math.trunc(finiteNonNegative(sample.resultCount)),
      cacheHit: sample.cacheHit === true,
      aborted: sample.aborted === true,
      failed: sample.failed === true,
      planRisk: sample.planRisk ?? null,
      quarantinedCount: Math.trunc(finiteNonNegative(sample.quarantinedCount)),
      rejectedCount: Math.trunc(finiteNonNegative(sample.rejectedCount)),
    });
    this.samples.push(normalized);
    while (this.samples.length > this.maxSamples) this.samples.shift();
    return normalized;
  }

  recordSearch(
    datasetKey: unknown,
    queryLength: number,
    response: SearchResponse,
    durationMs: number,
    plan?: CompiledQueryPlan | null,
  ): SearchMetricSample {
    return this.record({
      operation: 'search',
      durationMs,
      datasetBucket: datasetMetricBucket(datasetKey),
      queryLengthBucket: queryLengthBucket(queryLength),
      candidateCount: response.diagnostics.candidateCount,
      resultCount: response.results.length,
      cacheHit: response.diagnostics.cacheHit,
      aborted: false,
      failed: false,
      planRisk: plan?.risk ?? null,
      quarantinedCount: 0,
      rejectedCount: 0,
    });
  }

  recordIntegrity(datasetKey: unknown, report: IntegrityReport, durationMs: number): SearchMetricSample {
    return this.record({
      operation: 'integrity',
      durationMs,
      datasetBucket: datasetMetricBucket(datasetKey),
      queryLengthBucket: 'empty',
      candidateCount: report.normalizedCount,
      resultCount: report.acceptedCount,
      cacheHit: false,
      aborted: false,
      failed: !report.releaseReady,
      planRisk: null,
      quarantinedCount: report.quarantinedCount,
      rejectedCount: report.rejectedCount,
    });
  }

  recordFailure(
    operation: SearchMetricOperation,
    datasetKey: unknown,
    durationMs: number,
    options: { readonly aborted?: boolean; readonly queryLength?: number } = {},
  ): SearchMetricSample {
    return this.record({
      operation,
      durationMs,
      datasetBucket: datasetMetricBucket(datasetKey),
      queryLengthBucket: queryLengthBucket(options.queryLength ?? 0),
      candidateCount: 0,
      resultCount: 0,
      cacheHit: false,
      aborted: options.aborted === true,
      failed: options.aborted !== true,
      planRisk: null,
      quarantinedCount: 0,
      rejectedCount: 0,
    });
  }

  snapshot(): SearchObservabilitySnapshot {
    const searchSamples = this.samples.filter(sample =>
      sample.operation === 'search' || sample.operation === 'search-page');
    const searchDurations = searchSamples.map(sample => sample.durationMs);
    const operationCounts: Record<string, number> = {};
    const datasetBuckets: Record<string, number> = {};
    let candidateTotal = 0;
    let resultTotal = 0;
    let maxCandidateCount = 0;
    let quarantineCount = 0;
    let rejectedCount = 0;
    for (const sample of this.samples) {
      increment(operationCounts, sample.operation);
      increment(datasetBuckets, sample.datasetBucket);
      candidateTotal += sample.candidateCount;
      resultTotal += sample.resultCount;
      maxCandidateCount = Math.max(maxCandidateCount, sample.candidateCount);
      quarantineCount += sample.quarantinedCount;
      rejectedCount += sample.rejectedCount;
    }
    return Object.freeze({
      sampleCount: this.samples.length,
      searchCount: searchSamples.length,
      failureCount: this.samples.filter(sample => sample.failed).length,
      abortCount: this.samples.filter(sample => sample.aborted).length,
      cacheHitCount: this.samples.filter(sample => sample.cacheHit).length,
      highRiskPlanCount: this.samples.filter(sample => sample.planRisk === 'high').length,
      p50SearchMs: percentile(searchDurations, 0.5),
      p95SearchMs: percentile(searchDurations, 0.95),
      p99SearchMs: percentile(searchDurations, 0.99),
      averageCandidateCount: this.samples.length ? candidateTotal / this.samples.length : 0,
      averageResultCount: this.samples.length ? resultTotal / this.samples.length : 0,
      maxCandidateCount,
      quarantineCount,
      rejectedCount,
      operationCounts: Object.freeze(operationCounts),
      datasetBuckets: Object.freeze(datasetBuckets),
    });
  }

  evaluate(): SearchObservabilityEvaluation {
    const snapshot = this.snapshot();
    const violations: string[] = [];
    const warnings: string[] = [];
    const sampleCount = Math.max(1, snapshot.sampleCount);
    const searchCount = Math.max(1, snapshot.searchCount);
    if (snapshot.searchCount >= 10 && snapshot.p95SearchMs > this.budget.p95SearchMs) violations.push('p95-search-latency');
    if (snapshot.searchCount >= 10 && snapshot.p99SearchMs > this.budget.p99SearchMs) violations.push('p99-search-latency');
    if (snapshot.highRiskPlanCount / searchCount > this.budget.maxHighRiskPlanRatio) violations.push('high-risk-plan-ratio');
    if (snapshot.failureCount / sampleCount > this.budget.maxFailureRatio) violations.push('failure-ratio');
    if (snapshot.abortCount / sampleCount > this.budget.maxAbortRatio) warnings.push('high-abort-ratio');
    const integrityVolume = snapshot.quarantineCount + snapshot.rejectedCount + snapshot.averageResultCount;
    if (integrityVolume > 0 && snapshot.quarantineCount / integrityVolume > this.budget.maxQuarantineRatio) {
      warnings.push('high-quarantine-ratio');
    }
    if (snapshot.maxCandidateCount > 50_000) warnings.push('large-candidate-plan');
    return Object.freeze({
      withinBudget: violations.length === 0,
      violations: Object.freeze(violations),
      warnings: Object.freeze(warnings),
    });
  }

  reset(): void {
    this.samples.splice(0, this.samples.length);
  }

  recent(limitInput = 50): readonly SearchMetricSample[] {
    const limit = normalizeInteger(limitInput, { min: 1, max: this.maxSamples, fallback: 50 });
    return Object.freeze(this.samples.slice(Math.max(0, this.samples.length - limit)));
  }
}

export const createSearchObservability = (options: SearchObservabilityOptions = {}): SearchObservability =>
  new SearchObservability(options);
