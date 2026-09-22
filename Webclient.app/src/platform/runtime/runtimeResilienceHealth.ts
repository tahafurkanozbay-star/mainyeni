import type {
  RuntimeResilienceLane,
  RuntimeResilienceSupervisorSnapshot,
} from './runtimeResilienceSupervisor';

export type RuntimeResilienceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'critical';

export type RuntimeResilienceHealthRiskCode =
  | 'shed-rate'
  | 'failure-rate'
  | 'timeout-rate'
  | 'active-saturation'
  | 'critical-errors'
  | 'interactive-errors'
  | 'background-errors'
  | 'critical-latency'
  | 'interactive-latency'
  | 'background-latency'
  | 'signal-rejections'
  | 'observer-failures';

export interface RuntimeResilienceHealthPolicy {
  readonly minimumCompleted: number;
  readonly minimumLaneSignals: number;
  readonly shedWarningRate: number;
  readonly shedCriticalRate: number;
  readonly failureWarningRate: number;
  readonly failureCriticalRate: number;
  readonly timeoutWarningRate: number;
  readonly timeoutCriticalRate: number;
  readonly activeWarningRatio: number;
  readonly activeCriticalRatio: number;
  readonly laneErrorWarningRate: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly laneErrorCriticalRate: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly laneLatencyWarningRatio: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly laneLatencyCriticalRatio: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly signalRejectionWarningCount: number;
  readonly signalRejectionCriticalCount: number;
  readonly observerFailureWarningCount: number;
  readonly observerFailureCriticalCount: number;
  readonly maxRisks: number;
  readonly recoverySamples: number;
  readonly historyLimit: number;
}

export interface RuntimeResilienceHealthRisk {
  readonly code: RuntimeResilienceHealthRiskCode;
  readonly status: Exclude<RuntimeResilienceHealthStatus, 'healthy'>;
  readonly value: number;
  readonly threshold: number;
  readonly lane?: RuntimeResilienceLane;
}

export interface RuntimeResilienceHealthSummary {
  readonly status: RuntimeResilienceHealthStatus;
  readonly score: number;
  readonly active: number;
  readonly activeCapacity: number;
  readonly activeRatio: number;
  readonly admissionAttempts: number;
  readonly shedRate: number;
  readonly completed: number;
  readonly failureRate: number;
  readonly timeoutRate: number;
  readonly risks: readonly RuntimeResilienceHealthRisk[];
  readonly supervisorFingerprint: string;
}

export interface RuntimeResilienceHealthSample
  extends RuntimeResilienceHealthSummary {
  readonly sequence: number;
  readonly sampledAt: number;
  readonly previousStatus: RuntimeResilienceHealthStatus;
  readonly changed: boolean;
  readonly recoveryStreak: number;
  readonly fingerprint: string;
}

export interface RuntimeResilienceHealthMonitorOptions {
  readonly policy?: Partial<RuntimeResilienceHealthPolicy>;
}

export interface RuntimeResilienceHealthMonitorSnapshot {
  readonly samples: number;
  readonly current: RuntimeResilienceHealthSample | null;
  readonly history: readonly RuntimeResilienceHealthSample[];
}

export interface RuntimeResilienceHealthMonitor {
  readonly sample: (
    snapshot: RuntimeResilienceSupervisorSnapshot,
    at: number,
  ) => RuntimeResilienceHealthSample;
  readonly snapshot: () => RuntimeResilienceHealthMonitorSnapshot;
  readonly reset: () => void;
}

const LANES: readonly RuntimeResilienceLane[] = Object.freeze([
  'critical',
  'interactive',
  'background',
]);

const DEFAULT_POLICY: RuntimeResilienceHealthPolicy = Object.freeze({
  minimumCompleted: 8,
  minimumLaneSignals: 6,
  shedWarningRate: 0.08,
  shedCriticalRate: 0.25,
  failureWarningRate: 0.08,
  failureCriticalRate: 0.25,
  timeoutWarningRate: 0.04,
  timeoutCriticalRate: 0.15,
  activeWarningRatio: 0.8,
  activeCriticalRatio: 0.98,
  laneErrorWarningRate: Object.freeze({
    critical: 0.12,
    interactive: 0.1,
    background: 0.08,
  }),
  laneErrorCriticalRate: Object.freeze({
    critical: 0.3,
    interactive: 0.25,
    background: 0.2,
  }),
  laneLatencyWarningRatio: Object.freeze({
    critical: 0.7,
    interactive: 0.7,
    background: 0.75,
  }),
  laneLatencyCriticalRatio: Object.freeze({
    critical: 1,
    interactive: 1,
    background: 1,
  }),
  signalRejectionWarningCount: 1,
  signalRejectionCriticalCount: 8,
  observerFailureWarningCount: 1,
  observerFailureCriticalCount: 5,
  maxRisks: 16,
  recoverySamples: 3,
  historyLimit: 64,
});

const STATUS_RANK: Readonly<Record<RuntimeResilienceHealthStatus, number>> =
  Object.freeze({
    healthy: 0,
    degraded: 1,
    critical: 2,
  });

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) {
    throw new RangeError(name + ' must be finite');
  }
  return value;
};

const rate = (value: number, name: string): number => {
  const normalized = finite(value, name);
  if (normalized < 0 || normalized > 1) {
    throw new RangeError(name + ' must be between 0 and 1');
  }
  return normalized;
};

const positiveInteger = (
  value: number,
  name: string,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      name + ' must be a positive safe integer <= ' + maximum,
    );
  }
  return value;
};

const laneRates = (
  source: Readonly<Record<RuntimeResilienceLane, number>>,
  name: string,
): Readonly<Record<RuntimeResilienceLane, number>> => Object.freeze({
  critical: rate(source.critical, name + '.critical'),
  interactive: rate(source.interactive, name + '.interactive'),
  background: rate(source.background, name + '.background'),
});

const normalizePolicy = (
  source: Partial<RuntimeResilienceHealthPolicy> = {},
): RuntimeResilienceHealthPolicy => {
  const shedWarningRate = rate(
    source.shedWarningRate ?? DEFAULT_POLICY.shedWarningRate,
    'shedWarningRate',
  );
  const shedCriticalRate = rate(
    source.shedCriticalRate ?? DEFAULT_POLICY.shedCriticalRate,
    'shedCriticalRate',
  );
  const failureWarningRate = rate(
    source.failureWarningRate ?? DEFAULT_POLICY.failureWarningRate,
    'failureWarningRate',
  );
  const failureCriticalRate = rate(
    source.failureCriticalRate ?? DEFAULT_POLICY.failureCriticalRate,
    'failureCriticalRate',
  );
  const timeoutWarningRate = rate(
    source.timeoutWarningRate ?? DEFAULT_POLICY.timeoutWarningRate,
    'timeoutWarningRate',
  );
  const timeoutCriticalRate = rate(
    source.timeoutCriticalRate ?? DEFAULT_POLICY.timeoutCriticalRate,
    'timeoutCriticalRate',
  );
  const activeWarningRatio = rate(
    source.activeWarningRatio ?? DEFAULT_POLICY.activeWarningRatio,
    'activeWarningRatio',
  );
  const activeCriticalRatio = rate(
    source.activeCriticalRatio ?? DEFAULT_POLICY.activeCriticalRatio,
    'activeCriticalRatio',
  );

  if (shedCriticalRate < shedWarningRate) {
    throw new RangeError('shedCriticalRate cannot be below shedWarningRate');
  }
  if (failureCriticalRate < failureWarningRate) {
    throw new RangeError(
      'failureCriticalRate cannot be below failureWarningRate',
    );
  }
  if (timeoutCriticalRate < timeoutWarningRate) {
    throw new RangeError(
      'timeoutCriticalRate cannot be below timeoutWarningRate',
    );
  }
  if (activeCriticalRatio < activeWarningRatio) {
    throw new RangeError(
      'activeCriticalRatio cannot be below activeWarningRatio',
    );
  }

  const laneErrorWarningRate = laneRates(
    source.laneErrorWarningRate ?? DEFAULT_POLICY.laneErrorWarningRate,
    'laneErrorWarningRate',
  );
  const laneErrorCriticalRate = laneRates(
    source.laneErrorCriticalRate ?? DEFAULT_POLICY.laneErrorCriticalRate,
    'laneErrorCriticalRate',
  );
  const laneLatencyWarningRatio = laneRates(
    source.laneLatencyWarningRatio ?? DEFAULT_POLICY.laneLatencyWarningRatio,
    'laneLatencyWarningRatio',
  );
  const laneLatencyCriticalRatio = laneRates(
    source.laneLatencyCriticalRatio ?? DEFAULT_POLICY.laneLatencyCriticalRatio,
    'laneLatencyCriticalRatio',
  );

  for (const lane of LANES) {
    if (laneErrorCriticalRate[lane] < laneErrorWarningRate[lane]) {
      throw new RangeError(
        'lane error critical threshold cannot be below warning threshold',
      );
    }
    if (laneLatencyCriticalRatio[lane] < laneLatencyWarningRatio[lane]) {
      throw new RangeError(
        'lane latency critical threshold cannot be below warning threshold',
      );
    }
  }

  return Object.freeze({
    minimumCompleted: positiveInteger(
      source.minimumCompleted ?? DEFAULT_POLICY.minimumCompleted,
      'minimumCompleted',
      100_000,
    ),
    minimumLaneSignals: positiveInteger(
      source.minimumLaneSignals ?? DEFAULT_POLICY.minimumLaneSignals,
      'minimumLaneSignals',
      100_000,
    ),
    shedWarningRate,
    shedCriticalRate,
    failureWarningRate,
    failureCriticalRate,
    timeoutWarningRate,
    timeoutCriticalRate,
    activeWarningRatio,
    activeCriticalRatio,
    laneErrorWarningRate,
    laneErrorCriticalRate,
    laneLatencyWarningRatio,
    laneLatencyCriticalRatio,
    signalRejectionWarningCount: positiveInteger(
      source.signalRejectionWarningCount
        ?? DEFAULT_POLICY.signalRejectionWarningCount,
      'signalRejectionWarningCount',
      1_000_000,
    ),
    signalRejectionCriticalCount: positiveInteger(
      source.signalRejectionCriticalCount
        ?? DEFAULT_POLICY.signalRejectionCriticalCount,
      'signalRejectionCriticalCount',
      1_000_000,
    ),
    observerFailureWarningCount: positiveInteger(
      source.observerFailureWarningCount
        ?? DEFAULT_POLICY.observerFailureWarningCount,
      'observerFailureWarningCount',
      1_000_000,
    ),
    observerFailureCriticalCount: positiveInteger(
      source.observerFailureCriticalCount
        ?? DEFAULT_POLICY.observerFailureCriticalCount,
      'observerFailureCriticalCount',
      1_000_000,
    ),
    maxRisks: positiveInteger(
      source.maxRisks ?? DEFAULT_POLICY.maxRisks,
      'maxRisks',
      128,
    ),
    recoverySamples: positiveInteger(
      source.recoverySamples ?? DEFAULT_POLICY.recoverySamples,
      'recoverySamples',
      128,
    ),
    historyLimit: positiveInteger(
      source.historyLimit ?? DEFAULT_POLICY.historyLimit,
      'historyLimit',
      2_048,
    ),
  });
};

const risk = (
  code: RuntimeResilienceHealthRiskCode,
  value: number,
  warning: number,
  critical: number,
  lane?: RuntimeResilienceLane,
): RuntimeResilienceHealthRisk | null => {
  if (value >= critical) {
    return Object.freeze({
      code,
      status: 'critical' as const,
      value,
      threshold: critical,
      ...(lane === undefined ? {} : { lane }),
    });
  }
  if (value >= warning) {
    return Object.freeze({
      code,
      status: 'degraded' as const,
      value,
      threshold: warning,
      ...(lane === undefined ? {} : { lane }),
    });
  }
  return null;
};

const laneRiskCode = (
  lane: RuntimeResilienceLane,
  kind: 'errors' | 'latency',
): RuntimeResilienceHealthRiskCode => {
  if (lane === 'critical') {
    return kind === 'errors' ? 'critical-errors' : 'critical-latency';
  }
  if (lane === 'interactive') {
    return kind === 'errors'
      ? 'interactive-errors'
      : 'interactive-latency';
  }
  return kind === 'errors' ? 'background-errors' : 'background-latency';
};

const sortRisks = (
  values: readonly RuntimeResilienceHealthRisk[],
  maximum: number,
): readonly RuntimeResilienceHealthRisk[] => Object.freeze(
  values
    .slice()
    .sort((left, right) =>
      STATUS_RANK[right.status] - STATUS_RANK[left.status]
      || right.value - left.value
      || left.code.localeCompare(right.code))
    .slice(0, maximum),
);

const statusFor = (
  risks: readonly RuntimeResilienceHealthRisk[],
): RuntimeResilienceHealthStatus => risks.reduce<RuntimeResilienceHealthStatus>(
  (current, item) =>
    STATUS_RANK[item.status] > STATUS_RANK[current]
      ? item.status
      : current,
  'healthy',
);

const safeRatio = (numerator: number, denominator: number): number =>
  denominator <= 0 ? 0 : numerator / denominator;

const activeCapacity = (
  snapshot: RuntimeResilienceSupervisorSnapshot,
): number => LANES.reduce(
  (total, lane) => total + snapshot.envelope[lane].maxInFlight,
  0,
);

const scoreFor = (
  status: RuntimeResilienceHealthStatus,
  shedRate: number,
  failureRate: number,
  timeoutRate: number,
  activeRatio: number,
): number => {
  const statusPenalty = STATUS_RANK[status] * 15;
  const trafficPenalty = Math.min(
    45,
    shedRate * 30
      + failureRate * 40
      + timeoutRate * 50
      + Math.max(0, activeRatio - 0.7) * 20,
  );
  return Math.max(0, Math.round(100 - statusPenalty - trafficPenalty));
};

export const evaluateRuntimeResilienceHealth = (
  snapshot: RuntimeResilienceSupervisorSnapshot,
  overrides: Partial<RuntimeResilienceHealthPolicy> = {},
): RuntimeResilienceHealthSummary => {
  const policy = normalizePolicy(overrides);
  const counters = snapshot.counters;
  const admissionAttempts = counters.admitted + counters.shed;
  const shedRate = safeRatio(counters.shed, admissionAttempts);
  const completed = counters.completed;
  const terminalFailures = counters.failed + counters.timedOut;
  const failureRate = safeRatio(terminalFailures, completed);
  const timeoutRate = safeRatio(counters.timedOut, completed);
  const capacity = activeCapacity(snapshot);
  const activeRatio = safeRatio(snapshot.active, capacity);
  const risks: RuntimeResilienceHealthRisk[] = [];

  const shedRisk = admissionAttempts >= policy.minimumCompleted
    ? risk(
      'shed-rate',
      shedRate,
      policy.shedWarningRate,
      policy.shedCriticalRate,
    )
    : null;
  if (shedRisk) risks.push(shedRisk);

  if (completed >= policy.minimumCompleted) {
    const failureRisk = risk(
      'failure-rate',
      failureRate,
      policy.failureWarningRate,
      policy.failureCriticalRate,
    );
    const timeoutRisk = risk(
      'timeout-rate',
      timeoutRate,
      policy.timeoutWarningRate,
      policy.timeoutCriticalRate,
    );
    if (failureRisk) risks.push(failureRisk);
    if (timeoutRisk) risks.push(timeoutRisk);
  }

  const activeRisk = risk(
    'active-saturation',
    activeRatio,
    policy.activeWarningRatio,
    policy.activeCriticalRatio,
  );
  if (activeRisk) risks.push(activeRisk);

  for (const lane of LANES) {
    const laneSignals = snapshot.signals.lanes[lane];
    if (laneSignals.count < policy.minimumLaneSignals) continue;
    const errorRisk = risk(
      laneRiskCode(lane, 'errors'),
      laneSignals.errorRate,
      policy.laneErrorWarningRate[lane],
      policy.laneErrorCriticalRate[lane],
      lane,
    );
    if (errorRisk) risks.push(errorRisk);

    const timeoutMs = snapshot.envelope[lane].timeoutMs;
    const latencyRatio = safeRatio(laneSignals.p95LatencyMs, timeoutMs);
    const latencyRisk = risk(
      laneRiskCode(lane, 'latency'),
      latencyRatio,
      policy.laneLatencyWarningRatio[lane],
      policy.laneLatencyCriticalRatio[lane],
      lane,
    );
    if (latencyRisk) risks.push(latencyRisk);
  }

  const signalRisk = risk(
    'signal-rejections',
    counters.signalRejected,
    policy.signalRejectionWarningCount,
    policy.signalRejectionCriticalCount,
  );
  if (signalRisk) risks.push(signalRisk);

  const observerRisk = risk(
    'observer-failures',
    counters.observerFailures,
    policy.observerFailureWarningCount,
    policy.observerFailureCriticalCount,
  );
  if (observerRisk) risks.push(observerRisk);

  const sorted = sortRisks(risks, policy.maxRisks);
  const status = statusFor(sorted);

  return Object.freeze({
    status,
    score: scoreFor(
      status,
      shedRate,
      failureRate,
      timeoutRate,
      activeRatio,
    ),
    active: snapshot.active,
    activeCapacity: capacity,
    activeRatio,
    admissionAttempts,
    shedRate,
    completed,
    failureRate,
    timeoutRate,
    risks: sorted,
    supervisorFingerprint: snapshot.fingerprint,
  });
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createRuntimeResilienceHealthMonitor = (
  options: RuntimeResilienceHealthMonitorOptions = {},
): RuntimeResilienceHealthMonitor => {
  const policy = normalizePolicy(options.policy);
  const history: RuntimeResilienceHealthSample[] = [];
  let sequence = 0;
  let current: RuntimeResilienceHealthSample | null = null;
  let currentStatus: RuntimeResilienceHealthStatus = 'healthy';
  let recoveryStreak = 0;
  let lastObservedAt: number | null = null;

  const sample = (
    snapshot: RuntimeResilienceSupervisorSnapshot,
    at: number,
  ): RuntimeResilienceHealthSample => {
    const sampledAt = finite(at, 'sampledAt');
    if (sampledAt < 0) {
      throw new RangeError('sampledAt must be non-negative');
    }
    if (lastObservedAt !== null && sampledAt < lastObservedAt) {
      throw new RangeError('health monitor clock must be monotonic');
    }
    lastObservedAt = sampledAt;

    const evaluated = evaluateRuntimeResilienceHealth(snapshot, policy);
    const previousStatus = currentStatus;
    let committedStatus = evaluated.status;

    if (
      STATUS_RANK[evaluated.status] < STATUS_RANK[currentStatus]
    ) {
      recoveryStreak += 1;
      if (recoveryStreak < policy.recoverySamples) {
        committedStatus = currentStatus;
      }
    } else {
      recoveryStreak = 0;
    }

    currentStatus = committedStatus;
    const changed = previousStatus !== committedStatus;
    const fingerprint = fnv1a([
      committedStatus,
      evaluated.score,
      evaluated.active,
      evaluated.activeCapacity,
      evaluated.admissionAttempts,
      evaluated.shedRate,
      evaluated.completed,
      evaluated.failureRate,
      evaluated.timeoutRate,
      evaluated.supervisorFingerprint,
      ...evaluated.risks.map((item) =>
        [
          item.code,
          item.status,
          item.value,
          item.threshold,
          item.lane ?? '',
        ].join(':')),
    ].join('|'));

    current = Object.freeze({
      ...evaluated,
      status: committedStatus,
      sequence: ++sequence,
      sampledAt,
      previousStatus,
      changed,
      recoveryStreak,
      fingerprint,
    });
    history.push(current);
    if (history.length > policy.historyLimit) {
      history.splice(0, history.length - policy.historyLimit);
    }
    return current;
  };

  const snapshot = (): RuntimeResilienceHealthMonitorSnapshot => Object.freeze({
    samples: sequence,
    current,
    history: Object.freeze(history.slice()),
  });

  const reset = (): void => {
    sequence = 0;
    current = null;
    currentStatus = 'healthy';
    recoveryStreak = 0;
    lastObservedAt = null;
    history.splice(0, history.length);
  };

  return Object.freeze({
    sample,
    snapshot,
    reset,
  });
};
