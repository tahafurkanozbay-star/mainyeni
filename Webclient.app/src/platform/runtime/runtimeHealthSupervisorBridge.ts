import {
  createRuntimeHealthJournal,
  type RuntimeHealthEvent,
  type RuntimeHealthJournal,
  type RuntimeHealthJournalPolicy,
  type RuntimeHealthSummary,
} from './runtimeHealthJournal';
import {
  createRuntimeHealthPolicyEngine,
  type RuntimeHealthAssessment,
  type RuntimeHealthPolicy,
  type RuntimeHealthPolicyEngine,
  type RuntimeHealthState,
  type RuntimeHealthTransition,
} from './runtimeHealthPolicy';
import type { HealthStatus, RuntimeSupervisor } from './supervision';

export interface RuntimeHealthSupervisorBridgeOptions {
  readonly componentId?: string;
  readonly source?: string;
  readonly ttlMs?: number;
  readonly journal?: RuntimeHealthJournal;
  readonly journalPolicy?: Partial<RuntimeHealthJournalPolicy>;
  readonly policy?: RuntimeHealthPolicyEngine;
  readonly healthPolicy?: Partial<RuntimeHealthPolicy>;
  readonly transitionHistoryLimit?: number;
  readonly publishUnchanged?: boolean;
  readonly now?: () => number;
  readonly onTransition?: (transition: RuntimeHealthBridgeTransition) => void;
}

export interface RuntimeHealthBridgeTransition {
  readonly at: number;
  readonly previous: RuntimeHealthState;
  readonly current: RuntimeHealthState;
  readonly changed: boolean;
  readonly assessment: RuntimeHealthAssessment;
  readonly summary: RuntimeHealthSummary;
  readonly eventCode: string | null;
}

export interface RuntimeHealthSupervisorBridgeSnapshot {
  readonly generatedAt: number;
  readonly componentId: string;
  readonly assessment: RuntimeHealthAssessment;
  readonly summary: RuntimeHealthSummary;
  readonly transitions: readonly RuntimeHealthBridgeTransition[];
  readonly disposed: boolean;
}

export interface RuntimeHealthSupervisorBridge {
  readonly record: (event: RuntimeHealthEvent) => RuntimeHealthBridgeTransition;
  readonly assess: (at?: number) => RuntimeHealthBridgeTransition;
  readonly snapshot: () => RuntimeHealthSupervisorBridgeSnapshot;
  readonly clear: () => void;
  readonly dispose: () => void;
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const normalizeText = (value: unknown, fallback: string, maxLength: number): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
};

const healthStatusFor = (state: RuntimeHealthState): HealthStatus => {
  if (state === 'healthy') return 'healthy';
  if (state === 'degraded') return 'degraded';
  return 'unhealthy';
};

const safeObserver = (
  observer: RuntimeHealthSupervisorBridgeOptions['onTransition'],
  transition: RuntimeHealthBridgeTransition,
): void => {
  if (!observer) return;
  try {
    observer(transition);
  } catch {
    // Health observers are isolated from the control plane.
  }
};

const transitionSnapshot = (
  transition: RuntimeHealthTransition,
  summary: RuntimeHealthSummary,
  eventCode: string | null,
): RuntimeHealthBridgeTransition => Object.freeze({
  at: transition.assessment.assessedAt,
  previous: transition.previous,
  current: transition.current,
  changed: transition.changed,
  assessment: transition.assessment,
  summary,
  eventCode,
});

export class RuntimeHealthBridgeDisposedError extends Error {
  readonly code = 'RUNTIME_HEALTH_BRIDGE_DISPOSED';

  constructor() {
    super('Runtime health supervisor bridge has been disposed.');
    this.name = 'RuntimeHealthBridgeDisposedError';
  }
}

export const createRuntimeHealthSupervisorBridge = (
  supervisor: RuntimeSupervisor,
  options: RuntimeHealthSupervisorBridgeOptions = {},
): RuntimeHealthSupervisorBridge => {
  const now = options.now ?? Date.now;
  const componentId = normalizeText(options.componentId, 'runtime-control-plane', 160);
  const source = normalizeText(options.source, 'runtime-health-policy', 200);
  const ttlMs = boundedInteger(options.ttlMs, 30_000, 0, 24 * 60 * 60_000);
  const transitionHistoryLimit = boundedInteger(options.transitionHistoryLimit, 128, 1, 4096);
  const publishUnchanged = options.publishUnchanged === true;
  const ownsJournal = options.journal === undefined;
  const ownsPolicy = options.policy === undefined;
  const journal = options.journal ?? createRuntimeHealthJournal(options.journalPolicy, now);
  const policy = options.policy ?? createRuntimeHealthPolicyEngine(options.healthPolicy, now);
  const transitions: RuntimeHealthBridgeTransition[] = [];
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new RuntimeHealthBridgeDisposedError();
  };

  const publish = (transition: RuntimeHealthBridgeTransition): void => {
    const assessment = transition.assessment;
    supervisor.reportHealth({
      componentId,
      status: healthStatusFor(transition.current),
      observedAt: assessment.assessedAt,
      ttlMs,
      source,
      message: assessment.reasons.length > 0
        ? assessment.reasons.join(', ').slice(0, 1000)
        : `runtime-health:${transition.current}`,
      details: {
        score: assessment.score,
        failureRate: Number(assessment.failureRate.toFixed(6)),
        p95LatencyMs: assessment.p95LatencyMs,
        retainedSamples: assessment.retainedSamples,
        reasonCount: assessment.reasons.length,
      },
    });
  };

  const commit = (transition: RuntimeHealthBridgeTransition): RuntimeHealthBridgeTransition => {
    if (transition.changed || publishUnchanged) publish(transition);
    transitions.push(transition);
    if (transitions.length > transitionHistoryLimit) {
      transitions.splice(0, transitions.length - transitionHistoryLimit);
    }
    safeObserver(options.onTransition, transition);
    return transition;
  };

  const record = (event: RuntimeHealthEvent): RuntimeHealthBridgeTransition => {
    assertActive();
    const normalized = journal.record(event);
    const summary = journal.summary();
    return commit(transitionSnapshot(policy.observe(normalized, summary), summary, normalized.code));
  };

  const assess = (at = now()): RuntimeHealthBridgeTransition => {
    assertActive();
    const summary = journal.summary();
    return commit(transitionSnapshot(policy.assess(summary, at), summary, null));
  };

  const snapshot = (): RuntimeHealthSupervisorBridgeSnapshot => {
    assertActive();
    return Object.freeze({
      generatedAt: now(),
      componentId,
      assessment: policy.snapshot(),
      summary: journal.summary(),
      transitions: Object.freeze([...transitions]),
      disposed,
    });
  };

  const clear = (): void => {
    assertActive();
    journal.clear();
    policy.reset();
    transitions.splice(0);
    const transition = transitionSnapshot(policy.assess(journal.summary(), now()), journal.summary(), null);
    publish(transition);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    transitions.splice(0);
    if (ownsPolicy) policy.dispose();
    if (ownsJournal) journal.dispose();
  };

  return Object.freeze({ record, assess, snapshot, clear, dispose });
};
