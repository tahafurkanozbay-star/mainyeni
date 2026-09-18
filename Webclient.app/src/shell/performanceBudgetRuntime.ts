import type { SupportedWebVitalName, WebVitalSample } from '../observability/webVitalsRuntime';

export interface PerformanceBudget {
  readonly warning: number;
  readonly critical: number;
}

export type PerformanceBudgetMap = Readonly<Partial<Record<SupportedWebVitalName, PerformanceBudget>>>;
export type PerformanceBudgetStatus = 'good' | 'warning' | 'critical' | 'unbudgeted';

export interface PerformanceEvaluation {
  readonly metric: SupportedWebVitalName;
  readonly value: number;
  readonly status: PerformanceBudgetStatus;
  readonly warningThreshold: number | null;
  readonly criticalThreshold: number | null;
  readonly sampleId: string;
  readonly recordedAt: number;
}

export interface PerformanceBudgetSnapshot {
  readonly windowSize: number;
  readonly totalEvaluated: number;
  readonly evaluations: readonly PerformanceEvaluation[];
  readonly latestByMetric: Readonly<Partial<Record<SupportedWebVitalName, PerformanceEvaluation>>>;
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly unbudgetedCount: number;
  readonly healthy: boolean;
}

export interface PerformanceBudgetRuntime {
  readonly evaluate: (sample: WebVitalSample) => PerformanceEvaluation;
  readonly snapshot: () => PerformanceBudgetSnapshot;
  readonly clear: () => void;
}

const windowSizeOf = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(500, Math.max(5, Math.trunc(parsed)));
};

const threshold = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a finite non-negative number.`);
  }
  return parsed;
};

const normalizeBudgets = (input: PerformanceBudgetMap): PerformanceBudgetMap => {
  const output: Partial<Record<SupportedWebVitalName, PerformanceBudget>> = {};
  for (const [name, raw] of Object.entries(input) as [SupportedWebVitalName, PerformanceBudget][]) {
    if (!raw) continue;
    const warning = threshold(raw.warning, `${name} warning threshold`);
    const critical = threshold(raw.critical, `${name} critical threshold`);
    if (critical < warning) {
      throw new RangeError(`${name} critical threshold cannot be lower than warning threshold.`);
    }
    output[name] = Object.freeze({ warning, critical });
  }
  return Object.freeze(output);
};

export const createPerformanceBudgetRuntime = (
  options: {
    readonly budgets: PerformanceBudgetMap;
    readonly windowSize?: number;
  },
): PerformanceBudgetRuntime => {
  if (!options || !options.budgets) throw new TypeError('Performance budgets are required.');
  const budgets = normalizeBudgets(options.budgets);
  const windowSize = windowSizeOf(options.windowSize);
  let totalEvaluated = 0;
  let evaluations: PerformanceEvaluation[] = [];

  const evaluate = (sample: WebVitalSample): PerformanceEvaluation => {
    if (!sample || typeof sample.name !== 'string') throw new TypeError('Web Vital sample is required.');
    if (!Number.isFinite(sample.value)) throw new TypeError('Web Vital sample value must be finite.');
    const budget = budgets[sample.name];
    const status: PerformanceBudgetStatus = !budget
      ? 'unbudgeted'
      : sample.value >= budget.critical
        ? 'critical'
        : sample.value >= budget.warning
          ? 'warning'
          : 'good';

    const evaluation = Object.freeze({
      metric: sample.name,
      value: sample.value,
      status,
      warningThreshold: budget?.warning ?? null,
      criticalThreshold: budget?.critical ?? null,
      sampleId: sample.id,
      recordedAt: sample.recordedAt,
    });
    totalEvaluated += 1;
    evaluations = [...evaluations, evaluation];
    if (evaluations.length > windowSize) evaluations = evaluations.slice(-windowSize);
    return evaluation;
  };

  const snapshot = (): PerformanceBudgetSnapshot => {
    const latest: Partial<Record<SupportedWebVitalName, PerformanceEvaluation>> = {};
    for (const evaluation of evaluations) latest[evaluation.metric] = evaluation;
    const criticalCount = evaluations.filter((item) => item.status === 'critical').length;
    const warningCount = evaluations.filter((item) => item.status === 'warning').length;
    const unbudgetedCount = evaluations.filter((item) => item.status === 'unbudgeted').length;
    return Object.freeze({
      windowSize,
      totalEvaluated,
      evaluations: Object.freeze([...evaluations]),
      latestByMetric: Object.freeze(latest),
      criticalCount,
      warningCount,
      unbudgetedCount,
      healthy: criticalCount === 0,
    });
  };

  const clear = (): void => {
    totalEvaluated = 0;
    evaluations = [];
  };

  return Object.freeze({ evaluate, snapshot, clear });
};
