import type {
  ResourceBudgetSnapshot,
  ResourceKind,
  RuntimePhase,
  SchedulerSnapshot,
} from './contracts';
import { budgetPressure } from './resourceBudget';
import type { AdaptiveRuntimeSnapshot } from './adaptiveRuntimeControl';
import type { RuntimePressureLevel } from './pressureController';
import {
  createRuntimeHealthJournal,
  type RuntimeHealthJournal,
  type RuntimeHealthJournalSnapshot,
} from './runtimeHealthJournal';

export interface RuntimeHealthCoordinatorPolicy {
  readonly queueWarningRatio: number;
  readonly resourceWarningRatio: number;
}

export interface RuntimeHealthCoordinatorSample {
  readonly at?: number;
  readonly phase: RuntimePhase;
  readonly adaptive: AdaptiveRuntimeSnapshot;
  readonly scheduler: SchedulerSnapshot;
  readonly resources: ResourceBudgetSnapshot;
}

export interface RuntimeHealthCoordinatorSnapshot {
  readonly disposed: boolean;
  readonly samples: number;
  readonly phase: RuntimePhase | null;
  readonly pressureLevel: RuntimePressureLevel | null;
  readonly queuePressure: number;
  readonly resourcePressure: Readonly<Record<ResourceKind, number>>;
  readonly saturatedResources: readonly ResourceKind[];
  readonly health: RuntimeHealthJournalSnapshot;
}

export interface RuntimeHealthCoordinatorOptions {
  readonly journal?: RuntimeHealthJournal;
  readonly now?: () => number;
  readonly policy?: Partial<RuntimeHealthCoordinatorPolicy>;
}

export interface RuntimeHealthCoordinator {
  readonly record: (sample: RuntimeHealthCoordinatorSample) => RuntimeHealthCoordinatorSnapshot;
  readonly snapshot: () => RuntimeHealthCoordinatorSnapshot;
  readonly resetBaselines: () => void;
  readonly dispose: () => void;
}

const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  'network',
  'cpu',
  'memory',
  'render',
  'storage',
]);

const DEFAULT_POLICY: RuntimeHealthCoordinatorPolicy = Object.freeze({
  queueWarningRatio: 0.75,
  resourceWarningRatio: 0.85,
});

const ratio = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, Number(value)));
};

const normalizePolicy = (
  input: Partial<RuntimeHealthCoordinatorPolicy> = {},
): RuntimeHealthCoordinatorPolicy => Object.freeze({
  queueWarningRatio: ratio(input.queueWarningRatio, DEFAULT_POLICY.queueWarningRatio),
  resourceWarningRatio: ratio(input.resourceWarningRatio, DEFAULT_POLICY.resourceWarningRatio),
});

const pressureSeverity = (
  level: RuntimePressureLevel,
): 'debug' | 'info' | 'warning' | 'critical' => {
  if (level === 'critical') return 'critical';
  if (level === 'high') return 'warning';
  if (level === 'elevated') return 'info';
  return 'debug';
};

const phaseSeverity = (
  phase: RuntimePhase,
): 'debug' | 'info' | 'warning' | 'error' => {
  if (phase === 'failed') return 'error';
  if (phase === 'degraded') return 'warning';
  if (phase === 'starting' || phase === 'stopping' || phase === 'suspending') return 'debug';
  return 'info';
};

const counterDelta = (current: number, previous: number): number =>
  Math.max(0, current - previous);

interface CounterBaseline {
  readonly admissionShed: number;
  readonly admissionExpired: number;
  readonly admissionCancelled: number;
  readonly pressureShed: number;
  readonly schedulerFailed: number;
  readonly schedulerTimedOut: number;
  readonly schedulerRejected: number;
  readonly budgetRejected: number;
  readonly budgetExpired: number;
}

const baselineFrom = (sample: RuntimeHealthCoordinatorSample): CounterBaseline => Object.freeze({
  admissionShed: sample.adaptive.admission.shed,
  admissionExpired: sample.adaptive.admission.expired,
  admissionCancelled: sample.adaptive.admission.cancelled,
  pressureShed: sample.adaptive.pressureShed,
  schedulerFailed: sample.scheduler.failed,
  schedulerTimedOut: sample.scheduler.timedOut,
  schedulerRejected: sample.scheduler.rejected,
  budgetRejected: sample.resources.rejectedReservations,
  budgetExpired: sample.resources.expiredReservations,
});

const emptyPressure = (): Record<ResourceKind, number> => ({
  network: 0,
  cpu: 0,
  memory: 0,
  render: 0,
  storage: 0,
});

export const createRuntimeHealthCoordinator = (
  options: RuntimeHealthCoordinatorOptions = {},
): RuntimeHealthCoordinator => {
  const now = options.now ?? Date.now;
  const policy = normalizePolicy(options.policy);
  const journal = options.journal ?? createRuntimeHealthJournal({}, now);
  const ownsJournal = options.journal === undefined;
  let disposed = false;
  let samples = 0;
  let phase: RuntimePhase | null = null;
  let pressureLevel: RuntimePressureLevel | null = null;
  let baseline: CounterBaseline | null = null;
  let queuePressure = 0;
  let queueSaturated = false;
  let resourcePressure = emptyPressure();
  let saturatedResources = new Set<ResourceKind>();

  const assertActive = (): void => {
    if (disposed) throw new Error('Runtime health coordinator is disposed.');
  };

  const event = (
    at: number,
    kind: 'admission' | 'pressure' | 'lifecycle' | 'resource' | 'failure' | 'recovery',
    severity: 'debug' | 'info' | 'warning' | 'error' | 'critical',
    code: string,
    value?: number,
  ): void => {
    journal.record({
      at,
      kind,
      severity,
      code,
      ...(value === undefined ? {} : { value }),
    });
  };

  const recordPhase = (at: number, next: RuntimePhase): void => {
    if (phase === next) return;
    const previous = phase;
    phase = next;
    event(at, 'lifecycle', phaseSeverity(next), `phase-${next}`);
    if (previous === 'degraded' && next === 'ready') {
      event(at, 'recovery', 'info', 'phase-recovered');
    }
  };

  const recordPressure = (at: number, next: RuntimePressureLevel): void => {
    if (pressureLevel === next) return;
    const previous = pressureLevel;
    pressureLevel = next;
    event(at, 'pressure', pressureSeverity(next), `pressure-${next}`);
    if (previous && previous !== 'nominal' && next === 'nominal') {
      event(at, 'recovery', 'info', 'pressure-recovered');
    }
  };

  const recordCounterDeltas = (
    at: number,
    sample: RuntimeHealthCoordinatorSample,
    previous: CounterBaseline,
  ): void => {
    const shed = counterDelta(sample.adaptive.admission.shed, previous.admissionShed);
    if (shed > 0) event(at, 'admission', 'warning', 'admission-shed', shed);

    const expired = counterDelta(sample.adaptive.admission.expired, previous.admissionExpired);
    if (expired > 0) event(at, 'admission', 'warning', 'admission-expired', expired);

    const cancelled = counterDelta(sample.adaptive.admission.cancelled, previous.admissionCancelled);
    if (cancelled > 0) event(at, 'admission', 'info', 'admission-cancelled', cancelled);

    const pressureShed = counterDelta(sample.adaptive.pressureShed, previous.pressureShed);
    if (pressureShed > 0) event(at, 'pressure', 'warning', 'pressure-shed', pressureShed);

    const failed = counterDelta(sample.scheduler.failed, previous.schedulerFailed);
    if (failed > 0) event(at, 'failure', 'error', 'scheduler-failed', failed);

    const timedOut = counterDelta(sample.scheduler.timedOut, previous.schedulerTimedOut);
    if (timedOut > 0) event(at, 'failure', 'warning', 'scheduler-timed-out', timedOut);

    const rejected = counterDelta(sample.scheduler.rejected, previous.schedulerRejected);
    if (rejected > 0) event(at, 'admission', 'warning', 'scheduler-rejected', rejected);

    const budgetRejected = counterDelta(
      sample.resources.rejectedReservations,
      previous.budgetRejected,
    );
    if (budgetRejected > 0) event(at, 'resource', 'warning', 'budget-rejected', budgetRejected);

    const budgetExpired = counterDelta(
      sample.resources.expiredReservations,
      previous.budgetExpired,
    );
    if (budgetExpired > 0) event(at, 'resource', 'info', 'budget-expired', budgetExpired);
  };

  const recordQueuePressure = (
    at: number,
    sample: RuntimeHealthCoordinatorSample,
  ): void => {
    const capacity = Math.max(1, sample.resources.budget.maxQueuedTasks);
    queuePressure = Math.min(1, Math.max(0, sample.scheduler.queued / capacity));
    const nextSaturated = queuePressure >= policy.queueWarningRatio;
    if (nextSaturated === queueSaturated) return;
    queueSaturated = nextSaturated;
    if (nextSaturated) {
      event(at, 'admission', 'warning', 'scheduler-queue-pressure', queuePressure);
    } else {
      event(at, 'recovery', 'info', 'scheduler-queue-recovered', queuePressure);
    }
  };

  const recordResourcePressure = (
    at: number,
    sample: RuntimeHealthCoordinatorSample,
  ): void => {
    const nextPressure = emptyPressure();
    const nextSaturated = new Set<ResourceKind>();
    for (const kind of RESOURCE_KINDS) {
      const value = budgetPressure(sample.resources, kind);
      nextPressure[kind] = value;
      if (value >= policy.resourceWarningRatio) nextSaturated.add(kind);
    }

    for (const kind of RESOURCE_KINDS) {
      const wasSaturated = saturatedResources.has(kind);
      const isSaturated = nextSaturated.has(kind);
      if (wasSaturated === isSaturated) continue;
      if (isSaturated) {
        event(at, 'resource', 'warning', `resource-${kind}-pressure`, nextPressure[kind]);
      } else {
        event(at, 'recovery', 'info', `resource-${kind}-recovered`, nextPressure[kind]);
      }
    }
    resourcePressure = nextPressure;
    saturatedResources = nextSaturated;
  };

  const snapshot = (): RuntimeHealthCoordinatorSnapshot => {
    assertActive();
    return Object.freeze({
      disposed,
      samples,
      phase,
      pressureLevel,
      queuePressure,
      resourcePressure: Object.freeze({ ...resourcePressure }),
      saturatedResources: Object.freeze([...saturatedResources].sort()),
      health: journal.snapshot(),
    });
  };

  const record = (
    sample: RuntimeHealthCoordinatorSample,
  ): RuntimeHealthCoordinatorSnapshot => {
    assertActive();
    const at = Number.isFinite(sample.at) ? Number(sample.at) : now();
    recordPhase(at, sample.phase);
    recordPressure(at, sample.adaptive.pressure.level);
    if (baseline) recordCounterDeltas(at, sample, baseline);
    recordQueuePressure(at, sample);
    recordResourcePressure(at, sample);
    baseline = baselineFrom(sample);
    samples += 1;
    return snapshot();
  };

  const resetBaselines = (): void => {
    assertActive();
    baseline = null;
    phase = null;
    pressureLevel = null;
    queuePressure = 0;
    queueSaturated = false;
    resourcePressure = emptyPressure();
    saturatedResources = new Set<ResourceKind>();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    baseline = null;
    saturatedResources.clear();
    if (ownsJournal) journal.dispose();
  };

  return Object.freeze({ record, snapshot, resetBaselines, dispose });
};
