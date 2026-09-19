import type { BulkheadOptions } from './bulkhead';
import type { CircuitBreakerOptions } from './circuitBreaker';
import type { FailureBudgetOptions } from './failureBudget';
import type { ResourceLeasePolicy } from './resourceLeaseRegistry';
import type { RetryPolicyOptions } from './retryPolicy';
import type { StructuredTaskScopeOptions } from './structuredTaskScope';

export type RuntimePolicyProfileName = 'critical' | 'interactive' | 'background' | 'bulk';

export type BulkheadPolicyProfile = Required<Omit<BulkheadOptions, 'clock'>>;
export type CircuitBreakerPolicyProfile = Required<
  Omit<CircuitBreakerOptions, 'clock' | 'classifyFailure'>
>;
export type FailureBudgetPolicyProfile = Required<Omit<FailureBudgetOptions, 'clock'>>;
export type RetryPolicyProfile = Required<
  Omit<RetryPolicyOptions, 'retryable' | 'random' | 'clock' | 'sleep'>
>;
export type TaskScopePolicyProfile = Required<Omit<StructuredTaskScopeOptions, 'clock'>>;

export interface RuntimePolicyProfile {
  readonly name: RuntimePolicyProfileName;
  readonly version: 1;
  readonly bulkhead: BulkheadPolicyProfile;
  readonly circuitBreaker: CircuitBreakerPolicyProfile;
  readonly failureBudget: FailureBudgetPolicyProfile;
  readonly retry: RetryPolicyProfile;
  readonly resourceLeases: ResourceLeasePolicy;
  readonly taskScope: TaskScopePolicyProfile;
}

export interface RuntimePolicyProfileOverrides {
  readonly bulkhead?: Partial<BulkheadPolicyProfile>;
  readonly circuitBreaker?: Partial<CircuitBreakerPolicyProfile>;
  readonly failureBudget?: Partial<FailureBudgetPolicyProfile>;
  readonly retry?: Partial<RetryPolicyProfile>;
  readonly resourceLeases?: Partial<ResourceLeasePolicy>;
  readonly taskScope?: Partial<TaskScopePolicyProfile>;
}

export interface RuntimePolicyCapacitySummary {
  readonly profile: RuntimePolicyProfileName;
  readonly maxConcurrentWork: number;
  readonly maxQueuedWork: number;
  readonly maxOwnerConcurrentWork: number;
  readonly maxOwnerQueuedWork: number;
  readonly maxActiveLeases: number;
  readonly maxOwnerLeases: number;
  readonly maxScopedTasks: number;
  readonly maxScopedOwnerTasks: number;
  readonly maxChildScopes: number;
  readonly maxAttempts: number;
  readonly maxElapsedMs: number;
  readonly defaultTaskTimeoutMs: number;
  readonly maxTaskTimeoutMs: number;
}

const integer = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const finite = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const ratio = (name: string, value: number): number => finite(name, value, 0, 1);

const profileName = (value: string): RuntimePolicyProfileName => {
  if (
    value === 'critical'
    || value === 'interactive'
    || value === 'background'
    || value === 'bulk'
  ) {
    return value;
  }
  throw new RangeError('runtime policy profile name is invalid');
};

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const CRITICAL: RuntimePolicyProfile = freeze({
  name: 'critical',
  version: 1,
  bulkhead: freeze({
    maxConcurrent: 24,
    maxQueued: 192,
    maxConcurrentPerOwner: 8,
    maxQueuedPerOwner: 32,
    maxQueueWaitMs: 5_000,
    historyLimit: 128,
  }),
  circuitBreaker: freeze({
    failureThreshold: 8,
    recoveryTimeoutMs: 5_000,
    halfOpenMaxCalls: 4,
    successThreshold: 2,
    historyLimit: 128,
  }),
  failureBudget: freeze({
    windowMs: 60_000,
    bucketMs: 5_000,
    minimumSamples: 20,
    degradedFailureRatio: 0.25,
    exhaustedFailureRatio: 0.6,
    recoveryFailureRatio: 0.1,
    recoverySamples: 8,
    historyLimit: 128,
  }),
  retry: freeze({
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 750,
    maxElapsedMs: 4_000,
    backoffFactor: 2,
    jitterRatio: 0.1,
  }),
  resourceLeases: freeze({
    maxActiveLeases: 512,
    maxLeaseMs: 300_000,
    maxOwnerLeases: 64,
    historyLimit: 256,
  }),
  taskScope: freeze({
    maxActiveTasks: 256,
    maxOwnerTasks: 64,
    maxChildren: 64,
    historyLimit: 256,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 120_000,
  }),
});

const INTERACTIVE: RuntimePolicyProfile = freeze({
  name: 'interactive',
  version: 1,
  bulkhead: freeze({
    maxConcurrent: 12,
    maxQueued: 96,
    maxConcurrentPerOwner: 4,
    maxQueuedPerOwner: 16,
    maxQueueWaitMs: 3_000,
    historyLimit: 96,
  }),
  circuitBreaker: freeze({
    failureThreshold: 5,
    recoveryTimeoutMs: 10_000,
    halfOpenMaxCalls: 2,
    successThreshold: 1,
    historyLimit: 96,
  }),
  failureBudget: freeze({
    windowMs: 60_000,
    bucketMs: 5_000,
    minimumSamples: 12,
    degradedFailureRatio: 0.2,
    exhaustedFailureRatio: 0.5,
    recoveryFailureRatio: 0.08,
    recoverySamples: 5,
    historyLimit: 96,
  }),
  retry: freeze({
    maxAttempts: 3,
    baseDelayMs: 120,
    maxDelayMs: 1_200,
    maxElapsedMs: 5_000,
    backoffFactor: 2,
    jitterRatio: 0.15,
  }),
  resourceLeases: freeze({
    maxActiveLeases: 256,
    maxLeaseMs: 300_000,
    maxOwnerLeases: 32,
    historyLimit: 192,
  }),
  taskScope: freeze({
    maxActiveTasks: 128,
    maxOwnerTasks: 32,
    maxChildren: 32,
    historyLimit: 192,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 120_000,
  }),
});

const BACKGROUND: RuntimePolicyProfile = freeze({
  name: 'background',
  version: 1,
  bulkhead: freeze({
    maxConcurrent: 4,
    maxQueued: 48,
    maxConcurrentPerOwner: 2,
    maxQueuedPerOwner: 12,
    maxQueueWaitMs: 15_000,
    historyLimit: 64,
  }),
  circuitBreaker: freeze({
    failureThreshold: 4,
    recoveryTimeoutMs: 30_000,
    halfOpenMaxCalls: 1,
    successThreshold: 1,
    historyLimit: 64,
  }),
  failureBudget: freeze({
    windowMs: 120_000,
    bucketMs: 10_000,
    minimumSamples: 10,
    degradedFailureRatio: 0.15,
    exhaustedFailureRatio: 0.4,
    recoveryFailureRatio: 0.05,
    recoverySamples: 6,
    historyLimit: 64,
  }),
  retry: freeze({
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 5_000,
    maxElapsedMs: 20_000,
    backoffFactor: 2,
    jitterRatio: 0.2,
  }),
  resourceLeases: freeze({
    maxActiveLeases: 128,
    maxLeaseMs: 600_000,
    maxOwnerLeases: 16,
    historyLimit: 128,
  }),
  taskScope: freeze({
    maxActiveTasks: 64,
    maxOwnerTasks: 16,
    maxChildren: 16,
    historyLimit: 128,
    defaultTimeoutMs: 45_000,
    maxTimeoutMs: 300_000,
  }),
});

const BULK: RuntimePolicyProfile = freeze({
  name: 'bulk',
  version: 1,
  bulkhead: freeze({
    maxConcurrent: 2,
    maxQueued: 16,
    maxConcurrentPerOwner: 1,
    maxQueuedPerOwner: 4,
    maxQueueWaitMs: 30_000,
    historyLimit: 64,
  }),
  circuitBreaker: freeze({
    failureThreshold: 3,
    recoveryTimeoutMs: 45_000,
    halfOpenMaxCalls: 1,
    successThreshold: 1,
    historyLimit: 64,
  }),
  failureBudget: freeze({
    windowMs: 180_000,
    bucketMs: 15_000,
    minimumSamples: 6,
    degradedFailureRatio: 0.1,
    exhaustedFailureRatio: 0.35,
    recoveryFailureRatio: 0.03,
    recoverySamples: 4,
    historyLimit: 64,
  }),
  retry: freeze({
    maxAttempts: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    maxElapsedMs: 30_000,
    backoffFactor: 2,
    jitterRatio: 0.25,
  }),
  resourceLeases: freeze({
    maxActiveLeases: 64,
    maxLeaseMs: 900_000,
    maxOwnerLeases: 8,
    historyLimit: 96,
  }),
  taskScope: freeze({
    maxActiveTasks: 24,
    maxOwnerTasks: 8,
    maxChildren: 8,
    historyLimit: 96,
    defaultTimeoutMs: 90_000,
    maxTimeoutMs: 600_000,
  }),
});

const PRESETS: Readonly<Record<RuntimePolicyProfileName, RuntimePolicyProfile>> = freeze({
  critical: CRITICAL,
  interactive: INTERACTIVE,
  background: BACKGROUND,
  bulk: BULK,
});

const normalizeBulkhead = (
  base: BulkheadPolicyProfile,
  overrides: Partial<BulkheadPolicyProfile> = {},
): BulkheadPolicyProfile => {
  const maxConcurrent = integer(
    'bulkhead.maxConcurrent',
    overrides.maxConcurrent ?? base.maxConcurrent,
    1,
    256,
  );
  const maxQueued = integer(
    'bulkhead.maxQueued',
    overrides.maxQueued ?? base.maxQueued,
    0,
    10_000,
  );
  return freeze({
    maxConcurrent,
    maxQueued,
    maxConcurrentPerOwner: integer(
      'bulkhead.maxConcurrentPerOwner',
      overrides.maxConcurrentPerOwner ?? base.maxConcurrentPerOwner,
      1,
      maxConcurrent,
    ),
    maxQueuedPerOwner: integer(
      'bulkhead.maxQueuedPerOwner',
      overrides.maxQueuedPerOwner ?? base.maxQueuedPerOwner,
      0,
      maxQueued,
    ),
    maxQueueWaitMs: integer(
      'bulkhead.maxQueueWaitMs',
      overrides.maxQueueWaitMs ?? base.maxQueueWaitMs,
      1,
      300_000,
    ),
    historyLimit: integer(
      'bulkhead.historyLimit',
      overrides.historyLimit ?? base.historyLimit,
      0,
      1_000,
    ),
  });
};

const normalizeCircuit = (
  base: CircuitBreakerPolicyProfile,
  overrides: Partial<CircuitBreakerPolicyProfile> = {},
): CircuitBreakerPolicyProfile => {
  const halfOpenMaxCalls = integer(
    'circuitBreaker.halfOpenMaxCalls',
    overrides.halfOpenMaxCalls ?? base.halfOpenMaxCalls,
    1,
    32,
  );
  return freeze({
    failureThreshold: integer(
      'circuitBreaker.failureThreshold',
      overrides.failureThreshold ?? base.failureThreshold,
      1,
      100,
    ),
    recoveryTimeoutMs: integer(
      'circuitBreaker.recoveryTimeoutMs',
      overrides.recoveryTimeoutMs ?? base.recoveryTimeoutMs,
      1,
      300_000,
    ),
    halfOpenMaxCalls,
    successThreshold: integer(
      'circuitBreaker.successThreshold',
      overrides.successThreshold ?? base.successThreshold,
      1,
      halfOpenMaxCalls,
    ),
    historyLimit: integer(
      'circuitBreaker.historyLimit',
      overrides.historyLimit ?? base.historyLimit,
      0,
      1_000,
    ),
  });
};

const normalizeFailureBudget = (
  base: FailureBudgetPolicyProfile,
  overrides: Partial<FailureBudgetPolicyProfile> = {},
): FailureBudgetPolicyProfile => {
  const windowMs = integer(
    'failureBudget.windowMs',
    overrides.windowMs ?? base.windowMs,
    1_000,
    3_600_000,
  );
  const bucketMs = integer(
    'failureBudget.bucketMs',
    overrides.bucketMs ?? base.bucketMs,
    100,
    windowMs,
  );
  if (windowMs % bucketMs !== 0) {
    throw new RangeError('failureBudget.windowMs must be divisible by bucketMs');
  }
  const degradedFailureRatio = ratio(
    'failureBudget.degradedFailureRatio',
    overrides.degradedFailureRatio ?? base.degradedFailureRatio,
  );
  const exhaustedFailureRatio = ratio(
    'failureBudget.exhaustedFailureRatio',
    overrides.exhaustedFailureRatio ?? base.exhaustedFailureRatio,
  );
  const recoveryFailureRatio = ratio(
    'failureBudget.recoveryFailureRatio',
    overrides.recoveryFailureRatio ?? base.recoveryFailureRatio,
  );
  if (recoveryFailureRatio >= degradedFailureRatio) {
    throw new RangeError(
      'failureBudget.recoveryFailureRatio must be lower than degradedFailureRatio',
    );
  }
  if (degradedFailureRatio >= exhaustedFailureRatio) {
    throw new RangeError(
      'failureBudget.degradedFailureRatio must be lower than exhaustedFailureRatio',
    );
  }
  return freeze({
    windowMs,
    bucketMs,
    minimumSamples: integer(
      'failureBudget.minimumSamples',
      overrides.minimumSamples ?? base.minimumSamples,
      1,
      100_000,
    ),
    degradedFailureRatio,
    exhaustedFailureRatio,
    recoveryFailureRatio,
    recoverySamples: integer(
      'failureBudget.recoverySamples',
      overrides.recoverySamples ?? base.recoverySamples,
      1,
      100_000,
    ),
    historyLimit: integer(
      'failureBudget.historyLimit',
      overrides.historyLimit ?? base.historyLimit,
      0,
      1_000,
    ),
  });
};

const normalizeRetry = (
  base: RetryPolicyProfile,
  overrides: Partial<RetryPolicyProfile> = {},
): RetryPolicyProfile => {
  const baseDelayMs = integer(
    'retry.baseDelayMs',
    overrides.baseDelayMs ?? base.baseDelayMs,
    0,
    60_000,
  );
  const maxDelayMs = integer(
    'retry.maxDelayMs',
    overrides.maxDelayMs ?? base.maxDelayMs,
    0,
    120_000,
  );
  if (maxDelayMs < baseDelayMs) {
    throw new RangeError('retry.maxDelayMs must be greater than or equal to baseDelayMs');
  }
  return freeze({
    maxAttempts: integer(
      'retry.maxAttempts',
      overrides.maxAttempts ?? base.maxAttempts,
      1,
      10,
    ),
    baseDelayMs,
    maxDelayMs,
    maxElapsedMs: integer(
      'retry.maxElapsedMs',
      overrides.maxElapsedMs ?? base.maxElapsedMs,
      1,
      300_000,
    ),
    backoffFactor: finite(
      'retry.backoffFactor',
      overrides.backoffFactor ?? base.backoffFactor,
      1,
      10,
    ),
    jitterRatio: finite(
      'retry.jitterRatio',
      overrides.jitterRatio ?? base.jitterRatio,
      0,
      1,
    ),
  });
};

const normalizeLeases = (
  base: ResourceLeasePolicy,
  overrides: Partial<ResourceLeasePolicy> = {},
): ResourceLeasePolicy => {
  const maxActiveLeases = integer(
    'resourceLeases.maxActiveLeases',
    overrides.maxActiveLeases ?? base.maxActiveLeases,
    1,
    100_000,
  );
  return freeze({
    maxActiveLeases,
    maxLeaseMs: integer(
      'resourceLeases.maxLeaseMs',
      overrides.maxLeaseMs ?? base.maxLeaseMs,
      1,
      24 * 60 * 60_000,
    ),
    maxOwnerLeases: integer(
      'resourceLeases.maxOwnerLeases',
      overrides.maxOwnerLeases ?? base.maxOwnerLeases,
      1,
      maxActiveLeases,
    ),
    historyLimit: integer(
      'resourceLeases.historyLimit',
      overrides.historyLimit ?? base.historyLimit,
      1,
      10_000,
    ),
  });
};

const normalizeTaskScope = (
  base: TaskScopePolicyProfile,
  overrides: Partial<TaskScopePolicyProfile> = {},
): TaskScopePolicyProfile => {
  const maxActiveTasks = integer(
    'taskScope.maxActiveTasks',
    overrides.maxActiveTasks ?? base.maxActiveTasks,
    1,
    10_000,
  );
  const maxTimeoutMs = integer(
    'taskScope.maxTimeoutMs',
    overrides.maxTimeoutMs ?? base.maxTimeoutMs,
    1,
    30 * 60_000,
  );
  return freeze({
    maxActiveTasks,
    maxOwnerTasks: integer(
      'taskScope.maxOwnerTasks',
      overrides.maxOwnerTasks ?? base.maxOwnerTasks,
      1,
      maxActiveTasks,
    ),
    maxChildren: integer(
      'taskScope.maxChildren',
      overrides.maxChildren ?? base.maxChildren,
      1,
      1_000,
    ),
    historyLimit: integer(
      'taskScope.historyLimit',
      overrides.historyLimit ?? base.historyLimit,
      0,
      4_096,
    ),
    defaultTimeoutMs: integer(
      'taskScope.defaultTimeoutMs',
      overrides.defaultTimeoutMs ?? base.defaultTimeoutMs,
      1,
      maxTimeoutMs,
    ),
    maxTimeoutMs,
  });
};

const enforceCrossPolicyInvariants = (profile: RuntimePolicyProfile): void => {
  if (profile.bulkhead.maxConcurrent > profile.taskScope.maxActiveTasks) {
    throw new RangeError(
      'bulkhead.maxConcurrent must not exceed taskScope.maxActiveTasks',
    );
  }
  if (profile.bulkhead.maxConcurrentPerOwner > profile.taskScope.maxOwnerTasks) {
    throw new RangeError(
      'bulkhead.maxConcurrentPerOwner must not exceed taskScope.maxOwnerTasks',
    );
  }
  if (profile.retry.maxElapsedMs > profile.taskScope.maxTimeoutMs) {
    throw new RangeError(
      'retry.maxElapsedMs must not exceed taskScope.maxTimeoutMs',
    );
  }
  if (profile.resourceLeases.maxOwnerLeases > profile.resourceLeases.maxActiveLeases) {
    throw new RangeError(
      'resourceLeases.maxOwnerLeases must not exceed maxActiveLeases',
    );
  }
};

export const createRuntimePolicyProfile = (
  nameInput: RuntimePolicyProfileName | string,
  overrides: RuntimePolicyProfileOverrides = {},
): RuntimePolicyProfile => {
  const name = profileName(nameInput);
  const base = PRESETS[name];
  const profile: RuntimePolicyProfile = freeze({
    name,
    version: 1,
    bulkhead: normalizeBulkhead(base.bulkhead, overrides.bulkhead),
    circuitBreaker: normalizeCircuit(base.circuitBreaker, overrides.circuitBreaker),
    failureBudget: normalizeFailureBudget(base.failureBudget, overrides.failureBudget),
    retry: normalizeRetry(base.retry, overrides.retry),
    resourceLeases: normalizeLeases(base.resourceLeases, overrides.resourceLeases),
    taskScope: normalizeTaskScope(base.taskScope, overrides.taskScope),
  });
  enforceCrossPolicyInvariants(profile);
  return profile;
};

export const runtimePolicyCapacitySummary = (
  profile: RuntimePolicyProfile,
): RuntimePolicyCapacitySummary => freeze({
  profile: profile.name,
  maxConcurrentWork: profile.bulkhead.maxConcurrent,
  maxQueuedWork: profile.bulkhead.maxQueued,
  maxOwnerConcurrentWork: profile.bulkhead.maxConcurrentPerOwner,
  maxOwnerQueuedWork: profile.bulkhead.maxQueuedPerOwner,
  maxActiveLeases: profile.resourceLeases.maxActiveLeases,
  maxOwnerLeases: profile.resourceLeases.maxOwnerLeases,
  maxScopedTasks: profile.taskScope.maxActiveTasks,
  maxScopedOwnerTasks: profile.taskScope.maxOwnerTasks,
  maxChildScopes: profile.taskScope.maxChildren,
  maxAttempts: profile.retry.maxAttempts,
  maxElapsedMs: profile.retry.maxElapsedMs,
  defaultTaskTimeoutMs: profile.taskScope.defaultTimeoutMs,
  maxTaskTimeoutMs: profile.taskScope.maxTimeoutMs,
});

export const runtimePolicyPresetNames = (): readonly RuntimePolicyProfileName[] =>
  Object.freeze(['critical', 'interactive', 'background', 'bulk']);
