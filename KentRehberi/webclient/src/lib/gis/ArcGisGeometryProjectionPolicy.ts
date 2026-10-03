export type ProjectionPriority = 'interactive' | 'visible' | 'background';

export interface ProjectionIntent {
  readonly id: string;
  readonly viewId: string;
  readonly revision: number;
  readonly priority: ProjectionPriority;
  readonly sourceWkid: number;
  readonly targetWkid: number;
  readonly vertexCount: number;
  readonly estimatedBytes: number;
  readonly createdAt: number;
}

export interface ProjectionLease {
  readonly id: string;
  readonly viewId: string;
  readonly revision: number;
  readonly sourceWkid: number;
  readonly targetWkid: number;
  readonly startedAt: number;
}

export interface ProjectionResultMeta {
  readonly id: string;
  readonly viewId: string;
  readonly revision: number;
  readonly vertexCount: number;
  readonly bytes: number;
  readonly completedAt: number;
  readonly expiresAt: number;
}

export interface GeometryProjectionPolicyOptions {
  readonly maxViews: number;
  readonly maxQueued: number;
  readonly maxQueuedPerView: number;
  readonly maxRunning: number;
  readonly maxRunningPerView: number;
  readonly maxVerticesPerJob: number;
  readonly maxBytesPerJob: number;
  readonly maxReady: number;
  readonly maxReadyPerView: number;
  readonly maxReadyBytes: number;
  readonly maxReadyBytesPerView: number;
  readonly queueTtlMs: number;
  readonly runTtlMs: number;
  readonly readyTtlMs: number;
}

export interface GeometryProjectionSnapshot {
  readonly queued: number;
  readonly running: number;
  readonly ready: number;
  readonly readyBytes: number;
  readonly views: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expired: number;
  readonly cancelled: number;
  readonly evicted: number;
}

const DEFAULTS: GeometryProjectionPolicyOptions = {
  maxViews: 8,
  maxQueued: 48,
  maxQueuedPerView: 12,
  maxRunning: 6,
  maxRunningPerView: 2,
  maxVerticesPerJob: 100_000,
  maxBytesPerJob: 8 * 1024 * 1024,
  maxReady: 24,
  maxReadyPerView: 8,
  maxReadyBytes: 32 * 1024 * 1024,
  maxReadyBytesPerView: 12 * 1024 * 1024,
  queueTtlMs: 15_000,
  runTtlMs: 30_000,
  readyTtlMs: 45_000,
};

const rank: Record<ProjectionPriority, number> = { interactive: 0, visible: 1, background: 2 };

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validWkid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
}

export class ArcGisGeometryProjectionPolicy {
  private readonly options: GeometryProjectionPolicyOptions;
  private readonly revisions = new Map<string, number>();
  private readonly queue: ProjectionIntent[] = [];
  private readonly running = new Map<string, ProjectionLease>();
  private readonly ready = new Map<string, ProjectionResultMeta>();
  private accepted = 0;
  private rejected = 0;
  private expired = 0;
  private cancelled = 0;
  private evicted = 0;
  private disposed = false;

  constructor(options: Partial<GeometryProjectionPolicyOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!positive(value)) throw new Error(`Invalid projection budget: ${key}`);
    }
  }

  setRevision(viewId: string, revision: number): boolean {
    if (this.disposed || !validId(viewId) || !Number.isSafeInteger(revision) || revision < 0) return false;
    const current = this.revisions.get(viewId);
    if (current === undefined && this.revisions.size >= this.options.maxViews) return false;
    if (current !== undefined && revision < current) return false;
    this.revisions.set(viewId, revision);
    if (current !== undefined && revision > current) this.removeStale(viewId, revision);
    return true;
  }

  enqueue(intent: ProjectionIntent, now: number): boolean {
    this.sweep(now);
    if (!this.admissible(intent, now) || this.hasId(intent.id)) return this.reject();
    const perView = this.queue.reduce((count, item) => count + Number(item.viewId === intent.viewId), 0);
    if (this.queue.length >= this.options.maxQueued || perView >= this.options.maxQueuedPerView) return this.reject();
    this.queue.push({ ...intent });
    this.accepted += 1;
    return true;
  }

  startNext(now: number): ProjectionLease | null {
    this.sweep(now);
    if (this.disposed || this.running.size >= this.options.maxRunning) return null;
    const selected = this.queue
      .map((intent, index) => ({ intent, index }))
      .filter(({ intent }) => this.runningForView(intent.viewId) < this.options.maxRunningPerView)
      .sort((a, b) => rank[a.intent.priority] - rank[b.intent.priority]
        || a.intent.createdAt - b.intent.createdAt
        || a.intent.id.localeCompare(b.intent.id))[0];
    if (!selected) return null;
    this.queue.splice(selected.index, 1);
    const lease: ProjectionLease = {
      id: selected.intent.id,
      viewId: selected.intent.viewId,
      revision: selected.intent.revision,
      sourceWkid: selected.intent.sourceWkid,
      targetWkid: selected.intent.targetWkid,
      startedAt: now,
    };
    this.running.set(lease.id, lease);
    return Object.freeze({ ...lease });
  }

  complete(id: string, vertexCount: number, bytes: number, now: number): boolean {
    this.sweep(now);
    const lease = this.running.get(id);
    if (!lease) return false;
    this.running.delete(id);
    if (this.revisions.get(lease.viewId) !== lease.revision) return false;
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 0 || vertexCount > this.options.maxVerticesPerJob) return this.reject();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.options.maxBytesPerJob) return this.reject();
    this.sweepReady(now);
    this.evictForAdmission(lease.viewId, bytes);
    if (this.ready.size >= this.options.maxReady || this.readyForView(lease.viewId) >= this.options.maxReadyPerView) return this.reject();
    if (this.readyBytes() + bytes > this.options.maxReadyBytes) return this.reject();
    if (this.readyBytesForView(lease.viewId) + bytes > this.options.maxReadyBytesPerView) return this.reject();
    this.ready.set(id, Object.freeze({
      id,
      viewId: lease.viewId,
      revision: lease.revision,
      vertexCount,
      bytes,
      completedAt: now,
      expiresAt: now + this.options.readyTtlMs,
    }));
    return true;
  }

  consume(id: string, now: number): ProjectionResultMeta | null {
    this.sweep(now);
    const result = this.ready.get(id);
    if (!result) return null;
    this.ready.delete(id);
    return Object.freeze({ ...result });
  }

  cancel(id: string): boolean {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.cancelled += 1;
      return true;
    }
    if (this.running.delete(id) || this.ready.delete(id)) {
      this.cancelled += 1;
      return true;
    }
    return false;
  }

  releaseView(viewId: string): number {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]?.viewId === viewId) { this.queue.splice(i, 1); removed += 1; }
    }
    for (const [id, lease] of this.running) if (lease.viewId === viewId) { this.running.delete(id); removed += 1; }
    for (const [id, result] of this.ready) if (result.viewId === viewId) { this.ready.delete(id); removed += 1; }
    this.revisions.delete(viewId);
    this.cancelled += removed;
    return removed;
  }

  sweep(now: number): void {
    if (!Number.isFinite(now)) return;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (item && now - item.createdAt > this.options.queueTtlMs) { this.queue.splice(i, 1); this.expired += 1; }
    }
    for (const [id, lease] of this.running) {
      if (now - lease.startedAt > this.options.runTtlMs) { this.running.delete(id); this.expired += 1; }
    }
    this.sweepReady(now);
  }

  snapshot(): GeometryProjectionSnapshot {
    return Object.freeze({ queued: this.queue.length, running: this.running.size, ready: this.ready.size,
      readyBytes: this.readyBytes(), views: this.revisions.size, accepted: this.accepted, rejected: this.rejected,
      expired: this.expired, cancelled: this.cancelled, evicted: this.evicted });
  }

  dispose(): void {
    this.queue.length = 0;
    this.running.clear();
    this.ready.clear();
    this.revisions.clear();
    this.disposed = true;
  }

  private admissible(intent: ProjectionIntent, now: number): boolean {
    return !this.disposed && validId(intent.id) && validId(intent.viewId)
      && this.revisions.get(intent.viewId) === intent.revision
      && Number.isSafeInteger(intent.revision) && intent.revision >= 0
      && intent.priority in rank && validWkid(intent.sourceWkid) && validWkid(intent.targetWkid)
      && intent.sourceWkid !== intent.targetWkid
      && Number.isSafeInteger(intent.vertexCount) && intent.vertexCount >= 0 && intent.vertexCount <= this.options.maxVerticesPerJob
      && Number.isSafeInteger(intent.estimatedBytes) && intent.estimatedBytes >= 0 && intent.estimatedBytes <= this.options.maxBytesPerJob
      && Number.isFinite(intent.createdAt) && intent.createdAt <= now;
  }

  private hasId(id: string): boolean {
    return this.queue.some((item) => item.id === id) || this.running.has(id) || this.ready.has(id);
  }

  private runningForView(viewId: string): number {
    let count = 0; for (const lease of this.running.values()) if (lease.viewId === viewId) count += 1; return count;
  }
  private readyForView(viewId: string): number {
    let count = 0; for (const item of this.ready.values()) if (item.viewId === viewId) count += 1; return count;
  }
  private readyBytes(): number {
    let bytes = 0; for (const item of this.ready.values()) bytes += item.bytes; return bytes;
  }
  private readyBytesForView(viewId: string): number {
    let bytes = 0; for (const item of this.ready.values()) if (item.viewId === viewId) bytes += item.bytes; return bytes;
  }

  private sweepReady(now: number): void {
    for (const [id, item] of this.ready) if (now >= item.expiresAt) { this.ready.delete(id); this.expired += 1; }
  }

  private evictForAdmission(viewId: string, incomingBytes: number): void {
    const candidates = [...this.ready.values()].sort((a, b) => a.completedAt - b.completedAt || a.id.localeCompare(b.id));
    for (const item of candidates) {
      const globalPressure = this.ready.size >= this.options.maxReady || this.readyBytes() + incomingBytes > this.options.maxReadyBytes;
      const viewPressure = this.readyForView(viewId) >= this.options.maxReadyPerView || this.readyBytesForView(viewId) + incomingBytes > this.options.maxReadyBytesPerView;
      if (!globalPressure && !viewPressure) break;
      if (viewPressure && item.viewId !== viewId && !globalPressure) continue;
      this.ready.delete(item.id); this.evicted += 1;
    }
  }

  private removeStale(viewId: string, revision: number): void {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i]; if (item?.viewId === viewId && item.revision < revision) { this.queue.splice(i, 1); removed += 1; }
    }
    for (const [id, item] of this.running) if (item.viewId === viewId && item.revision < revision) { this.running.delete(id); removed += 1; }
    for (const [id, item] of this.ready) if (item.viewId === viewId && item.revision < revision) { this.ready.delete(id); removed += 1; }
    this.cancelled += removed;
  }

  private reject(): false { this.rejected += 1; return false; }
}
