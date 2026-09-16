import {
  RESOURCE_KINDS,
  TASK_PRIORITIES,
  TASK_PRIORITY_ORDER,
  abortError,
  createMonotonicIdFactory,
  positiveInteger,
  throwIfAborted,
  type ResourceKind,
  type RuntimeBudget,
  type ScheduledTaskOptions,
  type SchedulerSnapshot,
  type TaskContext,
  type TaskPriority,
} from './contracts';

export type TaskExecutor<TValue> = (context: TaskContext) => Promise<TValue> | TValue;

export class SchedulerQueueFullError extends Error {
  readonly code = 'SCHEDULER_QUEUE_FULL';

  constructor(message = 'Runtime task queue is full.') {
    super(message);
    this.name = 'SchedulerQueueFullError';
  }
}

export class SchedulerDisposedError extends Error {
  readonly code = 'SCHEDULER_DISPOSED';

  constructor() {
    super('Runtime task scheduler has been disposed.');
    this.name = 'SchedulerDisposedError';
  }
}

export class SchedulerTimeoutError extends Error {
  readonly code = 'SCHEDULER_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Runtime task exceeded ${timeoutMs}ms timeout.`);
    this.name = 'SchedulerTimeoutError';
  }
}

interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue | PromiseLike<TValue>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface InternalTask<TValue> {
  readonly id: string;
  readonly key: string | null;
  readonly priority: TaskPriority;
  readonly kind: ResourceKind;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly timeoutMs: number | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly executor: TaskExecutor<TValue>;
  readonly deferred: Deferred<TValue>;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal | null;
  externalAbortCleanup: (() => void) | null;
  startedAt: number | null;
  settled: boolean;
}

export interface TaskSchedulerOptions {
  readonly budget: RuntimeBudget;
  readonly now?: () => number;
  readonly wallTime?: () => number;
  readonly onEvent?: (name: string, attributes: Readonly<Record<string, unknown>>) => void;
}

export interface RuntimeTaskScheduler {
  readonly schedule: <TValue>(executor: TaskExecutor<TValue>, options?: ScheduledTaskOptions) => Promise<TValue>;
  readonly cancel: (idOrKey: string, reason?: unknown) => number;
  readonly cancelAll: (reason?: unknown) => number;
  readonly snapshot: () => SchedulerSnapshot;
  readonly updateBudget: (budget: RuntimeBudget) => void;
  readonly drain: (signal?: AbortSignal) => Promise<void>;
  readonly dispose: (reason?: unknown) => void;
}

const createDeferred = <TValue>(): Deferred<TValue> => {
  let resolve!: Deferred<TValue>['resolve'];
  let reject!: Deferred<TValue>['reject'];
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const normalizePriority = (value: TaskPriority | undefined): TaskPriority =>
  value && TASK_PRIORITIES.includes(value) ? value : 'normal';

const normalizeKind = (value: ResourceKind | undefined): ResourceKind =>
  value && RESOURCE_KINDS.includes(value) ? value : 'cpu';

const normalizeKey = (value: string | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 200) : null;
};

const taskLimitForKind = (budget: RuntimeBudget, kind: ResourceKind): number => {
  if (kind === 'network') return budget.maxConcurrentNetwork;
  if (kind === 'render') return 1;
  if (kind === 'memory' || kind === 'storage') return Math.max(1, Math.min(2, budget.maxConcurrentCpu));
  return budget.maxConcurrentCpu;
};

const totalConcurrencyLimit = (budget: RuntimeBudget): number =>
  Math.max(1, budget.maxConcurrentNetwork + budget.maxConcurrentCpu + 1);

const priorityWeight = (priority: TaskPriority): number => TASK_PRIORITY_ORDER[priority];

const compareTasks = (left: InternalTask<unknown>, right: InternalTask<unknown>): number => {
  const priorityDelta = priorityWeight(left.priority) - priorityWeight(right.priority);
  if (priorityDelta !== 0) return priorityDelta;
  return left.sequence - right.sequence;
};

const abortReason = (signal: AbortSignal | null, fallback = 'Runtime task cancelled.'): unknown => {
  if (!signal) return abortError(fallback);
  return signal.reason ?? abortError(fallback);
};

export const createTaskScheduler = (options: TaskSchedulerOptions): RuntimeTaskScheduler => {
  let budget = options.budget;
  const now = options.now ?? (() => typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now());
  const wallTime = options.wallTime ?? Date.now;
  const makeId = createMonotonicIdFactory('task', wallTime);
  const queue: Array<InternalTask<unknown>> = [];
  const active = new Map<string, InternalTask<unknown>>();
  const keyed = new Map<string, InternalTask<unknown>>();
  const activeByKind: Record<ResourceKind, number> = {
    network: 0,
    cpu: 0,
    memory: 0,
    render: 0,
    storage: 0,
  };
  const counters = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    deduplicated: 0,
    rejected: 0,
  };
  let sequence = 0;
  let disposed = false;
  let pumping = false;
  const drainWaiters = new Set<() => void>();

  const emit = (name: string, attributes: Record<string, unknown>): void => {
    try {
      options.onEvent?.(name, Object.freeze({ ...attributes }));
    } catch {
      // Diagnostics must never destabilize task execution.
    }
  };

  const notifyDrain = (): void => {
    if (queue.length !== 0 || active.size !== 0) return;
    for (const resolve of Array.from(drainWaiters)) resolve();
    drainWaiters.clear();
  };

  const removeKey = (task: InternalTask<unknown>): void => {
    if (task.key && keyed.get(task.key) === task) keyed.delete(task.key);
  };

  const cleanupTask = (task: InternalTask<unknown>): void => {
    task.externalAbortCleanup?.();
    task.externalAbortCleanup = null;
    removeKey(task);
  };

  const settleQueuedCancellation = (task: InternalTask<unknown>, reason: unknown): void => {
    if (task.settled) return;
    task.settled = true;
    cleanupTask(task);
    counters.cancelled += 1;
    task.deferred.reject(reason);
    emit('scheduler.cancelled', {
      id: task.id,
      key: task.key,
      priority: task.priority,
      kind: task.kind,
      stage: 'queued',
    });
  };

  const removeFromQueue = (task: InternalTask<unknown>): boolean => {
    const index = queue.indexOf(task);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  };

  const canStart = (task: InternalTask<unknown>): boolean => {
    if (active.size >= totalConcurrencyLimit(budget)) return false;
    return activeByKind[task.kind] < taskLimitForKind(budget, task.kind);
  };

  const nextRunnableTask = (): InternalTask<unknown> | null => {
    if (queue.length === 0) return null;
    queue.sort(compareTasks);
    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      if (task && canStart(task)) {
        queue.splice(index, 1);
        return task;
      }
    }
    return null;
  };

  const finishTask = (task: InternalTask<unknown>): void => {
    active.delete(task.id);
    activeByKind[task.kind] = Math.max(0, activeByKind[task.kind] - 1);
    cleanupTask(task);
    notifyDrain();
    schedulePump();
  };

  const executeTask = async (task: InternalTask<unknown>): Promise<void> => {
    if (task.settled) return;
    task.startedAt = now();
    active.set(task.id, task);
    activeByKind[task.kind] += 1;
    const executionStartedAt = task.startedAt;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    if (task.timeoutMs !== null) {
      timeoutHandle = setTimeout(() => {
        if (!task.controller.signal.aborted) {
          task.controller.abort(new SchedulerTimeoutError(task.timeoutMs as number));
        }
      }, task.timeoutMs);
    }

    emit('scheduler.started', {
      id: task.id,
      key: task.key,
      priority: task.priority,
      kind: task.kind,
      queueDelayMs: Math.max(0, executionStartedAt - task.enqueuedAt),
    });

    try {
      throwIfAborted(task.controller.signal);
      const value = await task.executor({
        signal: task.controller.signal,
        taskId: task.id,
        attempt: 1,
        enqueuedAt: task.enqueuedAt,
        startedAt: executionStartedAt,
      });
      throwIfAborted(task.controller.signal);
      if (!task.settled) {
        task.settled = true;
        counters.completed += 1;
        task.deferred.resolve(value);
        emit('scheduler.completed', {
          id: task.id,
          key: task.key,
          priority: task.priority,
          kind: task.kind,
          durationMs: Math.max(0, now() - executionStartedAt),
        });
      }
    } catch (error) {
      if (!task.settled) {
        task.settled = true;
        const timeout = task.controller.signal.reason instanceof SchedulerTimeoutError;
        const cancelled = task.controller.signal.aborted && !timeout;
        if (timeout) counters.timedOut += 1;
        else if (cancelled) counters.cancelled += 1;
        else counters.failed += 1;
        task.deferred.reject(error);
        emit(timeout ? 'scheduler.timed-out' : cancelled ? 'scheduler.cancelled' : 'scheduler.failed', {
          id: task.id,
          key: task.key,
          priority: task.priority,
          kind: task.kind,
          durationMs: Math.max(0, now() - executionStartedAt),
        });
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      finishTask(task);
    }
  };

  const pump = (): void => {
    if (disposed || pumping) return;
    pumping = true;
    try {
      while (true) {
        const task = nextRunnableTask();
        if (!task) break;
        void executeTask(task);
      }
    } finally {
      pumping = false;
    }
  };

  function schedulePump(): void {
    if (disposed) return;
    if (typeof queueMicrotask === 'function') queueMicrotask(pump);
    else Promise.resolve().then(pump);
  }

  const bindExternalSignal = (task: InternalTask<unknown>, signal: AbortSignal | undefined): void => {
    if (!signal) return;
    if (signal.aborted) {
      task.controller.abort(abortReason(signal));
      return;
    }
    const handler = () => task.controller.abort(abortReason(signal));
    signal.addEventListener('abort', handler, { once: true });
    task.externalAbortCleanup = () => signal.removeEventListener('abort', handler);
  };

  const schedule = <TValue>(
    executor: TaskExecutor<TValue>,
    scheduleOptions: ScheduledTaskOptions = {},
  ): Promise<TValue> => {
    if (disposed) return Promise.reject(new SchedulerDisposedError());
    if (typeof executor !== 'function') return Promise.reject(new TypeError('Task executor must be a function.'));

    const key = normalizeKey(scheduleOptions.key);
    if (key && scheduleOptions.deduplicate !== false) {
      const existing = keyed.get(key) as InternalTask<TValue> | undefined;
      if (existing && !existing.settled) {
        counters.deduplicated += 1;
        emit('scheduler.deduplicated', { key, existingId: existing.id });
        return existing.deferred.promise;
      }
    }

    if (queue.length >= budget.maxQueuedTasks) {
      counters.rejected += 1;
      const error = new SchedulerQueueFullError();
      emit('scheduler.rejected', {
        key,
        queueLength: queue.length,
        maxQueuedTasks: budget.maxQueuedTasks,
      });
      return Promise.reject(error);
    }

    if (key && scheduleOptions.replaceQueued) {
      const previous = keyed.get(key);
      if (previous && previous.startedAt === null && removeFromQueue(previous)) {
        previous.controller.abort(abortError('Superseded by a newer queued task.'));
        settleQueuedCancellation(previous, previous.controller.signal.reason);
      }
    }

    sequence += 1;
    const deferred = createDeferred<TValue>();
    const task: InternalTask<TValue> = {
      id: scheduleOptions.id?.trim().slice(0, 200) || makeId(),
      key,
      priority: normalizePriority(scheduleOptions.priority),
      kind: normalizeKind(scheduleOptions.kind),
      enqueuedAt: now(),
      sequence,
      timeoutMs: scheduleOptions.timeoutMs === undefined
        ? null
        : positiveInteger(scheduleOptions.timeoutMs, 15000, 10 * 60 * 1000),
      metadata: scheduleOptions.metadata ? Object.freeze({ ...scheduleOptions.metadata }) : null,
      executor,
      deferred,
      controller: new AbortController(),
      externalSignal: scheduleOptions.signal ?? null,
      externalAbortCleanup: null,
      startedAt: null,
      settled: false,
    };

    bindExternalSignal(task as InternalTask<unknown>, scheduleOptions.signal);
    if (task.controller.signal.aborted) {
      task.settled = true;
      counters.cancelled += 1;
      cleanupTask(task as InternalTask<unknown>);
      deferred.reject(task.controller.signal.reason ?? abortError());
      return deferred.promise;
    }

    queue.push(task as InternalTask<unknown>);
    if (key) keyed.set(key, task as InternalTask<unknown>);
    emit('scheduler.queued', {
      id: task.id,
      key: task.key,
      priority: task.priority,
      kind: task.kind,
      queued: queue.length,
    });
    schedulePump();
    return deferred.promise;
  };

  const cancel = (idOrKey: string, reason: unknown = abortError()): number => {
    if (!idOrKey) return 0;
    let cancelled = 0;
    for (const task of [...queue]) {
      if (task.id === idOrKey || task.key === idOrKey) {
        if (removeFromQueue(task)) {
          task.controller.abort(reason);
          settleQueuedCancellation(task, reason);
          cancelled += 1;
        }
      }
    }
    for (const task of active.values()) {
      if ((task.id === idOrKey || task.key === idOrKey) && !task.controller.signal.aborted) {
        task.controller.abort(reason);
        cancelled += 1;
      }
    }
    notifyDrain();
    return cancelled;
  };

  const cancelAll = (reason: unknown = abortError('Runtime scheduler cancelled all tasks.')): number => {
    let cancelled = 0;
    for (const task of [...queue]) {
      if (removeFromQueue(task)) {
        task.controller.abort(reason);
        settleQueuedCancellation(task, reason);
        cancelled += 1;
      }
    }
    for (const task of active.values()) {
      if (!task.controller.signal.aborted) {
        task.controller.abort(reason);
        cancelled += 1;
      }
    }
    notifyDrain();
    return cancelled;
  };

  const snapshot = (): SchedulerSnapshot => {
    const queuedByPriority: Record<TaskPriority, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
      background: 0,
    };
    for (const task of queue) queuedByPriority[task.priority] += 1;
    return Object.freeze({
      active: active.size,
      queued: queue.length,
      completed: counters.completed,
      failed: counters.failed,
      cancelled: counters.cancelled,
      timedOut: counters.timedOut,
      deduplicated: counters.deduplicated,
      rejected: counters.rejected,
      activeByKind: Object.freeze({ ...activeByKind }),
      queuedByPriority: Object.freeze(queuedByPriority),
    });
  };

  const updateBudget = (nextBudget: RuntimeBudget): void => {
    budget = nextBudget;
    schedulePump();
  };

  const drain = (signal?: AbortSignal): Promise<void> => {
    if (queue.length === 0 && active.size === 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const complete = () => {
        signal?.removeEventListener('abort', abortHandler);
        drainWaiters.delete(complete);
        resolve();
      };
      const abortHandler = () => {
        drainWaiters.delete(complete);
        reject(abortReason(signal ?? null));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      drainWaiters.add(complete);
    });
  };

  const dispose = (reason: unknown = new SchedulerDisposedError()): void => {
    if (disposed) return;
    disposed = true;
    cancelAll(reason);
    notifyDrain();
  };

  return Object.freeze({
    schedule,
    cancel,
    cancelAll,
    snapshot,
    updateBudget,
    drain,
    dispose,
  });
};
