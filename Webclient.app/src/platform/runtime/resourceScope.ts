export type ResourceScopeState = 'open' | 'closing' | 'closed' | 'disposed';
export type ResourceCleanupOutcome = 'released' | 'failed' | 'timed-out';
export type ResourceScopeEventKind =
  | 'registered'
  | 'released'
  | 'cleanup-failed'
  | 'cleanup-timed-out'
  | 'owner-released'
  | 'child-created'
  | 'child-closed'
  | 'scope-closing'
  | 'scope-closed'
  | 'scope-disposed'
  | 'observer-failed';

export interface ResourceScopeClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export type ResourceMetadataValue = string | number | boolean | null;
export type ResourceMetadata = Readonly<Record<string, ResourceMetadataValue>>;

export interface ResourceRegistrationRequest {
  readonly owner: string;
  readonly key: string;
  readonly label?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly cleanup: () => void | Promise<void>;
}

export interface ResourceScopeCloseOptions {
  readonly reason?: unknown;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly throwOnCleanupError?: boolean;
}

export interface ResourceScopeOptions {
  readonly maxResources?: number;
  readonly maxOwnerResources?: number;
  readonly maxChildren?: number;
  readonly historyLimit?: number;
  readonly defaultCleanupTimeoutMs?: number;
  readonly maxCleanupTimeoutMs?: number;
  readonly maxMetadataEntries?: number;
  readonly clock?: ResourceScopeClock;
  readonly onEvent?: (event: ResourceScopeEvent) => void;
}

export interface ResourceSnapshot {
  readonly id: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly registeredAt: number;
  readonly metadata: ResourceMetadata;
}

export interface ResourceCleanupHistoryEntry extends ResourceSnapshot {
  readonly releasedAt: number;
  readonly outcome: ResourceCleanupOutcome;
  readonly reason: string;
  readonly durationMs: number;
  readonly errorName?: string;
}

export interface ResourceScopeEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: ResourceScopeEventKind;
  readonly scope: string;
  readonly owner?: string;
  readonly key?: string;
  readonly resourceId?: number;
  readonly reason?: string;
  readonly outcome?: ResourceCleanupOutcome;
  readonly errorName?: string;
}

export interface ResourceScopeCounters {
  readonly registered: number;
  readonly released: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly rejected: number;
  readonly observerFailures: number;
}

export interface ResourceScopeSnapshot {
  readonly name: string;
  readonly state: ResourceScopeState;
  readonly createdAt: number;
  readonly activeResources: number;
  readonly activeOwners: number;
  readonly childScopes: number;
  readonly counters: ResourceScopeCounters;
  readonly resources: readonly ResourceSnapshot[];
  readonly history: readonly ResourceCleanupHistoryEntry[];
  readonly events: readonly ResourceScopeEvent[];
}

export interface ManagedResourceHandle {
  readonly id: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly released: boolean;
  readonly snapshot: () => ResourceSnapshot | undefined;
  readonly release: (reason?: unknown, timeoutMs?: number) => Promise<boolean>;
}

export interface ResourceScope {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly state: ResourceScopeState;
  readonly register: (request: ResourceRegistrationRequest) => ManagedResourceHandle;
  readonly registerDisposable: (
    owner: string,
    key: string,
    disposable: { dispose(): void | Promise<void> },
    options?: Omit<ResourceRegistrationRequest, 'owner' | 'key' | 'cleanup'>,
  ) => ManagedResourceHandle;
  readonly child: (name: string, overrides?: ResourceScopeOptions) => ResourceScope;
  readonly releaseOwner: (owner: string, reason?: unknown) => Promise<number>;
  readonly close: (options?: ResourceScopeCloseOptions) => Promise<void>;
  readonly snapshot: () => ResourceScopeSnapshot;
  readonly dispose: (reason?: unknown) => Promise<void>;
}

export class ResourceScopeError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'SCOPE_NOT_OPEN'
      | 'RESOURCE_CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'CHILD_CAPACITY_EXCEEDED'
      | 'CLEANUP_TIMEOUT'
      | 'CLEANUP_FAILED'
      | 'CLOSE_CANCELLED',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'ResourceScopeError';
  }
}

interface MutableResource {
  readonly id: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly registeredAt: number;
  readonly metadata: ResourceMetadata;
  readonly cleanup: () => void | Promise<void>;
  releasing: boolean;
  released: boolean;
}

interface MutableCounters {
  registered: number;
  released: number;
  failed: number;
  timedOut: number;
  rejected: number;
  observerFailures: number;
}

interface ResourceScopeInternalOptions {
  readonly onSettled?: () => void;
  readonly parentSignal?: AbortSignal;
}

const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|session|credential/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_TEXT = 180;
const MAX_METADATA_STRING = 200;

const SYSTEM_CLOCK: ResourceScopeClock = Object.freeze({
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
    throw new ResourceScopeError(
      'INVALID_REQUEST',
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const boundedText = (name: string, value: string, maximum = MAX_TEXT): string => {
  if (typeof value !== 'string') {
    throw new ResourceScopeError('INVALID_REQUEST', name + ' must be a string');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResourceScopeError(
      'INVALID_REQUEST',
      name + ' must contain 1-' + maximum + ' characters',
    );
  }
  if (CONTROL_CHARACTER.test(normalized)) {
    throw new ResourceScopeError('INVALID_REQUEST', name + ' cannot contain control characters');
  }
  return normalized;
};

const safeReason = (reason: unknown): string => {
  if (reason instanceof ResourceScopeError) return reason.code.toLowerCase();
  if (reason instanceof Error && reason.name) return reason.name.slice(0, 80);
  if (typeof reason === 'string') {
    const normalized = reason.replace(CONTROL_CHARACTER, ' ').trim();
    return normalized ? normalized.slice(0, 80) : 'unspecified';
  }
  return reason === undefined ? 'unspecified' : 'external';
};

const safeErrorName = (error: unknown): string =>
  error instanceof Error && error.name.trim() ? error.name.slice(0, 80) : 'UnknownError';

const sanitizeMetadataValue = (value: unknown): ResourceMetadataValue | undefined => {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_METADATA_STRING);
  }
  return undefined;
};

const sanitizeMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  maxEntries: number,
): ResourceMetadata => {
  if (!metadata) return Object.freeze({});
  const result: Record<string, ResourceMetadataValue> = {};
  const entries = Object.entries(metadata).slice(0, maxEntries);
  for (const [rawKey, rawValue] of entries) {
    const key = boundedText('metadata key', rawKey, 80);
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    const value = sanitizeMetadataValue(rawValue);
    if (value !== undefined) result[key] = value;
  }
  return Object.freeze(result);
};

const resourceSnapshot = (resource: MutableResource): ResourceSnapshot => Object.freeze({
  id: resource.id,
  owner: resource.owner,
  key: resource.key,
  label: resource.label,
  registeredAt: resource.registeredAt,
  metadata: resource.metadata,
});

const freezeCounters = (counters: MutableCounters): ResourceScopeCounters => Object.freeze({
  registered: counters.registered,
  released: counters.released,
  failed: counters.failed,
  timedOut: counters.timedOut,
  rejected: counters.rejected,
  observerFailures: counters.observerFailures,
});

const cancellationError = (reason?: unknown): ResourceScopeError =>
  new ResourceScopeError('CLOSE_CANCELLED', 'Resource scope close was cancelled.', reason);

const cleanupTimeoutError = (timeoutMs: number): ResourceScopeError =>
  new ResourceScopeError(
    'CLEANUP_TIMEOUT',
    'Resource cleanup exceeded the ' + timeoutMs + 'ms cleanup timeout.',
  );

class BoundedResourceScope implements ResourceScope {
  readonly #name: string;
  readonly #clock: ResourceScopeClock;
  readonly #maxResources: number;
  readonly #maxOwnerResources: number;
  readonly #maxChildren: number;
  readonly #historyLimit: number;
  readonly #defaultCleanupTimeoutMs: number;
  readonly #maxCleanupTimeoutMs: number;
  readonly #maxMetadataEntries: number;
  readonly #onEvent: ((event: ResourceScopeEvent) => void) | undefined;
  readonly #onSettled: (() => void) | undefined;
  readonly #controller = new AbortController();
  readonly #resources = new Map<number, MutableResource>();
  readonly #ownerCounts = new Map<string, number>();
  readonly #children = new Set<BoundedResourceScope>();
  readonly #history: ResourceCleanupHistoryEntry[] = [];
  readonly #events: ResourceScopeEvent[] = [];
  readonly #counters: MutableCounters = {
    registered: 0,
    released: 0,
    failed: 0,
    timedOut: 0,
    rejected: 0,
    observerFailures: 0,
  };

  #state: ResourceScopeState = 'open';
  #resourceSequence = 0;
  #eventSequence = 0;
  #createdAt: number;
  #lastObservedAt: number;
  #closePromise: Promise<void> | null = null;
  #parentAbortCleanup: (() => void) | null = null;
  #settledNotified = false;

  constructor(
    name: string,
    options: ResourceScopeOptions = {},
    internal: ResourceScopeInternalOptions = {},
  ) {
    this.#name = boundedText('scope name', name, 120);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#maxResources = boundedInteger('maxResources', options.maxResources ?? 256, 1, 10_000);
    this.#maxOwnerResources = boundedInteger(
      'maxOwnerResources',
      options.maxOwnerResources ?? Math.min(64, this.#maxResources),
      1,
      this.#maxResources,
    );
    this.#maxChildren = boundedInteger('maxChildren', options.maxChildren ?? 32, 1, 1_000);
    this.#historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 256, 0, 4_096);
    this.#maxCleanupTimeoutMs = boundedInteger(
      'maxCleanupTimeoutMs',
      options.maxCleanupTimeoutMs ?? 30_000,
      1,
      10 * 60_000,
    );
    this.#defaultCleanupTimeoutMs = boundedInteger(
      'defaultCleanupTimeoutMs',
      options.defaultCleanupTimeoutMs ?? Math.min(5_000, this.#maxCleanupTimeoutMs),
      1,
      this.#maxCleanupTimeoutMs,
    );
    this.#maxMetadataEntries = boundedInteger(
      'maxMetadataEntries',
      options.maxMetadataEntries ?? 16,
      0,
      64,
    );
    this.#onEvent = options.onEvent;
    this.#onSettled = internal.onSettled;
    this.#createdAt = this.#readClock();
    this.#lastObservedAt = this.#createdAt;

    if (internal.parentSignal) {
      const abortFromParent = (): void => {
        void this.dispose(internal.parentSignal?.reason ?? 'parent-disposed');
      };
      if (internal.parentSignal.aborted) {
        abortFromParent();
      } else {
        internal.parentSignal.addEventListener('abort', abortFromParent, { once: true });
        this.#parentAbortCleanup = () =>
          internal.parentSignal?.removeEventListener('abort', abortFromParent);
      }
    }
  }

  get name(): string {
    return this.#name;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get state(): ResourceScopeState {
    return this.#state;
  }

  register(request: ResourceRegistrationRequest): ManagedResourceHandle {
    this.#assertOpen();
    if (!request || typeof request.cleanup !== 'function') {
      this.#counters.rejected += 1;
      throw new ResourceScopeError('INVALID_REQUEST', 'cleanup must be a function');
    }

    const owner = boundedText('owner', request.owner);
    const key = boundedText('key', request.key);
    const label = request.label === undefined
      ? key
      : boundedText('label', request.label, 240);

    if (this.#resources.size >= this.#maxResources) {
      this.#counters.rejected += 1;
      throw new ResourceScopeError(
        'RESOURCE_CAPACITY_EXCEEDED',
        'Resource scope capacity is exhausted.',
      );
    }

    const ownerCount = this.#ownerCounts.get(owner) ?? 0;
    if (ownerCount >= this.#maxOwnerResources) {
      this.#counters.rejected += 1;
      throw new ResourceScopeError(
        'OWNER_CAPACITY_EXCEEDED',
        'Resource capacity is exhausted for owner ' + owner + '.',
      );
    }

    const id = ++this.#resourceSequence;
    const resource: MutableResource = {
      id,
      owner,
      key,
      label,
      registeredAt: this.#now(),
      metadata: sanitizeMetadata(request.metadata, this.#maxMetadataEntries),
      cleanup: request.cleanup,
      releasing: false,
      released: false,
    };
    this.#resources.set(id, resource);
    this.#ownerCounts.set(owner, ownerCount + 1);
    this.#counters.registered += 1;
    this.#emit('registered', resource);

    const handle: ManagedResourceHandle = {
      id,
      owner,
      key,
      label,
      get released() {
        return resource.released;
      },
      snapshot: () => {
        const active = this.#resources.get(id);
        return active ? resourceSnapshot(active) : undefined;
      },
      release: (reason?: unknown, timeoutMs?: number) =>
        this.#releaseResource(id, reason ?? 'manual-release', timeoutMs),
    };
    return Object.freeze(handle);
  }

  registerDisposable(
    owner: string,
    key: string,
    disposable: { dispose(): void | Promise<void> },
    options: Omit<ResourceRegistrationRequest, 'owner' | 'key' | 'cleanup'> = {},
  ): ManagedResourceHandle {
    if (!disposable || typeof disposable.dispose !== 'function') {
      this.#counters.rejected += 1;
      throw new ResourceScopeError('INVALID_REQUEST', 'disposable must expose dispose()');
    }
    return this.register({
      owner,
      key,
      ...options,
      cleanup: () => disposable.dispose(),
    });
  }

  child(name: string, overrides: ResourceScopeOptions = {}): ResourceScope {
    this.#assertOpen();
    if (this.#children.size >= this.#maxChildren) {
      this.#counters.rejected += 1;
      throw new ResourceScopeError(
        'CHILD_CAPACITY_EXCEEDED',
        'Resource scope child capacity is exhausted.',
      );
    }

    let child!: BoundedResourceScope;
    child = new BoundedResourceScope(
      this.#name + '/' + boundedText('child scope name', name, 80),
      {
        maxResources: overrides.maxResources ?? this.#maxResources,
        maxOwnerResources: overrides.maxOwnerResources ?? this.#maxOwnerResources,
        maxChildren: overrides.maxChildren ?? this.#maxChildren,
        historyLimit: overrides.historyLimit ?? this.#historyLimit,
        defaultCleanupTimeoutMs:
          overrides.defaultCleanupTimeoutMs ?? this.#defaultCleanupTimeoutMs,
        maxCleanupTimeoutMs: overrides.maxCleanupTimeoutMs ?? this.#maxCleanupTimeoutMs,
        maxMetadataEntries: overrides.maxMetadataEntries ?? this.#maxMetadataEntries,
        clock: overrides.clock ?? this.#clock,
        onEvent: overrides.onEvent ?? this.#onEvent,
      },
      {
        parentSignal: this.#controller.signal,
        onSettled: () => {
          this.#children.delete(child);
          this.#emitSimple('child-closed', 'child-closed');
          this.#notifySettledIfTerminal();
        },
      },
    );
    this.#children.add(child);
    this.#emitSimple('child-created', child.name);
    return child;
  }

  async releaseOwner(owner: string, reason: unknown = 'owner-release'): Promise<number> {
    const normalizedOwner = boundedText('owner', owner);
    const resources = [...this.#resources.values()]
      .filter((resource) => resource.owner === normalizedOwner)
      .sort((left, right) => right.id - left.id);

    let released = 0;
    const failures: unknown[] = [];
    for (const resource of resources) {
      try {
        if (await this.#releaseResource(resource.id, reason)) released += 1;
      } catch (error) {
        failures.push(error);
      }
    }

    this.#emitSimple('owner-released', normalizedOwner);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more owner resources failed cleanup.');
    }
    return released;
  }

  close(options: ResourceScopeCloseOptions = {}): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'disposed') return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    if (options.signal?.aborted) return Promise.reject(cancellationError(options.signal.reason));

    this.#state = 'closing';
    const reason = options.reason ?? 'scope-closing';
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.#emitSimple('scope-closing', safeReason(reason));

    this.#closePromise = this.#performClose(options)
      .finally(() => {
        this.#closePromise = null;
      });
    return this.#closePromise;
  }

  snapshot(): ResourceScopeSnapshot {
    const resources = [...this.#resources.values()]
      .map(resourceSnapshot)
      .sort((left, right) => left.id - right.id);
    return Object.freeze({
      name: this.#name,
      state: this.#state,
      createdAt: this.#createdAt,
      activeResources: resources.length,
      activeOwners: this.#ownerCounts.size,
      childScopes: this.#children.size,
      counters: freezeCounters(this.#counters),
      resources: Object.freeze(resources),
      history: Object.freeze(this.#history.slice()),
      events: Object.freeze(this.#events.slice()),
    });
  }

  async dispose(reason: unknown = 'scope-disposed'): Promise<void> {
    if (this.#state === 'disposed') return;
    try {
      await this.close({
        reason,
        throwOnCleanupError: false,
        cleanupTimeoutMs: this.#defaultCleanupTimeoutMs,
      });
    } finally {
      this.#state = 'disposed';
      if (!this.#controller.signal.aborted) this.#controller.abort(reason);
      this.#parentAbortCleanup?.();
      this.#parentAbortCleanup = null;
      this.#emitSimple('scope-disposed', safeReason(reason));
      this.#notifySettledIfTerminal();
    }
  }

  async #performClose(options: ResourceScopeCloseOptions): Promise<void> {
    const signal = options.signal;
    if (signal?.aborted) throw cancellationError(signal.reason);
    const timeoutMs = this.#normalizeCleanupTimeout(options.cleanupTimeoutMs);
    const failures: unknown[] = [];

    const childScopes = [...this.#children].reverse();
    for (const child of childScopes) {
      if (signal?.aborted) throw cancellationError(signal.reason);
      try {
        await child.close({
          reason: options.reason ?? 'parent-closing',
          cleanupTimeoutMs: timeoutMs,
          signal,
          throwOnCleanupError: options.throwOnCleanupError,
        });
      } catch (error) {
        failures.push(error);
      }
    }

    const resources = [...this.#resources.values()].sort((left, right) => right.id - left.id);
    for (const resource of resources) {
      if (signal?.aborted) throw cancellationError(signal.reason);
      try {
        await this.#releaseResource(
          resource.id,
          options.reason ?? 'scope-closing',
          timeoutMs,
        );
      } catch (error) {
        failures.push(error);
      }
    }

    this.#state = 'closed';
    this.#parentAbortCleanup?.();
    this.#parentAbortCleanup = null;
    this.#emitSimple('scope-closed', safeReason(options.reason ?? 'scope-closing'));
    this.#notifySettledIfTerminal();

    if (failures.length > 0 && options.throwOnCleanupError !== false) {
      throw new AggregateError(failures, 'One or more scoped resources failed cleanup.');
    }
  }

  async #releaseResource(
    id: number,
    reason: unknown,
    requestedTimeoutMs?: number,
  ): Promise<boolean> {
    const resource = this.#resources.get(id);
    if (!resource || resource.released || resource.releasing) return false;
    const timeoutMs = this.#normalizeCleanupTimeout(requestedTimeoutMs);
    const startedAt = this.#now();
    resource.releasing = true;

    try {
      await this.#runCleanup(resource.cleanup, timeoutMs);
      resource.released = true;
      this.#counters.released += 1;
      this.#recordCleanup(resource, 'released', reason, startedAt);
      this.#emit('released', resource, {
        reason: safeReason(reason),
        outcome: 'released',
      });
      return true;
    } catch (error) {
      resource.released = true;
      const timedOut = error instanceof ResourceScopeError && error.code === 'CLEANUP_TIMEOUT';
      if (timedOut) {
        this.#counters.timedOut += 1;
        this.#recordCleanup(resource, 'timed-out', reason, startedAt, error);
        this.#emit('cleanup-timed-out', resource, {
          reason: safeReason(reason),
          outcome: 'timed-out',
          errorName: safeErrorName(error),
        });
        throw error;
      }

      this.#counters.failed += 1;
      this.#recordCleanup(resource, 'failed', reason, startedAt, error);
      this.#emit('cleanup-failed', resource, {
        reason: safeReason(reason),
        outcome: 'failed',
        errorName: safeErrorName(error),
      });
      throw new ResourceScopeError(
        'CLEANUP_FAILED',
        'Resource cleanup failed for ' + resource.owner + '/' + resource.key + '.',
        error,
      );
    } finally {
      resource.releasing = false;
      this.#resources.delete(id);
      const ownerCount = (this.#ownerCounts.get(resource.owner) ?? 1) - 1;
      if (ownerCount <= 0) this.#ownerCounts.delete(resource.owner);
      else this.#ownerCounts.set(resource.owner, ownerCount);
      this.#notifySettledIfTerminal();
    }
  }

  #runCleanup(cleanup: () => void | Promise<void>, timeoutMs: number): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const cleanupPromise = Promise.resolve().then(cleanup);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#clock.setTimeout(() => reject(cleanupTimeoutError(timeoutMs)), timeoutMs);
    });

    return Promise.race([cleanupPromise, timeoutPromise])
      .then(() => undefined)
      .finally(() => {
        if (timeoutHandle !== null) this.#clock.clearTimeout(timeoutHandle);
      });
  }

  #recordCleanup(
    resource: MutableResource,
    outcome: ResourceCleanupOutcome,
    reason: unknown,
    startedAt: number,
    error?: unknown,
  ): void {
    if (this.#historyLimit === 0) return;
    const releasedAt = this.#now();
    this.#history.push(Object.freeze({
      ...resourceSnapshot(resource),
      releasedAt,
      outcome,
      reason: safeReason(reason),
      durationMs: Math.max(0, releasedAt - startedAt),
      ...(error === undefined ? {} : { errorName: safeErrorName(error) }),
    }));
    const overflow = this.#history.length - this.#historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
  }

  #emit(
    kind: ResourceScopeEventKind,
    resource: MutableResource,
    details: Partial<Pick<ResourceScopeEvent, 'reason' | 'outcome' | 'errorName'>> = {},
  ): void {
    this.#publish(Object.freeze({
      sequence: ++this.#eventSequence,
      at: this.#now(),
      kind,
      scope: this.#name,
      owner: resource.owner,
      key: resource.key,
      resourceId: resource.id,
      ...details,
    }));
  }

  #emitSimple(kind: ResourceScopeEventKind, reason?: string): void {
    this.#publish(Object.freeze({
      sequence: ++this.#eventSequence,
      at: this.#now(),
      kind,
      scope: this.#name,
      ...(reason ? { reason } : {}),
    }));
  }

  #publish(event: ResourceScopeEvent): void {
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
      if (event.kind !== 'observer-failed') {
        const observerEvent = Object.freeze({
          sequence: ++this.#eventSequence,
          at: this.#now(),
          kind: 'observer-failed' as const,
          scope: this.#name,
          reason: safeErrorName(error),
        });
        if (this.#historyLimit > 0) {
          this.#events.push(observerEvent);
          const overflow = this.#events.length - this.#historyLimit;
          if (overflow > 0) this.#events.splice(0, overflow);
        }
      }
    }
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      this.#counters.rejected += 1;
      throw new ResourceScopeError('SCOPE_NOT_OPEN', 'Resource scope is not accepting resources.');
    }
  }

  #normalizeCleanupTimeout(value?: number): number {
    if (value === undefined) return this.#defaultCleanupTimeoutMs;
    return boundedInteger('cleanupTimeoutMs', value, 1, this.#maxCleanupTimeoutMs);
  }

  #notifySettledIfTerminal(): void {
    if (this.#settledNotified) return;
    if (this.#state !== 'closed' && this.#state !== 'disposed') return;
    if (this.#resources.size !== 0 || this.#children.size !== 0) return;
    this.#settledNotified = true;
    this.#onSettled?.();
  }

  #readClock(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new ResourceScopeError('INVALID_REQUEST', 'clock returned an invalid timestamp');
    }
    return value;
  }

  #now(): number {
    const value = this.#readClock();
    if (value < this.#lastObservedAt) {
      throw new ResourceScopeError('INVALID_REQUEST', 'clock must be monotonic');
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createResourceScope = (
  name: string,
  options: ResourceScopeOptions = {},
): ResourceScope => new BoundedResourceScope(name, options);
