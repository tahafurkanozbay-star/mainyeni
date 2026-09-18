import type { PerformanceSnapshot, WebVitalRating } from '../platform/performance/performanceMonitor';

export const CORE_VITAL_NAMES = ['CLS', 'FCP', 'INP', 'LCP', 'TTFB'] as const;
export type CoreVitalName = typeof CORE_VITAL_NAMES[number];

export type PerformanceFindingLevel = 'warning' | 'block';
export type PerformanceReadinessLevel = 'pass' | PerformanceFindingLevel;
export type ResourceOriginKind = 'same-origin' | 'cross-origin' | 'opaque' | 'unknown';
export type ResourceCategory =
  | 'script'
  | 'style'
  | 'image'
  | 'font'
  | 'fetch'
  | 'xmlhttprequest'
  | 'navigation'
  | 'worker'
  | 'other';

export interface WebVitalMeasurement {
  readonly name: CoreVitalName;
  readonly value: number;
  readonly delta: number;
  readonly id: string;
  readonly rating: WebVitalRating;
  readonly navigationType: string;
  readonly recordedAt: number;
}

export interface NumericDistribution {
  readonly count: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly sum: number;
  readonly average: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly latest: number | null;
}

export interface ResourceTimingSample {
  readonly category: ResourceCategory;
  readonly originKind: ResourceOriginKind;
  readonly origin: string | null;
  readonly durationMs: number;
  readonly transferBytes: number;
  readonly encodedBytes: number;
  readonly decodedBytes: number;
  readonly cacheLike: boolean;
  readonly renderBlocking: boolean;
}

export interface ResourceTimingSummary {
  readonly count: number;
  readonly sameOriginCount: number;
  readonly crossOriginCount: number;
  readonly opaqueCount: number;
  readonly transferBytes: number;
  readonly encodedBytes: number;
  readonly decodedBytes: number;
  readonly cacheLikeCount: number;
  readonly cacheLikeRatio: number | null;
  readonly renderBlockingCount: number;
  readonly duration: NumericDistribution;
  readonly transfer: NumericDistribution;
  readonly categoryCounts: Readonly<Record<ResourceCategory, number>>;
  readonly crossOriginOrigins: readonly string[];
}

export interface LongTaskSample {
  readonly durationMs: number;
  readonly startTimeMs: number;
  readonly attributionCount: number;
}

export interface LongTaskSummary {
  readonly count: number;
  readonly totalDurationMs: number;
  readonly blockingTimeMs: number;
  readonly duration: NumericDistribution;
}

export interface PerformanceBudget {
  readonly vitals: Readonly<{
    lcpGoodMs: number;
    lcpBlockMs: number;
    clsGood: number;
    clsBlock: number;
    inpGoodMs: number;
    inpBlockMs: number;
    fcpWarningMs: number;
    fcpBlockMs: number;
    ttfbWarningMs: number;
    ttfbBlockMs: number;
  }>;
  readonly startup: Readonly<{
    firstRenderWarningMs: number;
    firstRenderBlockMs: number;
    domContentLoadedWarningMs: number;
    domContentLoadedBlockMs: number;
    loadWarningMs: number;
    loadBlockMs: number;
  }>;
  readonly longTasks: Readonly<{
    countWarning: number;
    countBlock: number;
    maxDurationWarningMs: number;
    maxDurationBlockMs: number;
    totalBlockingWarningMs: number;
    totalBlockingBlockMs: number;
  }>;
  readonly resources: Readonly<{
    countWarning: number;
    countBlock: number;
    transferWarningBytes: number;
    transferBlockBytes: number;
    decodedWarningBytes: number;
    decodedBlockBytes: number;
    crossOriginWarningCount: number;
    crossOriginBlockCount: number;
    minimumCacheLikeRatio: number;
  }>;
  readonly memory: Readonly<{
    utilizationWarning: number;
    utilizationBlock: number;
    usedWarningBytes: number;
    usedBlockBytes: number;
  }>;
  readonly evidence: Readonly<{
    minimumVitalSamples: number;
    requireLcp: boolean;
    requireCls: boolean;
    requireInp: boolean;
  }>;
}

export interface PerformanceFinding {
  readonly level: PerformanceFindingLevel;
  readonly code: string;
  readonly area: 'vitals' | 'startup' | 'long-task' | 'resource' | 'memory' | 'evidence';
  readonly message: string;
  readonly actual: number | boolean | string | null;
  readonly threshold: number | boolean | string | null;
}

export interface PerformanceEvidence {
  readonly monitor: PerformanceSnapshot;
  readonly resources: ResourceTimingSummary;
  readonly longTasks: LongTaskSummary;
  readonly vitals: Readonly<Partial<Record<CoreVitalName, WebVitalMeasurement>>>;
}

export interface PerformanceReadinessReport {
  readonly level: PerformanceReadinessLevel;
  readonly ready: boolean;
  readonly findings: readonly PerformanceFinding[];
  readonly blockerCodes: readonly string[];
  readonly warningCodes: readonly string[];
  readonly evidence: PerformanceEvidence;
  readonly budget: PerformanceBudget;
  readonly fingerprint: string;
  readonly generatedAt: number;
}

export interface PerformanceBaseline {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly fingerprint: string;
  readonly capturedAt: number;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface PerformanceRegression {
  readonly metric: string;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly delta: number | null;
  readonly deltaRatio: number | null;
  readonly direction: 'better' | 'worse' | 'same' | 'unknown';
}

export interface PerformanceBaselineComparison {
  readonly baselineLabel: string;
  readonly currentFingerprint: string;
  readonly regressions: readonly PerformanceRegression[];
  readonly improvements: readonly PerformanceRegression[];
  readonly unchanged: readonly PerformanceRegression[];
}

export interface PerformanceRuntimeSnapshot {
  readonly report: PerformanceReadinessReport;
  readonly baseline: PerformanceBaseline | null;
  readonly comparison: PerformanceBaselineComparison | null;
}

export interface PerformanceRuntime {
  readonly recordVital: (measurement: WebVitalMeasurement) => void;
  readonly capture: () => PerformanceRuntimeSnapshot;
  readonly setBaseline: (baseline: PerformanceBaseline | null) => void;
  readonly getBaseline: () => PerformanceBaseline | null;
  readonly getLastSnapshot: () => PerformanceRuntimeSnapshot | null;
  readonly reset: () => void;
}

export interface PerformanceLifecycleHandle {
  readonly dispose: () => void;
  readonly capture: () => PerformanceRuntimeSnapshot;
}

export interface ResourceTimingDependencies {
  readonly performanceRef?: Pick<Performance, 'getEntriesByType'> | null;
  readonly locationOrigin?: string | null;
}

export interface LongTaskDependencies {
  readonly performanceRef?: Pick<Performance, 'getEntriesByType'> | null;
}

export interface PerformanceRuntimeDependencies extends ResourceTimingDependencies, LongTaskDependencies {
  readonly monitor?: {
    readonly start: () => boolean;
    readonly snapshot: () => PerformanceSnapshot;
    readonly reset: () => void;
  };
  readonly now?: () => number;
  readonly budget?: PartialPerformanceBudget;
}

export interface PerformanceLifecycleDependencies {
  readonly documentRef?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  readonly windowRef?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends Readonly<Record<string, unknown>>
    ? DeepPartial<T[K]>
    : T[K];
};

export type PartialPerformanceBudget = DeepPartial<PerformanceBudget>;
