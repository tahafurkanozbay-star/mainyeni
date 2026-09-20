export type RequestLifetimeState = 'open' | 'closing' | 'closed' | 'disposed';
export type RequestLifetimeOutcome = 'success' | 'failure' | 'cancelled';

export interface RequestLifetimeScopeOptions {
  readonly maxActiveTasks?: number;
  readonly maxOwnerTasks?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
}

export interface RequestLifetimeRun<T> {
  readonly owner: string;
  readonly key: string;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly task: (signal: AbortSignal) => Promise<T>;
}

export interface RequestLifetimeCloseOptions {
  readonly cancelActive?: boolean;
  readonly reason?: unknown;
  readonly signal?: AbortSignal;
}

export interface RequestLifetimeEvent {
  readonly sequence: number;
  readonly at: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly outcome: RequestLifetimeOutcome;
  readonly durationMs: number;
  readonly errorName?: string;
}

export interface RequestLifetimeSnapshot {
  readonly state: RequestLifetimeState;
  readonly active: number;
  readonly owners: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly history: readonly RequestLifetimeEvent[];
}

export interface RequestLifetimeScope {
  readonly run: <T>(request: RequestLifetimeRun<T>) => Promise<T>;
  readonly close: (options?: RequestLifetimeCloseOptions) => Promise<void>;
  readonly waitForIdle: (signal?: AbortSignal) => Promise<void>;
  readonly snapshot: () => RequestLifetimeSnapshot;
  readonly dispose: (reason?: unknown) => void;
}

export class RequestLifetimeError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'SCOPE_NOT_OPEN'
      | 'TASK_CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'TASK_CANCELLED',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'RequestLifetimeError';
  }
}

interface ActiveTask {
  readonly id: number;
  readonly owner: string;
  readonly key: string;
  readonly label: string;
  readonly startedAt: number;
  readonly controller: AbortController;
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

interface LifetimeStats {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  rejected: number;
}

const integer = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const identity = (name: string, value: string, maximum: number): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RequestLifetimeError(
      'INVALID_REQUEST',
      `${name} must contain 1-${maximum} characters`,
    );
  }
  const unsafe = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (unsafe) {
    throw new RequestLifetimeError(
      'INVALID_REQUEST',
      `${name} cannot contain control characters`,
    );
  }
  return normalized;
};

const cancellationError = (reason?: unknown): RequestLifetimeError =>
  new RequestLifetimeError('TASK_CANCELLED', 'Request lifetime was cancelled.', reason);

const errorName = (error: unknown): string =>
  error instanceof Error && error.name.trim() ? error.name.slice(0, 80) : 'UnknownError';

class BoundedRequestLifetimeScope implements RequestLifetimeScope {
  readonly #maxActiveTasks: number;
  readonly #maxOwnerTasks: number;
  readonly #historyLimit: number;
  readonly #clock: () => number;
  readonly #rootController = new AbortController();
  readonly #active = new Map<number, ActiveTask>();
  readonly #owners = new Map<string, number>();
  readonly #waiters = new Set<IdleWaiter>();
  readonly #history: RequestLifetimeEvent[] = [];
  readonly #stats: LifetimeStats = {
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
  };
  #state: RequestLifetimeState = 'open';
  #taskSequence = 0;
  #eventSequence = 0;
  #lastObservedAt: number | undefined;

  constructor(options: RequestLifetimeScopeOptions = {}) {
    this.#maxActiveTasks = integer(
      'maxActiveTasks',
      options.maxActiveTasks ?? 128,
      1,
      10_000,
    );
    this.#maxOwnerTasks = integer(
      'maxOwnerTasks',
      options.maxOwnerTasks ?? Math.min(32, this.#maxActiveTasks),
      1,
      this.#maxActiveTasks,
    );
    this.#historyLimit = integer(
      'historyLimit',
      options.historyLimit ?? 256,
      0,
      4096,
    );
    this.#clock = options.clock ?? Date.now;
  }

  async run<T>(request: RequestLifetimeRun<T>): Promise<T> {
    if (this.#state !== 'open') {
      this.#stats.rejected += 1;
      throw new RequestLifetimeError(
        'SCOPE_NOT_OPEN',
        'Request lifetime scope is not accepting new work.',
      );
    }
    if (typeof request.task !== 'function') {
      this.#stats.rejected += 1;
      throw new RequestLifetimeError('INVALID_REQUEST', 'task must be a function');
    }

    const owner = identity('owner', request.owner, 160);
    const key = identity('key', request.key, 160);
    const label = request.label === undefined
      ? key
      : identity('label', request.label, 200);

    if (request.signal?.aborted) {
      this.#stats.rejected += 1;
      throw cancellationError(request.signal.reason);
    }
    if (this.#active.size >= this.#maxActiveTasks) {
      this.#stats.rejected += 1;
      throw new RequestLifetimeError(
        'TASK_CAPACITY_EXCEEDED',
        'Request lifetime capacity is exhausted.',
      );
    }

    const ownerCount = this.#owners.get(owner) ?? 0;
    if (ownerCount >= this.#maxOwnerTasks) {
      this.#stats.rejected += 1;
      throw new RequestLifetimeError(
        'OWNER_CAPACITY_EXCEEDED',
        'Request lifetime owner capacity is exhausted.',
      );
    }

    const task: ActiveTask = {
      id: ++this.#taskSequence,
      owner,
      key,
      label,
      startedAt: this.#now(),
      controller: new AbortController(),
      unlinkExternal: null,
      settled: false,
    };

    const abortFromRoot = (): void => {
      if (!task.controller.signal.aborted) {
        task.controller.abort(this.#rootController.signal.reason ?? cancellationError());
      }
    };
    this.#rootController.signal.addEventListener('abort', abortFromRoot, { once: true });

    if (request.signal) {
      const abortFromCaller = (): void => {
        if (!task.controller.signal.aborted) {
          task.controller.abort(request.signal?.reason ?? cancellationError());
        }
      };
      request.signal.addEventListener('abort', abortFromCaller, { once: true });
      task.unlinkExternal = () =>
        request.signal?.removeEventListener('abort', abortFromCaller);
    }

    this.#active.set(task.id, task);
    this.#owners.set(owner, ownerCount + 1);
    this.#stats.started += 1;

    try {
      const result = await request.task(task.controller.signal);
      if (task.controller.signal.aborted) {
        throw task.controller.signal.reason ?? cancellationError();
      }
      task.settled = true;
      this.#stats.succeeded += 1;
      this.#record(task, 'success');
      return result;
    } catch (error) {
      task.settled = true;
      if (task.controller.signal.aborted) {
        this.#stats.cancelled += 1;
        this.#record(task, 'cancelled', error);
      } else {
        this.#stats.failed += 1;
        this.#record(task, 'failure', error);
      }
      throw error;
    } finally {
      task.unlinkExternal?.();
      task.unlinkExternal = null;
      this.#rootController.signal.removeEventListener('abort', abortFromRoot);
      this.#active.delete(task.id);
      const remaining = (this.#owners.get(owner) ?? 1) - 1;
      if (remaining <= 0) this.#owners.delete(owner);
      else this.#owners.set(owner, remaining);
      this.#settleIdle();
    }
  }

  async close(options: RequestLifetimeCloseOptions = {}): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'disposed') return;
    if (this.#state === 'open') this.#state = 'closing';

    if (options.cancelActive) {
      const reason = options.reason ?? cancellationError('scope-closing');
      this.#active.forEach((task) => {
        if (!task.controller.signal.aborted) task.controller.abort(reason);
      });
    }

    this.#settleIdle();
    await this.waitForIdle(options.signal);
    if (!this.#isDisposed()) this.#state = 'closed';
  }

  waitForIdle(signal?: AbortSignal): Promise<void> {
    if (this.#active.size === 0) return Promise.resolve();
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
          this.#waiters.delete(waiter);
          waiter.unlink?.();
          reject(cancellationError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.unlink = () => signal.removeEventListener('abort', onAbort);
      }
      this.#waiters.add(waiter);
      this.#settleIdle();
    });
  }

  snapshot(): RequestLifetimeSnapshot {
    return Object.freeze({
      state: this.#state,
      active: this.#active.size,
      owners: this.#owners.size,
      ...this.#stats,
      history: Object.freeze(
        this.#history.map((event) => Object.freeze({ ...event })),
      ),
    });
  }

  dispose(reason: unknown = cancellationError('scope-disposed')): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    if (!this.#rootController.signal.aborted) this.#rootController.abort(reason);
    this.#active.forEach((task) => {
      if (!task.controller.signal.aborted) task.controller.abort(reason);
    });
    this.#settleIdle();
  }

  #record(
    task: ActiveTask,
    outcome: RequestLifetimeOutcome,
    error?: unknown,
  ): void {
    if (this.#historyLimit === 0) return;
    const at = this.#now();
    this.#history.push(Object.freeze({
      sequence: ++this.#eventSequence,
      at,
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

  #isDisposed(): boolean {
    return this.#state === 'disposed';
  }

  #settleIdle(): void {
    if (this.#active.size !== 0) return;
    if (this.#state === 'closing') this.#state = 'closed';
    this.#waiters.forEach((waiter) => {
      if (waiter.settled) return;
      waiter.settled = true;
      waiter.unlink?.();
      waiter.resolve();
    });
    this.#waiters.clear();
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < 0) {
      throw new RequestLifetimeError(
        'INVALID_REQUEST',
        'clock returned an invalid timestamp',
      );
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new RequestLifetimeError(
        'INVALID_REQUEST',
        'clock must be monotonic',
      );
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createRequestLifetimeScope = (
  options: RequestLifetimeScopeOptions = {},
): RequestLifetimeScope => new BoundedRequestLifetimeScope(options);
