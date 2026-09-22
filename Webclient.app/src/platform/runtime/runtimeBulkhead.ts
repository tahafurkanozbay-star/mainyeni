export type BulkheadLane = 'critical' | 'interactive' | 'background';

export interface BulkheadLaneConfig {
  readonly concurrency: number;
  readonly queue: number;
  readonly reserved: number;
}

export interface RuntimeBulkheadConfig {
  readonly globalConcurrency: number;
  readonly globalQueue: number;
  readonly lanes: Readonly<Record<BulkheadLane, BulkheadLaneConfig>>;
  readonly maxHistory: number;
  readonly maxWaitMs: number;
}

export interface BulkheadRequest {
  readonly lane: BulkheadLane;
  readonly key?: string;
  readonly now?: number;
}

export type BulkheadRejectReason = 'global-capacity' | 'lane-capacity' | 'global-queue' | 'lane-queue' | 'duplicate' | 'invalid';

export interface BulkheadLease {
  readonly id: number;
  readonly lane: BulkheadLane;
  readonly key?: string;
  readonly admittedAt: number;
}

export interface BulkheadQueued {
  readonly id: number;
  readonly lane: BulkheadLane;
  readonly key?: string;
  readonly queuedAt: number;
}

export type BulkheadAdmission =
  | { readonly kind: 'admitted'; readonly lease: BulkheadLease }
  | { readonly kind: 'queued'; readonly request: BulkheadQueued }
  | { readonly kind: 'rejected'; readonly reason: BulkheadRejectReason };

export interface BulkheadHistoryEntry {
  readonly at: number;
  readonly event: 'admit' | 'queue' | 'reject' | 'release' | 'cancel' | 'expire' | 'promote';
  readonly lane: BulkheadLane;
  readonly id?: number;
  readonly reason?: BulkheadRejectReason;
}

export interface BulkheadSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeByLane: Readonly<Record<BulkheadLane, number>>;
  readonly queuedByLane: Readonly<Record<BulkheadLane, number>>;
  readonly availableGlobal: number;
  readonly history: readonly BulkheadHistoryEntry[];
}

const LANES: readonly BulkheadLane[] = ['critical', 'interactive', 'background'];

function finiteInteger(name: string, value: number, minimum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function copyCounts(): Record<BulkheadLane, number> {
  return { critical: 0, interactive: 0, background: 0 };
}

interface QueueEntry extends BulkheadQueued {
  readonly sequence: number;
}

/**
 * Timer-free bounded bulkhead for shared browser/runtime work.
 *
 * The coordinator deliberately owns no Promise, timer, network transport or AbortSignal.
 * Callers drive time explicitly through `sweep(now)` and execute promoted work themselves.
 * This keeps resource ownership testable and prevents hidden background activity.
 */
export class RuntimeBulkhead {
  private readonly config: RuntimeBulkheadConfig;
  private readonly active = new Map<number, BulkheadLease>();
  private readonly queue: QueueEntry[] = [];
  private readonly keys = new Map<string, number>();
  private readonly history: BulkheadHistoryEntry[] = [];
  private nextId = 1;
  private sequence = 1;

  public constructor(config: RuntimeBulkheadConfig) {
    finiteInteger('globalConcurrency', config.globalConcurrency, 1);
    finiteInteger('globalQueue', config.globalQueue, 0);
    finiteInteger('maxHistory', config.maxHistory, 1);
    finiteInteger('maxWaitMs', config.maxWaitMs, 1);
    let reserved = 0;
    for (const lane of LANES) {
      const value = config.lanes[lane];
      finiteInteger(`${lane}.concurrency`, value.concurrency, 1);
      finiteInteger(`${lane}.queue`, value.queue, 0);
      finiteInteger(`${lane}.reserved`, value.reserved, 0);
      if (value.reserved > value.concurrency) throw new RangeError(`${lane}.reserved exceeds lane concurrency`);
      reserved += value.reserved;
    }
    if (reserved > config.globalConcurrency) throw new RangeError('reserved capacity exceeds global concurrency');
    this.config = Object.freeze({
      ...config,
      lanes: Object.freeze({
        critical: Object.freeze({ ...config.lanes.critical }),
        interactive: Object.freeze({ ...config.lanes.interactive }),
        background: Object.freeze({ ...config.lanes.background }),
      }),
    });
  }

  public admit(request: BulkheadRequest): BulkheadAdmission {
    const now = request.now ?? Date.now();
    if (!Number.isFinite(now)) return this.reject(request.lane, now, 'invalid');
    if (request.key && this.keys.has(request.key)) return this.reject(request.lane, now, 'duplicate');

    if (this.canRun(request.lane)) {
      const lease = this.createLease(request.lane, request.key, now);
      this.record({ at: now, event: 'admit', lane: request.lane, id: lease.id });
      return { kind: 'admitted', lease };
    }

    const laneQueued = this.queue.filter((entry) => entry.lane === request.lane).length;
    if (this.queue.length >= this.config.globalQueue) return this.reject(request.lane, now, 'global-queue');
    if (laneQueued >= this.config.lanes[request.lane].queue) return this.reject(request.lane, now, 'lane-queue');

    const entry: QueueEntry = Object.freeze({
      id: this.nextId++,
      lane: request.lane,
      ...(request.key ? { key: request.key } : {}),
      queuedAt: now,
      sequence: this.sequence++,
    });
    this.queue.push(entry);
    if (entry.key) this.keys.set(entry.key, entry.id);
    this.record({ at: now, event: 'queue', lane: entry.lane, id: entry.id });
    return { kind: 'queued', request: entry };
  }

  public release(leaseId: number, now = Date.now()): readonly BulkheadLease[] {
    const lease = this.active.get(leaseId);
    if (!lease) return [];
    this.active.delete(leaseId);
    if (lease.key) this.keys.delete(lease.key);
    this.record({ at: now, event: 'release', lane: lease.lane, id: leaseId });
    return this.promote(now);
  }

  public cancel(requestId: number, now = Date.now()): boolean {
    const index = this.queue.findIndex((entry) => entry.id === requestId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    if (!entry) return false;
    if (entry.key) this.keys.delete(entry.key);
    this.record({ at: now, event: 'cancel', lane: entry.lane, id: entry.id });
    return true;
  }

  public sweep(now = Date.now()): readonly BulkheadLease[] {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (!entry || now - entry.queuedAt <= this.config.maxWaitMs) continue;
      this.queue.splice(index, 1);
      if (entry.key) this.keys.delete(entry.key);
      this.record({ at: now, event: 'expire', lane: entry.lane, id: entry.id });
    }
    return this.promote(now);
  }

  public reset(now = Date.now()): void {
    for (const lease of this.active.values()) {
      this.record({ at: now, event: 'release', lane: lease.lane, id: lease.id });
    }
    for (const entry of this.queue) {
      this.record({ at: now, event: 'cancel', lane: entry.lane, id: entry.id });
    }
    this.active.clear();
    this.queue.splice(0);
    this.keys.clear();
  }

  public snapshot(): BulkheadSnapshot {
    const activeByLane = copyCounts();
    const queuedByLane = copyCounts();
    for (const lease of this.active.values()) activeByLane[lease.lane] += 1;
    for (const entry of this.queue) queuedByLane[entry.lane] += 1;
    return Object.freeze({
      active: this.active.size,
      queued: this.queue.length,
      activeByLane: Object.freeze(activeByLane),
      queuedByLane: Object.freeze(queuedByLane),
      availableGlobal: Math.max(0, this.config.globalConcurrency - this.active.size),
      history: Object.freeze(this.history.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  private canRun(lane: BulkheadLane): boolean {
    if (this.active.size >= this.config.globalConcurrency) return false;
    const laneActive = [...this.active.values()].filter((lease) => lease.lane === lane).length;
    if (laneActive >= this.config.lanes[lane].concurrency) return false;

    // Lower-priority lanes may consume only capacity not reserved for higher priorities.
    const rank = LANES.indexOf(lane);
    let protectedSlots = 0;
    for (let index = 0; index < rank; index += 1) {
      const protectedLane = LANES[index];
      if (!protectedLane) continue;
      const used = [...this.active.values()].filter((lease) => lease.lane === protectedLane).length;
      protectedSlots += Math.max(0, this.config.lanes[protectedLane].reserved - used);
    }
    return this.active.size < this.config.globalConcurrency - protectedSlots;
  }

  private createLease(lane: BulkheadLane, key: string | undefined, now: number, id?: number): BulkheadLease {
    const lease = Object.freeze({ id: id ?? this.nextId++, lane, ...(key ? { key } : {}), admittedAt: now });
    this.active.set(lease.id, lease);
    if (key) this.keys.set(key, lease.id);
    return lease;
  }

  private promote(now: number): readonly BulkheadLease[] {
    const promoted: BulkheadLease[] = [];
    // Stable priority order: lane priority first, FIFO within a lane. Re-scan after each promotion
    // because reserved capacity changes as protected lanes become active.
    while (true) {
      let selectedIndex = -1;
      for (const lane of LANES) {
        if (!this.canRun(lane)) continue;
        let bestSequence = Number.POSITIVE_INFINITY;
        for (let index = 0; index < this.queue.length; index += 1) {
          const entry = this.queue[index];
          if (entry?.lane === lane && entry.sequence < bestSequence) {
            bestSequence = entry.sequence;
            selectedIndex = index;
          }
        }
        if (selectedIndex >= 0) break;
      }
      if (selectedIndex < 0) break;
      const [entry] = this.queue.splice(selectedIndex, 1);
      if (!entry) break;
      if (entry.key) this.keys.delete(entry.key);
      const lease = this.createLease(entry.lane, entry.key, now, entry.id);
      this.record({ at: now, event: 'promote', lane: entry.lane, id: entry.id });
      promoted.push(lease);
    }
    return Object.freeze(promoted);
  }

  private reject(lane: BulkheadLane, now: number, reason: BulkheadRejectReason): BulkheadAdmission {
    this.record({ at: Number.isFinite(now) ? now : 0, event: 'reject', lane, reason });
    return { kind: 'rejected', reason };
  }

  private record(entry: BulkheadHistoryEntry): void {
    this.history.push(Object.freeze({ ...entry }));
    const overflow = this.history.length - this.config.maxHistory;
    if (overflow > 0) this.history.splice(0, overflow);
  }
}
