import { AppError } from '../errors/appError';
import {
  REQUEST_PRIORITIES,
  isAbortSignalLike,
  normalizeRequestPriority,
  normalizeSchedulerGroup,
  normalizeSchedulerLabel,
  toBoundedInteger
} from './contracts';
import type {
  RequestPriority,
  SchedulerCounters,
  SchedulerOptions,
  SchedulerSnapshot,
  SchedulerTaskMetadata
} from './contracts';

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_CONCURRENT_PER_GROUP = 4;
const DEFAULT_MAX_QUEUED = 160;
const DEFAULT_HIGH_PRIORITY_RESERVE = 2;
const DEFAULT_AGING_INTERVAL_MS = 1500;
const DEFAULT_STARVATION_THRESHOLD_MS = 8000;
const MAX_QUEUE_TIMEOUT_MS = 120000;

const PRIORITY_SCORE: Readonly<Record<RequestPriority, number>> = Object.freeze({
  critical: 500,
  high: 400,
  normal: 300,
  low: 200,
  background: 100
});

const FROZEN_REQUEST_PRIORITIES: readonly RequestPriority[] = Object.freeze([
  ...REQUEST_PRIORITIES
]);

type TimerHandle = ReturnType<typeof setTimeout>;
type SchedulerEventSink = (eventName: string, metadata: Record<string, unknown>) => void;

interface QueuedTask<T = unknown> {
  id: number;
  task: () => Promise<T> | T;
  priority: RequestPriority;
  groupKey: string;
  label: string | null;
  signal: AbortSignal | undefined;
  queuedAt: number;
  queueTimeoutMs: number;
  timeoutHandle: TimerHandle | null;
  abortHandler: (() => void) | null;
  settled: boolean;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

type ErasedQueuedTask = QueuedTask<any>;

const createSchedulerError = (
  message: string,
  code: string,
  details: Record<string, unknown> = {}
) => new AppError(message, {
  code,
  retryable: code === 'SCHEDULER_QUEUE_TIMEOUT',
  details
});

const createAbortError = () => new AppError('Request cancelled before execution.', {
  code: 'ABORTED',
  retryable: false
});

const safeClockValue = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const createCounters = (): SchedulerCounters => ({
  scheduled: 0,
  started: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  rejected: 0,
  bypassed: 0
});

const removeArrayItem = <T>(items: T[], target: T): boolean => {
  const index = items.indexOf(target);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
};

const isHighPriority = (priority: RequestPriority): boolean =>
  priority === 'critical' || priority === 'high';

export class RequestScheduler {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerGroup: number;
  readonly maxQueued: number;
  readonly highPriorityReserve: number;
  readonly agingIntervalMs: number;
  readonly starvationThresholdMs: number;

  private readonly clock: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly onEvent: SchedulerEventSink | null;
  private readonly queue: ErasedQueuedTask[] = [];
  private readonly runningByGroup = new Map<string, number>();
  private readonly counters: SchedulerCounters = createCounters();
  private running = 0;
  private sequence = 0;
  private peakRunning = 0;
  private peakQueued = 0;
  private pumping = false;
  private pumpRequested = false;

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrent = toBoundedInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 32);
    this.maxConcurrentPerGroup = toBoundedInteger(
      options.maxConcurrentPerGroup,
      Math.min(DEFAULT_MAX_CONCURRENT_PER_GROUP, this.maxConcurrent),
      1,
      this.maxConcurrent
    );
    this.maxQueued = toBoundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 1, 1000);
    this.highPriorityReserve = toBoundedInteger(
      options.highPriorityReserve,
      Math.min(DEFAULT_HIGH_PRIORITY_RESERVE, Math.max(0, this.maxConcurrent - 1)),
      0,
      Math.max(0, this.maxConcurrent - 1)
    );
    this.agingIntervalMs = toBoundedInteger(
      options.agingIntervalMs,
      DEFAULT_AGING_INTERVAL_MS,
      100,
      60000
    );
    this.starvationThresholdMs = toBoundedInteger(
      options.starvationThresholdMs,
      DEFAULT_STARVATION_THRESHOLD_MS,
      this.agingIntervalMs,
      120000
    );
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  }

  private now(): number {
    return safeClockValue(this.clock);
  }

  private emit(eventName: string, metadata: Record<string, unknown> = {}): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(eventName, metadata);
    } catch {
      // Local diagnostics are best-effort and must never block delivery.
    }
  }

  private getGroupRunning(groupKey: string): number {
    return this.runningByGroup.get(groupKey) || 0;
  }

  private incrementGroup(groupKey: string): void {
    this.runningByGroup.set(groupKey, this.getGroupRunning(groupKey) + 1);
  }

  private decrementGroup(groupKey: string): void {
    const next = Math.max(0, this.getGroupRunning(groupKey) - 1);
    if (next === 0) this.runningByGroup.delete(groupKey);
    else this.runningByGroup.set(groupKey, next);
  }

  private clearQueuedListeners(entry: ErasedQueuedTask): void {
    if (entry.timeoutHandle !== null) {
      this.clearTimer(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
      entry.abortHandler = null;
    }
  }

  private rejectQueued(
    entry: ErasedQueuedTask,
    error: unknown,
    reason: 'cancelled' | 'timeout' | 'queue-full'
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    removeArrayItem(this.queue, entry);
    this.clearQueuedListeners(entry);
    if (reason === 'cancelled') this.counters.cancelled += 1;
    else this.counters.rejected += 1;
    this.emit('network.scheduler.rejected', {
      taskId: entry.id,
      priority: entry.priority,
      groupKey: entry.groupKey,
      label: entry.label,
      reason,
      queueWaitMs: Math.max(0, this.now() - entry.queuedAt),
      queued: this.queue.length,
      running: this.running
    });
    entry.reject(error);
    this.requestPump();
  }

  private effectiveScore(entry: ErasedQueuedTask, timestamp: number): number {
    const waitMs = Math.max(0, timestamp - entry.queuedAt);
    const agingSteps = Math.floor(waitMs / this.agingIntervalMs);
    const boundedAging = Math.min(150, agingSteps * 15);
    const starvationBoost = waitMs >= this.starvationThresholdMs ? 125 : 0;
    return PRIORITY_SCORE[entry.priority] + boundedAging + starvationBoost;
  }

  private canRunGroup(entry: ErasedQueuedTask): boolean {
    return this.getGroupRunning(entry.groupKey) < this.maxConcurrentPerGroup;
  }

  private chooseNext(): ErasedQueuedTask | null {
    let candidates = this.queue.filter((entry) => !entry.settled && this.canRunGroup(entry));
    if (candidates.length === 0) return null;

    const reserveBoundary = Math.max(0, this.maxConcurrent - this.highPriorityReserve);
    if (this.highPriorityReserve > 0 && this.running >= reserveBoundary) {
      const urgent = candidates.filter((entry) => isHighPriority(entry.priority));
      if (urgent.length > 0) candidates = urgent;
    }

    const timestamp = this.now();
    candidates.sort((left, right) => {
      const scoreDelta = this.effectiveScore(right, timestamp) - this.effectiveScore(left, timestamp);
      if (scoreDelta !== 0) return scoreDelta;
      if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt;
      return left.id - right.id;
    });
    return candidates[0] || null;
  }

  private requestPump(): void {
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpRequested = false;
        while (this.running < this.maxConcurrent) {
          const next = this.chooseNext();
          if (!next) break;
          this.start(next);
        }
      } while (this.pumpRequested && this.running < this.maxConcurrent);
    } finally {
      this.pumping = false;
    }
  }

  private releaseRunningEntry(entry: ErasedQueuedTask): void {
    this.running = Math.max(0, this.running - 1);
    this.decrementGroup(entry.groupKey);
    this.requestPump();
  }

  private start(entry: ErasedQueuedTask): void {
    if (entry.settled || !removeArrayItem(this.queue, entry)) return;
    if (entry.signal?.aborted) {
      entry.settled = true;
      this.clearQueuedListeners(entry);
      this.counters.cancelled += 1;
      entry.reject(createAbortError());
      this.requestPump();
      return;
    }

    this.clearQueuedListeners(entry);
    const startedAt = this.now();
    const queueWaitMs = Math.max(0, startedAt - entry.queuedAt);
    this.running += 1;
    this.incrementGroup(entry.groupKey);
    this.peakRunning = Math.max(this.peakRunning, this.running);
    this.counters.started += 1;
    this.emit('network.scheduler.started', {
      taskId: entry.id,
      priority: entry.priority,
      groupKey: entry.groupKey,
      label: entry.label,
      queueWaitMs,
      queued: this.queue.length,
      running: this.running
    });

    let taskResult: Promise<any>;
    try {
      taskResult = Promise.resolve(entry.task());
    } catch (error) {
      taskResult = Promise.reject(error);
    }

    taskResult.then(
      (value) => {
        if (entry.settled) return;
        entry.settled = true;
        this.counters.completed += 1;
        this.emit('network.scheduler.completed', {
          taskId: entry.id,
          priority: entry.priority,
          groupKey: entry.groupKey,
          label: entry.label,
          queueWaitMs,
          runDurationMs: Math.max(0, this.now() - startedAt)
        });
        this.releaseRunningEntry(entry);
        entry.resolve(value);
      },
      (error) => {
        if (entry.settled) return;
        entry.settled = true;
        this.counters.failed += 1;
        this.emit('network.scheduler.failed', {
          taskId: entry.id,
          priority: entry.priority,
          groupKey: entry.groupKey,
          label: entry.label,
          queueWaitMs,
          runDurationMs: Math.max(0, this.now() - startedAt),
          code: error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : null
        });
        this.releaseRunningEntry(entry);
        entry.reject(error);
      }
    );
  }

  private executeBypass<T>(
    task: () => Promise<T> | T,
    priority: RequestPriority,
    groupKey: string,
    label: string | null,
    signal?: AbortSignal | null
  ): Promise<T> {
    if (signal?.aborted) {
      this.counters.cancelled += 1;
      return Promise.reject(createAbortError());
    }
    this.counters.scheduled += 1;
    this.counters.bypassed += 1;
    const startedAt = this.now();
    this.emit('network.scheduler.bypassed', { priority, groupKey, label });

    let result: Promise<T>;
    try {
      result = Promise.resolve(task());
    } catch (error) {
      result = Promise.reject(error);
    }

    return result.then(
      (value) => {
        this.counters.completed += 1;
        this.emit('network.scheduler.completed', {
          priority,
          groupKey,
          label,
          bypass: true,
          runDurationMs: Math.max(0, this.now() - startedAt)
        });
        return value;
      },
      (error) => {
        this.counters.failed += 1;
        this.emit('network.scheduler.failed', {
          priority,
          groupKey,
          label,
          bypass: true,
          runDurationMs: Math.max(0, this.now() - startedAt)
        });
        throw error;
      }
    );
  }

  schedule<T>(task: () => Promise<T> | T, options: SchedulerTaskMetadata = {}): Promise<T> {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('RequestScheduler.schedule requires a task function'));
    }
    const priority = normalizeRequestPriority(options.priority);
    const groupKey = normalizeSchedulerGroup(options.groupKey);
    const label = normalizeSchedulerLabel(options.label);
    const signal = isAbortSignalLike(options.signal) ? options.signal : undefined;

    if (options.bypass === true) {
      return this.executeBypass(task, priority, groupKey, label, signal);
    }
    if (signal?.aborted) {
      this.counters.cancelled += 1;
      this.emit('network.scheduler.rejected', {
        priority,
        groupKey,
        label,
        reason: 'cancelled-before-queue'
      });
      return Promise.reject(createAbortError());
    }
    if (this.queue.length >= this.maxQueued) {
      this.counters.rejected += 1;
      this.emit('network.scheduler.rejected', {
        priority,
        groupKey,
        label,
        reason: 'queue-full',
        queued: this.queue.length,
        maxQueued: this.maxQueued
      });
      return Promise.reject(createSchedulerError(
        'Network request queue is full.',
        'SCHEDULER_QUEUE_FULL',
        { maxQueued: this.maxQueued }
      ));
    }

    this.counters.scheduled += 1;
    const id = ++this.sequence;
    const queuedAt = this.now();
    const queueTimeoutMs = toBoundedInteger(options.queueTimeoutMs, 0, 0, MAX_QUEUE_TIMEOUT_MS);

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask<T> = {
        id,
        task,
        priority,
        groupKey,
        label,
        signal,
        queuedAt,
        queueTimeoutMs,
        timeoutHandle: null,
        abortHandler: null,
        settled: false,
        resolve,
        reject
      };
      const erased = entry as ErasedQueuedTask;

      if (signal) {
        entry.abortHandler = () => this.rejectQueued(erased, createAbortError(), 'cancelled');
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      if (queueTimeoutMs > 0) {
        entry.timeoutHandle = this.setTimer(() => {
          this.rejectQueued(
            erased,
            createSchedulerError(
              'Network request exceeded its queue wait budget.',
              'SCHEDULER_QUEUE_TIMEOUT',
              { queueTimeoutMs }
            ),
            'timeout'
          );
        }, queueTimeoutMs);
      }

      this.queue.push(erased);
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
      this.emit('network.scheduler.queued', {
        taskId: id,
        priority,
        groupKey,
        label,
        queueTimeoutMs,
        queued: this.queue.length,
        running: this.running
      });
      this.requestPump();
    });
  }

  getQueuedCount(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running;
  }

  cancelQueued(reason = 'Scheduler queue cleared'): number {
    const queued = [...this.queue];
    queued.forEach((entry) => {
      this.rejectQueued(
        entry,
        createSchedulerError(reason, 'SCHEDULER_QUEUE_CANCELLED'),
        'cancelled'
      );
    });
    return queued.length;
  }

  snapshot(): SchedulerSnapshot {
    const groupKeys = new Set<string>([
      ...this.runningByGroup.keys(),
      ...this.queue.map((entry) => entry.groupKey)
    ]);
    const groups: Record<string, { running: number; queued: number }> = {};
    [...groupKeys].sort().forEach((groupKey) => {
      groups[groupKey] = Object.freeze({
        running: this.getGroupRunning(groupKey),
        queued: this.queue.filter((entry) => entry.groupKey === groupKey).length
      });
    });

    const priorities: Record<RequestPriority, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
      background: 0
    };
    this.queue.forEach((entry) => {
      priorities[entry.priority] = (priorities[entry.priority] || 0) + 1;
    });

    return Object.freeze({
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerGroup: this.maxConcurrentPerGroup,
      maxQueued: this.maxQueued,
      running: this.running,
      queued: this.queue.length,
      peakRunning: this.peakRunning,
      peakQueued: this.peakQueued,
      groups: Object.freeze(groups),
      priorities: Object.freeze(priorities),
      counters: Object.freeze({ ...this.counters })
    });
  }
}

export const createRequestScheduler = (options: SchedulerOptions = {}): RequestScheduler =>
  new RequestScheduler(options);

export const getSchedulerGroupFromPath = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!text) return 'default';
  const withoutQuery = text.split(/[?#]/, 1)[0] || '/';
  const segments = withoutQuery.split('/').filter(Boolean);
  if (segments.length === 0) return 'root';
  if (segments[0]?.toLowerCase() === 'api' && segments.length > 1) {
    return normalizeSchedulerGroup(`api/${segments[1]}`);
  }
  return normalizeSchedulerGroup(segments[0]);
};

export const RequestSchedulerPolicy = Object.freeze({
  priorities: FROZEN_REQUEST_PRIORITIES,
  getSchedulerGroupFromPath,
  createRequestScheduler
});
