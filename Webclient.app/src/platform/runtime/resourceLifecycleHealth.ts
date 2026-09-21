import type {
  ResourceScopeRegistryEntry,
  ResourceScopeRegistrySnapshot,
  ResourceScopeRegistryStaleEntry,
} from './resourceScopeRegistry';

export type ResourceLifecycleHealthStatus = 'healthy' | 'degraded' | 'critical';

export type ResourceLifecycleRiskCode =
  | 'stale-scope'
  | 'stale-scope-pressure'
  | 'active-resource-pressure'
  | 'cleanup-failure'
  | 'cleanup-timeout'
  | 'observer-failure'
  | 'closing-scope'
  | 'registry-disposed-with-active-scopes';

export interface ResourceLifecycleHealthPolicy {
  readonly staleScopeWarningCount: number;
  readonly staleScopeCriticalCount: number;
  readonly activeResourceWarningCount: number;
  readonly activeResourceCriticalCount: number;
  readonly cleanupFailureWarningCount: number;
  readonly cleanupFailureCriticalCount: number;
  readonly cleanupTimeoutWarningCount: number;
  readonly cleanupTimeoutCriticalCount: number;
  readonly observerFailureWarningCount: number;
  readonly observerFailureCriticalCount: number;
  readonly maxRiskEntries: number;
}

export interface ResourceLifecycleRisk {
  readonly code: ResourceLifecycleRiskCode;
  readonly status: Exclude<ResourceLifecycleHealthStatus, 'healthy'>;
  readonly count: number;
  readonly threshold: number;
  readonly scopeCount: number;
}

export interface ResourceLifecycleHealthSummary {
  readonly status: ResourceLifecycleHealthStatus;
  readonly activeScopes: number;
  readonly activeOwners: number;
  readonly activeResources: number;
  readonly childScopes: number;
  readonly staleScopes: number;
  readonly closingScopes: number;
  readonly failedCleanups: number;
  readonly timedOutCleanups: number;
  readonly observerFailures: number;
  readonly registryCleanupFailures: number;
  readonly disposed: boolean;
  readonly risks: readonly ResourceLifecycleRisk[];
}

export interface ResourceLifecycleHealthSample extends ResourceLifecycleHealthSummary {
  readonly sequence: number;
  readonly sampledAt: number;
}

export interface ResourceLifecycleHealthMonitorOptions {
  readonly policy?: Partial<ResourceLifecycleHealthPolicy>;
  readonly historyLimit?: number;
  readonly now?: () => number;
}

export interface ResourceLifecycleHealthMonitorSnapshot {
  readonly samples: number;
  readonly current: ResourceLifecycleHealthSample | null;
  readonly history: readonly ResourceLifecycleHealthSample[];
}

export interface ResourceLifecycleHealthMonitor {
  readonly sample: (snapshot: ResourceScopeRegistrySnapshot) => ResourceLifecycleHealthSample;
  readonly snapshot: () => ResourceLifecycleHealthMonitorSnapshot;
  readonly reset: () => void;
}

const DEFAULT_POLICY: ResourceLifecycleHealthPolicy = Object.freeze({
  staleScopeWarningCount: 1,
  staleScopeCriticalCount: 4,
  activeResourceWarningCount: 128,
  activeResourceCriticalCount: 384,
  cleanupFailureWarningCount: 1,
  cleanupFailureCriticalCount: 5,
  cleanupTimeoutWarningCount: 1,
  cleanupTimeoutCriticalCount: 3,
  observerFailureWarningCount: 2,
  observerFailureCriticalCount: 10,
  maxRiskEntries: 16,
});

const integer = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
};

const validateThresholdPair = (
  name: string,
  warning: number,
  critical: number,
): void => {
  if (critical < warning) {
    throw new RangeError(name + ' critical threshold cannot be below warning threshold');
  }
};

const createPolicy = (
  overrides: Partial<ResourceLifecycleHealthPolicy> = {},
): ResourceLifecycleHealthPolicy => {
  const policy = Object.freeze({
    staleScopeWarningCount: integer(
      'staleScopeWarningCount',
      overrides.staleScopeWarningCount ?? DEFAULT_POLICY.staleScopeWarningCount,
      0,
      10_000,
    ),
    staleScopeCriticalCount: integer(
      'staleScopeCriticalCount',
      overrides.staleScopeCriticalCount ?? DEFAULT_POLICY.staleScopeCriticalCount,
      0,
      10_000,
    ),
    activeResourceWarningCount: integer(
      'activeResourceWarningCount',
      overrides.activeResourceWarningCount ?? DEFAULT_POLICY.activeResourceWarningCount,
      0,
      100_000,
    ),
    activeResourceCriticalCount: integer(
      'activeResourceCriticalCount',
      overrides.activeResourceCriticalCount ?? DEFAULT_POLICY.activeResourceCriticalCount,
      0,
      100_000,
    ),
    cleanupFailureWarningCount: integer(
      'cleanupFailureWarningCount',
      overrides.cleanupFailureWarningCount ?? DEFAULT_POLICY.cleanupFailureWarningCount,
      0,
      100_000,
    ),
    cleanupFailureCriticalCount: integer(
      'cleanupFailureCriticalCount',
      overrides.cleanupFailureCriticalCount ?? DEFAULT_POLICY.cleanupFailureCriticalCount,
      0,
      100_000,
    ),
    cleanupTimeoutWarningCount: integer(
      'cleanupTimeoutWarningCount',
      overrides.cleanupTimeoutWarningCount ?? DEFAULT_POLICY.cleanupTimeoutWarningCount,
      0,
      100_000,
    ),
    cleanupTimeoutCriticalCount: integer(
      'cleanupTimeoutCriticalCount',
      overrides.cleanupTimeoutCriticalCount ?? DEFAULT_POLICY.cleanupTimeoutCriticalCount,
      0,
      100_000,
    ),
    observerFailureWarningCount: integer(
      'observerFailureWarningCount',
      overrides.observerFailureWarningCount ?? DEFAULT_POLICY.observerFailureWarningCount,
      0,
      100_000,
    ),
    observerFailureCriticalCount: integer(
      'observerFailureCriticalCount',
      overrides.observerFailureCriticalCount ?? DEFAULT_POLICY.observerFailureCriticalCount,
      0,
      100_000,
    ),
    maxRiskEntries: integer(
      'maxRiskEntries',
      overrides.maxRiskEntries ?? DEFAULT_POLICY.maxRiskEntries,
      1,
      128,
    ),
  });

  validateThresholdPair(
    'stale scope',
    policy.staleScopeWarningCount,
    policy.staleScopeCriticalCount,
  );
  validateThresholdPair(
    'active resource',
    policy.activeResourceWarningCount,
    policy.activeResourceCriticalCount,
  );
  validateThresholdPair(
    'cleanup failure',
    policy.cleanupFailureWarningCount,
    policy.cleanupFailureCriticalCount,
  );
  validateThresholdPair(
    'cleanup timeout',
    policy.cleanupTimeoutWarningCount,
    policy.cleanupTimeoutCriticalCount,
  );
  validateThresholdPair(
    'observer failure',
    policy.observerFailureWarningCount,
    policy.observerFailureCriticalCount,
  );
  return policy;
};

const statusRank: Readonly<Record<ResourceLifecycleHealthStatus, number>> = Object.freeze({
  healthy: 0,
  degraded: 1,
  critical: 2,
});

const strongerStatus = (
  left: ResourceLifecycleHealthStatus,
  right: ResourceLifecycleHealthStatus,
): ResourceLifecycleHealthStatus =>
  statusRank[right] > statusRank[left] ? right : left;

const countResources = (entries: readonly ResourceScopeRegistryEntry[]): number =>
  entries.reduce((total, entry) => total + entry.scope.activeResources, 0);

const countChildren = (entries: readonly ResourceScopeRegistryEntry[]): number =>
  entries.reduce((total, entry) => total + entry.scope.childScopes, 0);

const countScopeCounter = (
  entries: readonly ResourceScopeRegistryEntry[],
  key: 'failed' | 'timedOut' | 'observerFailures',
): number => entries.reduce((total, entry) => total + entry.scope.counters[key], 0);

const countClosing = (entries: readonly ResourceScopeRegistryEntry[]): number =>
  entries.reduce(
    (total, entry) => total + (entry.scope.state === 'closing' ? 1 : 0),
    0,
  );

const scopeCountMatching = (
  entries: readonly ResourceScopeRegistryEntry[],
  predicate: (entry: ResourceScopeRegistryEntry) => boolean,
): number => entries.reduce((total, entry) => total + (predicate(entry) ? 1 : 0), 0);

const thresholdStatus = (
  count: number,
  warning: number,
  critical: number,
): ResourceLifecycleHealthStatus => {
  if (count >= critical && critical >= 0) return 'critical';
  if (count >= warning && warning >= 0) return 'degraded';
  return 'healthy';
};

const risk = (
  code: ResourceLifecycleRiskCode,
  count: number,
  warning: number,
  critical: number,
  scopeCount: number,
): ResourceLifecycleRisk | null => {
  const status = thresholdStatus(count, warning, critical);
  if (status === 'healthy') return null;
  return Object.freeze({
    code,
    status,
    count,
    threshold: status === 'critical' ? critical : warning,
    scopeCount,
  });
};

const riskPriority = (item: ResourceLifecycleRisk): number =>
  item.status === 'critical' ? 0 : 1;

const sortRisks = (
  risks: readonly ResourceLifecycleRisk[],
  maximum: number,
): readonly ResourceLifecycleRisk[] => Object.freeze(
  [...risks]
    .sort((left, right) =>
      riskPriority(left) - riskPriority(right)
      || right.count - left.count
      || left.code.localeCompare(right.code))
    .slice(0, maximum),
);

const disposedActiveRisk = (
  snapshot: ResourceScopeRegistrySnapshot,
): ResourceLifecycleRisk | null => {
  if (!snapshot.disposed || snapshot.activeScopes === 0) return null;
  return Object.freeze({
    code: 'registry-disposed-with-active-scopes',
    status: 'critical',
    count: snapshot.activeScopes,
    threshold: 0,
    scopeCount: snapshot.activeScopes,
  });
};

const closingRisk = (
  closingScopes: number,
): ResourceLifecycleRisk | null => {
  if (closingScopes === 0) return null;
  return Object.freeze({
    code: 'closing-scope',
    status: 'degraded',
    count: closingScopes,
    threshold: 1,
    scopeCount: closingScopes,
  });
};

export const evaluateResourceLifecycleHealth = (
  snapshot: ResourceScopeRegistrySnapshot,
  policyOverrides: Partial<ResourceLifecycleHealthPolicy> = {},
): ResourceLifecycleHealthSummary => {
  const policy = createPolicy(policyOverrides);
  const entries = snapshot.entries;
  const activeResources = countResources(entries);
  const childScopes = countChildren(entries);
  const failedCleanups = countScopeCounter(entries, 'failed');
  const timedOutCleanups = countScopeCounter(entries, 'timedOut');
  const observerFailures = countScopeCounter(entries, 'observerFailures');
  const closingScopes = countClosing(entries);

  const risks = [
    risk(
      'stale-scope',
      snapshot.staleScopes,
      policy.staleScopeWarningCount,
      policy.staleScopeCriticalCount,
      snapshot.staleScopes,
    ),
    risk(
      'active-resource-pressure',
      activeResources,
      policy.activeResourceWarningCount,
      policy.activeResourceCriticalCount,
      scopeCountMatching(entries, (entry) => entry.scope.activeResources > 0),
    ),
    risk(
      'cleanup-failure',
      failedCleanups + snapshot.cleanupFailures,
      policy.cleanupFailureWarningCount,
      policy.cleanupFailureCriticalCount,
      scopeCountMatching(entries, (entry) => entry.scope.counters.failed > 0),
    ),
    risk(
      'cleanup-timeout',
      timedOutCleanups,
      policy.cleanupTimeoutWarningCount,
      policy.cleanupTimeoutCriticalCount,
      scopeCountMatching(entries, (entry) => entry.scope.counters.timedOut > 0),
    ),
    risk(
      'observer-failure',
      observerFailures,
      policy.observerFailureWarningCount,
      policy.observerFailureCriticalCount,
      scopeCountMatching(entries, (entry) => entry.scope.counters.observerFailures > 0),
    ),
    closingRisk(closingScopes),
    disposedActiveRisk(snapshot),
  ].filter((item): item is ResourceLifecycleRisk => item !== null);

  if (
    snapshot.staleScopes >= policy.staleScopeCriticalCount
    && activeResources >= policy.activeResourceWarningCount
  ) {
    risks.push(Object.freeze({
      code: 'stale-scope-pressure',
      status: 'critical',
      count: snapshot.staleScopes,
      threshold: policy.staleScopeCriticalCount,
      scopeCount: snapshot.staleScopes,
    }));
  }

  const sortedRisks = sortRisks(risks, policy.maxRiskEntries);
  const status = sortedRisks.reduce<ResourceLifecycleHealthStatus>(
    (current, item) => strongerStatus(current, item.status),
    'healthy',
  );

  return Object.freeze({
    status,
    activeScopes: snapshot.activeScopes,
    activeOwners: snapshot.activeOwners,
    activeResources,
    childScopes,
    staleScopes: snapshot.staleScopes,
    closingScopes,
    failedCleanups,
    timedOutCleanups,
    observerFailures,
    registryCleanupFailures: snapshot.cleanupFailures,
    disposed: snapshot.disposed,
    risks: sortedRisks,
  });
};

const cloneSample = (
  summary: ResourceLifecycleHealthSummary,
  sequence: number,
  sampledAt: number,
): ResourceLifecycleHealthSample => Object.freeze({
  sequence,
  sampledAt,
  ...summary,
  risks: Object.freeze(summary.risks.map((item) => Object.freeze({ ...item }))),
});

export const createResourceLifecycleHealthMonitor = (
  options: ResourceLifecycleHealthMonitorOptions = {},
): ResourceLifecycleHealthMonitor => {
  const policy = createPolicy(options.policy);
  const historyLimit = integer('historyLimit', options.historyLimit ?? 64, 0, 1_024);
  const now = options.now ?? Date.now;
  let sequence = 0;
  let lastObservedAt: number | undefined;
  let current: ResourceLifecycleHealthSample | null = null;
  const history: ResourceLifecycleHealthSample[] = [];

  const timestamp = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('resource lifecycle health clock returned an invalid timestamp');
    }
    if (lastObservedAt !== undefined && value < lastObservedAt) {
      throw new RangeError('resource lifecycle health clock must be monotonic');
    }
    lastObservedAt = value;
    return value;
  };

  const sample = (
    snapshot: ResourceScopeRegistrySnapshot,
  ): ResourceLifecycleHealthSample => {
    const next = cloneSample(
      evaluateResourceLifecycleHealth(snapshot, policy),
      ++sequence,
      timestamp(),
    );
    current = next;
    if (historyLimit > 0) {
      history.push(next);
      const overflow = history.length - historyLimit;
      if (overflow > 0) history.splice(0, overflow);
    }
    return next;
  };

  const monitorSnapshot = (): ResourceLifecycleHealthMonitorSnapshot => Object.freeze({
    samples: sequence,
    current,
    history: Object.freeze(history.slice()),
  });

  const reset = (): void => {
    sequence = 0;
    current = null;
    history.splice(0, history.length);
    lastObservedAt = undefined;
  };

  return Object.freeze({
    sample,
    snapshot: monitorSnapshot,
    reset,
  });
};

export const lifecycleHealthFromStaleEntries = (
  entries: readonly ResourceScopeRegistryStaleEntry[],
): Readonly<{
  staleScopes: number;
  activeResources: number;
  childScopes: number;
  oldestAgeMs: number;
}> => {
  let activeResources = 0;
  let childScopes = 0;
  let oldestAgeMs = 0;
  for (const entry of entries) {
    activeResources += entry.activeResources;
    childScopes += entry.childScopes;
    oldestAgeMs = Math.max(oldestAgeMs, entry.ageMs);
  }
  return Object.freeze({
    staleScopes: entries.length,
    activeResources,
    childScopes,
    oldestAgeMs,
  });
};
