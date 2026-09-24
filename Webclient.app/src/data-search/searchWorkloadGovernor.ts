import { createAbortError, throwIfAborted } from './contracts';
import { hashFingerprint, normalizeInteger, normalizeSearchText, normalizeText } from './normalization';

export type SearchWorkPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';
export type SearchWorkOutcome = 'completed' | 'failed' | 'aborted' | 'queue-timeout' | 'disposed';

export interface SearchWorkloadGovernorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueueSize?: number;
  readonly maxConcurrentPerLane?: number;
  readonly maxQueueWaitMs?: number;
  readonly historySize?: number;
  readonly clock?: () => number;
}

export interface SearchWorkRequestOptions {
  readonly key: string;
  readonly lane?: string;
  readonly priority?: SearchWorkPriority;
  readonly signal?: AbortSignal | null;
  readonly maxQueueWaitMs?: number;
  readonly dedupe?: boolean;
}

export interface SearchWorkContext {
  readonly key: string;
  readonly lane: string;
  readonly priority: SearchWorkPriority;
  readonly signal: AbortSignal;
  readonly enqueuedAt: number;
  readonly startedAt: number;
  readonly queueWaitMs: number;
  readonly sequence: number;
}

export interface SearchWorkHistoryEntry {
  readonly keyFingerprint: string;
  readonly lane: string;
  readonly priority: SearchWorkPriority;
  readonly outcome: SearchWorkOutcome;
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number;
  readonly queueWaitMs: number;
  readonly executionMs: number;
  readonly subscriberCount: number;
}

export interface SearchWorkloadSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly inflightKeys: number;
  readonly lanes: Readonly<Record<string, Readonly<{ active: number; queued: number }>>>;
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly queueTimeouts: number;
  readonly dedupeHits: number;
  readonly rejected: number;
  readonly disposed: boolean;
  readonly history: readonly SearchWorkHistoryEntry[];
}

interface NormalizedGovernorOptions {
  readonly maxConcurrent: number;
  readonly maxQueueSize: number;
  readonly maxConcurrentPerLane: number;
  readonly maxQueueWaitMs: number;
  readonly historySize: number;
  readonly clock: () => number;
}

interface WorkSubscriber<T> {
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
}

interface WorkItem<T = unknown> {
  readonly key: string;
  readonly keyFingerprint: string;
  readonly lane: string;
  readonly priority: SearchWorkPriority;
  readonly priorityRank: number;
  readonly sequence: number;
  readonly enqueuedAt: number;
  readonly maxQueueWaitMs: number;
  readonly dedupe: boolean;
  readonly operation: (context: SearchWorkContext) => Promise<T> | T;
  readonly controller: AbortController;
  readonly subscribers: Set<WorkSubscriber<T>>;
  startedAt: number | null;
  queueTimer: ReturnType<typeof setTimeout> | null;
  state: 'queued' | 'active' | 'settled';
}

interface MutableStats {
  submitted: number;
  completed: number;
  failed: number;
  aborted: number;
  queueTimeouts: number;
  dedupeHits: number;
  rejected: number;
}

const PRIORITY_RANK: Readonly<Record<SearchWorkPriority, number>> = Object.freeze({
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
});

const normalizeLane = (value: unknown): string => {
  const lane = normalizeSearchText(value || 'default')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return lane || 'default';
};

const normalizePriority = (value: unknown): SearchWorkPriority => {
  const candidate = normalizeSearchText(value) as SearchWorkPriority;
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, candidate) ? candidate : 'normal';
};

const normalizeKey = (value: unknown): string => {
  const key = normalizeText(value).slice(0, 512);
  if (!key) throw new TypeError('Search workload key must be a non-empty bounded string.');
  return key;
};

const safeClock = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const normalizeOptions = (
  options: SearchWorkloadGovernorOptions = {},
): NormalizedGovernorOptions => {
  const maxConcurrent = normalizeInteger(options.maxConcurrent, {
    min: 1,
    max: 128,
    fallback: 6,
  });
  return Object.freeze({
    maxConcurrent,
    maxQueueSize: normalizeInteger(options.maxQueueSize, {
      min: 1,
      max: 20_000,
      fallback: 256,
    }),
    maxConcurrentPerLane: normalizeInteger(options.maxConcurrentPerLane, {
      min: 1,
      max: maxConcurrent,
      fallback: Math.min(3, maxConcurrent),
    }),
    maxQueueWaitMs: normalizeInteger(options.maxQueueWaitMs, {
      min: 10,
      max: 120_000,
      fallback: 5_000,
    }),
    historySize: normalizeInteger(options.historySize, {
      min: 0,
      max: 10_000,
      fallback: 128,
    }),
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  });
};

const createQueueTimeoutError = (lane: string): Error => {
  const error = new Error(`Search workload queue wait budget exceeded for lane "${lane}".`);
  error.name = 'SearchWorkQueueTimeoutError';
  return error;
};

const createDisposedError = (): Error => {
  const error = new Error('Search workload governor has been disposed.');
  error.name = 'SearchWorkloadDisposedError';
  return error;
};

const createQueueFullError = (): Error => {
  const error = new Error('Search workload queue reached its bounded capacity.');
  error.name = 'SearchWorkloadQueueFullError';
  return error;
};

export class SearchWorkloadGovernor {
  readonly #options: NormalizedGovernorOptions;
  readonly #queue: WorkItem[] = [];
  readonly #inflight = new Map<string, WorkItem>();
  readonly #laneActive = new Map<string, number>();
  readonly #history: SearchWorkHistoryEntry[] = [];
  readonly #stats: MutableStats = {
    submitted: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
    queueTimeouts: 0,
    dedupeHits: 0,
    rejected: 0,
  };
  #active = 0;
  #sequence = 0;
  #disposed = false;
  #draining = false;

  constructor(options: SearchWorkloadGovernorOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  run<T>(
    request: SearchWorkRequestOptions,
    operation: (context: SearchWorkContext) => Promise<T> | T,
  ): Promise<T> {
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('Search workload operation must be callable.'));
    }
    if (this.#disposed) {
      this.#stats.rejected += 1;
      return Promise.reject(createDisposedError());
    }

    let key: string;
    try {
      key = normalizeKey(request.key);
    } catch (error) {
      this.#stats.rejected += 1;
      return Promise.reject(error);
    }
    const signal = request.signal ?? null;
    try {
      throwIfAborted(signal);
    } catch (error) {
      this.#stats.aborted += 1;
      return Promise.reject(error);
    }

    const dedupe = request.dedupe !== false;
    const existing = dedupe ? this.#inflight.get(key) : undefined;
    if (existing && existing.state !== 'settled') {
      this.#stats.dedupeHits += 1;
      return this.#subscribe(existing as WorkItem<T>, signal);
    }

    if (this.#queue.length >= this.#options.maxQueueSize && this.#active >= this.#options.maxConcurrent) {
      this.#stats.rejected += 1;
      return Promise.reject(createQueueFullError());
    }

    const lane = normalizeLane(request.lane);
    const priority = normalizePriority(request.priority);
    const enqueuedAt = safeClock(this.#options.clock);
    const item: WorkItem<T> = {
      key,
      keyFingerprint: hashFingerprint(key),
      lane,
      priority,
      priorityRank: PRIORITY_RANK[priority],
      sequence: ++this.#sequence,
      enqueuedAt,
      maxQueueWaitMs: normalizeInteger(request.maxQueueWaitMs, {
        min: 10,
        max: 120_000,
        fallback: this.#options.maxQueueWaitMs,
      }),
      dedupe,
      operation,
      controller: new AbortController(),
      subscribers: new Set<WorkSubscriber<T>>(),
      startedAt: null,
      queueTimer: null,
      state: 'queued',
    };
    this.#stats.submitted += 1;
    if (dedupe) this.#inflight.set(key, item as WorkItem);
    this.#queue.push(item as WorkItem);
    this.#sortQueue();
    this.#armQueueTimeout(item as WorkItem);
    const promise = this.#subscribe(item, signal);
    this.#drain();
    return promise;
  }

  getSnapshot(): SearchWorkloadSnapshot {
    const lanes = new Map<string, { active: number; queued: number }>();
    for (const [lane, active] of this.#laneActive.entries()) {
      lanes.set(lane, { active, queued: 0 });
    }
    for (const item of this.#queue) {
      const current = lanes.get(item.lane) ?? { active: 0, queued: 0 };
      current.queued += 1;
      lanes.set(item.lane, current);
    }
    const laneObject: Record<string, Readonly<{ active: number; queued: number }>> = {};
    for (const [lane, value] of Array.from(lanes.entries()).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      laneObject[lane] = Object.freeze({ ...value });
    }
    return Object.freeze({
      active: this.#active,
      queued: this.#queue.length,
      inflightKeys: this.#inflight.size,
      lanes: Object.freeze(laneObject),
      submitted: this.#stats.submitted,
      completed: this.#stats.completed,
      failed: this.#stats.failed,
      aborted: this.#stats.aborted,
      queueTimeouts: this.#stats.queueTimeouts,
      dedupeHits: this.#stats.dedupeHits,
      rejected: this.#stats.rejected,
      disposed: this.#disposed,
      history: Object.freeze([...this.#history]),
    });
  }

  dispose(reason = 'Search workload governor disposed'): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = createDisposedError();
    error.message = reason;
    for (const item of this.#queue.slice()) {
      this.#settleQueuedItem(item, 'disposed', error);
    }
    for (const item of this.#inflight.values()) {
      if (item.state === 'active') item.controller.abort(reason);
    }
    this.#queue.length = 0;
  }

  #subscribe<T>(item: WorkItem<T>, signal: AbortSignal | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const subscriber: WorkSubscriber<T> = {
        resolve,
        reject,
        signal,
        abortListener: null,
        settled: false,
      };
      const rejectAbort = (): void => {
        if (subscriber.settled) return;
        subscriber.settled = true;
        item.subscribers.delete(subscriber);
        this.#stats.aborted += 1;
        reject(createAbortError('Search workload subscriber aborted'));
        if (item.subscribers.size === 0 && item.state !== 'settled') {
          if (item.state === 'queued') {
            const queueIndex = this.#queue.indexOf(item as WorkItem);
            if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
            this.#finishItem(item as WorkItem, 'aborted', null, createAbortError('All subscribers aborted before execution'));
          } else {
            item.controller.abort('All search workload subscribers aborted');
          }
        }
      };
      subscriber.abortListener = rejectAbort;
      if (signal) signal.addEventListener('abort', rejectAbort, { once: true });
      item.subscribers.add(subscriber);
      if (signal?.aborted) rejectAbort();
    });
  }

  #sortQueue(): void {
    this.#queue.sort((left, right) => left.priorityRank - right.priorityRank || left.sequence - right.sequence);
  }

  #armQueueTimeout(item: WorkItem): void {
    item.queueTimer = setTimeout(() => {
      if (item.state !== 'queued') return;
      const index = this.#queue.indexOf(item);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#stats.queueTimeouts += 1;
      this.#finishItem(item, 'queue-timeout', null, createQueueTimeoutError(item.lane));
      this.#drain();
    }, item.maxQueueWaitMs);
  }

  #canStart(item: WorkItem): boolean {
    if (this.#active >= this.#options.maxConcurrent) return false;
    return (this.#laneActive.get(item.lane) ?? 0) < this.#options.maxConcurrentPerLane;
  }

  #nextRunnableIndex(): number {
    for (let index = 0; index < this.#queue.length; index += 1) {
      const item = this.#queue[index];
      if (item && this.#canStart(item)) return index;
    }
    return -1;
  }

  #drain(): void {
    if (this.#draining || this.#disposed) return;
    this.#draining = true;
    try {
      while (this.#active < this.#options.maxConcurrent) {
        const index = this.#nextRunnableIndex();
        if (index < 0) break;
        const [item] = this.#queue.splice(index, 1);
        if (!item || item.state !== 'queued') continue;
        this.#start(item);
      }
    } finally {
      this.#draining = false;
    }
  }

  #start(item: WorkItem): void {
    if (item.queueTimer) {
      clearTimeout(item.queueTimer);
      item.queueTimer = null;
    }
    if (item.subscribers.size === 0) {
      this.#finishItem(item, 'aborted', null, createAbortError('Search workload has no active subscribers'));
      return;
    }
    item.state = 'active';
    item.startedAt = safeClock(this.#options.clock);
    this.#active += 1;
    this.#laneActive.set(item.lane, (this.#laneActive.get(item.lane) ?? 0) + 1);
    const context: SearchWorkContext = Object.freeze({
      key: item.key,
      lane: item.lane,
      priority: item.priority,
      signal: item.controller.signal,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      queueWaitMs: Math.max(0, item.startedAt - item.enqueuedAt),
      sequence: item.sequence,
    });

    Promise.resolve()
      .then(() => item.operation(context))
      .then(
        value => this.#finishItem(item, 'completed', value, null),
        error => {
          const aborted = item.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
          this.#finishItem(item, aborted ? 'aborted' : 'failed', null, error);
        },
      )
      .finally(() => this.#drain());
  }

  #settleQueuedItem(item: WorkItem, outcome: SearchWorkOutcome, error: Error): void {
    const index = this.#queue.indexOf(item);
    if (index >= 0) this.#queue.splice(index, 1);
    this.#finishItem(item, outcome, null, error);
  }

  #finishItem(
    item: WorkItem,
    outcome: SearchWorkOutcome,
    value: unknown,
    error: unknown,
  ): void {
    if (item.state === 'settled') return;
    const wasActive = item.state === 'active';
    item.state = 'settled';
    if (item.queueTimer) {
      clearTimeout(item.queueTimer);
      item.queueTimer = null;
    }
    if (wasActive) {
      this.#active = Math.max(0, this.#active - 1);
      const laneCount = Math.max(0, (this.#laneActive.get(item.lane) ?? 1) - 1);
      if (laneCount === 0) this.#laneActive.delete(item.lane);
      else this.#laneActive.set(item.lane, laneCount);
    }
    if (this.#inflight.get(item.key) === item) this.#inflight.delete(item.key);

    if (outcome === 'completed') this.#stats.completed += 1;
    else if (outcome === 'failed') this.#stats.failed += 1;
    else if (outcome === 'aborted') this.#stats.aborted += 1;

    const completedAt = safeClock(this.#options.clock);
    this.#pushHistory(Object.freeze({
      keyFingerprint: item.keyFingerprint,
      lane: item.lane,
      priority: item.priority,
      outcome,
      sequence: item.sequence,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      completedAt,
      queueWaitMs: item.startedAt === null ? Math.max(0, completedAt - item.enqueuedAt) : Math.max(0, item.startedAt - item.enqueuedAt),
      executionMs: item.startedAt === null ? 0 : Math.max(0, completedAt - item.startedAt),
      subscriberCount: item.subscribers.size,
    }));

    for (const subscriber of item.subscribers) {
      if (subscriber.signal && subscriber.abortListener) {
        subscriber.signal.removeEventListener('abort', subscriber.abortListener);
      }
      if (subscriber.settled) continue;
      subscriber.settled = true;
      if (outcome === 'completed') {
        subscriber.resolve(value);
      } else {
        subscriber.reject(error ?? new Error(`Search workload ended with outcome ${outcome}.`));
      }
    }
    item.subscribers.clear();
  }

  #pushHistory(entry: SearchWorkHistoryEntry): void {
    if (this.#options.historySize <= 0) return;
    this.#history.push(entry);
    if (this.#history.length > this.#options.historySize) {
      this.#history.splice(0, this.#history.length - this.#options.historySize);
    }
  }
}

export const createSearchWorkloadGovernor = (
  options: SearchWorkloadGovernorOptions = {},
): SearchWorkloadGovernor => new SearchWorkloadGovernor(options);
