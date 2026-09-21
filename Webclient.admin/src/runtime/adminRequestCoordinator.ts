export type AdminRequestOutcome =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'queue-timeout'
  | 'capacity-rejected';

export interface AdminRequestEvent {
  readonly outcome: AdminRequestOutcome;
  readonly queueMs: number;
  readonly executionMs: number;
}

export interface AdminRequestCoordinatorSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly scheduled: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly queueTimedOut: number;
  readonly capacityRejected: number;
  readonly singleFlightJoined: number;
  readonly recent: readonly AdminRequestEvent[];
}

export interface AdminRequestCoordinatorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly defaultQueueTimeoutMs?: number;
  readonly historyLimit?: number;
  readonly now?: () => number;
}

export interface AdminRequestScheduleOptions {
  readonly singleFlightKey?: string;
  readonly signal?: AbortSignal;
  readonly queueTimeoutMs?: number;
}

export type AdminRequestCoordinatorErrorCode =
  | 'queue-full'
  | 'queue-timeout'
  | 'aborted';

export class AdminRequestCoordinatorError extends Error {
  public readonly code: AdminRequestCoordinatorErrorCode;

  public constructor(
    code: AdminRequestCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminRequestCoordinatorError';
    this.code = code;
  }
}

interface QueueEntry<T> {
  readonly id: number;
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  readonly queuedAt: number;
  queueTimer: ReturnType<typeof setTimeout> | null;
  abortHandler: (() => void) | null;
}

const clampInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

const freezeEvent = (
  outcome: AdminRequestOutcome,
  queueMs: number,
  executionMs: number,
): AdminRequestEvent => Object.freeze({
  outcome,
  queueMs: Math.max(0, Math.round(queueMs)),
  executionMs: Math.max(0, Math.round(executionMs)),
});

export class AdminRequestCoordinator {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly defaultQueueTimeoutMs: number;
  private readonly historyLimit: number;
  private readonly now: () => number;

  private activeCount = 0;
  private nextId = 1;
  private readonly queue: QueueEntry<unknown>[] = [];
  private readonly singleFlight = new Map<string, Promise<unknown>>();
  private readonly recentEvents: AdminRequestEvent[] = [];

  private peakActiveCount = 0;
  private peakQueuedCount = 0;
  private scheduledCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;
  private queueTimedOutCount = 0;
  private capacityRejectedCount = 0;
  private singleFlightJoinedCount = 0;

  public constructor(options: AdminRequestCoordinatorOptions = {}) {
    this.maxConcurrent = clampInteger(
      options.maxConcurrent,
      6,
      1,
      16,
    );
    this.maxQueued = clampInteger(
      options.maxQueued,
      64,
      0,
      512,
    );
    this.defaultQueueTimeoutMs = clampInteger(
      options.defaultQueueTimeoutMs,
      5_000,
      100,
      30_000,
    );
    this.historyLimit = clampInteger(
      options.historyLimit,
      32,
      0,
      256,
    );
    this.now = options.now ?? (() => performance.now());
  }

  public schedule<T>(
    operation: () => Promise<T>,
    options: AdminRequestScheduleOptions = {},
  ): Promise<T> {
    const key = options.singleFlightKey?.trim();
    if (key) {
      const existing = this.singleFlight.get(key);
      if (existing) {
        this.singleFlightJoinedCount += 1;
        return existing as Promise<T>;
      }
    }

    if (options.signal?.aborted) {
      this.cancelledCount += 1;
      this.record('cancelled', 0, 0);
      return Promise.reject(new AdminRequestCoordinatorError(
        'aborted',
        'Admin request was aborted before scheduling.',
      ));
    }

    const promise = new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        id: this.nextId++,
        operation,
        resolve,
        reject,
        signal: options.signal,
        queuedAt: this.now(),
        queueTimer: null,
        abortHandler: null,
      };
      this.scheduledCount += 1;

      if (this.activeCount < this.maxConcurrent) {
        this.start(entry);
        return;
      }

      if (this.queue.length >= this.maxQueued) {
        this.capacityRejectedCount += 1;
        this.record('capacity-rejected', 0, 0);
        reject(new AdminRequestCoordinatorError(
          'queue-full',
          'Admin request queue is at capacity.',
        ));
        return;
      }

      this.enqueue(
        entry as QueueEntry<unknown>,
        clampInteger(
          options.queueTimeoutMs,
          this.defaultQueueTimeoutMs,
          100,
          30_000,
        ),
      );
    });

    if (key) {
      this.singleFlight.set(key, promise);
      const clear = (): void => {
        if (this.singleFlight.get(key) === promise) {
          this.singleFlight.delete(key);
        }
      };
      void promise.then(clear, clear);
    }

    return promise;
  }

  public snapshot(): AdminRequestCoordinatorSnapshot {
    return Object.freeze({
      active: this.activeCount,
      queued: this.queue.length,
      peakActive: this.peakActiveCount,
      peakQueued: this.peakQueuedCount,
      scheduled: this.scheduledCount,
      completed: this.completedCount,
      failed: this.failedCount,
      cancelled: this.cancelledCount,
      queueTimedOut: this.queueTimedOutCount,
      capacityRejected: this.capacityRejectedCount,
      singleFlightJoined: this.singleFlightJoinedCount,
      recent: Object.freeze([...this.recentEvents]),
    });
  }

  private enqueue(
    entry: QueueEntry<unknown>,
    queueTimeoutMs: number,
  ): void {
    const cancelQueued = (
      code: 'aborted' | 'queue-timeout',
      outcome: 'cancelled' | 'queue-timeout',
    ): void => {
      const index = this.queue.findIndex((candidate) => candidate.id === entry.id);
      if (index < 0) return;

      this.queue.splice(index, 1);
      this.detachQueueControls(entry);

      const queueMs = this.now() - entry.queuedAt;
      if (outcome === 'cancelled') this.cancelledCount += 1;
      else this.queueTimedOutCount += 1;
      this.record(outcome, queueMs, 0);

      entry.reject(new AdminRequestCoordinatorError(
        code,
        outcome === 'cancelled'
          ? 'Admin request was aborted while queued.'
          : 'Admin request exceeded the queue wait budget.',
      ));
    };

    if (entry.signal) {
      entry.abortHandler = () => cancelQueued('aborted', 'cancelled');
      entry.signal.addEventListener('abort', entry.abortHandler, { once: true });
    }

    entry.queueTimer = globalThis.setTimeout(
      () => cancelQueued('queue-timeout', 'queue-timeout'),
      queueTimeoutMs,
    );

    this.queue.push(entry);
    this.peakQueuedCount = Math.max(this.peakQueuedCount, this.queue.length);
  }

  private start<T>(entry: QueueEntry<T>): void {
    this.detachQueueControls(entry as QueueEntry<unknown>);

    this.activeCount += 1;
    this.peakActiveCount = Math.max(
      this.peakActiveCount,
      this.activeCount,
    );

    const startedAt = this.now();
    const queueMs = startedAt - entry.queuedAt;

    void (async () => {
      try {
        const value = await entry.operation();
        this.completedCount += 1;
        this.record(
          'success',
          queueMs,
          this.now() - startedAt,
        );
        entry.resolve(value);
      } catch (error) {
        if (entry.signal?.aborted) {
          this.cancelledCount += 1;
          this.record(
            'cancelled',
            queueMs,
            this.now() - startedAt,
          );
        } else {
          this.failedCount += 1;
          this.record(
            'failure',
            queueMs,
            this.now() - startedAt,
          );
        }
        entry.reject(error);
      } finally {
        this.activeCount -= 1;
        this.drain();
      }
    })();
  }

  private drain(): void {
    while (
      this.activeCount < this.maxConcurrent
      && this.queue.length > 0
    ) {
      const next = this.queue.shift();
      if (!next) return;

      if (next.signal?.aborted) {
        this.detachQueueControls(next);
        this.cancelledCount += 1;
        this.record(
          'cancelled',
          this.now() - next.queuedAt,
          0,
        );
        next.reject(new AdminRequestCoordinatorError(
          'aborted',
          'Admin request was aborted while queued.',
        ));
        continue;
      }

      this.start(next);
    }
  }

  private detachQueueControls(entry: QueueEntry<unknown>): void {
    if (entry.queueTimer !== null) {
      globalThis.clearTimeout(entry.queueTimer);
      entry.queueTimer = null;
    }

    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
      entry.abortHandler = null;
    }
  }

  private record(
    outcome: AdminRequestOutcome,
    queueMs: number,
    executionMs: number,
  ): void {
    if (this.historyLimit === 0) return;

    this.recentEvents.push(freezeEvent(
      outcome,
      queueMs,
      executionMs,
    ));

    while (this.recentEvents.length > this.historyLimit) {
      this.recentEvents.shift();
    }
  }
}

export const adminRequestCoordinator = new AdminRequestCoordinator();
