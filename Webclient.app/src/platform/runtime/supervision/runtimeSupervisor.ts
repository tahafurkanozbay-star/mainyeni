import {
  boundedInteger,
  normalizeIdentifier,
  safeObserver,
  type ComponentLifecycleSnapshot,
  type HealthSignal,
  type LifecycleComponent,
  type LifecycleEvent,
  type ReadinessReport,
  type RequestCoordinatorSnapshot,
  type RequestExecutionContext,
} from './contracts';
import {
  HealthRegistry,
  type HealthRegistrySnapshot,
} from './healthRegistry';
import {
  LifecycleCoordinator,
  type LifecycleCoordinatorOptions,
  type LifecycleRunResult,
} from './lifecycleCoordinator';
import {
  RequestCoordinator,
  type CoordinatedRequestOptions,
  type RequestCoordinatorOptions,
} from './requestCoordinator';
import type { DependencyGraphSnapshot } from './dependencyGraph';

export interface RuntimeSupervisorOptions {
  readonly lifecycle?: Omit<LifecycleCoordinatorOptions, 'health' | 'onEvent'>;
  readonly requests?: RequestCoordinatorOptions;
  readonly healthTtlMs?: number;
  readonly eventHistoryLimit?: number;
  readonly onEvent?: (event: RuntimeSupervisorEvent) => void;
}

export interface RuntimeSupervisorEvent {
  readonly type: 'lifecycle' | 'health' | 'request' | 'supervisor';
  readonly timestamp: number;
  readonly name: string;
  readonly componentId: string | null;
  readonly message: string | null;
}

export interface RuntimeSupervisorSnapshot {
  readonly generatedAt: number;
  readonly started: boolean;
  readonly graph: DependencyGraphSnapshot;
  readonly lifecycle: readonly ComponentLifecycleSnapshot[];
  readonly health: HealthRegistrySnapshot;
  readonly readiness: ReadinessReport;
  readonly requests: RequestCoordinatorSnapshot;
  readonly events: readonly RuntimeSupervisorEvent[];
}

export interface RuntimeWorkOptions extends CoordinatedRequestOptions {
  readonly requireReady?: boolean;
  readonly componentId?: string;
}

export class RuntimeNotReadyError extends Error {
  readonly code = 'RUNTIME_NOT_READY';
  readonly readiness: ReadinessReport;

  constructor(readiness: ReadinessReport) {
    super(`Runtime is not ready: ${readiness.summary}.`);
    this.name = 'RuntimeNotReadyError';
    this.readiness = readiness;
  }
}

export class ComponentUnavailableError extends Error {
  readonly code = 'COMPONENT_UNAVAILABLE';
  readonly componentId: string;

  constructor(componentId: string) {
    super(`Runtime component "${componentId}" is not available.`);
    this.name = 'ComponentUnavailableError';
    this.componentId = componentId;
  }
}

export class RuntimeSupervisor {
  readonly #health: HealthRegistry;
  readonly #lifecycle: LifecycleCoordinator;
  readonly #requests: RequestCoordinator;
  readonly #events: RuntimeSupervisorEvent[] = [];
  readonly #eventHistoryLimit: number;
  readonly #onEvent: ((event: RuntimeSupervisorEvent) => void) | undefined;
  readonly #now: () => number;
  #started = false;

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.#now = options.requests?.now ?? options.lifecycle?.clock?.now ?? Date.now;
    this.#eventHistoryLimit = boundedInteger(options.eventHistoryLimit, 256, 16, 4096);
    this.#onEvent = options.onEvent;
    this.#health = new HealthRegistry({
      ...(options.healthTtlMs === undefined ? {} : { defaultTtlMs: options.healthTtlMs }),
      now: this.#now,
      onChange: (snapshot) => {
        this.#recordEvent({
          type: 'health',
          name: 'health-change',
          componentId: snapshot.componentId,
          message: `${snapshot.status}${snapshot.stale ? ':stale' : ''}`,
        });
      },
    });
    this.#lifecycle = new LifecycleCoordinator({
      ...options.lifecycle,
      health: this.#health,
      onEvent: (event) => this.#recordLifecycleEvent(event),
    });
    this.#requests = new RequestCoordinator({
      ...options.requests,
      onChange: (snapshot) => {
        this.#recordEvent({
          type: 'request',
          name: 'request-state',
          componentId: null,
          message: `${snapshot.active} active / ${snapshot.queued} queued`,
        });
        safeObserver(options.requests?.onChange, snapshot);
      },
    });
  }

  get health(): HealthRegistry {
    return this.#health;
  }

  get lifecycle(): LifecycleCoordinator {
    return this.#lifecycle;
  }

  get requests(): RequestCoordinator {
    return this.#requests;
  }

  get started(): boolean {
    return this.#started;
  }

  register(component: LifecycleComponent): void {
    this.#lifecycle.register(component);
    this.#recordEvent({
      type: 'supervisor',
      name: 'component-registered',
      componentId: normalizeIdentifier(component.id, 'component id'),
      message: null,
    });
  }

  unregister(componentId: string): boolean {
    const id = normalizeIdentifier(componentId, 'component id');
    const removed = this.#lifecycle.unregister(id);
    if (removed) {
      this.#recordEvent({
        type: 'supervisor',
        name: 'component-unregistered',
        componentId: id,
        message: null,
      });
    }
    return removed;
  }

  async start(signal?: AbortSignal): Promise<LifecycleRunResult> {
    const result = await this.#lifecycle.startAll(signal);
    this.#started = this.#lifecycle.running;
    this.#recordEvent({
      type: 'supervisor',
      name: result.success ? 'runtime-started' : 'runtime-start-incomplete',
      componentId: null,
      message: `${result.started.length} started, ${result.failed.length} failed, ${result.skipped.length} skipped`,
    });
    return result;
  }

  async stop(signal?: AbortSignal): Promise<LifecycleRunResult> {
    this.#requests.cancelAll(new DOMException('Runtime is stopping.', 'AbortError'));
    const result = await this.#lifecycle.stopAll(signal);
    this.#started = false;
    this.#recordEvent({
      type: 'supervisor',
      name: result.success ? 'runtime-stopped' : 'runtime-stop-incomplete',
      componentId: null,
      message: `${result.stopped.length} stopped, ${result.failed.length} failed`,
    });
    return result;
  }

  reportHealth(signal: HealthSignal): void {
    this.#health.report(signal);
  }

  readiness(): ReadinessReport {
    return this.#health.readiness();
  }

  async execute<TValue>(
    operation: (context: RequestExecutionContext) => Promise<TValue> | TValue,
    options: RuntimeWorkOptions,
  ): Promise<TValue> {
    if (options.requireReady !== false) {
      const readiness = this.#health.readiness();
      if (readiness.status === 'not-ready') throw new RuntimeNotReadyError(readiness);
    }
    if (options.componentId) this.#assertComponentAvailable(options.componentId);
    return this.#requests.submit(operation, options);
  }

  cancelRequest(key: string, reason?: unknown): boolean {
    return this.#requests.cancel(key, reason);
  }

  async restart(componentId: string, signal?: AbortSignal): Promise<void> {
    await this.#lifecycle.restart(componentId, signal);
    this.#recordEvent({
      type: 'supervisor',
      name: 'component-restarted',
      componentId: normalizeIdentifier(componentId, 'component id'),
      message: null,
    });
  }

  snapshot(): RuntimeSupervisorSnapshot {
    const health = this.#health.snapshot();
    return Object.freeze({
      generatedAt: this.#now(),
      started: this.#started,
      graph: this.#lifecycle.graph(),
      lifecycle: this.#lifecycle.states(),
      health,
      readiness: health.readiness,
      requests: this.#requests.snapshot(),
      events: Object.freeze([...this.#events]),
    });
  }

  events(limit = this.#eventHistoryLimit): readonly RuntimeSupervisorEvent[] {
    const normalizedLimit = boundedInteger(limit, this.#eventHistoryLimit, 1, this.#eventHistoryLimit);
    return Object.freeze(this.#events.slice(-normalizedLimit));
  }

  clearEvents(): void {
    this.#events.splice(0);
  }

  #assertComponentAvailable(componentId: string): void {
    const id = normalizeIdentifier(componentId, 'component id');
    const state = this.#lifecycle.state(id);
    const health = this.#health.get(id);
    if (!state || state.state !== 'running' || health?.status === 'unhealthy' || health?.stale) {
      throw new ComponentUnavailableError(id);
    }
  }

  #recordLifecycleEvent(event: LifecycleEvent): void {
    this.#recordEvent({
      type: 'lifecycle',
      name: event.type,
      componentId: event.componentId,
      message: event.message,
      timestamp: event.timestamp,
    });
  }

  #recordEvent(
    event: Omit<RuntimeSupervisorEvent, 'timestamp'> & { readonly timestamp?: number },
  ): void {
    const normalized: RuntimeSupervisorEvent = Object.freeze({
      type: event.type,
      timestamp: event.timestamp ?? this.#now(),
      name: event.name,
      componentId: event.componentId,
      message: event.message,
    });
    this.#events.push(normalized);
    if (this.#events.length > this.#eventHistoryLimit) {
      this.#events.splice(0, this.#events.length - this.#eventHistoryLimit);
    }
    safeObserver(this.#onEvent, normalized);
  }
}
