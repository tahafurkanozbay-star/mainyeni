import {
  createSpatialQueryAdmissionController,
  type SpatialQueryAdmissionPolicy,
  type SpatialQueryAdmissionResult,
} from './spatialQueryAdmissionController';
import {
  createSpatialQueryBudgetLedger,
  type SpatialQueryBudgetLimits,
  type SpatialQueryBudgetReason,
  type SpatialQueryPriority,
} from './spatialQueryBudgetLedger';
import {
  createSpatialLayerEpochRegistry,
  type SpatialLayerEpochRegistryPolicy,
  type SpatialLayerEpochToken,
} from './spatialLayerEpochRegistry';

export type SpatialQuerySupervisionErrorCode =
  | 'DISPOSED'
  | 'ABORTED'
  | 'ADMISSION_DEFERRED'
  | 'ADMISSION_REJECTED'
  | 'BUDGET_DEFERRED'
  | 'BUDGET_REJECTED'
  | 'STALE_RESULT';

export class SpatialQuerySupervisionError extends Error {
  readonly code: SpatialQuerySupervisionErrorCode;
  readonly reason: string;
  readonly mayResubmit: boolean;

  constructor(code: SpatialQuerySupervisionErrorCode, reason: string, mayResubmit: boolean) {
    super(`Spatial query execution blocked: ${reason}`);
    this.name = 'SpatialQuerySupervisionError';
    this.code = code;
    this.reason = reason;
    this.mayResubmit = mayResubmit;
  }
}

export interface SpatialQuerySupervisionRequest {
  readonly owner: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly priority?: SpatialQueryPriority;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
  readonly estimatedCpuMs: number;
  readonly estimatedGpuBytes: number;
  readonly signal?: AbortSignal;
}

export interface SpatialQuerySupervisionContext {
  readonly signal: AbortSignal;
  readonly layerEpoch: SpatialLayerEpochToken;
}

export interface SpatialQueryExecutionSupervisorPolicy {
  readonly admission: Partial<SpatialQueryAdmissionPolicy>;
  readonly budgetLimits: SpatialQueryBudgetLimits;
  readonly budgetInteractiveReserveRatio: number;
  readonly epochs: Partial<SpatialLayerEpochRegistryPolicy>;
}

export interface SpatialQueryExecutionSupervisorSnapshot {
  readonly disposed: boolean;
  readonly executions: number;
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly admissionBlocks: number;
  readonly budgetBlocks: number;
  readonly staleResultsBlocked: number;
  readonly mutations: number;
  readonly admission: ReturnType<ReturnType<typeof createSpatialQueryAdmissionController>['snapshot']>;
  readonly budget: ReturnType<ReturnType<typeof createSpatialQueryBudgetLedger>['snapshot']>;
  readonly epochs: ReturnType<ReturnType<typeof createSpatialLayerEpochRegistry>['snapshot']>;
}

const DEFAULT_BUDGET_LIMITS: SpatialQueryBudgetLimits = Object.freeze({
  features: 50_000,
  responseBytes: 64 * 1024 * 1024,
  cpuMs: 4_000,
  gpuBytes: 128 * 1024 * 1024,
  maxLeases: 64,
  maxOwners: 64,
  maxHistory: 256,
});

const normalizeText = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  if (normalized.length > 512) throw new RangeError(`${name} must not exceed 512 characters`);
  return normalized;
};

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
  return value;
};

const positiveFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
  return value;
};

const positiveInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

const normalizeLimits = (
  limits: Partial<SpatialQueryBudgetLimits> | undefined,
): SpatialQueryBudgetLimits => Object.freeze({
  features: positiveFinite(limits?.features ?? DEFAULT_BUDGET_LIMITS.features, 'budgetLimits.features'),
  responseBytes: positiveFinite(limits?.responseBytes ?? DEFAULT_BUDGET_LIMITS.responseBytes, 'budgetLimits.responseBytes'),
  cpuMs: positiveFinite(limits?.cpuMs ?? DEFAULT_BUDGET_LIMITS.cpuMs, 'budgetLimits.cpuMs'),
  gpuBytes: positiveFinite(limits?.gpuBytes ?? DEFAULT_BUDGET_LIMITS.gpuBytes, 'budgetLimits.gpuBytes'),
  maxLeases: positiveInteger(limits?.maxLeases ?? DEFAULT_BUDGET_LIMITS.maxLeases, 'budgetLimits.maxLeases', 10_000),
  maxOwners: positiveInteger(limits?.maxOwners ?? DEFAULT_BUDGET_LIMITS.maxOwners, 'budgetLimits.maxOwners', 10_000),
  maxHistory: (() => {
    const value = limits?.maxHistory ?? DEFAULT_BUDGET_LIMITS.maxHistory;
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
      throw new RangeError('budgetLimits.maxHistory must be a non-negative safe integer no greater than 100000');
    }
    return value;
  })(),
});

export const normalizeSpatialQueryExecutionSupervisorPolicy = (
  policy: Partial<SpatialQueryExecutionSupervisorPolicy> = {},
): SpatialQueryExecutionSupervisorPolicy => {
  const reserve = policy.budgetInteractiveReserveRatio ?? 0.15;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 1) {
    throw new RangeError('budgetInteractiveReserveRatio must be within [0, 1)');
  }
  return Object.freeze({
    admission: Object.freeze({ ...(policy.admission ?? {}) }),
    budgetLimits: normalizeLimits(policy.budgetLimits),
    budgetInteractiveReserveRatio: reserve,
    epochs: Object.freeze({ ...(policy.epochs ?? {}) }),
  });
};

const normalizePriority = (value: SpatialQueryPriority | undefined): SpatialQueryPriority => {
  const priority = value ?? 'normal';
  if (priority !== 'interactive' && priority !== 'normal' && priority !== 'background') {
    throw new TypeError('priority is invalid');
  }
  return priority;
};

const abortError = (reason: unknown): SpatialQuerySupervisionError =>
  new SpatialQuerySupervisionError('ABORTED', String(reason ?? 'query-aborted'), false);

const admissionError = (
  result: Exclude<SpatialQueryAdmissionResult, { readonly decision: 'admit' }>,
): SpatialQuerySupervisionError => new SpatialQuerySupervisionError(
  result.decision === 'defer' ? 'ADMISSION_DEFERRED' : 'ADMISSION_REJECTED',
  result.reason,
  result.mayResubmit,
);

const budgetError = (
  kind: 'defer' | 'reject',
  reason: SpatialQueryBudgetReason,
): SpatialQuerySupervisionError => new SpatialQuerySupervisionError(
  kind === 'defer' ? 'BUDGET_DEFERRED' : 'BUDGET_REJECTED',
  reason,
  kind === 'defer',
);

export const createSpatialQueryExecutionSupervisor = (
  policyInput: Partial<SpatialQueryExecutionSupervisorPolicy> = {},
): Readonly<{
  run<T>(
    request: SpatialQuerySupervisionRequest,
    operation: (context: SpatialQuerySupervisionContext) => Promise<T>,
  ): Promise<T>;
  advanceLayer(serviceId: string, layerId: number): SpatialLayerEpochToken;
  snapshot(): SpatialQueryExecutionSupervisorSnapshot;
  dispose(): void;
}> => {
  const policy = normalizeSpatialQueryExecutionSupervisorPolicy(policyInput);
  const admission = createSpatialQueryAdmissionController(policy.admission);
  const budget = createSpatialQueryBudgetLedger({
    limits: policy.budgetLimits,
    interactiveReserveRatio: policy.budgetInteractiveReserveRatio,
  });
  const epochs = createSpatialLayerEpochRegistry(policy.epochs);
  let disposed = false;
  let executions = 0;
  let completed = 0;
  let failed = 0;
  let aborted = 0;
  let admissionBlocks = 0;
  let budgetBlocks = 0;
  let staleResultsBlocked = 0;
  let mutations = 0;

  const normalizeRequest = (request: SpatialQuerySupervisionRequest) => {
    const owner = normalizeText(request.owner, 'owner');
    const serviceId = normalizeText(request.serviceId, 'serviceId');
    if (!Number.isSafeInteger(request.layerId) || request.layerId < 0) {
      throw new RangeError('layerId must be a non-negative safe integer');
    }
    return Object.freeze({
      owner,
      serviceId,
      layerId: request.layerId,
      priority: normalizePriority(request.priority),
      estimatedFeatures: finiteNonNegative(request.estimatedFeatures, 'estimatedFeatures'),
      estimatedBytes: finiteNonNegative(request.estimatedBytes, 'estimatedBytes'),
      estimatedCpuMs: finiteNonNegative(request.estimatedCpuMs, 'estimatedCpuMs'),
      estimatedGpuBytes: finiteNonNegative(request.estimatedGpuBytes, 'estimatedGpuBytes'),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  };

  const run = async <T>(
    requestInput: SpatialQuerySupervisionRequest,
    operation: (context: SpatialQuerySupervisionContext) => Promise<T>,
  ): Promise<T> => {
    if (disposed) throw new SpatialQuerySupervisionError('DISPOSED', 'supervisor-disposed', false);
    if (typeof operation !== 'function') throw new TypeError('operation is required');
    const request = normalizeRequest(requestInput);
    if (request.signal?.aborted) {
      aborted += 1;
      throw abortError(request.signal.reason);
    }

    executions += 1;
    const admissionDecision = admission.request({
      serviceId: request.serviceId,
      layerId: request.layerId,
      priority: request.priority,
      estimatedFeatures: request.estimatedFeatures,
      estimatedBytes: request.estimatedBytes,
      estimatedCpuMs: request.estimatedCpuMs,
      estimatedGpuBytes: request.estimatedGpuBytes,
    });
    if (admissionDecision.decision !== 'admit' || !admissionDecision.ticket) {
      admissionBlocks += 1;
      failed += 1;
      throw admissionError(admissionDecision as Exclude<SpatialQueryAdmissionResult, { readonly decision: 'admit' }>);
    }

    const budgetDecision = budget.acquire({
      owner: request.owner,
      serviceId: request.serviceId,
      layerId: String(request.layerId),
      priority: request.priority,
      features: request.estimatedFeatures,
      responseBytes: request.estimatedBytes,
      cpuMs: request.estimatedCpuMs,
      gpuBytes: request.estimatedGpuBytes,
    });
    if (budgetDecision.kind !== 'admit') {
      admission.release(admissionDecision.ticket.id);
      budgetBlocks += 1;
      failed += 1;
      throw budgetError(budgetDecision.kind, budgetDecision.reason);
    }

    const layerEpoch = epochs.capture({ serviceId: request.serviceId, layerId: request.layerId });
    const controller = new AbortController();
    const externalSignal = request.signal;
    const onAbort = (): void => controller.abort(externalSignal?.reason ?? 'query-aborted');
    externalSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (externalSignal?.aborted) controller.abort(externalSignal.reason);
      const value = await operation({ signal: controller.signal, layerEpoch });
      if (controller.signal.aborted) {
        aborted += 1;
        failed += 1;
        throw abortError(controller.signal.reason);
      }
      if (!epochs.isCurrent(layerEpoch)) {
        staleResultsBlocked += 1;
        failed += 1;
        throw new SpatialQuerySupervisionError('STALE_RESULT', 'layer-mutated-during-query', true);
      }
      completed += 1;
      return value;
    } catch (error) {
      if (!(error instanceof SpatialQuerySupervisionError)) failed += 1;
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onAbort);
      budget.release(budgetDecision.lease.id);
      admission.release(admissionDecision.ticket.id);
    }
  };

  const advanceLayer = (serviceIdInput: string, layerId: number): SpatialLayerEpochToken => {
    if (disposed) throw new SpatialQuerySupervisionError('DISPOSED', 'supervisor-disposed', false);
    const serviceId = normalizeText(serviceIdInput, 'serviceId');
    if (!Number.isSafeInteger(layerId) || layerId < 0) {
      throw new RangeError('layerId must be a non-negative safe integer');
    }
    mutations += 1;
    return epochs.advance({ serviceId, layerId });
  };

  const snapshot = (): SpatialQueryExecutionSupervisorSnapshot => Object.freeze({
    disposed,
    executions,
    completed,
    failed,
    aborted,
    admissionBlocks,
    budgetBlocks,
    staleResultsBlocked,
    mutations,
    admission: admission.snapshot(),
    budget: budget.snapshot(),
    epochs: epochs.snapshot(),
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    admission.clearQueue();
    budget.dispose();
    epochs.clear();
  };

  return Object.freeze({ run, advanceLayer, snapshot, dispose });
};
