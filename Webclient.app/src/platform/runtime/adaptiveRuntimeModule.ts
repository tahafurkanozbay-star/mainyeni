import type { RuntimeBudget } from './contracts';
import {
  createAdaptiveRuntimeControl,
  type AdaptiveRuntimeControl,
  type AdaptiveRuntimeSample,
  type AdaptiveRuntimeSnapshot,
  type AdaptiveRuntimeControlOptions,
} from './adaptiveRuntimeControl';
import type { AdmissionLease, AdmissionRequest } from './admissionController';
import type { RuntimeKernelModule, RuntimeKernelModuleContext } from './runtimeKernel';

export type AdaptiveRuntimeModulePhase = 'idle' | 'running' | 'suspended' | 'stopped' | 'disposed';

export interface AdaptiveRuntimeModuleOptions {
  readonly id?: string;
  readonly required?: boolean;
  readonly order?: number;
  readonly admission?: AdaptiveRuntimeControlOptions['admission'];
  readonly pressure?: AdaptiveRuntimeControlOptions['pressure'];
  readonly now?: () => number;
  readonly cancelQueuedOnSuspend?: boolean;
  readonly suspendedLanePredicate?: (request: Readonly<AdmissionRequest>) => boolean;
}

export interface AdaptiveRuntimeModuleSnapshot {
  readonly phase: AdaptiveRuntimeModulePhase;
  readonly generation: number;
  readonly control: AdaptiveRuntimeSnapshot | null;
  readonly budget: RuntimeBudget | null;
}

export interface AdaptiveRuntimeModule {
  readonly module: RuntimeKernelModule;
  readonly acquire: (request: AdmissionRequest) => Promise<AdmissionLease>;
  readonly record: (sample: AdaptiveRuntimeSample) => AdaptiveRuntimeSnapshot;
  readonly snapshot: () => AdaptiveRuntimeModuleSnapshot;
  readonly cancelQueued: (predicate?: (request: Readonly<AdmissionRequest>) => boolean) => number;
  readonly dispose: () => void;
}

const defaultSuspendPredicate = (request: Readonly<AdmissionRequest>): boolean =>
  request.lane === 'background' || request.lane === 'prefetch' || request.lane === 'maintenance';

const sameBudget = (left: RuntimeBudget | null, right: RuntimeBudget): boolean => {
  if (!left) return false;
  return left.tier === right.tier
    && left.maxConcurrentNetwork === right.maxConcurrentNetwork
    && left.maxConcurrentCpu === right.maxConcurrentCpu
    && left.maxQueuedTasks === right.maxQueuedTasks
    && left.maxCacheEntries === right.maxCacheEntries
    && left.maxCacheBytes === right.maxCacheBytes
    && left.maxVisibleFeatures2d === right.maxVisibleFeatures2d
    && left.maxVisibleFeatures3d === right.maxVisibleFeatures3d
    && left.maxGpuHeavyLayers === right.maxGpuHeavyLayers
    && left.frameBudgetMs === right.frameBudgetMs
    && left.backgroundSliceMs === right.backgroundSliceMs
    && left.telemetryCapacity === right.telemetryCapacity;
};

const cloneBudget = (budget: RuntimeBudget): RuntimeBudget => Object.freeze({ ...budget });

export const createAdaptiveRuntimeModule = (
  options: AdaptiveRuntimeModuleOptions = {},
): AdaptiveRuntimeModule => {
  let control: AdaptiveRuntimeControl | null = null;
  let budget: RuntimeBudget | null = null;
  let phase: AdaptiveRuntimeModulePhase = 'idle';
  let generation = 0;
  let disposed = false;

  const assertUsable = (): void => {
    if (disposed) throw new Error('Adaptive runtime module is disposed.');
  };

  const assertRunning = (): AdaptiveRuntimeControl => {
    assertUsable();
    if (phase !== 'running' || !control) {
      throw new Error(`Adaptive runtime module is not running (${phase}).`);
    }
    return control;
  };

  const createControl = (nextBudget: RuntimeBudget): AdaptiveRuntimeControl => {
    const next = createAdaptiveRuntimeControl({
      budget: nextBudget,
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.pressure ? { pressure: options.pressure } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    generation += 1;
    budget = cloneBudget(nextBudget);
    return next;
  };

  const activate = (context: RuntimeKernelModuleContext): void => {
    assertUsable();
    const nextBudget = context.budget.snapshot().budget;
    if (!control || !sameBudget(budget, nextBudget)) {
      control?.dispose();
      control = createControl(nextBudget);
    }
    phase = 'running';
  };

  const suspend = (): void => {
    assertUsable();
    if (!control || phase !== 'running') {
      phase = 'suspended';
      return;
    }
    if (options.cancelQueuedOnSuspend !== false) {
      control.cancelQueued(options.suspendedLanePredicate ?? defaultSuspendPredicate);
    }
    phase = 'suspended';
  };

  const stop = (): void => {
    if (disposed) return;
    control?.dispose();
    control = null;
    budget = null;
    phase = 'stopped';
  };

  const dispose = (): void => {
    if (disposed) return;
    control?.dispose();
    control = null;
    budget = null;
    phase = 'disposed';
    disposed = true;
  };

  const snapshot = (): AdaptiveRuntimeModuleSnapshot => Object.freeze({
    phase,
    generation,
    control: control?.snapshot() ?? null,
    budget,
  });

  const acquire = (request: AdmissionRequest): Promise<AdmissionLease> => {
    try {
      return assertRunning().acquire(request);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const record = (sample: AdaptiveRuntimeSample): AdaptiveRuntimeSnapshot => assertRunning().record(sample);

  const cancelQueued = (predicate?: (request: Readonly<AdmissionRequest>) => boolean): number => {
    assertUsable();
    if (!control) return 0;
    return predicate ? control.cancelQueued(predicate) : control.cancelQueued();
  };

  const module: RuntimeKernelModule = Object.freeze({
    id: options.id ?? 'adaptive-runtime-control',
    order: options.order ?? 40,
    required: options.required ?? false,
    start: (context: RuntimeKernelModuleContext) => activate(context),
    ready: (context: RuntimeKernelModuleContext) => activate(context),
    suspend: () => suspend(),
    resume: (context: RuntimeKernelModuleContext) => activate(context),
    stop: () => stop(),
    dispose: () => dispose(),
  });

  return Object.freeze({ module, acquire, record, snapshot, cancelQueued, dispose });
};
