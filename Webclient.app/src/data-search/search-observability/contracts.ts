export const SEARCH_METRICS = Object.freeze({
  SearchDurationMs: 'search.duration.ms',
  IndexBuildDurationMs: 'index.build.duration.ms',
  CandidateCount: 'search.candidate.count',
  MatchedCount: 'search.matched.count',
  DatasetRecordCount: 'dataset.record.count',
  CacheHit: 'cache.hit',
  CacheMiss: 'cache.miss',
  Cancellation: 'search.cancellation',
  Error: 'search.error',
} as const);

export interface NumericSampleSummary {
  count: number;
  min: number | null;
  max: number | null;
  sum: number;
  average: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  latest: number | null;
}

export interface RollingSampleWindow {
  add(value: unknown): boolean;
  addMany(values: unknown): number;
  values(): number[];
  summary(): NumericSampleSummary;
  clear(): number;
  size(): number;
  maxSamples: number;
}

export type TelemetryDimensions = Readonly<Record<string, string>>;

export interface TelemetryEvent {
  metric: string;
  value: number;
  dimensions: TelemetryDimensions;
  timestamp: number | null;
}

export interface TelemetrySeriesSnapshot {
  key: string;
  metric: string;
  dimensions: TelemetryDimensions;
  summary: NumericSampleSummary;
}

export interface SearchTelemetrySnapshot {
  acceptedEvents: number;
  rejectedEvents: number;
  seriesCount: number;
  series: TelemetrySeriesSnapshot[];
}

export interface SearchTelemetryCollector {
  record(event: unknown): boolean;
  recordMetric(metric: unknown, value: unknown, dimensions?: unknown): boolean;
  get(metric: unknown, dimensions?: unknown): NumericSampleSummary;
  find(metric: unknown): TelemetrySeriesSnapshot[];
  snapshot(): SearchTelemetrySnapshot;
  clear(): number;
}

export interface SearchTelemetryCollectorOptions {
  maxSamples?: unknown;
}

export interface SearchPerformanceBudget {
  searchP95Ms: number;
  searchP99Ms: number;
  indexBuildP95Ms: number;
  candidateP95: number;
  maxErrorRatio: number;
  maxCancellationRatio: number;
  minCacheHitRatio: number;
  minimumSamples: number;
}

export interface SearchBudgetFinding {
  level: 'warning' | 'block';
  code: string;
  actual: number;
  threshold: number;
  message: string;
}

export interface SearchBudgetEvaluation {
  level: 'pass' | 'warning' | 'block';
  withinBudget: boolean;
  representative: boolean;
  findings: SearchBudgetFinding[];
  metrics: {
    duration: NumericSampleSummary;
    indexBuild: NumericSampleSummary;
    candidates: NumericSampleSummary;
    errorRatio: number;
    cancellationRatio: number;
    cacheHitRatio: number;
  };
  budget: SearchPerformanceBudget;
}

export interface DebounceRecommendationInput {
  searchP95Ms?: unknown;
  recordCount?: unknown;
  queryLength?: unknown;
  min?: number;
  max?: number;
}

export interface MeasureOperationOptions {
  now?: () => number;
}

export interface MeasuredOperation<T> {
  value: T | undefined;
  durationMs: number;
  error: unknown | null;
}

export interface SearchObservabilityOptions extends SearchTelemetryCollectorOptions {
  collector?: SearchTelemetryCollector;
  budget?: Partial<SearchPerformanceBudget>;
}

export interface SearchObservationContext {
  dataset?: unknown;
  mode?: unknown;
  schema?: unknown;
  recordCount?: unknown;
  queryLength?: unknown;
  min?: number;
  max?: number;
}

export interface SearchObservability {
  collector: SearchTelemetryCollector;
  recordSearch<T>(result: T, durationMs: unknown, context?: SearchObservationContext): T;
  recordIndexBuild(durationMs: unknown, context?: SearchObservationContext): void;
  recordDatasetSize(recordCount: unknown, context?: SearchObservationContext): void;
  recordCache(hit: boolean, context?: SearchObservationContext): void;
  recordCancellation(context?: SearchObservationContext): void;
  recordError(context?: SearchObservationContext): void;
  snapshot(): SearchTelemetrySnapshot;
  evaluate(customBudget?: Partial<SearchPerformanceBudget>): SearchBudgetEvaluation;
  recommendDebounce(context?: SearchObservationContext): number;
  clear(): number;
}

export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
