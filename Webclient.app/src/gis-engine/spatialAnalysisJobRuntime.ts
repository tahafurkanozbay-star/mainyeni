export type SpatialAnalysisJobPriority = 'interactive' | 'normal' | 'background';
export type SpatialAnalysisJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export type SpatialAnalysisJobRuntimeConfiguration = Readonly<{
  maxConcurrent: number;
  maxQueued: number;
  maxHistory: number;
  defaultTimeoutMs: number;
}>;

export type SpatialAnalysisJobContext = Readonly<{
  jobId: string;
  signal: AbortSignal;
}>;

export type SpatialAnalysisJobOptions = Readonly<{
  dedupeKey?: string;
  priority?: SpatialAnalysisJobPriority;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type SpatialAnalysisJobSnapshot = Readonly<{
  id: string;
  dedupeKey: string | null;
  priority: SpatialAnalysisJobPriority;
  status: SpatialAnalysisJobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  errorCode: string | null;
}>;

export type SpatialAnalysisJobRuntimeSnapshot = Readonly<{
  disposed: boolean;
  queued: number;
  running: number;
  retainedHistory: number;
  submitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  deduped: number;
}>;

type JobExecutor<T> = (context: SpatialAnalysisJobContext) => T | Promise<T>;

type InternalJob<T> = {
  id: string;
  dedupeKey: string | undefined;
  priority: SpatialAnalysisJobPriority;
  timeoutMs: number;
  sequence: number;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  status: SpatialAnalysisJobStatus;
  errorCode: string | undefined;
  subscribers: number;
  settled: boolean;
  controller: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  executor: JobExecutor<T>;
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const priorityRank: Record<SpatialAnalysisJobPriority, number> = {
  interactive: 3,
  normal: 2,
  background: 1,
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
};

const errorWithCode = (message: string, code: string): Error & { code: string } => (
  Object.assign(new Error(message), { code })
);

const cancelledError = (jobId: string): Error & { code: string } => (
  errorWithCode(`Spatial analysis job ${jobId} was cancelled.`, 'CANCELLED')
);

const timeoutError = (jobId: string): Error & { code: string } => (
  errorWithCode(`Spatial analysis job ${jobId} exceeded its timeout.`, 'TIMEOUT')
);

const disposedError = (): Error & { code: string } => (
  errorWithCode('Spatial analysis job runtime is disposed.', 'RUNTIME_DISPOSED')
);

const queueFullError = (): Error & { code: string } => (
  errorWithCode('Spatial analysis job queue is full.', 'QUEUE_FULL')
);

const readErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

export const normalizeSpatialAnalysisJobConfiguration = (
  configuration: SpatialAnalysisJobRuntimeConfiguration,
): SpatialAnalysisJobRuntimeConfiguration => ({
  maxConcurrent: positiveInteger(configuration.maxConcurrent, 'maxConcurrent'),
  maxQueued: positiveInteger(configuration.maxQueued, 'maxQueued'),
  maxHistory: positiveInteger(configuration.maxHistory, 'maxHistory'),
  defaultTimeoutMs: nonNegativeInteger(configuration.defaultTimeoutMs, 'defaultTimeoutMs'),
});

const publicSnapshot = <T>(job: InternalJob<T>): SpatialAnalysisJobSnapshot => {
  const startedAt = job.startedAt ?? null;
  const finishedAt = job.finishedAt ?? null;
  return {
    id: job.id,
    dedupeKey: job.dedupeKey ?? null,
    priority: job.priority,
    status: job.status,
    createdAt: job.createdAt,
    startedAt,
    finishedAt,
    durationMs: startedAt !== null && finishedAt !== null ? Math.max(0, finishedAt - startedAt) : null,
    errorCode: job.errorCode ?? null,
  };
};

export class SpatialAnalysisJobRuntime {
  #configuration: SpatialAnalysisJobRuntimeConfiguration;
  #disposed = false;
  #sequence = 0;
  #queue: InternalJob<unknown>[] = [];
  #jobs = new Map<string, InternalJob<unknown>>();
  #dedupe = new Map<string, string>();
  #history: SpatialAnalysisJobSnapshot[] = [];
  #running = 0;
  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #timedOut = 0;
  #deduped = 0;

  constructor(configuration: SpatialAnalysisJobRuntimeConfiguration) {
    this.#configuration = normalizeSpatialAnalysisJobConfiguration(configuration);
  }

  submit<T>(executor: JobExecutor<T>, options: SpatialAnalysisJobOptions = {}): Promise<T> {
    if (this.#disposed) return Promise.reject(disposedError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? cancelledError('preflight'));

    const dedupeKey = options.dedupeKey?.trim() || undefined;
    if (dedupeKey) {
      const existingId = this.#dedupe.get(dedupeKey);
      const existing = existingId ? this.#jobs.get(existingId) as InternalJob<T> | undefined : undefined;
      if (existing && !existing.settled) {
        this.#deduped += 1;
        return this.#attach(existing, options.signal);
      }
    }

    if (this.#queue.length >= this.#configuration.maxQueued) return Promise.reject(queueFullError());

    const sequence = ++this.#sequence;
    const id = `spatial-job-${sequence}`;
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);

    const timeoutMs = options.timeoutMs === undefined
      ? this.#configuration.defaultTimeoutMs
      : nonNegativeInteger(options.timeoutMs, 'timeoutMs');
    const job: InternalJob<T> = {
      id,
      dedupeKey,
      priority: options.priority ?? 'normal',
      timeoutMs,
      sequence,
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      status: 'queued',
      errorCode: undefined,
      subscribers: 0,
      settled: false,
      controller: new AbortController(),
      timeoutHandle: undefined,
      executor,
      promise,
      resolve,
      reject,
    };

    this.#jobs.set(id, job as InternalJob<unknown>);
    if (dedupeKey) this.#dedupe.set(dedupeKey, id);
    this.#queue.push(job as InternalJob<unknown>);
    this.#submitted += 1;
    const consumer = this.#attach(job, options.signal);
    this.#sortQueue();
    this.#pump();
    return consumer;
  }

  cancel(jobId: string, reason: unknown = cancelledError(jobId)): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.settled) return false;
    job.controller.abort(reason);
    this.#finishFailure(job, reason, 'cancelled');
    return true;
  }

  cancelByDedupeKey(dedupeKey: string, reason?: unknown): boolean {
    const jobId = this.#dedupe.get(dedupeKey.trim());
    return jobId ? this.cancel(jobId, reason ?? cancelledError(jobId)) : false;
  }

  getJob(jobId: string): SpatialAnalysisJobSnapshot | null {
    const active = this.#jobs.get(jobId);
    if (active) return publicSnapshot(active);
    return this.#history.find((item) => item.id === jobId) ?? null;
  }

  listHistory(): readonly SpatialAnalysisJobSnapshot[] {
    return [...this.#history];
  }

  snapshot(): SpatialAnalysisJobRuntimeSnapshot {
    return {
      disposed: this.#disposed,
      queued: this.#queue.filter((job) => !job.settled).length,
      running: this.#running,
      retainedHistory: this.#history.length,
      submitted: this.#submitted,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      timedOut: this.#timedOut,
      deduped: this.#deduped,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const reason = disposedError();
    for (const job of this.#jobs.values()) {
      if (job.settled) continue;
      job.controller.abort(reason);
      this.#finishFailure(job, reason, 'cancelled');
    }
    this.#queue = [];
  }

  #sortQueue(): void {
    this.#queue.sort((left, right) => (
      priorityRank[right.priority] - priorityRank[left.priority] || left.sequence - right.sequence
    ));
  }

  #pump(): void {
    if (this.#disposed) return;
    while (this.#running < this.#configuration.maxConcurrent) {
      const job = this.#queue.shift();
      if (!job) break;
      if (job.settled) continue;
      this.#start(job);
    }
  }

  #start(job: InternalJob<unknown>): void {
    if (job.settled || this.#disposed) return;
    job.status = 'running';
    job.startedAt = Date.now();
    this.#running += 1;

    if (job.timeoutMs > 0) {
      job.timeoutHandle = setTimeout(() => {
        const error = timeoutError(job.id);
        job.controller.abort(error);
        this.#finishFailure(job, error, 'timed-out');
      }, job.timeoutMs);
    }

    const context: SpatialAnalysisJobContext = { jobId: job.id, signal: job.controller.signal };
    void Promise.resolve()
      .then(() => job.executor(context))
      .then(
        (value) => {
          if (job.controller.signal.aborted) {
            const reason = job.controller.signal.reason ?? cancelledError(job.id);
            this.#finishFailure(job, reason, readErrorCode(reason) === 'TIMEOUT' ? 'timed-out' : 'cancelled');
            return;
          }
          this.#finishSuccess(job, value);
        },
        (error: unknown) => {
          const code = readErrorCode(job.controller.signal.reason) ?? readErrorCode(error);
          const status: SpatialAnalysisJobStatus = code === 'TIMEOUT'
            ? 'timed-out'
            : job.controller.signal.aborted ? 'cancelled' : 'failed';
          this.#finishFailure(job, error, status);
        },
      );
  }

  #finishSuccess(job: InternalJob<unknown>, value: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.status = 'completed';
    job.finishedAt = Date.now();
    job.resolve(value);
    this.#completed += 1;
    this.#cleanup(job);
  }

  #finishFailure(
    job: InternalJob<unknown>,
    error: unknown,
    status: Extract<SpatialAnalysisJobStatus, 'failed' | 'cancelled' | 'timed-out'>,
  ): void {
    if (job.settled) return;
    job.settled = true;
    job.status = status;
    job.finishedAt = Date.now();
    job.errorCode = readErrorCode(error);
    job.reject(error);
    if (status === 'failed') this.#failed += 1;
    else if (status === 'timed-out') this.#timedOut += 1;
    else this.#cancelled += 1;
    this.#cleanup(job);
  }

  #cleanup(job: InternalJob<unknown>): void {
    if (job.timeoutHandle !== undefined) clearTimeout(job.timeoutHandle);
    job.timeoutHandle = undefined;
    if (job.startedAt !== undefined) this.#running = Math.max(0, this.#running - 1);
    this.#queue = this.#queue.filter((candidate) => candidate !== job);
    this.#jobs.delete(job.id);
    if (job.dedupeKey && this.#dedupe.get(job.dedupeKey) === job.id) this.#dedupe.delete(job.dedupeKey);
    this.#history.unshift(publicSnapshot(job));
    if (this.#history.length > this.#configuration.maxHistory) {
      this.#history.length = this.#configuration.maxHistory;
    }
    this.#pump();
  }

  #attach<T>(job: InternalJob<T>, signal?: AbortSignal): Promise<T> {
    job.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let detached = false;
      let cancelled = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        signal?.removeEventListener('abort', onAbort);
        job.subscribers = Math.max(0, job.subscribers - 1);
        if (job.subscribers === 0 && !job.settled) {
          const reason = cancelledError(job.id);
          job.controller.abort(reason);
          this.#finishFailure(job as InternalJob<unknown>, reason, 'cancelled');
        }
      };
      const onAbort = (): void => {
        if (cancelled) return;
        cancelled = true;
        detach();
        reject(signal?.reason ?? cancelledError(job.id));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (value) => {
          if (cancelled) return;
          detach();
          resolve(value);
        },
        (error: unknown) => {
          if (cancelled) return;
          detach();
          reject(error);
        },
      );
    });
  }
}

export const createSpatialAnalysisJobRuntime = (
  configuration: SpatialAnalysisJobRuntimeConfiguration,
): SpatialAnalysisJobRuntime => new SpatialAnalysisJobRuntime(configuration);
