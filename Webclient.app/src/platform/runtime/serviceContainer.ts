import {
  createServiceGraph,
  type NormalizedServiceDescriptor,
  type ServiceCriticality,
  type ServiceDescriptor,
  type ServiceGraphBuilder,
  type ServiceGraphOptions,
  type ServiceGraphSnapshot,
  type ServiceStartupMode,
} from './serviceGraph';

export interface ServiceToken<T> {
  readonly id: string;
  readonly __type?: T;
}

export interface ServiceFactoryContext {
  readonly serviceId: string;
  readonly signal: AbortSignal;
  readonly dependency: <T>(token: ServiceToken<T>) => T;
  readonly optional: <T>(token: ServiceToken<T>) => T | undefined;
}

export interface ServiceStopContext {
  readonly serviceId: string;
  readonly signal: AbortSignal;
  readonly reason: string;
}

export interface ServiceDefinition<T> {
  readonly token: ServiceToken<T>;
  readonly version: string;
  readonly domain: string;
  readonly criticality?: ServiceCriticality;
  readonly startup?: ServiceStartupMode;
  readonly dependsOn?: readonly ServiceToken<unknown>[];
  readonly optionalDependencies?: readonly ServiceToken<unknown>[];
  readonly provides?: readonly string[];
  readonly consumes?: readonly string[];
  readonly lifecycleTimeoutMs?: number;
  readonly start: (context: ServiceFactoryContext) => T | Promise<T>;
  readonly stop?: (
    instance: T,
    context: ServiceStopContext,
  ) => void | Promise<void>;
}

export type ServiceContainerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'disposed';

export type ServiceRuntimeStatus =
  | 'registered'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export type ServiceContainerEventKind =
  | 'registered'
  | 'removed'
  | 'sealed'
  | 'container-starting'
  | 'container-ready'
  | 'container-degraded'
  | 'container-failed'
  | 'service-starting'
  | 'service-ready'
  | 'service-failed'
  | 'service-stopping'
  | 'service-stopped'
  | 'service-stop-failed'
  | 'rollback-started'
  | 'rollback-completed'
  | 'container-stopping'
  | 'container-stopped'
  | 'container-disposed'
  | 'observer-failed';

export interface ServiceContainerEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: ServiceContainerEventKind;
  readonly state: ServiceContainerState;
  readonly serviceId?: string;
  readonly errorName?: string;
  readonly code?: ServiceContainerErrorCode;
  readonly durationMs?: number;
}

export interface ServiceRuntimeSnapshot {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly criticality: ServiceCriticality;
  readonly startup: ServiceStartupMode;
  readonly status: ServiceRuntimeStatus;
  readonly starts: number;
  readonly stops: number;
  readonly startedAt?: number;
  readonly readyAt?: number;
  readonly stoppedAt?: number;
  readonly startDurationMs?: number;
  readonly stopDurationMs?: number;
  readonly failureCode?: ServiceContainerErrorCode;
  readonly errorName?: string;
}

export interface ServiceContainerCounters {
  readonly registered: number;
  readonly removed: number;
  readonly starts: number;
  readonly startFailures: number;
  readonly optionalFailures: number;
  readonly stops: number;
  readonly stopFailures: number;
  readonly rollbacks: number;
  readonly rejected: number;
  readonly observerFailures: number;
}

export interface ServiceContainerSnapshot {
  readonly state: ServiceContainerState;
  readonly sealed: boolean;
  readonly generation: number;
  readonly graph: ServiceGraphSnapshot;
  readonly services: readonly ServiceRuntimeSnapshot[];
  readonly counters: ServiceContainerCounters;
  readonly events: readonly ServiceContainerEvent[];
  readonly fingerprint: string;
}

export interface ServiceContainerClock {
  readonly now: () => number;
  readonly setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ServiceContainerOptions extends ServiceGraphOptions {
  readonly historyLimit?: number;
  readonly defaultLifecycleTimeoutMs?: number;
  readonly maxLifecycleTimeoutMs?: number;
  readonly clock?: ServiceContainerClock;
  readonly parentSignal?: AbortSignal;
  readonly onEvent?: (event: ServiceContainerEvent) => void;
}

export interface ServiceContainerStopOptions {
  readonly reason?: unknown;
  readonly throwOnStopError?: boolean;
}

export interface ServiceContainer {
  readonly state: ServiceContainerState;
  readonly sealed: boolean;
  readonly register: <T>(definition: ServiceDefinition<T>) => () => void;
  readonly remove: (token: ServiceToken<unknown>) => boolean;
  readonly seal: () => ServiceGraphSnapshot;
  readonly start: () => Promise<ServiceContainerSnapshot>;
  readonly resolve: <T>(token: ServiceToken<T>) => Promise<T>;
  readonly get: <T>(token: ServiceToken<T>) => T;
  readonly has: (token: ServiceToken<unknown>) => boolean;
  readonly snapshot: () => ServiceContainerSnapshot;
  readonly stop: (options?: ServiceContainerStopOptions) => Promise<ServiceContainerSnapshot>;
  readonly dispose: (reason?: unknown) => Promise<void>;
}

export type ServiceContainerErrorCode =
  | 'INVALID_DEFINITION'
  | 'DUPLICATE_SERVICE'
  | 'SERVICE_NOT_FOUND'
  | 'SERVICE_NOT_READY'
  | 'DEPENDENCY_NOT_DECLARED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'GRAPH_INVALID'
  | 'REGISTRATION_CLOSED'
  | 'CONTAINER_STOPPING'
  | 'CONTAINER_DISPOSED'
  | 'START_FAILED'
  | 'START_TIMEOUT'
  | 'STOP_FAILED'
  | 'STOP_TIMEOUT'
  | 'ABORTED';

export class ServiceContainerError extends Error {
  constructor(
    readonly code: ServiceContainerErrorCode,
    message: string,
    readonly serviceId?: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'ServiceContainerError';
  }
}

interface InternalDefinition {
  readonly token: ServiceToken<unknown>;
  readonly descriptor: NormalizedServiceDescriptor;
  readonly lifecycleTimeoutMs: number;
  readonly start: (context: ServiceFactoryContext) => unknown | Promise<unknown>;
  readonly stop?: (
    instance: unknown,
    context: ServiceStopContext,
  ) => void | Promise<void>;
}

interface ServiceRecord {
  readonly definition: InternalDefinition;
  status: ServiceRuntimeStatus;
  instance: unknown;
  starts: number;
  stops: number;
  startedAt?: number;
  readyAt?: number;
  stoppedAt?: number;
  startDurationMs?: number;
  stopDurationMs?: number;
  failureCode?: ServiceContainerErrorCode;
  errorName?: string;
  startPromise: Promise<unknown> | null;
  controller: AbortController | null;
}

interface MutableCounters {
  registered: number;
  removed: number;
  starts: number;
  startFailures: number;
  optionalFailures: number;
  stops: number;
  stopFailures: number;
  rollbacks: number;
  rejected: number;
  observerFailures: number;
}

const ID_PATTERN = /^[a-z][a-z0-9.-]{0,79}$/u;

const SYSTEM_CLOCK: ServiceContainerClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

const boundedInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ServiceContainerError(
      'INVALID_DEFINITION',
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const normalizedTokenId = (token: ServiceToken<unknown>): string => {
  if (!token || typeof token.id !== 'string') {
    throw new ServiceContainerError(
      'INVALID_DEFINITION',
      'service token must contain an id',
    );
  }
  const normalized = token.id.trim().toLowerCase();
  if (!ID_PATTERN.test(normalized)) {
    throw new ServiceContainerError(
      'INVALID_DEFINITION',
      'service token id must match ' + ID_PATTERN.source,
    );
  }
  return normalized;
};

export const createServiceToken = <T>(id: string): ServiceToken<T> => {
  const normalized = normalizedTokenId({ id });
  return Object.freeze({ id: normalized }) as ServiceToken<T>;
};

const safeErrorName = (error: unknown): string =>
  error instanceof Error && error.name.trim()
    ? error.name.trim().slice(0, 80)
    : 'UnknownError';

const safeReason = (reason: unknown): string => {
  if (reason instanceof ServiceContainerError) return reason.code.toLowerCase();
  if (reason instanceof Error && reason.name.trim()) return reason.name.trim().slice(0, 80);
  if (typeof reason === 'string') {
    const normalized = reason.replace(/[\r\n\t]/g, ' ').trim();
    return normalized ? normalized.slice(0, 80) : 'unspecified';
  }
  return reason === undefined ? 'unspecified' : 'external';
};

const errorCode = (
  error: unknown,
  fallback: ServiceContainerErrorCode,
): ServiceContainerErrorCode =>
  error instanceof ServiceContainerError ? error.code : fallback;

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const definitionDescriptor = <T>(
  definition: ServiceDefinition<T>,
): ServiceDescriptor => ({
  id: normalizedTokenId(definition.token),
  version: definition.version,
  domain: definition.domain,
  ...(definition.criticality === undefined
    ? {}
    : { criticality: definition.criticality }),
  ...(definition.startup === undefined ? {} : { startup: definition.startup }),
  dependsOn: Object.freeze(
    (definition.dependsOn ?? []).map((token) => normalizedTokenId(token)),
  ),
  optionalDependencies: Object.freeze(
    (definition.optionalDependencies ?? []).map((token) => normalizedTokenId(token)),
  ),
  provides: Object.freeze([...(definition.provides ?? [])]),
  consumes: Object.freeze([...(definition.consumes ?? [])]),
});

const eraseDefinition = <T>(
  definition: ServiceDefinition<T>,
  descriptor: NormalizedServiceDescriptor,
  lifecycleTimeoutMs: number,
): InternalDefinition => {
  if (typeof definition.start !== 'function') {
    throw new ServiceContainerError(
      'INVALID_DEFINITION',
      'service start factory must be a function',
      descriptor.id,
    );
  }
  if (definition.stop !== undefined && typeof definition.stop !== 'function') {
    throw new ServiceContainerError(
      'INVALID_DEFINITION',
      'service stop hook must be a function',
      descriptor.id,
    );
  }

  const start = definition.start as (
    context: ServiceFactoryContext,
  ) => unknown | Promise<unknown>;
  const stop = definition.stop === undefined
    ? undefined
    : definition.stop as (
      instance: unknown,
      context: ServiceStopContext,
    ) => void | Promise<void>;

  return Object.freeze({
    token: Object.freeze({ id: descriptor.id }),
    descriptor,
    lifecycleTimeoutMs,
    start,
    ...(stop === undefined ? {} : { stop }),
  });
};

const freezeCounters = (
  counters: MutableCounters,
): ServiceContainerCounters => Object.freeze({ ...counters });

const serviceSnapshot = (record: ServiceRecord): ServiceRuntimeSnapshot => {
  const descriptor = record.definition.descriptor;
  return Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    domain: descriptor.domain,
    criticality: descriptor.criticality,
    startup: descriptor.startup,
    status: record.status,
    starts: record.starts,
    stops: record.stops,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.readyAt === undefined ? {} : { readyAt: record.readyAt }),
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
    ...(record.startDurationMs === undefined
      ? {}
      : { startDurationMs: record.startDurationMs }),
    ...(record.stopDurationMs === undefined
      ? {}
      : { stopDurationMs: record.stopDurationMs }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    ...(record.errorName === undefined ? {} : { errorName: record.errorName }),
  });
};

class BoundedServiceContainer implements ServiceContainer {
  readonly #graph: ServiceGraphBuilder;
  readonly #records = new Map<string, ServiceRecord>();
  readonly #clock: ServiceContainerClock;
  readonly #historyLimit: number;
  readonly #defaultLifecycleTimeoutMs: number;
  readonly #maxLifecycleTimeoutMs: number;
  readonly #onEvent: ((event: ServiceContainerEvent) => void) | undefined;
  readonly #events: ServiceContainerEvent[] = [];
  readonly #counters: MutableCounters = {
    registered: 0,
    removed: 0,
    starts: 0,
    startFailures: 0,
    optionalFailures: 0,
    stops: 0,
    stopFailures: 0,
    rollbacks: 0,
    rejected: 0,
    observerFailures: 0,
  };

  #state: ServiceContainerState = 'idle';
  #sealed = false;
  #generation = 0;
  #eventSequence = 0;
  #lastObservedAt: number | undefined;
  #startPromise: Promise<ServiceContainerSnapshot> | null = null;
  #stopPromise: Promise<ServiceContainerSnapshot> | null = null;
  #controller = new AbortController();
  #parentAbortCleanup: (() => void) | null = null;

  constructor(options: ServiceContainerOptions = {}) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#historyLimit = boundedInteger(
      'historyLimit',
      options.historyLimit ?? 256,
      0,
      4_096,
    );
    this.#maxLifecycleTimeoutMs = boundedInteger(
      'maxLifecycleTimeoutMs',
      options.maxLifecycleTimeoutMs ?? 60_000,
      1,
      10 * 60_000,
    );
    this.#defaultLifecycleTimeoutMs = boundedInteger(
      'defaultLifecycleTimeoutMs',
      options.defaultLifecycleTimeoutMs ?? Math.min(10_000, this.#maxLifecycleTimeoutMs),
      1,
      this.#maxLifecycleTimeoutMs,
    );
    this.#onEvent = options.onEvent;
    this.#graph = createServiceGraph(options);

    if (options.parentSignal) {
      const parentSignal = options.parentSignal;
      const abort = (): void => {
        void this.dispose(parentSignal.reason ?? 'parent-aborted');
      };
      if (parentSignal.aborted) {
        this.#state = 'disposed';
        this.#controller.abort(parentSignal.reason ?? 'parent-aborted');
      } else {
        parentSignal.addEventListener('abort', abort, { once: true });
        this.#parentAbortCleanup = () => parentSignal.removeEventListener('abort', abort);
      }
    }
  }

  get state(): ServiceContainerState {
    return this.#state;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  register<T>(definition: ServiceDefinition<T>): () => void {
    this.#assertRegistrationOpen();
    const descriptorInput = definitionDescriptor(definition);
    const unregisterGraph = this.#graph.register(descriptorInput);
    let descriptor: NormalizedServiceDescriptor;
    try {
      const graphDescriptor = this.#graph.descriptor(descriptorInput.id);
      if (!graphDescriptor) {
        throw new ServiceContainerError(
          'INVALID_DEFINITION',
          'registered graph descriptor could not be resolved',
          descriptorInput.id,
        );
      }
      descriptor = graphDescriptor;
      if (this.#records.has(descriptor.id)) {
        throw new ServiceContainerError(
          'DUPLICATE_SERVICE',
          'service is already registered: ' + descriptor.id,
          descriptor.id,
        );
      }
      const timeout = boundedInteger(
        'lifecycleTimeoutMs',
        definition.lifecycleTimeoutMs ?? this.#defaultLifecycleTimeoutMs,
        1,
        this.#maxLifecycleTimeoutMs,
      );
      const erased = eraseDefinition(definition, descriptor, timeout);
      this.#records.set(descriptor.id, {
        definition: erased,
        status: 'registered',
        instance: undefined,
        starts: 0,
        stops: 0,
        startPromise: null,
        controller: null,
      });
    } catch (error) {
      unregisterGraph();
      this.#counters.rejected += 1;
      throw error;
    }

    this.#counters.registered += 1;
    this.#emit('registered', descriptor.id);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#sealed || this.#state === 'disposed') return;
      if (this.#records.delete(descriptor.id)) {
        unregisterGraph();
        this.#counters.removed += 1;
        this.#emit('removed', descriptor.id);
      }
    };
  }

  remove(token: ServiceToken<unknown>): boolean {
    this.#assertRegistrationOpen();
    const id = normalizedTokenId(token);
    const record = this.#records.get(id);
    if (!record) return false;
    if (record.status !== 'registered' && record.status !== 'stopped') {
      this.#counters.rejected += 1;
      throw new ServiceContainerError(
        'REGISTRATION_CLOSED',
        'active service cannot be removed: ' + id,
        id,
      );
    }
    const removed = this.#records.delete(id);
    if (removed) {
      this.#graph.remove(id);
      this.#counters.removed += 1;
      this.#emit('removed', id);
    }
    return removed;
  }

  seal(): ServiceGraphSnapshot {
    this.#assertNotDisposed();
    const graph = this.#graph.snapshot();
    if (!graph.valid) {
      throw new ServiceContainerError(
        'GRAPH_INVALID',
        'service graph is invalid',
        undefined,
        graph.issues,
      );
    }
    if (!this.#sealed) {
      this.#sealed = true;
      this.#emit('sealed');
    }
    return graph;
  }

  start(): Promise<ServiceContainerSnapshot> {
    this.#assertNotDisposed();
    if (this.#state === 'stopping') {
      return Promise.reject(new ServiceContainerError(
        'CONTAINER_STOPPING',
        'service container is stopping',
      ));
    }
    if (this.#state === 'ready' || this.#state === 'degraded') {
      return Promise.resolve(this.snapshot());
    }
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#performStart()
      .finally(() => {
        this.#startPromise = null;
      });
    return this.#startPromise;
  }

  async resolve<T>(token: ServiceToken<T>): Promise<T> {
    this.#assertNotDisposed();
    if (this.#state === 'stopping') {
      throw new ServiceContainerError(
        'CONTAINER_STOPPING',
        'service container is stopping',
      );
    }
    this.seal();
    const id = normalizedTokenId(token);
    const record = this.#records.get(id);
    if (!record) {
      throw new ServiceContainerError(
        'SERVICE_NOT_FOUND',
        'service is not registered: ' + id,
        id,
      );
    }
    if (record.status !== 'ready') {
      await this.#ensureStarted(id, new Set());
      this.#refreshRunningState();
    }
    return this.#readyInstance<T>(id);
  }

  get<T>(token: ServiceToken<T>): T {
    this.#assertNotDisposed();
    return this.#readyInstance<T>(normalizedTokenId(token));
  }

  has(token: ServiceToken<unknown>): boolean {
    this.#assertNotDisposed();
    return this.#records.has(normalizedTokenId(token));
  }

  snapshot(): ServiceContainerSnapshot {
    this.#assertNotDisposed();
    const graph = this.#graph.snapshot();
    const services = Object.freeze(
      [...this.#records.values()]
        .map(serviceSnapshot)
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    const counters = freezeCounters(this.#counters);
    const fingerprint = fnv1a([
      'service-container-v1',
      this.#state,
      this.#sealed ? 'sealed' : 'open',
      String(this.#generation),
      graph.fingerprint,
      ...services.map((service) => [
        service.id,
        service.status,
        service.starts,
        service.stops,
        service.failureCode ?? '',
        service.errorName ?? '',
      ].join('|')),
      JSON.stringify(counters),
    ].join('\n'));

    return Object.freeze({
      state: this.#state,
      sealed: this.#sealed,
      generation: this.#generation,
      graph,
      services,
      counters,
      events: Object.freeze(this.#events.slice()),
      fingerprint,
    });
  }

  stop(
    options: ServiceContainerStopOptions = {},
  ): Promise<ServiceContainerSnapshot> {
    if (this.#state === 'disposed') {
      return Promise.reject(new ServiceContainerError(
        'CONTAINER_DISPOSED',
        'service container is disposed',
      ));
    }
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#performStop(options)
      .finally(() => {
        this.#stopPromise = null;
      });
    return this.#stopPromise;
  }

  async dispose(reason: unknown = 'container-disposed'): Promise<void> {
    if (this.#state === 'disposed') return;
    try {
      await this.stop({
        reason,
        throwOnStopError: false,
      });
    } finally {
      this.#state = 'disposed';
      if (!this.#controller.signal.aborted) this.#controller.abort(reason);
      this.#parentAbortCleanup?.();
      this.#parentAbortCleanup = null;
      this.#emit('container-disposed');
      this.#graph.dispose();
      for (const record of this.#records.values()) {
        record.instance = undefined;
        record.controller = null;
        record.startPromise = null;
      }
      this.#records.clear();
    }
  }

  async #performStart(): Promise<ServiceContainerSnapshot> {
    const graph = this.seal();
    if (this.#controller.signal.aborted) this.#controller = new AbortController();
    this.#state = 'starting';
    this.#generation += 1;
    this.#emit('container-starting');

    const targets = this.#eagerTargets(graph);
    const startedThisRun: string[] = [];
    let optionalFailure = false;

    for (const id of graph.startupOrder) {
      if (!targets.has(id)) continue;
      const record = this.#records.get(id);
      if (!record) continue;
      if (record.status === 'ready') continue;

      try {
        await this.#ensureStarted(id, new Set());
        if (record.status === 'ready') startedThisRun.push(id);
      } catch (error) {
        if (record.definition.descriptor.criticality === 'optional') {
          optionalFailure = true;
          this.#counters.optionalFailures += 1;
          continue;
        }

        this.#state = 'failed';
        this.#emit(
          'container-failed',
          id,
          errorCode(error, 'START_FAILED'),
          safeErrorName(error),
        );
        await this.#rollback(startedThisRun, 'startup-rollback');
        throw error instanceof ServiceContainerError
          ? error
          : new ServiceContainerError(
            'START_FAILED',
            'required service failed to start: ' + id,
            id,
            error,
          );
      }
    }

    this.#state = optionalFailure || this.#hasOptionalFailure()
      ? 'degraded'
      : 'ready';
    this.#emit(
      this.#state === 'degraded' ? 'container-degraded' : 'container-ready',
    );
    return this.snapshot();
  }

  async #ensureStarted(
    id: string,
    stack: Set<string>,
  ): Promise<unknown> {
    const record = this.#records.get(id);
    if (!record) {
      throw new ServiceContainerError(
        'SERVICE_NOT_FOUND',
        'service is not registered: ' + id,
        id,
      );
    }
    if (record.status === 'ready') return record.instance;
    if (record.startPromise) return record.startPromise;
    if (stack.has(id)) {
      throw new ServiceContainerError(
        'GRAPH_INVALID',
        'runtime dependency cycle detected at ' + id,
        id,
      );
    }

    const nextStack = new Set(stack);
    nextStack.add(id);
    const descriptor = record.definition.descriptor;

    for (const dependencyId of descriptor.dependsOn) {
      const dependency = this.#records.get(dependencyId);
      if (!dependency) {
        throw new ServiceContainerError(
          'DEPENDENCY_UNAVAILABLE',
          'required dependency is unavailable: ' + dependencyId,
          id,
        );
      }
      try {
        await this.#ensureStarted(dependencyId, nextStack);
      } catch (error) {
        throw new ServiceContainerError(
          'DEPENDENCY_UNAVAILABLE',
          'required dependency failed: ' + dependencyId,
          id,
          error,
        );
      }
    }

    for (const dependencyId of descriptor.optionalDependencies) {
      if (!this.#records.has(dependencyId)) continue;
      try {
        await this.#ensureStarted(dependencyId, nextStack);
      } catch {
        // Optional dependency failure is represented in that service's snapshot.
      }
    }

    record.startPromise = this.#startRecord(record)
      .finally(() => {
        record.startPromise = null;
      });
    return record.startPromise;
  }

  async #startRecord(record: ServiceRecord): Promise<unknown> {
    const descriptor = record.definition.descriptor;
    const startedAt = this.#now();
    record.status = 'starting';
    record.startedAt = startedAt;
    record.readyAt = undefined;
    record.stoppedAt = undefined;
    record.startDurationMs = undefined;
    record.stopDurationMs = undefined;
    record.failureCode = undefined;
    record.errorName = undefined;
    record.controller = this.#linkedController();
    this.#emit('service-starting', descriptor.id);

    const context = this.#factoryContext(record);
    try {
      const instance = await this.#withTimeout(
        () => record.definition.start(context),
        record.definition.lifecycleTimeoutMs,
        descriptor.id,
        'start',
        record.controller,
      );
      record.instance = instance;
      record.status = 'ready';
      record.starts += 1;
      this.#counters.starts += 1;
      record.readyAt = this.#now();
      record.startDurationMs = Math.max(0, record.readyAt - startedAt);
      this.#emit(
        'service-ready',
        descriptor.id,
        undefined,
        undefined,
        record.startDurationMs,
      );
      return instance;
    } catch (error) {
      record.instance = undefined;
      record.status = 'failed';
      record.failureCode = errorCode(error, 'START_FAILED');
      record.errorName = safeErrorName(error);
      this.#counters.startFailures += 1;
      this.#emit(
        'service-failed',
        descriptor.id,
        record.failureCode,
        record.errorName,
        Math.max(0, this.#now() - startedAt),
      );
      throw error instanceof ServiceContainerError
        ? error
        : new ServiceContainerError(
          'START_FAILED',
          'service failed to start: ' + descriptor.id,
          descriptor.id,
          error,
        );
    }
  }

  #factoryContext(record: ServiceRecord): ServiceFactoryContext {
    const descriptor = record.definition.descriptor;
    const required = new Set(descriptor.dependsOn);
    const optional = new Set(descriptor.optionalDependencies);
    const access = <T>(
      token: ServiceToken<T>,
      optionalAccess: boolean,
    ): T | undefined => {
      const dependencyId = normalizedTokenId(token);
      const allowed = optionalAccess
        ? required.has(dependencyId) || optional.has(dependencyId)
        : required.has(dependencyId);

      if (!allowed) {
        throw new ServiceContainerError(
          'DEPENDENCY_NOT_DECLARED',
          'service attempted undeclared dependency access: ' + dependencyId,
          descriptor.id,
        );
      }

      const dependency = this.#records.get(dependencyId);
      if (!dependency || dependency.status !== 'ready') {
        if (optionalAccess) return undefined;
        throw new ServiceContainerError(
          'DEPENDENCY_UNAVAILABLE',
          'dependency is not ready: ' + dependencyId,
          descriptor.id,
        );
      }
      return dependency.instance as T;
    };

    return Object.freeze({
      serviceId: descriptor.id,
      signal: record.controller?.signal ?? this.#controller.signal,
      dependency: <T>(token: ServiceToken<T>): T => {
        const value = access(token, false);
        if (value === undefined) {
          throw new ServiceContainerError(
            'DEPENDENCY_UNAVAILABLE',
            'dependency resolved to undefined: ' + token.id,
            descriptor.id,
          );
        }
        return value;
      },
      optional: <T>(token: ServiceToken<T>): T | undefined => access(token, true),
    });
  }

  async #performStop(
    options: ServiceContainerStopOptions,
  ): Promise<ServiceContainerSnapshot> {
    if (this.#state === 'idle' || this.#state === 'stopped') {
      this.#state = 'stopped';
      return this.snapshot();
    }

    const graph = this.#graph.snapshot();
    this.#state = 'stopping';
    const reason = safeReason(options.reason ?? 'container-stopping');
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#emit('container-stopping');

    const failures: unknown[] = [];
    for (const id of graph.shutdownOrder) {
      const record = this.#records.get(id);
      if (!record || record.status !== 'ready') continue;
      try {
        await this.#stopRecord(record, reason);
      } catch (error) {
        failures.push(error);
      }
    }

    for (const record of this.#records.values()) {
      if (record.status !== 'ready') continue;
      try {
        await this.#stopRecord(record, reason);
      } catch (error) {
        failures.push(error);
      }
    }

    this.#state = 'stopped';
    this.#emit('container-stopped');

    const snapshot = this.snapshot();
    if (failures.length > 0 && options.throwOnStopError !== false) {
      throw new AggregateError(failures, 'one or more services failed to stop');
    }
    return snapshot;
  }

  async #stopRecord(
    record: ServiceRecord,
    reason: string,
  ): Promise<void> {
    const descriptor = record.definition.descriptor;
    const startedAt = this.#now();
    record.status = 'stopping';
    record.controller?.abort(reason);
    this.#emit('service-stopping', descriptor.id);

    try {
      if (record.definition.stop && record.instance !== undefined) {
        const stopController = new AbortController();
        await this.#withTimeout(
          () => record.definition.stop?.(
            record.instance,
            Object.freeze({
              serviceId: descriptor.id,
              signal: stopController.signal,
              reason,
            }),
          ),
          record.definition.lifecycleTimeoutMs,
          descriptor.id,
          'stop',
          stopController,
        );
      }
      record.instance = undefined;
      record.status = 'stopped';
      record.stops += 1;
      this.#counters.stops += 1;
      record.stoppedAt = this.#now();
      record.stopDurationMs = Math.max(0, record.stoppedAt - startedAt);
      this.#emit(
        'service-stopped',
        descriptor.id,
        undefined,
        undefined,
        record.stopDurationMs,
      );
    } catch (error) {
      record.instance = undefined;
      record.status = 'stopped';
      record.failureCode = errorCode(error, 'STOP_FAILED');
      record.errorName = safeErrorName(error);
      record.stoppedAt = this.#now();
      record.stopDurationMs = Math.max(0, record.stoppedAt - startedAt);
      this.#counters.stopFailures += 1;
      this.#emit(
        'service-stop-failed',
        descriptor.id,
        record.failureCode,
        record.errorName,
        record.stopDurationMs,
      );
      throw error instanceof ServiceContainerError
        ? error
        : new ServiceContainerError(
          'STOP_FAILED',
          'service failed to stop: ' + descriptor.id,
          descriptor.id,
          error,
        );
    } finally {
      record.controller = null;
    }
  }

  async #rollback(
    startedIds: readonly string[],
    reason: string,
  ): Promise<void> {
    if (startedIds.length === 0) return;
    this.#counters.rollbacks += 1;
    this.#emit('rollback-started');

    const failures: unknown[] = [];
    for (const id of [...startedIds].reverse()) {
      const record = this.#records.get(id);
      if (!record || record.status !== 'ready') continue;
      try {
        await this.#stopRecord(record, reason);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#emit('rollback-completed');

    if (failures.length > 0) {
      // Rollback cleanup evidence is already retained per service; startup remains failed.
    }
  }

  #eagerTargets(graph: ServiceGraphSnapshot): Set<string> {
    const targets = new Set<string>();
    const visit = (id: string): void => {
      if (targets.has(id)) return;
      targets.add(id);
      const descriptor = this.#records.get(id)?.definition.descriptor;
      if (!descriptor) return;
      for (const dependency of descriptor.dependsOn) visit(dependency);
    };

    for (const descriptor of graph.descriptors) {
      if (descriptor.startup === 'eager') visit(descriptor.id);
    }
    return targets;
  }

  #readyInstance<T>(id: string): T {
    const record = this.#records.get(id);
    if (!record) {
      throw new ServiceContainerError(
        'SERVICE_NOT_FOUND',
        'service is not registered: ' + id,
        id,
      );
    }
    if (record.status !== 'ready') {
      throw new ServiceContainerError(
        'SERVICE_NOT_READY',
        'service is not ready: ' + id,
        id,
      );
    }
    return record.instance as T;
  }

  #refreshRunningState(): void {
    if (
      this.#state === 'stopping'
      || this.#state === 'stopped'
      || this.#state === 'disposed'
    ) return;

    const requiredFailure = [...this.#records.values()].some(
      (record) =>
        record.status === 'failed'
        && record.definition.descriptor.criticality === 'required',
    );
    if (requiredFailure) {
      this.#state = 'failed';
      return;
    }
    this.#state = this.#hasOptionalFailure() ? 'degraded' : 'ready';
  }

  #hasOptionalFailure(): boolean {
    return [...this.#records.values()].some(
      (record) =>
        record.status === 'failed'
        && record.definition.descriptor.criticality === 'optional',
    );
  }

  #linkedController(): AbortController {
    const controller = new AbortController();
    const parent = this.#controller.signal;
    if (parent.aborted) {
      controller.abort(parent.reason);
      return controller;
    }
    const abort = (): void => controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener(
      'abort',
      () => parent.removeEventListener('abort', abort),
      { once: true },
    );
    return controller;
  }

  #withTimeout<T>(
    operation: () => T | Promise<T>,
    timeoutMs: number,
    serviceId: string,
    phase: 'start' | 'stop',
    controller: AbortController,
  ): Promise<T> {
    if (controller.signal.aborted) {
      return Promise.reject(new ServiceContainerError(
        'ABORTED',
        'service lifecycle operation was aborted',
        serviceId,
        controller.signal.reason,
      ));
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const operationPromise = Promise.resolve().then(operation);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#clock.setTimeout(() => {
        const code: ServiceContainerErrorCode =
          phase === 'start' ? 'START_TIMEOUT' : 'STOP_TIMEOUT';
        const error = new ServiceContainerError(
          code,
          'service ' + phase + ' exceeded ' + timeoutMs + 'ms',
          serviceId,
        );
        if (!controller.signal.aborted) controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    return Promise.race([operationPromise, timeoutPromise])
      .finally(() => {
        if (timeoutHandle !== null) this.#clock.clearTimeout(timeoutHandle);
      });
  }

  #emit(
    kind: ServiceContainerEventKind,
    serviceId?: string,
    code?: ServiceContainerErrorCode,
    errorName?: string,
    durationMs?: number,
  ): void {
    const event = Object.freeze({
      sequence: ++this.#eventSequence,
      at: this.#now(),
      kind,
      state: this.#state,
      ...(serviceId === undefined ? {} : { serviceId }),
      ...(code === undefined ? {} : { code }),
      ...(errorName === undefined ? {} : { errorName }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    if (this.#historyLimit > 0) {
      this.#events.push(event);
      const overflow = this.#events.length - this.#historyLimit;
      if (overflow > 0) this.#events.splice(0, overflow);
    }
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch (error) {
      this.#counters.observerFailures += 1;
      if (kind !== 'observer-failed') {
        const observerEvent = Object.freeze({
          sequence: ++this.#eventSequence,
          at: this.#now(),
          kind: 'observer-failed' as const,
          state: this.#state,
          errorName: safeErrorName(error),
        });
        if (this.#historyLimit > 0) {
          this.#events.push(observerEvent);
          const overflow = this.#events.length - this.#historyLimit;
          if (overflow > 0) this.#events.splice(0, overflow);
        }
      }
    }
  }

  #assertRegistrationOpen(): void {
    this.#assertNotDisposed();
    if (this.#sealed || (this.#state !== 'idle' && this.#state !== 'stopped')) {
      this.#counters.rejected += 1;
      throw new ServiceContainerError(
        'REGISTRATION_CLOSED',
        'service registration is closed',
      );
    }
  }

  #assertNotDisposed(): void {
    if (this.#state === 'disposed') {
      throw new ServiceContainerError(
        'CONTAINER_DISPOSED',
        'service container is disposed',
      );
    }
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new ServiceContainerError(
        'INVALID_DEFINITION',
        'service container clock returned an invalid timestamp',
      );
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new ServiceContainerError(
        'INVALID_DEFINITION',
        'service container clock must be monotonic',
      );
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createServiceContainer = (
  options: ServiceContainerOptions = {},
): ServiceContainer => new BoundedServiceContainer(options);
