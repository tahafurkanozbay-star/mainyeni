import {
  boundedInteger,
  boundedText,
  freezeArray,
  governanceIdentifier,
  sanitizeEvidenceDetail,
  stableFingerprint,
  type GovernanceClock,
  type ReadinessEvidence,
  type ReadinessRequirement,
  type ReadinessRequirementSnapshot,
  type ReadinessSnapshot,
  type ReadinessState,
  type ReadinessStatus,
  defaultGovernanceClock,
} from './contracts';

export interface ReadinessGateOptions {
  readonly clock?: GovernanceClock;
  readonly maxRequirements?: number;
  readonly historyLimit?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface ReadinessEvent {
  readonly sequence: number;
  readonly at: number;
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly state: ReadinessState;
  readonly code?: string;
}

export interface ReadinessGate {
  readonly register: (requirement: ReadinessRequirement) => () => void;
  readonly record: (id: string, status: ReadinessStatus, options?: { readonly code?: string; readonly detail?: string; readonly observedAt?: number }) => ReadinessSnapshot;
  readonly clearEvidence: (id: string) => boolean;
  readonly snapshot: (now?: number) => ReadinessSnapshot;
  readonly history: () => readonly ReadinessEvent[];
  readonly subscribe: (listener: (snapshot: ReadinessSnapshot) => void, emitCurrent?: boolean) => () => void;
  readonly dispose: () => void;
}

interface NormalizedRequirement {
  readonly id: string;
  readonly severity: 'critical' | 'degraded';
  readonly ttlMs: number | null;
  readonly required: boolean;
  readonly description: string;
}

const publicRequirement = (
  requirement: NormalizedRequirement,
): ReadinessRequirement => Object.freeze({
  id: requirement.id,
  severity: requirement.severity,
  ...(requirement.ttlMs === null ? {} : { ttlMs: requirement.ttlMs }),
  required: requirement.required,
  ...(requirement.description ? { description: requirement.description } : {}),
});

const normalizeRequirement = (requirement: ReadinessRequirement): NormalizedRequirement => {
  if (!requirement || typeof requirement !== 'object') throw new TypeError('readiness requirement is required');
  const id = governanceIdentifier(requirement.id, 'readiness requirement', 120);
  if (!['critical', 'degraded'].includes(requirement.severity)) {
    throw new TypeError(`unsupported readiness severity: ${String(requirement.severity)}`);
  }
  const ttlMs = requirement.ttlMs === undefined
    ? null
    : boundedInteger(requirement.ttlMs, 60_000, 100, 24 * 60 * 60 * 1000);
  return Object.freeze({
    ...requirement,
    id,
    severity: requirement.severity,
    ttlMs,
    required: requirement.required !== false,
    description: boundedText(requirement.description, '', 240),
  });
};

const normalizeStatus = (status: ReadinessStatus): ReadinessStatus => {
  if (!['pass', 'fail', 'unknown'].includes(status)) throw new TypeError(`unsupported readiness status: ${String(status)}`);
  return status;
};

export const createReadinessGate = (options: ReadinessGateOptions = {}): ReadinessGate => {
  const clock = options.clock ?? defaultGovernanceClock;
  const maxRequirements = boundedInteger(options.maxRequirements, 128, 1, 2048);
  const historyLimit = boundedInteger(options.historyLimit, 256, 0, 4096);
  const requirements = new Map<string, NormalizedRequirement>();
  const evidence = new Map<string, ReadinessEvidence>();
  const history: ReadinessEvent[] = [];
  const listeners = new Set<(snapshot: ReadinessSnapshot) => void>();
  let sequence = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('readiness gate has been disposed');
  };

  const register = (input: ReadinessRequirement): (() => void) => {
    assertActive();
    if (requirements.size >= maxRequirements) throw new RangeError('readiness requirement capacity exceeded');
    const requirement = normalizeRequirement(input);
    if (requirements.has(requirement.id)) throw new Error(`readiness requirement already registered: ${requirement.id}`);
    requirements.set(requirement.id, requirement);
    return () => {
      requirements.delete(requirement.id);
      evidence.delete(requirement.id);
    };
  };

  const snapshot = (now = clock.now()): ReadinessSnapshot => {
    assertActive();
    const blockers: string[] = [];
    const degraded: string[] = [];
    const unknown: string[] = [];
    const snapshots: ReadinessRequirementSnapshot[] = [];

    for (const requirement of [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
      const current = evidence.get(requirement.id) ?? null;
      const stale = Boolean(current?.expiresAt !== null && current?.expiresAt !== undefined && current.expiresAt <= now);
      const effectiveStatus: ReadinessStatus = stale || !current ? 'unknown' : current.status;
      if (requirement.required && effectiveStatus === 'fail') {
        if (requirement.severity === 'critical') blockers.push(requirement.id);
        else degraded.push(requirement.id);
      } else if (requirement.required && effectiveStatus === 'unknown') {
        unknown.push(requirement.id);
        if (requirement.severity === 'critical') blockers.push(requirement.id);
        else degraded.push(requirement.id);
      }
      snapshots.push(Object.freeze({
        requirement: publicRequirement(requirement),
        evidence: current,
        stale,
        effectiveStatus,
      }));
    }

    let state: ReadinessState = 'ready';
    if (blockers.length > 0) state = 'blocked';
    else if (degraded.length > 0) state = 'degraded';
    else if (unknown.length > 0) state = 'unknown';

    return Object.freeze({
      state,
      generatedAt: now,
      blockers: freezeArray(blockers),
      degraded: freezeArray(degraded),
      unknown: freezeArray(unknown),
      requirements: freezeArray(snapshots),
      fingerprint: stableFingerprint({
        state,
        requirements: snapshots.map((item) => ({
          id: item.requirement.id,
          severity: item.requirement.severity,
          status: item.effectiveStatus,
          stale: item.stale,
          code: item.evidence?.code ?? null,
        })),
      }),
    });
  };

  const notify = (current: ReadinessSnapshot): void => {
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      try {
        listener(current);
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
  };

  const remember = (id: string, status: ReadinessStatus, state: ReadinessState, code?: string): void => {
    if (historyLimit === 0) return;
    history.push(Object.freeze({
      sequence: ++sequence,
      at: clock.now(),
      id,
      status,
      state,
      ...(code ? { code } : {}),
    }));
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  };

  const record = (
    id: string,
    status: ReadinessStatus,
    recordOptions: { readonly code?: string; readonly detail?: string; readonly observedAt?: number } = {},
  ): ReadinessSnapshot => {
    assertActive();
    const normalizedId = governanceIdentifier(id, 'readiness requirement', 120);
    const requirement = requirements.get(normalizedId);
    if (!requirement) throw new Error(`unknown readiness requirement: ${normalizedId}`);
    const normalizedStatus = normalizeStatus(status);
    const observedAt = Number.isFinite(recordOptions.observedAt)
      ? Math.max(0, Number(recordOptions.observedAt))
      : clock.now();
    const expiresAt = requirement.ttlMs === null ? null : observedAt + requirement.ttlMs;
    const code = boundedText(recordOptions.code, '', 80) || undefined;
    const detail = recordOptions.detail === undefined
      ? undefined
      : sanitizeEvidenceDetail(recordOptions.detail);
    evidence.set(normalizedId, Object.freeze({
      id: normalizedId,
      status: normalizedStatus,
      observedAt,
      expiresAt,
      ...(code ? { code } : {}),
      ...(detail === undefined ? {} : { detail }),
    }));
    const current = snapshot();
    remember(normalizedId, normalizedStatus, current.state, code);
    notify(current);
    return current;
  };

  const clearEvidence = (id: string): boolean => {
    assertActive();
    const normalized = governanceIdentifier(id, 'readiness requirement', 120);
    const removed = evidence.delete(normalized);
    if (removed) notify(snapshot());
    return removed;
  };

  const subscribe = (
    listener: (current: ReadinessSnapshot) => void,
    emitCurrent = false,
  ): (() => void) => {
    assertActive();
    if (typeof listener !== 'function') throw new TypeError('readiness listener must be a function');
    listeners.add(listener);
    if (emitCurrent) {
      try {
        listener(snapshot());
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    requirements.clear();
    evidence.clear();
    history.splice(0);
    listeners.clear();
  };

  return Object.freeze({
    register,
    record,
    clearEvidence,
    snapshot,
    history: () => freezeArray(history),
    subscribe,
    dispose,
  });
};
