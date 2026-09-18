import {
  RuntimeSupervisor,
  type LifecycleComponent,
  type ReadinessReport,
  type RequestExecutionContext,
  type RuntimeSupervisorOptions,
  type RuntimeSupervisorSnapshot,
  type RuntimeWorkOptions,
} from './supervision';
import {
  createRuntimeReadinessBarrier,
  type RuntimeReadinessBarrier,
  type RuntimeReadinessBarrierOptions,
  type RuntimeReadinessBarrierSnapshot,
  type RuntimeReadinessWaitOptions,
} from './runtimeReadinessBarrier';
import {
  createRuntimeHealthSupervisorBridge,
  type RuntimeHealthBridgeTransition,
  type RuntimeHealthSupervisorBridge,
  type RuntimeHealthSupervisorBridgeOptions,
  type RuntimeHealthSupervisorBridgeSnapshot,
} from './runtimeHealthSupervisorBridge';
import {
  createSupervisorRecoveryCoordinator,
  type RuntimeRecoveryCoordinator,
  type RuntimeRecoveryCoordinatorOptions,
  type RuntimeRecoveryCoordinatorSnapshot,
  type RuntimeRecoveryRequest,
  type RuntimeRecoveryResult,
} from './runtimeRecoveryCoordinator';
import {
  RuntimeOwnershipScope,
  type RuntimeOwnershipScopeOptions,
  type RuntimeOwnershipScopeSnapshot,
} from './runtimeOwnershipScope';
import type { RuntimeHealthEvent } from './runtimeHealthJournal';

export type RuntimeControlPlanePhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'disposed';

export interface RuntimeControlPlaneOptions {
  readonly supervisor?: RuntimeSupervisorOptions;
  readonly readiness?: RuntimeReadinessBarrierOptions;
  readonly health?: RuntimeHealthSupervisorBridgeOptions;
  readonly recovery?: RuntimeRecoveryCoordinatorOptions;
  readonly ownership?: RuntimeOwnershipScopeOptions;
  readonly eventHistoryLimit?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: RuntimeControlPlaneEvent) => void;
}

export interface RuntimeControlPlaneExecutionOptions extends RuntimeWorkOptions {
  readonly waitForReady?: boolean;
  readonly readiness?: RuntimeReadinessWaitOptions;
}

export interface RuntimeControlPlaneEvent {
  readonly at: number;
  readonly type: 'phase' | 'health' | 'readiness' | 'recovery' | 'ownership';
  readonly name: string;
  readonly componentId: string | null;
  readonly message: string | null;
}

export interface RuntimeControlPlaneSnapshot {
  readonly generatedAt: number;
  readonly phase: RuntimeControlPlanePhase;
  readonly readiness: ReadinessReport;
  readonly supervisor: RuntimeSupervisorSnapshot;
  readonly barrier: RuntimeReadinessBarrierSnapshot;
  readonly health: RuntimeHealthSupervisorBridgeSnapshot;
  readonly recovery: RuntimeRecoveryCoordinatorSnapshot;
  readonly ownership: RuntimeOwnershipScopeSnapshot;
  readonly events: readonly RuntimeControlPlaneEvent[];
}

export interface RuntimeControlPlane {
  readonly supervisor: RuntimeSupervisor;
  readonly readinessBarrier: RuntimeReadinessBarrier;
  readonly healthBridge: RuntimeHealthSupervisorBridge;
  readonly recovery: RuntimeRecoveryCoordinator;
  readonly ownership: RuntimeOwnershipScope;
  readonly phase: () => RuntimeControlPlanePhase;
  readonly register: (component: LifecycleComponent) => void;
  readonly unregister: (componentId: string) => boolean;
  readonly start: (signal?: AbortSignal) => Promise<RuntimeControlPlaneSnapshot>;
  readonly stop: (signal?: AbortSignal) => Promise<RuntimeControlPlaneSnapshot>;
  readonly execute: <TValue>(
    operation: (context: RequestExecutionContext) => Promise<TValue> | TValue,
    options: RuntimeControlPlaneExecutionOptions,
  ) => Promise<TValue>;
  readonly recordHealth: (event: RuntimeHealthEvent) => RuntimeHealthBridgeTransition;
  readonly assessHealth: (at?: number) => RuntimeHealthBridgeTransition;
  readonly recover: (request: RuntimeRecoveryRequest) => Promise<RuntimeRecoveryResult>;
  readonly waitUntilReady: (options?: RuntimeReadinessWaitOptions) => Promise<ReadinessReport>;
  readonly snapshot: () => RuntimeControlPlaneSnapshot;
  readonly events: (limit?: number) => readonly RuntimeControlPlaneEvent[];
  readonly subscribe: (listener: (snapshot: RuntimeControlPlaneSnapshot) => void) => () => void;
  readonly dispose: (reason?: unknown) => Promise<void>;
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === 'string') return error.slice(0, 1000);
  return 'Unknown runtime control-plane failure.';
};

const safeEventObserver = (
  observer: RuntimeControlPlaneOptions['onEvent'],
  event: RuntimeControlPlaneEvent,
): void => {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Control plane behavior never depends on diagnostics observers.
  }
};

const safeSnapshotObserver = (
  observer: (snapshot: RuntimeControlPlaneSnapshot) => void,
  snapshot: RuntimeControlPlaneSnapshot,
): void => {
  try {
    observer(snapshot);
  } catch {
    // Snapshot listeners are isolated from runtime lifecycle decisions.
  }
};

const phaseForReadiness = (
  current: RuntimeControlPlanePhase,
  readiness: ReadinessReport,
): RuntimeControlPlanePhase => {
  if (current === 'disposed' || current === 'failed' || current === 'stopping' || current === 'stopped') return current;
  if (current === 'idle' || current === 'starting') return current;
  return readiness.status === 'ready' ? 'running' : 'degraded';
};

export class RuntimeControlPlaneDisposedError extends Error {
  readonly code = 'RUNTIME_CONTROL_PLANE_DISPOSED';

  constructor() {
    super('Runtime control plane has been disposed.');
    this.name = 'RuntimeControlPlaneDisposedError';
  }
}

export const createRuntimeControlPlane = (
  options: RuntimeControlPlaneOptions = {},
): RuntimeControlPlane => {
  const now = options.now ?? Date.now;
  const eventHistoryLimit = boundedInteger(options.eventHistoryLimit, 256, 16, 4096);
  const events: RuntimeControlPlaneEvent[] = [];
  const listeners = new Set<(snapshot: RuntimeControlPlaneSnapshot) => void>();
  let currentPhase: RuntimeControlPlanePhase = 'idle';
  let disposed = false;
  let lifecycle: Promise<RuntimeControlPlaneSnapshot> | null = null;

  const recordEvent = (
    type: RuntimeControlPlaneEvent['type'],
    name: string,
    componentId: string | null,
    message: string | null,
  ): void => {
    const event: RuntimeControlPlaneEvent = Object.freeze({
      at: now(),
      type,
      name: name.slice(0, 160),
      componentId,
      message: message?.slice(0, 1000) ?? null,
    });
    events.push(event);
    if (events.length > eventHistoryLimit) events.splice(0, events.length - eventHistoryLimit);
    safeEventObserver(options.onEvent, event);
  };

  const transition = (next: RuntimeControlPlanePhase, message: string | null = null): void => {
    if (currentPhase === next) return;
    const previous = currentPhase;
    currentPhase = next;
    recordEvent('phase', 'phase-transition', null, `${previous}->${next}${message ? `:${message}` : ''}`);
  };

  const supervisor = new RuntimeSupervisor({
    ...options.supervisor,
    onEvent: (event) => {
      options.supervisor?.onEvent?.(event);
      if (event.type === 'health') {
        recordEvent('health', event.name, event.componentId, event.message);
      }
    },
  });
  const readinessBarrier = createRuntimeReadinessBarrier(options.readiness);
  const ownership = new RuntimeOwnershipScope({
    ...options.ownership,
    label: options.ownership?.label ?? 'runtime-control-plane',
    now,
    onFailure: (failure) => {
      options.ownership?.onFailure?.(failure);
      recordEvent('ownership', 'dispose-failure', null, `${failure.label}:${failure.message}`);
    },
  });
  const recovery = createSupervisorRecoveryCoordinator(supervisor, {
    ...options.recovery,
    onEvent: (event) => {
      options.recovery?.onEvent?.(event);
      recordEvent('recovery', event.outcome, event.componentId, event.message ?? event.reason);
    },
  });
  const healthBridge = createRuntimeHealthSupervisorBridge(supervisor, {
    ...options.health,
    now,
    onTransition: (healthTransition) => {
      options.health?.onTransition?.(healthTransition);
      recordEvent(
        'health',
        healthTransition.changed ? 'health-transition' : 'health-assessment',
        options.health?.componentId ?? 'runtime-control-plane',
        `${healthTransition.previous}->${healthTransition.current}`,
      );
    },
  });

  const assertActive = (): void => {
    if (disposed) throw new RuntimeControlPlaneDisposedError();
  };

  const appendUnique = (values: readonly string[], value: string): readonly string[] =>
    Object.freeze([...new Set([...values, value])].sort((left, right) => left.localeCompare(right)));

  const without = (values: readonly string[], value: string): readonly string[] =>
    Object.freeze(values.filter((entry) => entry !== value));

  const currentReadiness = (): ReadinessReport => {
    const base = supervisor.readiness();
    const health = healthBridge.snapshot();
    const componentId = health.componentId;
    const state = health.assessment.state;
    if (state === 'healthy') return base;

    const required = appendUnique(base.required, componentId);
    const healthy = without(base.healthy, componentId);
    const unknown = without(base.unknown, componentId);
    const disabled = without(base.disabled, componentId);
    const stale = without(base.stale, componentId);

    if (state === 'degraded') {
      const degraded = appendUnique(without(base.degraded, componentId), componentId);
      const unhealthy = without(base.unhealthy, componentId);
      return Object.freeze({
        status: base.status === 'not-ready' ? 'not-ready' : 'degraded',
        generatedAt: Math.max(base.generatedAt, health.generatedAt),
        required,
        healthy,
        degraded,
        unhealthy,
        unknown,
        disabled,
        stale,
        summary: `${base.summary}; runtime health degraded (${health.assessment.score}/100)`,
      });
    }

    return Object.freeze({
      status: 'not-ready',
      generatedAt: Math.max(base.generatedAt, health.generatedAt),
      required,
      healthy,
      degraded: without(base.degraded, componentId),
      unhealthy: appendUnique(without(base.unhealthy, componentId), componentId),
      unknown,
      disabled,
      stale,
      summary: `${base.summary}; runtime health ${state} (${health.assessment.score}/100)`,
    });
  };

  const refreshReadiness = (): ReadinessReport => {
    const readiness = currentReadiness();
    readinessBarrier.update(readiness);
    const nextPhase = phaseForReadiness(currentPhase, readiness);
    if (nextPhase !== currentPhase) transition(nextPhase, readiness.status);
    recordEvent('readiness', readiness.status, null, readiness.summary);
    return readiness;
  };

  const snapshot = (): RuntimeControlPlaneSnapshot => {
    assertActive();
    const supervisorSnapshot = supervisor.snapshot();
    const health = healthBridge.snapshot();
    const readiness = currentReadiness();
    return Object.freeze({
      generatedAt: now(),
      phase: currentPhase,
      readiness,
      supervisor: supervisorSnapshot,
      barrier: readinessBarrier.snapshot(),
      health,
      recovery: recovery.snapshot(),
      ownership: ownership.snapshot(),
      events: Object.freeze([...events]),
    });
  };

  const notify = (): void => {
    if (disposed || listeners.size === 0) return;
    const current = snapshot();
    for (const listener of listeners) safeSnapshotObserver(listener, current);
  };

  const healthUnsubscribe = supervisor.health.subscribe(() => {
    if (disposed) return;
    refreshReadiness();
    notify();
  });
  ownership.own(healthUnsubscribe, 'health-registry-subscription');

  const register = (component: LifecycleComponent): void => {
    assertActive();
    supervisor.register(component);
    refreshReadiness();
    notify();
  };

  const unregister = (componentId: string): boolean => {
    assertActive();
    const removed = supervisor.unregister(componentId);
    if (removed) {
      refreshReadiness();
      notify();
    }
    return removed;
  };

  const start = (signal?: AbortSignal): Promise<RuntimeControlPlaneSnapshot> => {
    if (disposed) return Promise.reject(new RuntimeControlPlaneDisposedError());
    if (currentPhase === 'running' || currentPhase === 'degraded') return Promise.resolve(snapshot());
    if (lifecycle) return lifecycle;

    transition('starting');
    lifecycle = (async () => {
      try {
        const result = await supervisor.start(signal);
        const readiness = refreshReadiness();
        if (!result.success && readiness.status === 'not-ready') {
          transition('failed', 'startup-incomplete');
        } else {
          transition(readiness.status === 'ready' ? 'running' : 'degraded', readiness.status);
        }
        notify();
        return snapshot();
      } catch (error) {
        transition('failed', errorMessage(error));
        notify();
        throw error;
      } finally {
        lifecycle = null;
      }
    })();
    return lifecycle;
  };

  const stop = (signal?: AbortSignal): Promise<RuntimeControlPlaneSnapshot> => {
    if (disposed) return Promise.reject(new RuntimeControlPlaneDisposedError());
    if (currentPhase === 'stopped' || currentPhase === 'idle') {
      transition('stopped');
      return Promise.resolve(snapshot());
    }
    if (lifecycle) return lifecycle.then(() => stop(signal));

    transition('stopping');
    lifecycle = (async () => {
      try {
        await supervisor.stop(signal);
        refreshReadiness();
        transition('stopped');
        notify();
        return snapshot();
      } catch (error) {
        transition('failed', errorMessage(error));
        notify();
        throw error;
      } finally {
        lifecycle = null;
      }
    })();
    return lifecycle;
  };

  const waitUntilReady = (waitOptions?: RuntimeReadinessWaitOptions): Promise<ReadinessReport> => {
    assertActive();
    refreshReadiness();
    return readinessBarrier.wait(waitOptions);
  };

  const execute = async <TValue>(
    operation: (context: RequestExecutionContext) => Promise<TValue> | TValue,
    executionOptions: RuntimeControlPlaneExecutionOptions,
  ): Promise<TValue> => {
    assertActive();
    if (executionOptions.waitForReady !== false) {
      await waitUntilReady(executionOptions.readiness);
    }
    const {
      waitForReady: _waitForReady,
      readiness: _readiness,
      ...supervisorOptions
    } = executionOptions;
    return supervisor.execute(operation, {
      ...supervisorOptions,
      requireReady: supervisorOptions.requireReady !== false,
    });
  };

  const recordHealth = (event: RuntimeHealthEvent): RuntimeHealthBridgeTransition => {
    assertActive();
    const result = healthBridge.record(event);
    refreshReadiness();
    notify();
    return result;
  };

  const assessHealth = (at?: number): RuntimeHealthBridgeTransition => {
    assertActive();
    const result = healthBridge.assess(at);
    refreshReadiness();
    notify();
    return result;
  };

  const recover = async (request: RuntimeRecoveryRequest): Promise<RuntimeRecoveryResult> => {
    assertActive();
    const result = await recovery.request(request);
    refreshReadiness();
    notify();
    return result;
  };

  const eventList = (limit = eventHistoryLimit): readonly RuntimeControlPlaneEvent[] => {
    const normalized = boundedInteger(limit, eventHistoryLimit, 1, eventHistoryLimit);
    return Object.freeze(events.slice(-normalized));
  };

  const subscribe = (listener: (current: RuntimeControlPlaneSnapshot) => void): (() => void) => {
    assertActive();
    if (typeof listener !== 'function') throw new TypeError('Control-plane listener must be a function.');
    listeners.add(listener);
    safeSnapshotObserver(listener, snapshot());
    return () => listeners.delete(listener);
  };

  const dispose = async (reason: unknown = new RuntimeControlPlaneDisposedError()): Promise<void> => {
    if (disposed) return;
    try {
      if (currentPhase !== 'idle' && currentPhase !== 'stopped' && currentPhase !== 'failed') {
        await stop();
      }
    } catch {
      // Disposal remains best-effort and continues with subordinate resources.
    }
    disposed = true;
    recovery.dispose(reason);
    healthBridge.dispose();
    readinessBarrier.dispose(reason);
    listeners.clear();
    await ownership.dispose(reason);
    currentPhase = 'disposed';
  };

  return Object.freeze({
    supervisor,
    readinessBarrier,
    healthBridge,
    recovery,
    ownership,
    phase: () => currentPhase,
    register,
    unregister,
    start,
    stop,
    execute,
    recordHealth,
    assessHealth,
    recover,
    waitUntilReady,
    snapshot,
    events: eventList,
    subscribe,
    dispose,
  });
};
