export type ViewportQueryPriority = 'interactive' | 'foreground' | 'background';

export interface ViewportQueryIntent {
  readonly id: string;
  readonly viewId: string;
  readonly revision: number;
  readonly priority: ViewportQueryPriority;
  readonly createdAt: number;
  readonly extentArea: number;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
}

export interface ViewportQueryLease {
  readonly id: string;
  readonly viewId: string;
  readonly revision: number;
  readonly priority: ViewportQueryPriority;
  readonly startedAt: number;
}

export interface ViewportQueryPolicyOptions {
  readonly maxViews: number;
  readonly maxQueued: number;
  readonly maxQueuedPerView: number;
  readonly maxRunning: number;
  readonly maxRunningPerView: number;
  readonly maxExtentArea: number;
  readonly maxEstimatedFeatures: number;
  readonly maxEstimatedBytes: number;
  readonly queueTtlMs: number;
  readonly runTtlMs: number;
}

export interface ViewportQuerySnapshot {
  readonly queued: number;
  readonly running: number;
  readonly views: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expired: number;
  readonly cancelled: number;
}

const DEFAULTS: ViewportQueryPolicyOptions = {
  maxViews: 8,
  maxQueued: 48,
  maxQueuedPerView: 12,
  maxRunning: 6,
  maxRunningPerView: 2,
  maxExtentArea: 1e14,
  maxEstimatedFeatures: 5000,
  maxEstimatedBytes: 8 * 1024 * 1024,
  queueTtlMs: 15_000,
  runTtlMs: 30_000,
};

const priorityRank: Record<ViewportQueryPriority, number> = {
  interactive: 0,
  foreground: 1,
  background: 2,
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

export class ArcGisViewportQueryPolicy {
  private readonly options: ViewportQueryPolicyOptions;
  private readonly revisions = new Map<string, number>();
  private readonly queue: ViewportQueryIntent[] = [];
  private readonly running = new Map<string, ViewportQueryLease>();
  private accepted = 0;
  private rejected = 0;
  private expired = 0;
  private cancelled = 0;
  private disposed = false;

  constructor(options: Partial<ViewportQueryPolicyOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!finitePositive(value)) throw new Error(`Invalid viewport query budget: ${key}`);
    }
  }

  setRevision(viewId: string, revision: number): boolean {
    if (this.disposed || !validId(viewId) || !Number.isSafeInteger(revision) || revision < 0) return false;
    if (!this.revisions.has(viewId) && this.revisions.size >= this.options.maxViews) return false;
    const current = this.revisions.get(viewId);
    if (current !== undefined && revision < current) return false;
    this.revisions.set(viewId, revision);
    if (current !== undefined && revision > current) this.cancelStale(viewId, revision);
    return true;
  }

  enqueue(intent: ViewportQueryIntent, now: number): boolean {
    this.sweep(now);
    if (!this.isAdmissible(intent, now)) {
      this.rejected += 1;
      return false;
    }
    const queuedForView = this.queue.reduce((n, item) => n + Number(item.viewId === intent.viewId), 0);
    if (this.queue.length >= this.options.maxQueued || queuedForView >= this.options.maxQueuedPerView) {
      this.rejected += 1;
      return false;
    }
    if (this.queue.some((item) => item.id === intent.id) || this.running.has(intent.id)) {
      this.rejected += 1;
      return false;
    }
    this.queue.push({ ...intent });
    this.accepted += 1;
    return true;
  }

  startNext(now: number): ViewportQueryLease | null {
    this.sweep(now);
    if (this.disposed || this.running.size >= this.options.maxRunning) return null;
    const candidates = this.queue
      .map((intent, index) => ({ intent, index }))
      .filter(({ intent }) => this.runningForView(intent.viewId) < this.options.maxRunningPerView)
      .sort((a, b) => priorityRank[a.intent.priority] - priorityRank[b.intent.priority]
        || a.intent.createdAt - b.intent.createdAt
        || a.intent.id.localeCompare(b.intent.id));
    const selected = candidates[0];
    if (!selected) return null;
    this.queue.splice(selected.index, 1);
    const lease: ViewportQueryLease = {
      id: selected.intent.id,
      viewId: selected.intent.viewId,
      revision: selected.intent.revision,
      priority: selected.intent.priority,
      startedAt: now,
    };
    this.running.set(lease.id, lease);
    return { ...lease };
  }

  complete(id: string, now: number): boolean {
    this.sweep(now);
    const lease = this.running.get(id);
    if (!lease) return false;
    this.running.delete(id);
    return this.revisions.get(lease.viewId) === lease.revision;
  }

  cancelView(viewId: string): number {
    let removed = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.viewId === viewId) {
        this.queue.splice(index, 1);
        removed += 1;
      }
    }
    for (const [id, lease] of this.running) {
      if (lease.viewId === viewId) {
        this.running.delete(id);
        removed += 1;
      }
    }
    this.revisions.delete(viewId);
    this.cancelled += removed;
    return removed;
  }

  sweep(now: number): void {
    if (!Number.isFinite(now)) return;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const intent = this.queue[index];
      if (intent && now - intent.createdAt > this.options.queueTtlMs) {
        this.queue.splice(index, 1);
        this.expired += 1;
      }
    }
    for (const [id, lease] of this.running) {
      if (now - lease.startedAt > this.options.runTtlMs) {
        this.running.delete(id);
        this.expired += 1;
      }
    }
  }

  snapshot(): ViewportQuerySnapshot {
    return Object.freeze({
      queued: this.queue.length,
      running: this.running.size,
      views: this.revisions.size,
      accepted: this.accepted,
      rejected: this.rejected,
      expired: this.expired,
      cancelled: this.cancelled,
    });
  }

  dispose(): void {
    this.queue.length = 0;
    this.running.clear();
    this.revisions.clear();
    this.disposed = true;
  }

  private isAdmissible(intent: ViewportQueryIntent, now: number): boolean {
    if (this.disposed || !validId(intent.id) || !validId(intent.viewId)) return false;
    if (!Number.isSafeInteger(intent.revision) || intent.revision < 0) return false;
    if (!(intent.priority in priorityRank) || !Number.isFinite(intent.createdAt) || intent.createdAt > now) return false;
    if (!finitePositive(intent.extentArea) || intent.extentArea > this.options.maxExtentArea) return false;
    if (!Number.isSafeInteger(intent.estimatedFeatures) || intent.estimatedFeatures < 0 || intent.estimatedFeatures > this.options.maxEstimatedFeatures) return false;
    if (!Number.isSafeInteger(intent.estimatedBytes) || intent.estimatedBytes < 0 || intent.estimatedBytes > this.options.maxEstimatedBytes) return false;
    return this.revisions.get(intent.viewId) === intent.revision;
  }

  private runningForView(viewId: string): number {
    let count = 0;
    for (const lease of this.running.values()) if (lease.viewId === viewId) count += 1;
    return count;
  }

  private cancelStale(viewId: string, revision: number): void {
    let removed = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const intent = this.queue[index];
      if (intent?.viewId === viewId && intent.revision < revision) {
        this.queue.splice(index, 1);
        removed += 1;
      }
    }
    for (const [id, lease] of this.running) {
      if (lease.viewId === viewId && lease.revision < revision) {
        this.running.delete(id);
        removed += 1;
      }
    }
    this.cancelled += removed;
  }
}
