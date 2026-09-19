export type BulkheadRejectionReason = 'disposed' | 'queue-capacity' | 'owner-capacity' | 'queue-timeout' | 'aborted';

export interface BulkheadOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly maxConcurrentPerOwner?: number;
  readonly maxQueuedPerOwner?: number;
  readonly maxQueueWaitMs?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
}

export interface BulkheadRunOptions {
  readonly owner?: string;
  readonly signal?: AbortSignal;
  readonly queueWaitMs?: number;
}

export interface BulkheadSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly disposed: boolean;
  readonly totalStarted: number;
  readonly totalCompleted: number;
  readonly totalRejected: number;
}

export interface BulkheadEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: 'queued' | 'started' | 'completed' | 'rejected' | 'disposed';
  readonly owner: string;
  readonly reason?: BulkheadRejectionReason;
}

export class BulkheadRejectedError extends Error {
  constructor(readonly reason: BulkheadRejectionReason) {
    super(`Bulkhead rejected work: ${reason}`);
    this.name = 'BulkheadRejectedError';
  }
}

interface QueueEntry<T> {
  readonly owner: string;
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
}

const integer = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const ownerKey = (owner: string | undefined): string => {
  const value = owner?.trim() || 'default';
  if (value.length > 128) throw new RangeError('owner must be at most 128 characters');
  return value;
};

export class BoundedBulkhead {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxConcurrentPerOwner: number;
  readonly maxQueuedPerOwner: number;
  readonly maxQueueWaitMs: number;
  readonly historyLimit: number;
  readonly #clock: () => number;
  readonly #queue: QueueEntry<unknown>[] = [];
  readonly #activeByOwner = new Map<string, number>();
  readonly #history: BulkheadEvent[] = [];
  #active = 0;
  #disposed = false;
  #totalStarted = 0;
  #totalCompleted = 0;
  #totalRejected = 0;
  #sequence = 0;

  constructor(options: BulkheadOptions = {}) {
    this.maxConcurrent = integer('maxConcurrent', options.maxConcurrent ?? 8, 1, 256);
    this.maxQueued = integer('maxQueued', options.maxQueued ?? 64, 0, 10_000);
    this.maxConcurrentPerOwner = integer('maxConcurrentPerOwner', options.maxConcurrentPerOwner ?? this.maxConcurrent, 1, this.maxConcurrent);
    this.maxQueuedPerOwner = integer('maxQueuedPerOwner', options.maxQueuedPerOwner ?? Math.min(this.maxQueued, 16), 0, this.maxQueued);
    this.maxQueueWaitMs = integer('maxQueueWaitMs', options.maxQueueWaitMs ?? 10_000, 1, 300_000);
    this.historyLimit = integer('historyLimit', options.historyLimit ?? 64, 0, 1_000);
    this.#clock = options.clock ?? Date.now;
  }

  snapshot(): BulkheadSnapshot {
    return Object.freeze({ active: this.#active, queued: this.#queue.length, disposed: this.#disposed, totalStarted: this.#totalStarted, totalCompleted: this.#totalCompleted, totalRejected: this.#totalRejected });
  }

  history(): readonly BulkheadEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  run<T>(operation: () => Promise<T>, options: BulkheadRunOptions = {}): Promise<T> {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('operation must be a function'));
    const owner = ownerKey(options.owner);
    if (this.#disposed) return this.#rejectImmediately<T>(owner, 'disposed');
    if (options.signal?.aborted) return this.#rejectImmediately<T>(owner, 'aborted');
    if (this.#canStart(owner)) return this.#start(owner, operation);
    if (this.#queue.length >= this.maxQueued) return this.#rejectImmediately<T>(owner, 'queue-capacity');
    if (this.#queuedFor(owner) >= this.maxQueuedPerOwner) return this.#rejectImmediately<T>(owner, 'owner-capacity');

    const queueWaitMs = integer('queueWaitMs', options.queueWaitMs ?? this.maxQueueWaitMs, 1, this.maxQueueWaitMs);
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        owner,
        operation,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
        timer: undefined,
        abortListener: undefined,
      };
      entry.timer = setTimeout(() => this.#removeAndReject(entry, 'queue-timeout'), queueWaitMs);
      if (options.signal) {
        entry.abortListener = () => this.#removeAndReject(entry, 'aborted');
        options.signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      this.#queue.push(entry as QueueEntry<unknown>);
      this.#record('queued', owner);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#queue.splice(0);
    for (const entry of pending) this.#rejectEntry(entry, 'disposed');
    this.#record('disposed', 'bulkhead');
  }

  #canStart(owner: string): boolean {
    return this.#active < this.maxConcurrent && (this.#activeByOwner.get(owner) ?? 0) < this.maxConcurrentPerOwner;
  }

  #queuedFor(owner: string): number {
    let count = 0;
    for (const entry of this.#queue) if (entry.owner === owner) count += 1;
    return count;
  }

  #start<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    this.#active += 1;
    this.#activeByOwner.set(owner, (this.#activeByOwner.get(owner) ?? 0) + 1);
    this.#totalStarted += 1;
    this.#record('started', owner);
    let result: Promise<T>;
    try { result = Promise.resolve(operation()); } catch (error) { result = Promise.reject(error); }
    return result.finally(() => {
      this.#active -= 1;
      const remaining = (this.#activeByOwner.get(owner) ?? 1) - 1;
      if (remaining <= 0) this.#activeByOwner.delete(owner); else this.#activeByOwner.set(owner, remaining);
      this.#totalCompleted += 1;
      this.#record('completed', owner);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#disposed) return;
    let index = 0;
    while (this.#active < this.maxConcurrent && index < this.#queue.length) {
      const entry = this.#queue[index];
      if (!entry) break;
      if (!this.#canStart(entry.owner)) { index += 1; continue; }
      this.#queue.splice(index, 1);
      this.#cleanup(entry);
      void this.#start(entry.owner, entry.operation).then(entry.resolve, entry.reject);
    }
  }

  #removeAndReject<T>(entry: QueueEntry<T>, reason: BulkheadRejectionReason): void {
    const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#rejectEntry(entry, reason);
    this.#drain();
  }

  #rejectEntry<T>(entry: QueueEntry<T>, reason: BulkheadRejectionReason): void {
    this.#cleanup(entry);
    this.#totalRejected += 1;
    this.#record('rejected', entry.owner, reason);
    entry.reject(new BulkheadRejectedError(reason));
  }

  #rejectImmediately<T>(owner: string, reason: BulkheadRejectionReason): Promise<T> {
    this.#totalRejected += 1;
    this.#record('rejected', owner, reason);
    return Promise.reject(new BulkheadRejectedError(reason));
  }

  #cleanup<T>(entry: QueueEntry<T>): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener('abort', entry.abortListener);
    entry.timer = undefined;
    entry.abortListener = undefined;
  }

  #record(kind: BulkheadEvent['kind'], owner: string, reason?: BulkheadRejectionReason): void {
    if (this.historyLimit === 0) return;
    const base = { sequence: ++this.#sequence, at: this.#clock(), kind, owner };
    this.#history.push(Object.freeze(reason === undefined ? base : { ...base, reason }));
    while (this.#history.length > this.historyLimit) this.#history.shift();
  }
}
