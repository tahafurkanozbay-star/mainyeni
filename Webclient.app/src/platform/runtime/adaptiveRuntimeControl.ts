import type { ResourceBudgetSnapshot, RuntimeBudget } from './contracts';
import {
  createAdmissionController,
  type AdmissionLease,
  type AdmissionPolicy,
  type AdmissionRequest,
  type AdmissionSnapshot,
} from './admissionController';
import {
  createRuntimePressureController,
  type RuntimePressureController,
  type RuntimePressureDecision,
  type RuntimePressurePolicy,
  type RuntimePressureSample,
} from './pressureController';

export interface AdaptiveRuntimeSample {
  readonly at: number;
  readonly p95LatencyMs: number;
  readonly targetLatencyMs: number;
  readonly failureRate: number;
  readonly frameTimeMs: number | null;
  readonly frameBudgetMs: number;
  readonly resourceSnapshot: ResourceBudgetSnapshot;
}

export interface AdaptiveRuntimeControlOptions {
  readonly budget: RuntimeBudget;
  readonly admission?: Partial<AdmissionPolicy>;
  readonly pressure?: Partial<RuntimePressurePolicy>;
  readonly now?: () => number;
}

export interface AdaptiveRuntimeSnapshot {
  readonly admission: AdmissionSnapshot;
  readonly pressure: RuntimePressureDecision;
  readonly effectiveBudget: RuntimeBudget;
}

export interface AdaptiveRuntimeControl {
  readonly acquire: (request: AdmissionRequest) => Promise<AdmissionLease>;
  readonly record: (sample: AdaptiveRuntimeSample) => AdaptiveRuntimeSnapshot;
  readonly snapshot: () => AdaptiveRuntimeSnapshot;
  readonly cancelQueued: (predicate?: (request: Readonly<AdmissionRequest>) => boolean) => number;
  readonly dispose: () => void;
}

const positive = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;

const defaultAdmissionPolicy = (
  budget: RuntimeBudget,
  overrides: Partial<AdmissionPolicy> = {},
): AdmissionPolicy => Object.freeze({
  maxActive: positive(overrides.maxActive, budget.maxConcurrentNetwork + budget.maxConcurrentCpu),
  maxQueued: positive(overrides.maxQueued, budget.maxQueuedTasks),
  maxCost: positive(overrides.maxCost, Math.max(4, budget.maxConcurrentNetwork + budget.maxConcurrentCpu * 2)),
  maxQueueAgeMs: positive(overrides.maxQueueAgeMs, 30_000),
  ...(overrides.laneMaxActive ? { laneMaxActive: overrides.laneMaxActive } : {}),
  ...(overrides.laneMaxQueued ? { laneMaxQueued: overrides.laneMaxQueued } : {}),
});

const emptyResourceSnapshot = (budget: RuntimeBudget): ResourceBudgetSnapshot => Object.freeze({
  budget,
  used: Object.freeze({ network: 0, cpu: 0, memory: 0, render: 0, storage: 0 }),
  available: Object.freeze({ network: 0, cpu: 0, memory: 0, render: 0, storage: 0 }),
  reservationCount: 0,
  rejectedReservations: 0,
  expiredReservations: 0,
});

const initialPressure = (
  controller: RuntimePressureController,
  budget: RuntimeBudget,
): RuntimePressureDecision => {
  const current = controller.snapshot();
  if (current.budget === budget) return current;
  return Object.freeze({ ...current, budget });
};

export const createAdaptiveRuntimeControl = (
  options: AdaptiveRuntimeControlOptions,
): AdaptiveRuntimeControl => {
  const now = options.now ?? Date.now;
  const admission = createAdmissionController(defaultAdmissionPolicy(options.budget, options.admission), now);
  const pressure = createRuntimePressureController(options.budget, options.pressure);
  let currentPressure = initialPressure(pressure, options.budget);
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Adaptive runtime control is disposed.');
  };

  const snapshot = (): AdaptiveRuntimeSnapshot => Object.freeze({
    admission: admission.snapshot(),
    pressure: currentPressure,
    effectiveBudget: currentPressure.budget,
  });

  const record = (sample: AdaptiveRuntimeSample): AdaptiveRuntimeSnapshot => {
    assertActive();
    const admissionSnapshot = admission.snapshot();
    const pressureSample: RuntimePressureSample = Object.freeze({
      at: sample.at,
      queueDepth: admissionSnapshot.queued,
      queueCapacity: defaultAdmissionPolicy(options.budget, options.admission).maxQueued,
      p95LatencyMs: sample.p95LatencyMs,
      targetLatencyMs: sample.targetLatencyMs,
      failureRate: sample.failureRate,
      frameTimeMs: sample.frameTimeMs,
      frameBudgetMs: sample.frameBudgetMs,
      resourceSnapshot: sample.resourceSnapshot,
    });
    currentPressure = pressure.record(pressureSample);
    return snapshot();
  };

  const acquire = (request: AdmissionRequest): Promise<AdmissionLease> => {
    if (disposed) return Promise.reject(new Error('Adaptive runtime control is disposed.'));
    return admission.acquire(request);
  };

  const cancelQueued = (predicate?: (request: Readonly<AdmissionRequest>) => boolean): number => {
    assertActive();
    return predicate ? admission.cancelQueued(predicate) : admission.cancelQueued();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    admission.dispose();
    pressure.reset();
  };

  // Keep an explicit zero-pressure shape available to callers constructing synthetic samples.
  void emptyResourceSnapshot;

  return Object.freeze({ acquire, record, snapshot, cancelQueued, dispose });
};
