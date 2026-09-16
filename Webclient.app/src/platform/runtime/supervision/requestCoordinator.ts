import {
  RequestCoordinatorDisposedError,
  RequestQueueOverflowError,
  boundedInteger,
  normalizeIdentifier,
  safeObserver,
  type RequestCoordinatorSnapshot,
  type RequestExecutionContext,
} from './contracts';

export interface RequestLanePolicy {
  readonly concurrency?: number;
  readonly queueLimit?: number;
}

export interface RequestCoordinatorOptions {
  readonly concurrency?: number;
  readonly queueLimit?: number;
  readonly defaultLaneConcurrency?: number;
  readonly defaultLaneQueueLimit?: number;
  readonly lanes?: Readonly<Record<string, RequestLanePolicy>>;
  readonly now?: () => number;
  readonly onChange?: (snapshot: RequestCoordinatorSnapshot) => void;
}

export interface CoordinatedRequestOptions {
  readonly key: string;
  readonly lane?: string;
  readonly priority?: number;
  readonly signal?: AbortSignal;
  readonly deduplicate?: boolean;
}

export interface RequestHandle<TValue> {
  readonly key: string;
  readonly lane: string;
  readonly promise: Promise<TValue>;
  readonly cancel: (reason?: unknown) => void;
}

interface NormalizedLanePolicy {
  readonly concurrency: number;
  readonly queueLimit: number;
}

interface Subscriber<TValue> {
  readonly id: number;
  readonly resolve: (value: TValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortHandler: (() => void) | null;
  settled: boolean;
}

interface RequestTask {
  readonly key: string;
  readonly lane: string;
  readonly priority: number;
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly operation: (context: RequestExecutionContext) => Promise<unknown> | unknown;
  readonly subscribers: Map<number, Subscriber<unknown>>;
  readonly controller: AbortController;
  state: 'queued' | 'active' | 'settled';
  startedAt: number | null;
}

interface MutableMetrics {
  accepted: number;
  completed: number;
  failed: number;
  cancelled: number;
  deduplicated: number;
  rejected: number;
}

const DEFAULT_LANE = 'default';

const normalizePriority = (value: unknown): number => boundedInteger(value, 0, -1000, 1000);

const taskComparator = (left: RequestTask, right: RequestTask): number => {
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  const time = left.enqueuedAt - right.enqueuedAt;
  if (time !== 0) return time;
  return left.sequence - right.sequence;
};

const cancellationReason = (signal?: AbortSignal): unknown => signal?.reason
  ?? new DOMException('The coordinated request was cancelled.', 'AbortError');

export class RequestCoordinator {
  readonly #now: () => number;
  readonly #globalConcurrency: number;
  readonly #globalQueueLimit: number;
  readonly #defaultLaneConcurrency: number;
  readonly #defaultLaneQueueLimit: number;
  readonly #configuredLanes = new Map<string, NormalizedLanePolicy>();
  readonly #tasksByKey = new Map<string, RequestTask>();
  readonly #activeByLane = new Map<string, number>();
  readonly #queuedByLane = new Map<string, number>();
  readonly #onChange: ((snapshot: RequestCoordinatorSnapshot) => void) | undefined;
  readonly #metrics: MutableMetrics = {
    accepted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    deduplicated: 0,
    rejected: 0,
  };
  #queue: RequestTask[] = [];
  #active = 0;
  #sequence = 0;
  #subscriberSequence = 0;
  #disposed = false;
  #draining = false;

  constructor(options: RequestCoordinatorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#globalConcurrency = boundedInteger(options.concurrency, 8, 1, 128);
    this.#globalQueueLimit = boundedInteger(options.queueLimit, 256, 0, 100_000);
    this.#defaultLaneConcurrency = boundedInteger(options.defaultLaneConcurrency, 4, 1, 128);
    this.#defaultLaneQueueLimit = boundedInteger(options.defaultLaneQueueLimit, 128, 0, 100_000);
    this.#onChange = options.onChange;

    Object.entries(options.lanes ?? {}).reduce((configured, [rawLane, policy]) => {
      const lane = normalizeIdentifier(rawLane, 'request lane');
      configured.set(lane, this.#normalizeLanePolicy(policy));
      return configured;
    }, this.#configuredLanes);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get activeCount(): number {
    return this.#active;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  configureLane(laneInput: string, policy: RequestLanePolicy): void {
    this.#assertUsable();
    const lane = normalizeIdentifier(laneInput, 'request lane');
    this.#configuredLanes.set(lane, this.#normalizeLanePolicy(policy));
    this.#drain();
    this.#emitChange();
  }

  removeLanePolicy(laneInput: string): boolean {
    this.#assertUsable();
    const lane = normalizeIdentifier(laneInput, 'request lane');
    const removed = this.#configuredLanes.delete(lane);
    if (removed) {
      this.#drain();
      this.#emitChange();
    }
    return removed;
  }

  submit<TValue>(
    operation: (context: RequestExecutionContext) => Promise<TValue> | TValue,
    options: CoordinatedRequestOptions,
  ): Promise<TValue> {
    return this.submitHandle(operation, options).promise;
  }

  submitHandle<TValue>(
    operation: (context: RequestExecutionContext) => Promise<TValue> | TValue,
    options: CoordinatedRequestOptions,
  ): RequestHandle<TValue> {
    this.#assertUsable();
    if (typeof operation !== 'function') throw new TypeError('Coordinated request operation must be a function.');
    const key = normalizeIdentifier(options.key, 'request key');
    const lane = normalizeIdentifier(options.lane ?? DEFAULT_LANE, 'request lane');
    if (options.signal?.aborted) {
      const reason = cancellationReason(options.signal);
      return Object.freeze({
        key,
        lane,
        promise: Promise.reject(reason),
        cancel: () => undefined,
      });
    }

    const existing = this.#tasksByKey.get(key);
    if (existing && options.deduplicate !== false) {
      if (existing.lane !== lane) {
        throw new TypeError(
          `Deduplicated request "${key}" already belongs to lane "${existing.lane}", not "${lane}".`,
        );
      }
      this.#metrics.deduplicated += 1;
      const handle = this.#attachSubscriber<TValue>(existing, options.signal);
      this.#emitChange();
      return handle;
    }
    if (existing) {
      throw new TypeError(`Request key "${key}" is already active and deduplication is disabled.`);
    }

    this.#assertQueueCapacity(lane);
    const task: RequestTask = {
      key,
      lane,
      priority: normalizePriority(options.priority),
      sequence: ++this.#sequence,
      enqueuedAt: this.#now(),
      operation: operation as (context: RequestExecutionContext) => Promise<unknown> | unknown,
      subscribers: new Map<number, Subscriber<unknown>>(),
      controller: new AbortController(),
      state: 'queued',
      startedAt: null,
    };
    this.#tasksByKey.set(key, task);
    this.#queue.push(task);
    this.#incrementQueuedLane(lane);
    this.#queue.sort(taskComparator);
    this.#metrics.accepted += 1;
    const handle = this.#attachSubscriber<TValue>(task, options.signal);
    this.#drain();
    this.#emitChange();
    return handle;
  }

  cancel(keyInput: string, reason?: unknown): boolean {
    let key: string;
    try {
      key = normalizeIdentifier(keyInput, 'request key');
    } catch {
      return false;
    }
    const task = this.#tasksByKey.get(key);
    if (!task || task.state === 'settled') return false;
    const cancellation = reason ?? new DOMException(`Request "${key}" was cancelled.`, 'AbortError');
    if (!task.controller.signal.aborted) task.controller.abort(cancellation);
    this.#settleAllSubscribers(task, false, cancellation);
    if (task.state === 'queued') {
      this.#metrics.cancelled += 1;
      this.#removeQueuedTask(task);
    }
    this.#cleanupTaskIfOrphaned(task);
    this.#drain();
    this.#emitChange();
    return true;
  }

  cancelAll(reason?: unknown): number {
    return [...this.#tasksByKey.values()]
      .filter((task) => task.state !== 'settled')
      .reduce((cancelled, task) => cancelled + (this.cancel(task.key, reason) ? 1 : 0), 0);
  }

  cancelLane(laneInput: string, reason?: unknown): number {
    const lane = normalizeIdentifier(laneInput, 'request lane');
    return [...this.#tasksByKey.values()]
      .filter((task) => task.lane === lane && task.state !== 'settled')
      .reduce((cancelled, task) => cancelled + (this.cancel(task.key, reason) ? 1 : 0), 0);
  }

  snapshot(): RequestCoordinatorSnapshot {
    const lanes = new Set<string>([
      ...this.#configuredLanes.keys(),
      ...this.#activeByLane.keys(),
      ...this.#queuedByLane.keys(),
    ]);
    const laneRecord = [...lanes].sort().reduce<Record<string, { readonly active: number; readonly queued: number }>>(
      (record, lane) => {
        record[lane] = Object.freeze({
          active: this.#activeByLane.get(lane) ?? 0,
          queued: this.#queuedByLane.get(lane) ?? 0,
        });
        return record;
      },
      {},
    );
    return Object.freeze({
      active: this.#active,
      queued: this.#queue.length,
      inFlightKeys: Object.freeze(
        [...this.#tasksByKey.values()]
          .filter((task) => task.state === 'active')
          .map((task) => task.key)
          .sort(),
      ),
      queueKeys: Object.freeze(this.#queue.map((task) => task.key)),
      lanes: Object.freeze(laneRecord),
      ...this.#metrics,
    });
  }

  dispose(reason?: unknown): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const cancellation = reason ?? new DOMException('Request coordinator disposed.', 'AbortError');
    [...this.#tasksByKey.values()].reduce((processed, task) => {
      if (!task.controller.signal.aborted) task.controller.abort(cancellation);
      this.#settleAllSubscribers(task, false, cancellation);
      task.state = 'settled';
      return processed + 1;
    }, 0);
    this.#queue = [];
    this.#tasksByKey.clear();
    this.#activeByLane.clear();
    this.#queuedByLane.clear();
    this.#active = 0;
    this.#emitChange();
  }

  #attachSubscriber<TValue>(task: RequestTask, signal: AbortSignal | undefined): RequestHandle<TValue> {
    const subscriberId = ++this.#subscriberSequence;
    let cancelSubscriber = (_reason?: unknown): void => undefined;
    const promise = new Promise<TValue>((resolve, reject) => {
      const subscriber: Subscriber<TValue> = {
        id: subscriberId,
        resolve,
        reject,
        signal,
        abortHandler: null,
        settled: false,
      };
      const unknownSubscriber = subscriber as Subscriber<unknown>;
      const abortHandler = signal
        ? () => {
          if (subscriber.settled) return;
          const cancellation = cancellationReason(signal);
          this.#settleSubscriber(unknownSubscriber, false, cancellation);
          this.#cleanupTaskIfOrphaned(task, cancellation);
          this.#drain();
          this.#emitChange();
        }
        : null;
      const stored: Subscriber<unknown> = {
        ...unknownSubscriber,
        abortHandler,
      };
      task.subscribers.set(subscriberId, stored);
      if (signal && abortHandler) signal.addEventListener('abort', abortHandler, { once: true });
      cancelSubscriber = (reason?: unknown) => {
        const current = task.subscribers.get(subscriberId);
        if (!current || current.settled) return;
        const cancellation = reason ?? new DOMException('Request subscriber cancelled.', 'AbortError');
        this.#settleSubscriber(current, false, cancellation);
        this.#cleanupTaskIfOrphaned(task, cancellation);
        this.#drain();
        this.#emitChange();
      };
    });
    return Object.freeze({ key: task.key, lane: task.lane, promise, cancel: cancelSubscriber });
  }

  #settleSubscriber(subscriber: Subscriber<unknown>, success: boolean, value: unknown): void {
    if (subscriber.settled) return;
    subscriber.settled = true;
    if (subscriber.signal && subscriber.abortHandler) {
      subscriber.signal.removeEventListener('abort', subscriber.abortHandler);
    }
    if (success) subscriber.resolve(value);
    else subscriber.reject(value);
  }

  #settleAllSubscribers(task: RequestTask, success: boolean, value: unknown): void {
    [...task.subscribers.values()].reduce((settled, subscriber) => {
      this.#settleSubscriber(subscriber, success, value);
      return settled + 1;
    }, 0);
  }

  #cleanupTaskIfOrphaned(task: RequestTask, reason?: unknown): void {
    [...task.subscribers.entries()].reduce((removed, [id, subscriber]) => {
      if (!subscriber.settled) return removed;
      task.subscribers.delete(id);
      return removed + 1;
    }, 0);
    if (task.subscribers.size > 0 || task.state === 'settled') return;
    if (!task.controller.signal.aborted) {
      task.controller.abort(reason ?? new DOMException('All request subscribers cancelled.', 'AbortError'));
    }
    if (task.state === 'queued') {
      this.#removeQueuedTask(task);
      task.state = 'settled';
      this.#tasksByKey.delete(task.key);
    }
  }

  #incrementQueuedLane(lane: string): void {
    this.#queuedByLane.set(lane, (this.#queuedByLane.get(lane) ?? 0) + 1);
  }

  #decrementQueuedLane(lane: string): void {
    const queued = Math.max(0, (this.#queuedByLane.get(lane) ?? 1) - 1);
    if (queued === 0) this.#queuedByLane.delete(lane);
    else this.#queuedByLane.set(lane, queued);
  }

  #removeQueuedTask(task: RequestTask): void {
    const index = this.#queue.indexOf(task);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#decrementQueuedLane(task.lane);
  }

  #assertQueueCapacity(lane: string): void {
    if (this.#queue.length >= this.#globalQueueLimit) {
      this.#metrics.rejected += 1;
      throw new RequestQueueOverflowError(lane);
    }
    const lanePolicy = this.#lanePolicy(lane);
    const laneQueued = this.#queuedByLane.get(lane) ?? 0;
    if (laneQueued >= lanePolicy.queueLimit) {
      this.#metrics.rejected += 1;
      throw new RequestQueueOverflowError(lane);
    }
  }

  #normalizeLanePolicy(policy: RequestLanePolicy): NormalizedLanePolicy {
    return Object.freeze({
      concurrency: boundedInteger(policy.concurrency, this.#defaultLaneConcurrency, 1, 128),
      queueLimit: boundedInteger(policy.queueLimit, this.#defaultLaneQueueLimit, 0, 100_000),
    });
  }

  #lanePolicy(lane: string): NormalizedLanePolicy {
    return this.#configuredLanes.get(lane) ?? Object.freeze({
      concurrency: this.#defaultLaneConcurrency,
      queueLimit: this.#defaultLaneQueueLimit,
    });
  }

  #nextRunnableTask(): RequestTask | null {
    if (this.#active >= this.#globalConcurrency) return null;
    return this.#queue.find((task) => {
      const laneActive = this.#activeByLane.get(task.lane) ?? 0;
      return laneActive < this.#lanePolicy(task.lane).concurrency;
    }) ?? null;
  }

  #drain(): void {
    if (this.#draining || this.#disposed) return;
    this.#draining = true;
    try {
      while (true) {
        const task = this.#nextRunnableTask();
        if (!task) break;
        this.#removeQueuedTask(task);
        if (task.subscribers.size === 0) {
          task.state = 'settled';
          this.#tasksByKey.delete(task.key);
          continue;
        }
        this.#startTask(task);
      }
    } finally {
      this.#draining = false;
    }
  }

  #startTask(task: RequestTask): void {
    task.state = 'active';
    task.startedAt = this.#now();
    this.#active += 1;
    this.#activeByLane.set(task.lane, (this.#activeByLane.get(task.lane) ?? 0) + 1);
    const context: RequestExecutionContext = Object.freeze({
      key: task.key,
      lane: task.lane,
      signal: task.controller.signal,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt,
      priority: task.priority,
    });

    void Promise.resolve()
      .then(() => task.operation(context))
      .then(
        (value) => this.#finishTask(task, true, value),
        (error: unknown) => this.#finishTask(task, false, error),
      );
  }

  #finishTask(task: RequestTask, success: boolean, value: unknown): void {
    if (task.state !== 'active') return;
    task.state = 'settled';
    this.#active = Math.max(0, this.#active - 1);
    const laneActive = Math.max(0, (this.#activeByLane.get(task.lane) ?? 1) - 1);
    if (laneActive === 0) this.#activeByLane.delete(task.lane);
    else this.#activeByLane.set(task.lane, laneActive);

    if (success) this.#metrics.completed += 1;
    else if (task.controller.signal.aborted) this.#metrics.cancelled += 1;
    else this.#metrics.failed += 1;

    this.#settleAllSubscribers(task, success, value);
    task.subscribers.clear();
    this.#tasksByKey.delete(task.key);
    this.#drain();
    this.#emitChange();
  }

  #assertUsable(): void {
    if (this.#disposed) throw new RequestCoordinatorDisposedError();
  }

  #emitChange(): void {
    safeObserver(this.#onChange, this.snapshot());
  }
}
