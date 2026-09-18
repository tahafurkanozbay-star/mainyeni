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
  type RuntimePressureLevel,
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

export interface PressureSheddingPolicy {
  /** Pressure levels that are allowed to evict queued low-value work. */
  readonly levels: readonly RuntimePressureLevel[];
  /** Lanes that may be shed. Foreground/default work is intentionally absent by default. */
  readonly lanes: readonly string[];
  /** Maximum queued requests removed by one pressure sample. */
  readonly maxPerSample: number;
}

export interface AdaptiveRuntimeControlOptions {
  readonly budget: RuntimeBudget;
  readonly admission?: Partial<AdmissionPolicy>;
  readonly pressure?: Partial<RuntimePressurePolicy>;
  readonly shedding?: Partial<PressureSheddingPolicy> | false;
  readonly now?: () => number;
}

export interface AdaptiveRuntimeSnapshot {
  readonly admission: AdmissionSnapshot;
  readonly pressure: RuntimePressureDecision;
  readonly effectiveBudget: RuntimeBudget;
  readonly pressureShed: number;
  readonly lastPressureShed: number;
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

const defaultSheddingPolicy: PressureSheddingPolicy = Object.freeze({
  levels: Object.freeze(['critical'] as const),
  lanes: Object.freeze(['background', 'prefetch', 'maintenance']),
  maxPerSample: 16,
});

const normalizeSheddingPolicy = (
  input: Partial<PressureSheddingPolicy> | false | undefined,
): PressureSheddingPolicy | null => {
  if (input === false) return null;
  const levels = input?.levels?.length ? [...new Set(input.levels)] : [...defaultSheddingPolicy.levels];
  const lanes = input?.lanes?.map((lane) => lane.trim()).filter(Boolean);
  return Object.freeze({
    levels: Object.freeze(levels),
    lanes: Object.freeze(lanes?.length ? [...new Set(lanes)] : [...defaultSheddingPolicy.lanes]),
    maxPerSample: positive(input?.maxPerSample, defaultSheddingPolicy.maxPerSample),
  });
};

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
  const admissionPolicy = defaultAdmissionPolicy(options.budget, options.admission);
  const admission = createAdmissionController(admissionPolicy, now);
  const pressure = createRuntimePressureController(options.budget, options.pressure);
  const shedding = normalizeSheddingPolicy(options.shedding);
  let currentPressure = initialPressure(pressure, options.budget);
  let pressureShed = 0;
  let lastPressureShed = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Adaptive runtime control is disposed.');
  };

  const snapshot = (): AdaptiveRuntimeSnapshot => Object.freeze({
    admission: admission.snapshot(),
    pressure: currentPressure,
    effectiveBudget: currentPressure.budget,
    pressureShed,
    lastPressureShed,
  });

  const shedForPressure = (): number => {
    if (!shedding || !shedding.levels.includes(currentPressure.level)) return 0;
    const allowedLanes = new Set(shedding.lanes);
    let remaining = shedding.maxPerSample;
    return admission.cancelQueued((request) => {
      if (remaining <= 0 || !allowedLanes.has(request.lane ?? 'default')) return false;
      remaining -= 1;
      return true;
    });
  };

  const record = (sample: AdaptiveRuntimeSample): AdaptiveRuntimeSnapshot => {
    assertActive();
    const admissionSnapshot = admission.snapshot();
    const pressureSample: RuntimePressureSample = Object.freeze({
      at: sample.at,
      queueDepth: admissionSnapshot.queued,
      queueCapacity: admissionPolicy.maxQueued,
      p95LatencyMs: sample.p95LatencyMs,
      targetLatencyMs: sample.targetLatencyMs,
      failureRate: sample.failureRate,
      frameTimeMs: sample.frameTimeMs,
      frameBudgetMs: sample.frameBudgetMs,
      resourceSnapshot: sample.resourceSnapshot,
    });
    currentPressure = pressure.record(pressureSample);
    lastPressureShed = shedForPressure();
    pressureShed += lastPressureShed;
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
    lastPressureShed = 0;
  };

  return Object.freeze({ acquire, record, snapshot, cancelQueued, dispose });
};
