import type {
  ServiceContainerErrorCode,
  ServiceContainerSnapshot,
  ServiceRuntimeSnapshot,
} from './serviceContainer';

export type ServiceContainerHealthStatus = 'healthy' | 'degraded' | 'critical';

export type ServiceContainerRiskCode =
  | 'invalid-graph'
  | 'container-failed'
  | 'required-service-failure'
  | 'optional-service-failure'
  | 'startup-timeout'
  | 'stop-failure'
  | 'slow-start'
  | 'slow-stop'
  | 'observer-failure'
  | 'registration-rejection';

export interface ServiceContainerHealthPolicy {
  readonly optionalFailureWarningCount: number;
  readonly optionalFailureCriticalCount: number;
  readonly stopFailureWarningCount: number;
  readonly stopFailureCriticalCount: number;
  readonly slowStartWarningCount: number;
  readonly slowStartCriticalCount: number;
  readonly slowStopWarningCount: number;
  readonly slowStopCriticalCount: number;
  readonly observerFailureWarningCount: number;
  readonly observerFailureCriticalCount: number;
  readonly rejectionWarningCount: number;
  readonly rejectionCriticalCount: number;
  readonly slowStartMs: number;
  readonly slowStopMs: number;
  readonly maxRiskEntries: number;
}

export interface ServiceContainerHealthRisk {
  readonly code: ServiceContainerRiskCode;
  readonly status: Exclude<ServiceContainerHealthStatus, 'healthy'>;
  readonly count: number;
  readonly threshold: number;
  readonly affectedServices: number;
}

export interface ServiceContainerHealthSummary {
  readonly status: ServiceContainerHealthStatus;
  readonly containerState: ServiceContainerSnapshot['state'];
  readonly graphValid: boolean;
  readonly totalServices: number;
  readonly readyServices: number;
  readonly failedServices: number;
  readonly requiredFailures: number;
  readonly optionalFailures: number;
  readonly startTimeouts: number;
  readonly stopFailures: number;
  readonly slowStarts: number;
  readonly slowStops: number;
  readonly observerFailures: number;
  readonly registrationRejections: number;
  readonly risks: readonly ServiceContainerHealthRisk[];
}

export interface ServiceContainerHealthSample extends ServiceContainerHealthSummary {
  readonly sequence: number;
  readonly sampledAt: number;
  readonly fingerprint: string;
}

export interface ServiceContainerHealthMonitorOptions {
  readonly policy?: Partial<ServiceContainerHealthPolicy>;
  readonly historyLimit?: number;
  readonly now?: () => number;
}

export interface ServiceContainerHealthMonitorSnapshot {
  readonly samples: number;
  readonly current: ServiceContainerHealthSample | null;
  readonly history: readonly ServiceContainerHealthSample[];
}

export interface ServiceContainerHealthMonitor {
  readonly sample: (snapshot: ServiceContainerSnapshot) => ServiceContainerHealthSample;
  readonly snapshot: () => ServiceContainerHealthMonitorSnapshot;
  readonly reset: () => void;
}

const DEFAULT_POLICY: ServiceContainerHealthPolicy = Object.freeze({
  optionalFailureWarningCount: 1,
  optionalFailureCriticalCount: 4,
  stopFailureWarningCount: 1,
  stopFailureCriticalCount: 3,
  slowStartWarningCount: 2,
  slowStartCriticalCount: 6,
  slowStopWarningCount: 2,
  slowStopCriticalCount: 6,
  observerFailureWarningCount: 1,
  observerFailureCriticalCount: 5,
  rejectionWarningCount: 2,
  rejectionCriticalCount: 10,
  slowStartMs: 1_500,
  slowStopMs: 1_500,
  maxRiskEntries: 16,
});

const integer = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const validatePair = (
  name: string,
  warning: number,
  critical: number,
): void => {
  if (critical < warning) {
    throw new RangeError(name + ' critical threshold cannot be below warning threshold');
  }
};

const createPolicy = (
  overrides: Partial<ServiceContainerHealthPolicy> = {},
): ServiceContainerHealthPolicy => {
  const policy = Object.freeze({
    optionalFailureWarningCount: integer(
      'optionalFailureWarningCount',
      overrides.optionalFailureWarningCount ?? DEFAULT_POLICY.optionalFailureWarningCount,
      1,
      10_000,
    ),
    optionalFailureCriticalCount: integer(
      'optionalFailureCriticalCount',
      overrides.optionalFailureCriticalCount ?? DEFAULT_POLICY.optionalFailureCriticalCount,
      1,
      10_000,
    ),
    stopFailureWarningCount: integer(
      'stopFailureWarningCount',
      overrides.stopFailureWarningCount ?? DEFAULT_POLICY.stopFailureWarningCount,
      1,
      10_000,
    ),
    stopFailureCriticalCount: integer(
      'stopFailureCriticalCount',
      overrides.stopFailureCriticalCount ?? DEFAULT_POLICY.stopFailureCriticalCount,
      1,
      10_000,
    ),
    slowStartWarningCount: integer(
      'slowStartWarningCount',
      overrides.slowStartWarningCount ?? DEFAULT_POLICY.slowStartWarningCount,
      1,
      10_000,
    ),
    slowStartCriticalCount: integer(
      'slowStartCriticalCount',
      overrides.slowStartCriticalCount ?? DEFAULT_POLICY.slowStartCriticalCount,
      1,
      10_000,
    ),
    slowStopWarningCount: integer(
      'slowStopWarningCount',
      overrides.slowStopWarningCount ?? DEFAULT_POLICY.slowStopWarningCount,
      1,
      10_000,
    ),
    slowStopCriticalCount: integer(
      'slowStopCriticalCount',
      overrides.slowStopCriticalCount ?? DEFAULT_POLICY.slowStopCriticalCount,
      1,
      10_000,
    ),
    observerFailureWarningCount: integer(
      'observerFailureWarningCount',
      overrides.observerFailureWarningCount ?? DEFAULT_POLICY.observerFailureWarningCount,
      1,
      100_000,
    ),
    observerFailureCriticalCount: integer(
      'observerFailureCriticalCount',
      overrides.observerFailureCriticalCount ?? DEFAULT_POLICY.observerFailureCriticalCount,
      1,
      100_000,
    ),
    rejectionWarningCount: integer(
      'rejectionWarningCount',
      overrides.rejectionWarningCount ?? DEFAULT_POLICY.rejectionWarningCount,
      1,
      100_000,
    ),
    rejectionCriticalCount: integer(
      'rejectionCriticalCount',
      overrides.rejectionCriticalCount ?? DEFAULT_POLICY.rejectionCriticalCount,
      1,
      100_000,
    ),
    slowStartMs: integer(
      'slowStartMs',
      overrides.slowStartMs ?? DEFAULT_POLICY.slowStartMs,
      1,
      10 * 60_000,
    ),
    slowStopMs: integer(
      'slowStopMs',
      overrides.slowStopMs ?? DEFAULT_POLICY.slowStopMs,
      1,
      10 * 60_000,
    ),
    maxRiskEntries: integer(
      'maxRiskEntries',
      overrides.maxRiskEntries ?? DEFAULT_POLICY.maxRiskEntries,
      1,
      128,
    ),
  });

  validatePair(
    'optional failure',
    policy.optionalFailureWarningCount,
    policy.optionalFailureCriticalCount,
  );
  validatePair(
    'stop failure',
    policy.stopFailureWarningCount,
    policy.stopFailureCriticalCount,
  );
  validatePair(
    'slow start',
    policy.slowStartWarningCount,
    policy.slowStartCriticalCount,
  );
  validatePair(
    'slow stop',
    policy.slowStopWarningCount,
    policy.slowStopCriticalCount,
  );
  validatePair(
    'observer failure',
    policy.observerFailureWarningCount,
    policy.observerFailureCriticalCount,
  );
  validatePair(
    'registration rejection',
    policy.rejectionWarningCount,
    policy.rejectionCriticalCount,
  );
  return policy;
};

const rank: Readonly<Record<ServiceContainerHealthStatus, number>> = Object.freeze({
  healthy: 0,
  degraded: 1,
  critical: 2,
});

const stronger = (
  left: ServiceContainerHealthStatus,
  right: ServiceContainerHealthStatus,
): ServiceContainerHealthStatus =>
  rank[right] > rank[left] ? right : left;

const thresholdStatus = (
  count: number,
  warning: number,
  critical: number,
): ServiceContainerHealthStatus => {
  if (count >= critical) return 'critical';
  if (count >= warning) return 'degraded';
  return 'healthy';
};

const thresholdRisk = (
  code: ServiceContainerRiskCode,
  count: number,
  warning: number,
  critical: number,
  affectedServices = count,
): ServiceContainerHealthRisk | null => {
  const status = thresholdStatus(count, warning, critical);
  if (status === 'healthy') return null;
  return Object.freeze({
    code,
    status,
    count,
    threshold: status === 'critical' ? critical : warning,
    affectedServices,
  });
};

const criticalRisk = (
  code: ServiceContainerRiskCode,
  count: number,
  affectedServices = count,
): ServiceContainerHealthRisk | null =>
  count <= 0
    ? null
    : Object.freeze({
      code,
      status: 'critical' as const,
      count,
      threshold: 1,
      affectedServices,
    });

const countFailures = (
  services: readonly ServiceRuntimeSnapshot[],
  criticality: 'required' | 'optional',
): number => services.reduce(
  (total, service) =>
    total + (service.status === 'failed' && service.criticality === criticality ? 1 : 0),
  0,
);

const countFailureCode = (
  services: readonly ServiceRuntimeSnapshot[],
  code: ServiceContainerErrorCode,
): number => services.reduce(
  (total, service) => total + (service.failureCode === code ? 1 : 0),
  0,
);

const countSlow = (
  services: readonly ServiceRuntimeSnapshot[],
  key: 'startDurationMs' | 'stopDurationMs',
  threshold: number,
): number => services.reduce(
  (total, service) => {
    const value = service[key];
    return total + (value !== undefined && value >= threshold ? 1 : 0);
  },
  0,
);

const sortRisks = (
  risks: readonly ServiceContainerHealthRisk[],
  maximum: number,
): readonly ServiceContainerHealthRisk[] => Object.freeze(
  [...risks]
    .sort((left, right) =>
      rank[right.status] - rank[left.status]
      || right.count - left.count
      || left.code.localeCompare(right.code))
    .slice(0, maximum),
);

export const evaluateServiceContainerHealth = (
  snapshot: ServiceContainerSnapshot,
  overrides: Partial<ServiceContainerHealthPolicy> = {},
): ServiceContainerHealthSummary => {
  const policy = createPolicy(overrides);
  const services = snapshot.services;
  const readyServices = services.reduce(
    (total, service) => total + (service.status === 'ready' ? 1 : 0),
    0,
  );
  const failedServices = services.reduce(
    (total, service) => total + (service.status === 'failed' ? 1 : 0),
    0,
  );
  const requiredFailures = countFailures(services, 'required');
  const optionalFailures = countFailures(services, 'optional');
  const startTimeouts = countFailureCode(services, 'START_TIMEOUT');
  const stopFailures = services.reduce(
    (total, service) =>
      total + (
        service.failureCode === 'STOP_FAILED'
        || service.failureCode === 'STOP_TIMEOUT'
          ? 1
          : 0
      ),
    0,
  );
  const slowStarts = countSlow(services, 'startDurationMs', policy.slowStartMs);
  const slowStops = countSlow(services, 'stopDurationMs', policy.slowStopMs);

  const risks = [
    snapshot.graph.valid
      ? null
      : criticalRisk('invalid-graph', snapshot.graph.issues.length, snapshot.graph.serviceCount),
    snapshot.state === 'failed'
      ? criticalRisk('container-failed', 1, failedServices)
      : null,
    criticalRisk('required-service-failure', requiredFailures),
    criticalRisk('startup-timeout', startTimeouts),
    thresholdRisk(
      'optional-service-failure',
      optionalFailures,
      policy.optionalFailureWarningCount,
      policy.optionalFailureCriticalCount,
    ),
    thresholdRisk(
      'stop-failure',
      stopFailures,
      policy.stopFailureWarningCount,
      policy.stopFailureCriticalCount,
    ),
    thresholdRisk(
      'slow-start',
      slowStarts,
      policy.slowStartWarningCount,
      policy.slowStartCriticalCount,
    ),
    thresholdRisk(
      'slow-stop',
      slowStops,
      policy.slowStopWarningCount,
      policy.slowStopCriticalCount,
    ),
    thresholdRisk(
      'observer-failure',
      snapshot.counters.observerFailures,
      policy.observerFailureWarningCount,
      policy.observerFailureCriticalCount,
      0,
    ),
    thresholdRisk(
      'registration-rejection',
      snapshot.counters.rejected,
      policy.rejectionWarningCount,
      policy.rejectionCriticalCount,
      0,
    ),
  ].filter((risk): risk is ServiceContainerHealthRisk => risk !== null);

  const sortedRisks = sortRisks(risks, policy.maxRiskEntries);
  const status = sortedRisks.reduce<ServiceContainerHealthStatus>(
    (current, risk) => stronger(current, risk.status),
    'healthy',
  );

  return Object.freeze({
    status,
    containerState: snapshot.state,
    graphValid: snapshot.graph.valid,
    totalServices: services.length,
    readyServices,
    failedServices,
    requiredFailures,
    optionalFailures,
    startTimeouts,
    stopFailures,
    slowStarts,
    slowStops,
    observerFailures: snapshot.counters.observerFailures,
    registrationRejections: snapshot.counters.rejected,
    risks: sortedRisks,
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

const sampleFingerprint = (
  summary: ServiceContainerHealthSummary,
): string => fnv1a([
  summary.status,
  summary.containerState,
  summary.graphValid ? 'valid' : 'invalid',
  summary.totalServices,
  summary.readyServices,
  summary.failedServices,
  summary.requiredFailures,
  summary.optionalFailures,
  summary.startTimeouts,
  summary.stopFailures,
  summary.slowStarts,
  summary.slowStops,
  summary.observerFailures,
  summary.registrationRejections,
  ...summary.risks.map((risk) =>
    [risk.code, risk.status, risk.count, risk.threshold, risk.affectedServices].join(':')),
].join('|'));

export const createServiceContainerHealthMonitor = (
  options: ServiceContainerHealthMonitorOptions = {},
): ServiceContainerHealthMonitor => {
  const policy = createPolicy(options.policy);
  const historyLimit = integer(
    'historyLimit',
    options.historyLimit ?? 64,
    0,
    1_024,
  );
  const now = options.now ?? Date.now;
  let sequence = 0;
  let lastObservedAt: number | undefined;
  let current: ServiceContainerHealthSample | null = null;
  const history: ServiceContainerHealthSample[] = [];

  const timestamp = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('service health clock returned an invalid timestamp');
    }
    if (lastObservedAt !== undefined && value < lastObservedAt) {
      throw new RangeError('service health clock must be monotonic');
    }
    lastObservedAt = value;
    return value;
  };

  const sample = (
    snapshot: ServiceContainerSnapshot,
  ): ServiceContainerHealthSample => {
    const summary = evaluateServiceContainerHealth(snapshot, policy);
    const next = Object.freeze({
      sequence: ++sequence,
      sampledAt: timestamp(),
      ...summary,
      risks: Object.freeze(summary.risks.map((risk) => Object.freeze({ ...risk }))),
      fingerprint: sampleFingerprint(summary),
    });
    current = next;
    if (historyLimit > 0) {
      history.push(next);
      const overflow = history.length - historyLimit;
      if (overflow > 0) history.splice(0, overflow);
    }
    return next;
  };

  const monitorSnapshot = (): ServiceContainerHealthMonitorSnapshot => Object.freeze({
    samples: sequence,
    current,
    history: Object.freeze(history.slice()),
  });

  const reset = (): void => {
    sequence = 0;
    lastObservedAt = undefined;
    current = null;
    history.splice(0, history.length);
  };

  return Object.freeze({
    sample,
    snapshot: monitorSnapshot,
    reset,
  });
};
