export type TaskScopeState = 'open' | 'closing' | 'closed' | 'disposed';
export type TaskScopeOutcome = 'success' | 'failure' | 'cancelled' | 'timed-out';

export interface TaskScopeClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface StructuredTaskScopeOptions {
  readonly maxActiveTasks?: number;
  readonly maxOwnerTasks?: number;
  readonly maxChildren?: number;
  readonly historyLimit?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly clock?: TaskScopeClock;
}

export interface ScopedTaskRequest<T> {
  readonly owner: string;
  readonly key: string;
  readonly label?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly task: (signal: AbortSignal) => Promise<T>;
}

export interface TaskScopeCloseRequest {
  readonly cancelActive?: boolean;
  readonly reason?: unknown;
  readonly signal?: AbortSignal;
}

export interface TaskScopeEvent {
  readonly sequence: number;
  readonly at: number;
  readonly scope: string;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly outcome: TaskScopeOutcome;
  readonly durationMs: number;
  readonly errorName?: string;
}

export interface TaskScopeSnapshot {
  readonly name: string;
  readonly state: TaskScopeState;
  readonly active: number;
  readonly owners: number;
  readonly children: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly rejected: number;
  readonly history: readonly TaskScopeEvent[];
}

export interface StructuredTaskScope {
  readonly run: <T>(request: ScopedTaskRequest<T>) => Promise<T>;
  readonly fork: (name: string, overrides?: StructuredTaskScopeOptions) => StructuredTaskScope;
  readonly close: (request?: TaskScopeCloseRequest) => Promise<void>;
  readonly waitForIdle: (signal?: AbortSignal) => Promise<void>;
  readonly snapshot: () => TaskScopeSnapshot;
  readonly dispose: (reason?: unknown) => void;
}

export class StructuredTaskScopeError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'SCOPE_NOT_OPEN'
      | 'TASK_CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'CHILD_CAPACITY_EXCEEDED'
      | 'TASK_CANCELLED'
      | 'TASK_TIMEOUT',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'StructuredTaskScopeError';
  }
}

interface ActiveTask {
  readonly id: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  unlinkExternal: (() => void) | null;
  settled: boolean;
}

interface IdleWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  unlink: (() => void) | null;
  settled: boolean;
}

interface MutableStats {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  rejected: number;
}

const SYSTEM_CLOCK: TaskScopeClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

const integer = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const text = (name: string, value: string, maximum = 160): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new StructuredTaskScopeError(
      'INVALID_REQUEST',
      `${name} must contain 1-${maximum} characters`,
    );
  }
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new StructuredTaskScopeError('INVALID_REQUEST', `${name} cannot contain control characters`);
    }
  }
  return normalized;
};

const errorName = (error: unknown): string =>
  error instanceof Error && error.name.trim() ? error.name.slice(0, 80) : 'UnknownError';

const cancellationError = (reason?: unknown): StructuredTaskScopeError =>
  new StructuredTaskScopeError('TASK_CANCELLED', 'Scoped task was cancelled.', reason);

const timeoutError = (timeoutMs: number): StructuredTaskScopeError =>
  new StructuredTaskScopeError(
    'TASK_TIMEOUT',
    `Scoped task exceeded its ${timeoutMs}ms timeout.`,
  );

const normalizeTimeout = (
  value: number | undefined,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): number => {
  if (value === undefined) return defaultTimeoutMs;
  return integer('timeoutMs', value, 1, maxTimeoutMs);
};

class BoundedStructuredTaskScope implements StructuredTaskScope {
  readonly #name: string;
  readonly #clock: TaskScopeClock;
  readonly #maxActiveTasks: number;
  readonly #maxOwnerTasks: number;
  readonly #maxChildren: number;
  readonly #historyLimit: number;
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #controller = new AbortController();
  readonly #active = new Map<number, ActiveTask>();
  readonly #ownerCounts = new Map<string, number>();
  readonly #children = new Set<BoundedStructuredTaskScope>();
  readonly #history: TaskScopeEvent[] = [];
  readonly #idleWaiters = new Set<IdleWaiter>();
  readonly #stats: MutableStats = {
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    rejected: 0,
  };
  readonly #onSettled: (() => void) | undefined;
  #state: TaskScopeState = 'open';
  #sequence = 0;
  #taskSequence = 0;
  #lastObservedAt: number | undefined;

  constructor(
    name: string,
    options: StructuredTaskScopeOptions = {},
    onSettled?: () => void,
  ) {
    this.#name = text('scope name', name, 120);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#maxActiveTasks = integer('maxActiveTasks', options.maxActiveTasks ?? 128, 1, 10_000);
    this.#maxOwnerTasks = integer('maxOwnerTasks', options.maxOwnerTasks ?? 32, 1, this.#maxActiveTasks);
    this.#maxChildren = integer('maxChildren', options.maxChildren ?? 32, 1, 1_000);
    this.#historyLimit = integer('historyLimit', options.historyLimit ?? 256, 0, 4_096);
    this.#maxTimeoutMs = integer('maxTimeoutMs', options.maxTimeoutMs ?? 120_000, 1, 30 * 60_000);
    this.#defaultTimeoutMs = integer(
      'defaultTimeoutMs',
      options.defaultTimeoutMs ?? 30_000,
      1,
      this.#maxTimeoutMs,
    );
    this.#onSettled = onSettled;
  }

  async run<T>(request: ScopedTaskRequest<T>): Promise<T> {
    if (this.#state !== 'open') {
      this.#stats.rejected += 1;
      throw new StructuredTaskScopeError('SCOPE_NOT_OPEN', 'Task scope is not accepting new work.');
    }
    if (typeof request.task !== 'function') {
      this.#stats.rejected += 1;
      throw new StructuredTaskScopeError('INVALID_REQUEST', 'task must be a function');
    }

    const owner = text('owner', request.owner);
    const key = text('key', request.key);
    const label = request.label === undefined ? key : text('label', request.label, 200);
    if (request.signal?.aborted) {
      this.#stats.rejected += 1;
      throw cancellationError(request.signal.reason);
    }
    if (this.#active.size >= this.#maxActiveTasks) {
      this.#stats.rejected += 1;
      throw new StructuredTaskScopeError(
        'TASK_CAPACITY_EXCEEDED',
        'Task scope active capacity is exhausted.',
      );
    }
    const ownerCount = this.#ownerCounts.get(owner) ?? 0;
    if (ownerCount >= this.#maxOwnerTasks) {
      this.#stats.rejected += 1;
      throw new StructuredTaskScopeError(
        'OWNER_CAPACITY_EXCEEDED',
        `Task scope owner capacity is exhausted for ${owner}.`,
      );
    }

    const startedAt = this.#now();
    const timeoutMs = normalizeTimeout(
      request.timeoutMs,
      this.#defaultTimeoutMs,
      this.#maxTimeoutMs,
    );
    const controller = new AbortController();
    const task: ActiveTask = {
      id: ++this.#taskSequence,
      owner,
      key,
      label,
      startedAt,
      controller,
      timeoutMs,
      timeoutHandle: null,
      unlinkExternal: null,
      settled: false,
    };

    const abortFromScope = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(this.#controller.signal.reason ?? cancellationError());
      }
    };
    this.#controller.signal.addEventListener('abort', abortFromScope, { once: true });

    if (request.signal) {
      const abortFromRequest = (): void => {
        if (!controller.signal.aborted) controller.abort(request.signal?.reason ?? cancellationError());
      };
      request.signal.addEventListener('abort', abortFromRequest, { once: true });
      task.unlinkExternal = () => request.signal?.removeEventListener('abort', abortFromRequest);
    }

    task.timeoutHandle = this.#clock.setTimeout(() => {
      if (!controller.signal.aborted && !task.settled) controller.abort(timeoutError(timeoutMs));
    }, timeoutMs);

    this.#active.set(task.id, task);
    this.#ownerCounts.set(owner, ownerCount + 1);
    this.#stats.started += 1;

    try {
      const result = await request.task(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? cancellationError();
      task.settled = true;
      this.#stats.succeeded += 1;
      this.#record(task, 'success');
      return result;
    } catch (error) {
      task.settled = true;
      const timedOut = controller.signal.reason instanceof StructuredTaskScopeError
        && controller.signal.reason.code === 'TASK_TIMEOUT';
      const cancelled = controller.signal.aborted && !timedOut;
      if (timedOut) {
        this.#stats.timedOut += 1;
        this.#record(task, 'timed-out', error);
      } else if (cancelled) {
        this.#stats.cancelled += 1;
        this.#record(task, 'cancelled', error);
      } else {
        this.#stats.failed += 1;
        this.#record(task, 'failure', error);
      }
      throw error;
    } finally {
      if (task.timeoutHandle !== null) {
        this.#clock.clearTimeout(task.timeoutHandle);
        task.timeoutHandle = null;
      }
      task.unlinkExternal?.();
      task.unlinkExternal = null;
      this.#controller.signal.removeEventListener('abort', abortFromScope);
      this.#active.delete(task.id);
      const nextOwnerCount = (this.#ownerCounts.get(owner) ?? 1) - 1;
      if (nextOwnerCount <= 0) this.#ownerCounts.delete(owner);
      else this.#ownerCounts.set(owner, nextOwnerCount);
      this.#checkSettled();
    }
  }

  fork(name: string, overrides: StructuredTaskScopeOptions = {}): StructuredTaskScope {
    if (this.#state !== 'open') {
      throw new StructuredTaskScopeError('SCOPE_NOT_OPEN', 'Task scope is not accepting child scopes.');
    }
    if (this.#children.size >= this.#maxChildren) {
      throw new StructuredTaskScopeError(
        'CHILD_CAPACITY_EXCEEDED',
        'Task scope child capacity is exhausted.',
      );
    }

    let child!: BoundedStructuredTaskScope;
    const propagate = (): void => child.dispose(this.#controller.signal.reason);
    const onSettled = (): void => {
      this.#controller.signal.removeEventListener('abort', propagate);
      this.#children.delete(child);
      this.#checkSettled();
    };
    child = new BoundedStructuredTaskScope(
      `${this.#name}/${text('child scope name', name, 80)}`,
      {
        maxActiveTasks: overrides.maxActiveTasks ?? this.#maxActiveTasks,
        maxOwnerTasks: overrides.maxOwnerTasks ?? this.#maxOwnerTasks,
        maxChildren: overrides.maxChildren ?? this.#maxChildren,
        historyLimit: overrides.historyLimit ?? this.#historyLimit,
        defaultTimeoutMs: overrides.defaultTimeoutMs ?? this.#defaultTimeoutMs,
        maxTimeoutMs: overrides.maxTimeoutMs ?? this.#maxTimeoutMs,
        clock: overrides.clock ?? this.#clock,
      },
      onSettled,
    );
    this.#children.add(child);
    this.#controller.signal.addEventListener('abort', propagate, { once: true });
    return child;
  }

  async close(request: TaskScopeCloseRequest = {}): Promise<void> {
    if (this.#state === 'disposed' || this.#state === 'closed') return;
    if (this.#state === 'open') this.#state = 'closing';

    if (request.cancelActive) {
      const reason = request.reason ?? cancellationError('scope-closing');
      for (const task of this.#active.values()) {
        if (!task.controller.signal.aborted) task.controller.abort(reason);
      }
      for (const child of this.#children) child.dispose(reason);
    } else {
      for (const child of this.#children) {
        void child.close({
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }
    }

    this.#checkSettled();
    await this.waitForIdle(request.signal);
    if (this.#state !== 'disposed') {
      this.#state = 'closed';
      this.#onSettled?.();
    }
  }

  waitForIdle(signal?: AbortSignal): Promise<void> {
    if (this.#active.size === 0 && this.#children.size === 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(cancellationError(signal.reason));

    return new Promise<void>((resolve, reject) => {
      const waiter: IdleWaiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        unlink: null,
        settled: false,
      };

      if (signal) {
        const onAbort = (): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#idleWaiters.delete(waiter);
          waiter.unlink?.();
          reject(cancellationError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.unlink = () => signal.removeEventListener('abort', onAbort);
      }

      this.#idleWaiters.add(waiter);
      this.#settleIdleWaiters();
    });
  }

  snapshot(): TaskScopeSnapshot {
    return Object.freeze({
      name: this.#name,
      state: this.#state,
      active: this.#active.size,
      owners: this.#ownerCounts.size,
      children: this.#children.size,
      ...this.#stats,
      history: Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))),
    });
  }

  dispose(reason: unknown = cancellationError('scope-disposed')): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    for (const task of this.#active.values()) {
      if (!task.controller.signal.aborted) task.controller.abort(reason);
    }
    for (const child of this.#children) child.dispose(reason);
    this.#settleIdleWaiters();
    this.#onSettled?.();
  }

  #record(task: ActiveTask, outcome: TaskScopeOutcome, error?: unknown): void {
    if (this.#historyLimit === 0) return;
    const at = this.#now();
    this.#history.push(Object.freeze({
      sequence: ++this.#sequence,
      at,
      scope: this.#name,
      owner: task.owner,
      key: task.key,
      label: task.label,
      outcome,
      durationMs: Math.max(0, at - task.startedAt),
      ...(error === undefined ? {} : { errorName: errorName(error) }),
    }));
    const overflow = this.#history.length - this.#historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
  }

  #checkSettled(): void {
    if (this.#state === 'closing' && this.#active.size === 0 && this.#children.size === 0) {
      this.#state = 'closed';
      this.#onSettled?.();
    }
    this.#settleIdleWaiters();
  }

  #settleIdleWaiters(): void {
    if (this.#active.size !== 0 || this.#children.size !== 0) return;
    for (const waiter of this.#idleWaiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.unlink?.();
      waiter.resolve();
    }
    this.#idleWaiters.clear();
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new StructuredTaskScopeError('INVALID_REQUEST', 'clock returned an invalid timestamp');
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new StructuredTaskScopeError('INVALID_REQUEST', 'clock must be monotonic');
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createStructuredTaskScope = (
  name: string,
  options: StructuredTaskScopeOptions = {},
): StructuredTaskScope => new BoundedStructuredTaskScope(name, options);
