import type { MutationSafetyRuntimeSnapshot } from './mutationSafetyRuntime';

export type MutationSafetyHealthStatus = 'healthy' | 'degraded' | 'critical';

export type MutationSafetyRiskCode =
  | 'stale-in-flight'
  | 'entry-capacity-pressure'
  | 'in-flight-conflict'
  | 'retained-replay-conflict'
  | 'ambiguous-outcome-rate'
  | 'observer-failure'
  | 'disposed-with-active-mutation';

export interface MutationSafetyHealthRisk {
  readonly code: MutationSafetyRiskCode;
  readonly status: Exclude<MutationSafetyHealthStatus, 'healthy'>;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
}

export interface MutationSafetyHealthPolicy {
  readonly staleWarningCount: number;
  readonly staleCriticalCount: number;
  readonly capacityWarningRatio: number;
  readonly capacityCriticalRatio: number;
  readonly inFlightConflictWarningCount: number;
  readonly inFlightConflictCriticalCount: number;
  readonly replayConflictWarningCount: number;
  readonly replayConflictCriticalCount: number;
  readonly ambiguousOutcomeWarningRatio: number;
  readonly ambiguousOutcomeCriticalRatio: number;
  readonly minimumOutcomeSamples: number;
  readonly observerFailureWarningCount: number;
  readonly observerFailureCriticalCount: number;
  readonly maxRisks: number;
}

export interface MutationSafetyHealth {
  readonly status: MutationSafetyHealthStatus;
  readonly protectedExecutions: number;
  readonly inFlight: number;
  readonly retained: number;
  readonly staleInFlight: number;
  readonly entryCapacityRatio: number;
  readonly inFlightConflicts: number;
  readonly replayConflicts: number;
  readonly ambiguousOutcomes: number;
  readonly settledOutcomes: number;
  readonly ambiguousOutcomeRatio: number;
  readonly observerFailures: number;
  readonly disposed: boolean;
  readonly risks: readonly MutationSafetyHealthRisk[];
}

export interface MutationSafetyHealthSample extends MutationSafetyHealth {
  readonly sequence: number;
  readonly sampledAt: number;
}

export interface MutationSafetyHealthMonitorSnapshot {
  readonly samples: number;
  readonly current: MutationSafetyHealthSample | null;
  readonly history: readonly MutationSafetyHealthSample[];
}

export interface MutationSafetyHealthMonitorOptions {
  readonly policy?: Partial<MutationSafetyHealthPolicy>;
  readonly historyLimit?: number;
  readonly now?: () => number;
}

export interface MutationSafetyHealthMonitor {
  readonly sample: (snapshot: MutationSafetyRuntimeSnapshot) => MutationSafetyHealthSample;
  readonly snapshot: () => MutationSafetyHealthMonitorSnapshot;
  readonly reset: () => void;
}

const DEFAULT_POLICY: MutationSafetyHealthPolicy = Object.freeze({
  staleWarningCount: 1,
  staleCriticalCount: 3,
  capacityWarningRatio: 0.75,
  capacityCriticalRatio: 0.9,
  inFlightConflictWarningCount: 1,
  inFlightConflictCriticalCount: 5,
  replayConflictWarningCount: 3,
  replayConflictCriticalCount: 10,
  ambiguousOutcomeWarningRatio: 0.2,
  ambiguousOutcomeCriticalRatio: 0.5,
  minimumOutcomeSamples: 5,
  observerFailureWarningCount: 1,
  observerFailureCriticalCount: 3,
  maxRisks: 12,
});

const STATUS_WEIGHT: Readonly<Record<MutationSafetyHealthStatus, number>> = Object.freeze({
  healthy: 0,
  degraded: 1,
  critical: 2,
});

const finiteInteger = (
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return parsed;
};

const finiteRatio = (
  name: string,
  value: unknown,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError(name + ' must be a finite ratio between 0 and 1');
  }
  return parsed;
};

const normalizePolicy = (
  policy: Partial<MutationSafetyHealthPolicy> = {},
): MutationSafetyHealthPolicy => {
  const normalized: MutationSafetyHealthPolicy = Object.freeze({
    staleWarningCount: finiteInteger(
      'staleWarningCount',
      policy.staleWarningCount ?? DEFAULT_POLICY.staleWarningCount,
      0,
      1_000_000,
    ),
    staleCriticalCount: finiteInteger(
      'staleCriticalCount',
      policy.staleCriticalCount ?? DEFAULT_POLICY.staleCriticalCount,
      0,
      1_000_000,
    ),
    capacityWarningRatio: finiteRatio(
      'capacityWarningRatio',
      policy.capacityWarningRatio ?? DEFAULT_POLICY.capacityWarningRatio,
    ),
    capacityCriticalRatio: finiteRatio(
      'capacityCriticalRatio',
      policy.capacityCriticalRatio ?? DEFAULT_POLICY.capacityCriticalRatio,
    ),
    inFlightConflictWarningCount: finiteInteger(
      'inFlightConflictWarningCount',
      policy.inFlightConflictWarningCount ?? DEFAULT_POLICY.inFlightConflictWarningCount,
      0,
      1_000_000,
    ),
    inFlightConflictCriticalCount: finiteInteger(
      'inFlightConflictCriticalCount',
      policy.inFlightConflictCriticalCount ?? DEFAULT_POLICY.inFlightConflictCriticalCount,
      0,
      1_000_000,
    ),
    replayConflictWarningCount: finiteInteger(
      'replayConflictWarningCount',
      policy.replayConflictWarningCount ?? DEFAULT_POLICY.replayConflictWarningCount,
      0,
      1_000_000,
    ),
    replayConflictCriticalCount: finiteInteger(
      'replayConflictCriticalCount',
      policy.replayConflictCriticalCount ?? DEFAULT_POLICY.replayConflictCriticalCount,
      0,
      1_000_000,
    ),
    ambiguousOutcomeWarningRatio: finiteRatio(
      'ambiguousOutcomeWarningRatio',
      policy.ambiguousOutcomeWarningRatio ?? DEFAULT_POLICY.ambiguousOutcomeWarningRatio,
    ),
    ambiguousOutcomeCriticalRatio: finiteRatio(
      'ambiguousOutcomeCriticalRatio',
      policy.ambiguousOutcomeCriticalRatio ?? DEFAULT_POLICY.ambiguousOutcomeCriticalRatio,
    ),
    minimumOutcomeSamples: finiteInteger(
      'minimumOutcomeSamples',
      policy.minimumOutcomeSamples ?? DEFAULT_POLICY.minimumOutcomeSamples,
      0,
      1_000_000,
    ),
    observerFailureWarningCount: finiteInteger(
      'observerFailureWarningCount',
      policy.observerFailureWarningCount ?? DEFAULT_POLICY.observerFailureWarningCount,
      0,
      1_000_000,
    ),
    observerFailureCriticalCount: finiteInteger(
      'observerFailureCriticalCount',
      policy.observerFailureCriticalCount ?? DEFAULT_POLICY.observerFailureCriticalCount,
      0,
      1_000_000,
    ),
    maxRisks: finiteInteger(
      'maxRisks',
      policy.maxRisks ?? DEFAULT_POLICY.maxRisks,
      1,
      128,
    ),
  });

  const thresholdPairs: ReadonlyArray<readonly [number, number, string]> = [
    [normalized.staleWarningCount, normalized.staleCriticalCount, 'stale'],
    [
      normalized.inFlightConflictWarningCount,
      normalized.inFlightConflictCriticalCount,
      'inFlightConflict',
    ],
    [
      normalized.replayConflictWarningCount,
      normalized.replayConflictCriticalCount,
      'replayConflict',
    ],
    [
      normalized.observerFailureWarningCount,
      normalized.observerFailureCriticalCount,
      'observerFailure',
    ],
  ];
  for (const [warning, critical, name] of thresholdPairs) {
    if (critical < warning) {
      throw new RangeError(name + ' critical threshold must be >= warning threshold');
    }
  }
  if (normalized.capacityCriticalRatio < normalized.capacityWarningRatio) {
    throw new RangeError('capacity critical ratio must be >= warning ratio');
  }
  if (normalized.ambiguousOutcomeCriticalRatio < normalized.ambiguousOutcomeWarningRatio) {
    throw new RangeError('ambiguous outcome critical ratio must be >= warning ratio');
  }
  return normalized;
};

const pushThresholdRisk = (
  risks: MutationSafetyHealthRisk[],
  input: {
    readonly code: MutationSafetyRiskCode;
    readonly metric: string;
    readonly value: number;
    readonly warning: number;
    readonly critical: number;
  },
): void => {
  if (input.value >= input.critical) {
    risks.push(Object.freeze({
      code: input.code,
      status: 'critical',
      metric: input.metric,
      value: input.value,
      threshold: input.critical,
    }));
    return;
  }
  if (input.value >= input.warning) {
    risks.push(Object.freeze({
      code: input.code,
      status: 'degraded',
      metric: input.metric,
      value: input.value,
      threshold: input.warning,
    }));
  }
};

const highestStatus = (
  risks: readonly MutationSafetyHealthRisk[],
): MutationSafetyHealthStatus => {
  let status: MutationSafetyHealthStatus = 'healthy';
  for (const risk of risks) {
    if (STATUS_WEIGHT[risk.status] > STATUS_WEIGHT[status]) status = risk.status;
  }
  return status;
};

const boundedRatio = (numerator: number, denominator: number): number => {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
};

export const evaluateMutationSafetyHealth = (
  snapshot: MutationSafetyRuntimeSnapshot,
  policy: Partial<MutationSafetyHealthPolicy> = {},
): MutationSafetyHealth => {
  const normalized = normalizePolicy(policy);
  const registry = snapshot.registry;
  const entryCapacityRatio = boundedRatio(
    registry.entries,
    registry.limits.maxEntries,
  );
  const inFlightConflicts = registry.counters.inFlightConflicts;
  const replayConflicts = registry.counters.retainedConflicts;
  const ambiguousOutcomes = snapshot.failedExecutions + snapshot.cancelledExecutions;
  const settledOutcomes = snapshot.completedExecutions + ambiguousOutcomes;
  const ambiguousOutcomeRatio = boundedRatio(ambiguousOutcomes, settledOutcomes);
  const observerFailures =
    snapshot.observerFailures + registry.counters.observerFailures;

  const risks: MutationSafetyHealthRisk[] = [];

  pushThresholdRisk(risks, {
    code: 'stale-in-flight',
    metric: 'staleInFlight',
    value: registry.staleInFlight,
    warning: normalized.staleWarningCount,
    critical: normalized.staleCriticalCount,
  });
  pushThresholdRisk(risks, {
    code: 'entry-capacity-pressure',
    metric: 'entryCapacityRatio',
    value: entryCapacityRatio,
    warning: normalized.capacityWarningRatio,
    critical: normalized.capacityCriticalRatio,
  });
  pushThresholdRisk(risks, {
    code: 'in-flight-conflict',
    metric: 'inFlightConflicts',
    value: inFlightConflicts,
    warning: normalized.inFlightConflictWarningCount,
    critical: normalized.inFlightConflictCriticalCount,
  });
  pushThresholdRisk(risks, {
    code: 'retained-replay-conflict',
    metric: 'replayConflicts',
    value: replayConflicts,
    warning: normalized.replayConflictWarningCount,
    critical: normalized.replayConflictCriticalCount,
  });
  if (settledOutcomes >= normalized.minimumOutcomeSamples) {
    pushThresholdRisk(risks, {
      code: 'ambiguous-outcome-rate',
      metric: 'ambiguousOutcomeRatio',
      value: ambiguousOutcomeRatio,
      warning: normalized.ambiguousOutcomeWarningRatio,
      critical: normalized.ambiguousOutcomeCriticalRatio,
    });
  }
  pushThresholdRisk(risks, {
    code: 'observer-failure',
    metric: 'observerFailures',
    value: observerFailures,
    warning: normalized.observerFailureWarningCount,
    critical: normalized.observerFailureCriticalCount,
  });
  if (snapshot.disposed && registry.inFlight > 0) {
    risks.push(Object.freeze({
      code: 'disposed-with-active-mutation',
      status: 'critical',
      metric: 'inFlight',
      value: registry.inFlight,
      threshold: 0,
    }));
  }

  risks.sort((left, right) => {
    const severity = STATUS_WEIGHT[right.status] - STATUS_WEIGHT[left.status];
    if (severity !== 0) return severity;
    const pressure = right.value - left.value;
    if (pressure !== 0) return pressure;
    return left.code.localeCompare(right.code);
  });

  const retainedRisks = Object.freeze(risks.slice(0, normalized.maxRisks));
  return Object.freeze({
    status: highestStatus(retainedRisks),
    protectedExecutions: snapshot.protectedExecutions,
    inFlight: registry.inFlight,
    retained: registry.retained,
    staleInFlight: registry.staleInFlight,
    entryCapacityRatio,
    inFlightConflicts,
    replayConflicts,
    ambiguousOutcomes,
    settledOutcomes,
    ambiguousOutcomeRatio,
    observerFailures,
    disposed: snapshot.disposed,
    risks: retainedRisks,
  });
};

export const createMutationSafetyHealthMonitor = (
  options: MutationSafetyHealthMonitorOptions = {},
): MutationSafetyHealthMonitor => {
  const policy = normalizePolicy(options.policy);
  const historyLimit = finiteInteger(
    'historyLimit',
    options.historyLimit ?? 64,
    0,
    4_096,
  );
  const now = options.now ?? Date.now;
  const history: MutationSafetyHealthSample[] = [];
  let current: MutationSafetyHealthSample | null = null;
  let samples = 0;
  let lastSampledAt: number | undefined;

  const readNow = (): number => {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('health monitor clock returned an invalid timestamp');
    }
    if (lastSampledAt !== undefined && value < lastSampledAt) {
      throw new RangeError('health monitor clock must be monotonic');
    }
    lastSampledAt = value;
    return value;
  };

  return Object.freeze({
    sample: (snapshot: MutationSafetyRuntimeSnapshot): MutationSafetyHealthSample => {
      const sampledAt = readNow();
      const health = evaluateMutationSafetyHealth(snapshot, policy);
      const sample: MutationSafetyHealthSample = Object.freeze({
        ...health,
        sequence: ++samples,
        sampledAt,
      });
      current = sample;
      if (historyLimit > 0) {
        history.push(sample);
        const overflow = history.length - historyLimit;
        if (overflow > 0) history.splice(0, overflow);
      }
      return sample;
    },
    snapshot: (): MutationSafetyHealthMonitorSnapshot => Object.freeze({
      samples,
      current,
      history: Object.freeze(history.slice()),
    }),
    reset: (): void => {
      history.length = 0;
      current = null;
      samples = 0;
      lastSampledAt = undefined;
    },
  });
};
