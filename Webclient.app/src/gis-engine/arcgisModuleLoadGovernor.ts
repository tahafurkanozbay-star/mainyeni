export type ArcgisModuleLoadPriority = 'critical' | 'interactive' | 'prefetch';
export type ArcgisModuleLoadStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export type ArcgisModuleLoadGovernorConfiguration = Readonly<{
  maxConcurrent: number;
  maxQueued: number;
  maxHistory: number;
  maxBatchModules: number;
  defaultTimeoutMs: number;
}>;

export type ArcgisGovernedModuleLoader = (
  moduleIds: readonly string[],
  signal: AbortSignal,
) => Promise<readonly unknown[]>;

export type ArcgisModuleLoadOptions = Readonly<{
  priority?: ArcgisModuleLoadPriority;
  dedupeKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type ArcgisModuleLoadJobSnapshot = Readonly<{
  id: string;
  priority: ArcgisModuleLoadPriority;
  dedupeKey: string | null;
  moduleIds: readonly string[];
  status: ArcgisModuleLoadStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  subscriberCount: number;
  errorCode: string | null;
}>;

export type ArcgisModuleLoadGovernorSnapshot = Readonly<{
  disposed: boolean;
  queued: number;
  running: number;
  loadedModules: number;
  retainedHistory: number;
  submitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  deduped: number;
}>;

type InternalJob = {
  id: string;
  sequence: number;
  priority: ArcgisModuleLoadPriority;
  dedupeKey: string;
  moduleIds: readonly string[];
  timeoutMs: number;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  status: ArcgisModuleLoadStatus;
  subscriberCount: number;
  errorCode: string | undefined;
  settled: boolean;
  controller: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  promise: Promise<readonly unknown[]>;
  resolve: (value: readonly unknown[] | PromiseLike<readonly unknown[]>) => void;
  reject: (reason?: unknown) => void;
};

const PRIORITY_RANK: Readonly<Record<ArcgisModuleLoadPriority, number>> = Object.freeze({
  critical: 3,
  interactive: 2,
  prefetch: 1,
});

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(\`\${name} must be a positive safe integer\`);
  }
  return value;
};

const nonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(\`\${name} must be a non-negative safe integer\`);
  }
  return value;
};

const normalizeModuleIds = (moduleIdsInput: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const moduleIds: string[] = [];
  for (const moduleIdInput of moduleIdsInput) {
    const moduleId = String(moduleIdInput ?? '').trim();
    if (!moduleId) throw new Error('ArcGIS module id is required.');
    if (seen.has(moduleId)) continue;
    seen.add(moduleId);
    moduleIds.push(moduleId);
  }
  return Object.freeze(moduleIds);
};

const createError = (message: string, code: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

const cancellationError = (jobId: string): Error & { code: string } =>
  createError(\`ArcGIS module load job \${jobId} was cancelled.\`, 'CANCELLED');

const timeoutError = (jobId: string): Error & { code: string } =>
  createError(\`ArcGIS module load job \${jobId} exceeded its timeout.\`, 'TIMEOUT');

const disposedError = (): Error & { code: string } =>
  createError('ArcGIS module load governor is disposed.', 'GOVERNOR_DISPOSED');

const queueFullError = (): Error & { code: string } =>
  createError('ArcGIS module load queue is full.', 'QUEUE_FULL');

const batchTooLargeError = (): Error & { code: string } =>
  createError('ArcGIS module load batch exceeds the configured module budget.', 'BATCH_TOO_LARGE');

const payloadMismatchError = (): Error & { code: string } =>
  createError('ArcGIS module loader returned a payload with an unexpected length.', 'PAYLOAD_MISMATCH');

const readErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

export const normalizeArcgisModuleLoadGovernorConfiguration = (
  configuration: ArcgisModuleLoadGovernorConfiguration,
): ArcgisModuleLoadGovernorConfiguration => Object.freeze({
  maxConcurrent: positiveInteger(configuration.maxConcurrent, 'maxConcurrent'),
  maxQueued: positiveInteger(configuration.maxQueued, 'maxQueued'),
  maxHistory: positiveInteger(configuration.maxHistory, 'maxHistory'),
  maxBatchModules: positiveInteger(configuration.maxBatchModules, 'maxBatchModules'),
  defaultTimeoutMs: nonNegativeInteger(configuration.defaultTimeoutMs, 'defaultTimeoutMs'),
});

const toPublicSnapshot = (job: InternalJob): ArcgisModuleLoadJobSnapshot => {
  const startedAt = job.startedAt ?? null;
  const finishedAt = job.finishedAt ?? null;
  return Object.freeze({
    id: job.id,
    priority: job.priority,
    dedupeKey: job.dedupeKey || null,
    moduleIds: job.moduleIds,
    status: job.status,
    createdAt: job.createdAt,
    startedAt,
    finishedAt,
    durationMs: startedAt !== null && finishedAt !== null
      ? Math.max(0, finishedAt - startedAt)
      : null,
    subscriberCount: job.subscriberCount,
    errorCode: job.errorCode ?? null,
  });
};

export class ArcgisModuleLoadGovernor {
  #configuration: ArcgisModuleLoadGovernorConfiguration;
  #loader: ArcgisGovernedModuleLoader;
  #disposed = false;
  #sequence = 0;
  #queue: InternalJob[] = [];
  #jobs = new Map<string, InternalJob>();
  #dedupe = new Map<string, string>();
  #history: ArcgisModuleLoadJobSnapshot[] = [];
  #loadedModuleIds = new Set<string>();
  #running = 0;
  #submitted = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #timedOut = 0;
  #deduped = 0;

  constructor(
    configuration: ArcgisModuleLoadGovernorConfiguration,
    loader: ArcgisGovernedModuleLoader,
  ) {
    if (typeof loader !== 'function') {
      throw new TypeError('ArcGIS module load governor requires a loader function.');
    }
    this.#configuration = normalizeArcgisModuleLoadGovernorConfiguration(configuration);
    this.#loader = loader;
  }

  submit(
    moduleIdsInput: readonly string[],
    options: ArcgisModuleLoadOptions = {},
  ): Promise<readonly unknown[]> {
    if (this.#disposed) return Promise.reject(disposedError());
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? cancellationError('preflight'));
    }

    const moduleIds = normalizeModuleIds(moduleIdsInput);
    if (moduleIds.length === 0) return Promise.resolve(Object.freeze([]));
    if (moduleIds.length > this.#configuration.maxBatchModules) {
      return Promise.reject(batchTooLargeError());
    }

    const dedupeKey = options.dedupeKey?.trim() || moduleIds.join('\u001f');
    const existingId = this.#dedupe.get(dedupeKey);
    const existing = existingId ? this.#jobs.get(existingId) : undefined;
    if (existing && !existing.settled) {
      this.#deduped += 1;
      return this.#attach(existing, options.signal);
    }

    if (this.#queue.filter((job) => !job.settled).length >= this.#configuration.maxQueued) {
      return Promise.reject(queueFullError());
    }

    const sequence = ++this.#sequence;
    const id = \`arcgis-module-job-\${sequence}\`;
    let resolve!: (value: readonly unknown[] | PromiseLike<readonly unknown[]>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<readonly unknown[]>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);

    const timeoutMs = options.timeoutMs === undefined
      ? this.#configuration.defaultTimeoutMs
      : nonNegativeInteger(options.timeoutMs, 'timeoutMs');

    const job: InternalJob = {
      id,
      sequence,
      priority: options.priority ?? 'interactive',
      dedupeKey,
      moduleIds,
      timeoutMs,
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      status: 'queued',
      subscriberCount: 0,
      errorCode: undefined,
      settled: false,
      controller: new AbortController(),
      timeoutHandle: undefined,
      promise,
      resolve,
      reject,
    };

    this.#jobs.set(job.id, job);
    this.#dedupe.set(dedupeKey, job.id);
    this.#queue.push(job);
    this.#submitted += 1;
    const consumer = this.#attach(job, options.signal);
    this.#sortQueue();
    this.#pump();
    return consumer;
  }

  cancel(jobId: string, reason: unknown = cancellationError(jobId)): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.settled) return false;
    job.controller.abort(reason);
    this.#finishFailure(job, reason, 'cancelled');
    return true;
  }

  cancelByDedupeKey(dedupeKeyInput: string, reason?: unknown): boolean {
    const dedupeKey = String(dedupeKeyInput ?? '').trim();
    if (!dedupeKey) return false;
    const jobId = this.#dedupe.get(dedupeKey);
    if (!jobId) return false;
    return this.cancel(jobId, reason ?? cancellationError(jobId));
  }

  getJob(jobId: string): ArcgisModuleLoadJobSnapshot | null {
    const active = this.#jobs.get(jobId);
    if (active) return toPublicSnapshot(active);
    return this.#history.find((entry) => entry.id === jobId) ?? null;
  }

  listHistory(): readonly ArcgisModuleLoadJobSnapshot[] {
    return Object.freeze([...this.#history]);
  }

  hasLoaded(moduleIdInput: string): boolean {
    const moduleId = String(moduleIdInput ?? '').trim();
    if (!moduleId) return false;
    return this.#loadedModuleIds.has(moduleId);
  }

  snapshot(): ArcgisModuleLoadGovernorSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      queued: this.#queue.filter((job) => !job.settled).length,
      running: this.#running,
      loadedModules: this.#loadedModuleIds.size,
      retainedHistory: this.#history.length,
      submitted: this.#submitted,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      timedOut: this.#timedOut,
      deduped: this.#deduped,
    });
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
    this.#dedupe.clear();
  }

  #sortQueue(): void {
    this.#queue.sort((left, right) => (
      PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
      || left.sequence - right.sequence
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

  #start(job: InternalJob): void {
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

    void Promise.resolve()
      .then(() => this.#loader(job.moduleIds, job.controller.signal))
      .then(
        (modules) => {
          if (job.settled) return;
          if (job.controller.signal.aborted) {
            const reason = job.controller.signal.reason ?? cancellationError(job.id);
            const status = readErrorCode(reason) === 'TIMEOUT' ? 'timed-out' : 'cancelled';
            this.#finishFailure(job, reason, status);
            return;
          }
          if (!Array.isArray(modules) || modules.length !== job.moduleIds.length) {
            this.#finishFailure(job, payloadMismatchError(), 'failed');
            return;
          }
          for (const moduleId of job.moduleIds) this.#loadedModuleIds.add(moduleId);
          this.#finishSuccess(job, Object.freeze([...modules]));
        },
        (error: unknown) => {
          if (job.settled) return;
          const reason = job.controller.signal.aborted
            ? job.controller.signal.reason ?? error
            : error;
          const code = readErrorCode(reason);
          const status: Extract<ArcgisModuleLoadStatus, 'failed' | 'cancelled' | 'timed-out'> =
            code === 'TIMEOUT'
              ? 'timed-out'
              : job.controller.signal.aborted
                ? 'cancelled'
                : 'failed';
          this.#finishFailure(job, reason, status);
        },
      );
  }

  #finishSuccess(job: InternalJob, modules: readonly unknown[]): void {
    if (job.settled) return;
    job.settled = true;
    job.status = 'completed';
    job.finishedAt = Date.now();
    job.resolve(modules);
    this.#completed += 1;
    this.#cleanup(job);
  }

  #finishFailure(
    job: InternalJob,
    error: unknown,
    status: Extract<ArcgisModuleLoadStatus, 'failed' | 'cancelled' | 'timed-out'>,
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

  #cleanup(job: InternalJob): void {
    if (job.timeoutHandle !== undefined) clearTimeout(job.timeoutHandle);
    job.timeoutHandle = undefined;
    if (job.startedAt !== undefined) this.#running = Math.max(0, this.#running - 1);
    this.#queue = this.#queue.filter((candidate) => candidate !== job);
    this.#jobs.delete(job.id);
    if (this.#dedupe.get(job.dedupeKey) === job.id) this.#dedupe.delete(job.dedupeKey);

    this.#history.unshift(toPublicSnapshot(job));
    if (this.#history.length > this.#configuration.maxHistory) {
      this.#history.length = this.#configuration.maxHistory;
    }
    this.#pump();
  }

  #attach(job: InternalJob, signal?: AbortSignal): Promise<readonly unknown[]> {
    job.subscriberCount += 1;

    return new Promise<readonly unknown[]>((resolve, reject) => {
      let detached = false;
      let consumerCancelled = false;

      const detach = (): void => {
        if (detached) return;
        detached = true;
        signal?.removeEventListener('abort', onAbort);
        job.subscriberCount = Math.max(0, job.subscriberCount - 1);
        if (job.subscriberCount === 0 && !job.settled) {
          const reason = cancellationError(job.id);
          job.controller.abort(reason);
          this.#finishFailure(job, reason, 'cancelled');
        }
      };

      const onAbort = (): void => {
        if (consumerCancelled) return;
        consumerCancelled = true;
        detach();
        reject(signal?.reason ?? cancellationError(job.id));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (modules) => {
          if (consumerCancelled) return;
          detach();
          resolve(modules);
        },
        (error: unknown) => {
          if (consumerCancelled) return;
          detach();
          reject(error);
        },
      );
    });
  }
}

export const createArcgisModuleLoadGovernor = (
  configuration: ArcgisModuleLoadGovernorConfiguration,
  loader: ArcgisGovernedModuleLoader,
): ArcgisModuleLoadGovernor => new ArcgisModuleLoadGovernor(configuration, loader);
