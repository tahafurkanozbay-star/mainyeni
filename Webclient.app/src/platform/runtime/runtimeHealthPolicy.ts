import type { RuntimeHealthEvent, RuntimeHealthSeverity, RuntimeHealthSummary } from './runtimeHealthJournal';

export type RuntimeHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'critical';

export interface RuntimeHealthPolicy {
  readonly degradedFailureRate: number;
  readonly unhealthyFailureRate: number;
  readonly criticalFailureRate: number;
  readonly degradedP95LatencyMs: number;
  readonly unhealthyP95LatencyMs: number;
  readonly criticalP95LatencyMs: number;
  readonly minimumSamples: number;
  readonly recoverySamples: number;
  readonly maxReasons: number;
}

export interface RuntimeHealthAssessment {
  readonly state: RuntimeHealthState;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly assessedAt: number;
  readonly failureRate: number;
  readonly p95LatencyMs: number | null;
  readonly retainedSamples: number;
}

export interface RuntimeHealthTransition {
  readonly previous: RuntimeHealthState;
  readonly current: RuntimeHealthState;
  readonly changed: boolean;
  readonly assessment: RuntimeHealthAssessment;
}

export interface RuntimeHealthPolicyEngine {
  readonly assess: (summary: RuntimeHealthSummary, at?: number) => RuntimeHealthTransition;
  readonly observe: (event: RuntimeHealthEvent, summary: RuntimeHealthSummary) => RuntimeHealthTransition;
  readonly snapshot: () => RuntimeHealthAssessment;
  readonly reset: () => void;
  readonly dispose: () => void;
}

const DEFAULT_POLICY: RuntimeHealthPolicy = Object.freeze({
  degradedFailureRate: 0.05,
  unhealthyFailureRate: 0.15,
  criticalFailureRate: 0.35,
  degradedP95LatencyMs: 1_500,
  unhealthyP95LatencyMs: 4_000,
  criticalP95LatencyMs: 10_000,
  minimumSamples: 8,
  recoverySamples: 3,
  maxReasons: 6,
});

const clampRate = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
const positive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;
const positiveInt = (value: number, fallback: number): number => Math.max(1, Math.floor(positive(value, fallback)));

const normalizePolicy = (input: Partial<RuntimeHealthPolicy>): RuntimeHealthPolicy => {
  const degradedFailureRate = clampRate(input.degradedFailureRate ?? DEFAULT_POLICY.degradedFailureRate, DEFAULT_POLICY.degradedFailureRate);
  const unhealthyFailureRate = Math.max(degradedFailureRate, clampRate(input.unhealthyFailureRate ?? DEFAULT_POLICY.unhealthyFailureRate, DEFAULT_POLICY.unhealthyFailureRate));
  const criticalFailureRate = Math.max(unhealthyFailureRate, clampRate(input.criticalFailureRate ?? DEFAULT_POLICY.criticalFailureRate, DEFAULT_POLICY.criticalFailureRate));
  const degradedP95LatencyMs = positive(input.degradedP95LatencyMs ?? DEFAULT_POLICY.degradedP95LatencyMs, DEFAULT_POLICY.degradedP95LatencyMs);
  const unhealthyP95LatencyMs = Math.max(degradedP95LatencyMs, positive(input.unhealthyP95LatencyMs ?? DEFAULT_POLICY.unhealthyP95LatencyMs, DEFAULT_POLICY.unhealthyP95LatencyMs));
  const criticalP95LatencyMs = Math.max(unhealthyP95LatencyMs, positive(input.criticalP95LatencyMs ?? DEFAULT_POLICY.criticalP95LatencyMs, DEFAULT_POLICY.criticalP95LatencyMs));
  return Object.freeze({
    degradedFailureRate, unhealthyFailureRate, criticalFailureRate,
    degradedP95LatencyMs, unhealthyP95LatencyMs, criticalP95LatencyMs,
    minimumSamples: positiveInt(input.minimumSamples ?? DEFAULT_POLICY.minimumSamples, DEFAULT_POLICY.minimumSamples),
    recoverySamples: positiveInt(input.recoverySamples ?? DEFAULT_POLICY.recoverySamples, DEFAULT_POLICY.recoverySamples),
    maxReasons: positiveInt(input.maxReasons ?? DEFAULT_POLICY.maxReasons, DEFAULT_POLICY.maxReasons),
  });
};

const rank: Readonly<Record<RuntimeHealthState, number>> = Object.freeze({ healthy: 0, degraded: 1, unhealthy: 2, critical: 3 });
const stateForRank = (value: number): RuntimeHealthState => value >= 3 ? 'critical' : value >= 2 ? 'unhealthy' : value >= 1 ? 'degraded' : 'healthy';

const severityFloor = (severity: RuntimeHealthSeverity): RuntimeHealthState => {
  if (severity === 'critical') return 'critical';
  if (severity === 'error') return 'unhealthy';
  if (severity === 'warning') return 'degraded';
  return 'healthy';
};

export const createRuntimeHealthPolicyEngine = (
  options: Partial<RuntimeHealthPolicy> = {},
  now: () => number = Date.now,
): RuntimeHealthPolicyEngine => {
  const policy = normalizePolicy(options);
  let disposed = false;
  let current: RuntimeHealthState = 'healthy';
  let recoveryStreak = 0;
  let last: RuntimeHealthAssessment = Object.freeze({
    state: 'healthy', score: 100, reasons: Object.freeze([]), assessedAt: now(), failureRate: 0, p95LatencyMs: null, retainedSamples: 0,
  });

  const assertActive = (): void => { if (disposed) throw new Error('Runtime health policy engine is disposed.'); };

  const derive = (summary: RuntimeHealthSummary, at: number, floor: RuntimeHealthState = 'healthy'): RuntimeHealthAssessment => {
    const reasons: string[] = [];
    let desiredRank = rank[floor];
    const enoughSamples = summary.retained >= policy.minimumSamples;
    if (enoughSamples) {
      if (summary.failureRate >= policy.criticalFailureRate) { desiredRank = Math.max(desiredRank, 3); reasons.push('critical-failure-rate'); }
      else if (summary.failureRate >= policy.unhealthyFailureRate) { desiredRank = Math.max(desiredRank, 2); reasons.push('high-failure-rate'); }
      else if (summary.failureRate >= policy.degradedFailureRate) { desiredRank = Math.max(desiredRank, 1); reasons.push('elevated-failure-rate'); }
      const p95 = summary.p95LatencyMs;
      if (p95 !== null) {
        if (p95 >= policy.criticalP95LatencyMs) { desiredRank = Math.max(desiredRank, 3); reasons.push('critical-latency'); }
        else if (p95 >= policy.unhealthyP95LatencyMs) { desiredRank = Math.max(desiredRank, 2); reasons.push('high-latency'); }
        else if (p95 >= policy.degradedP95LatencyMs) { desiredRank = Math.max(desiredRank, 1); reasons.push('elevated-latency'); }
      }
    } else if (rank[floor] > 0) reasons.push('event-severity');

    const desired = stateForRank(desiredRank);
    if (rank[desired] < rank[current]) {
      recoveryStreak += 1;
      if (recoveryStreak < policy.recoverySamples) desiredRank = rank[current];
    } else {
      recoveryStreak = 0;
    }
    const state = stateForRank(desiredRank);
    const failurePenalty = Math.min(55, summary.failureRate * 100);
    const latencyRatio = summary.p95LatencyMs === null ? 0 : summary.p95LatencyMs / policy.criticalP95LatencyMs;
    const latencyPenalty = Math.min(35, latencyRatio * 35);
    const statePenalty = rank[state] * 5;
    return Object.freeze({
      state,
      score: Math.max(0, Math.round(100 - failurePenalty - latencyPenalty - statePenalty)),
      reasons: Object.freeze(reasons.slice(0, policy.maxReasons)),
      assessedAt: Number.isFinite(at) ? at : now(),
      failureRate: summary.failureRate,
      p95LatencyMs: summary.p95LatencyMs,
      retainedSamples: summary.retained,
    });
  };

  const commit = (assessment: RuntimeHealthAssessment): RuntimeHealthTransition => {
    const previous = current;
    current = assessment.state;
    last = assessment;
    return Object.freeze({ previous, current, changed: previous !== current, assessment });
  };

  const assess = (summary: RuntimeHealthSummary, at = now()): RuntimeHealthTransition => {
    assertActive();
    return commit(derive(summary, at));
  };

  const observe = (event: RuntimeHealthEvent, summary: RuntimeHealthSummary): RuntimeHealthTransition => {
    assertActive();
    return commit(derive(summary, event.at, severityFloor(event.severity)));
  };

  const snapshot = (): RuntimeHealthAssessment => { assertActive(); return last; };
  const reset = (): void => {
    assertActive(); current = 'healthy'; recoveryStreak = 0;
    last = Object.freeze({ state: 'healthy', score: 100, reasons: Object.freeze([]), assessedAt: now(), failureRate: 0, p95LatencyMs: null, retainedSamples: 0 });
  };
  const dispose = (): void => { disposed = true; recoveryStreak = 0; };
  return Object.freeze({ assess, observe, snapshot, reset, dispose });
};
