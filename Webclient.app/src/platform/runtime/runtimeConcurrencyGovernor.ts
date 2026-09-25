export type RuntimeConcurrencyLane = 'interactive' | 'background' | 'maintenance';
export type RuntimeConcurrencyDecision = 'admit' | 'queue' | 'reject';
export type RuntimeConcurrencyRejection = 'queue-full' | 'duplicate' | 'disposed';

export interface RuntimeConcurrencyPolicy {
  readonly globalConcurrency: number;
  readonly globalQueue: number;
  readonly laneConcurrency: Readonly<Record<RuntimeConcurrencyLane, number>>;
  readonly laneQueue: Readonly<Record<RuntimeConcurrencyLane, number>>;
  readonly historyLimit: number;
}

export interface RuntimeConcurrencyRequest {
  readonly id: string;
  readonly lane: RuntimeConcurrencyLane;
}

export interface RuntimeConcurrencyResult {
  readonly decision: RuntimeConcurrencyDecision;
  readonly request: RuntimeConcurrencyRequest;
  readonly reason?: RuntimeConcurrencyRejection;
}

export interface RuntimeConcurrencySnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeByLane: Readonly<Record<RuntimeConcurrencyLane, number>>;
  readonly queuedByLane: Readonly<Record<RuntimeConcurrencyLane, number>>;
  readonly disposed: boolean;
}

export interface RuntimeConcurrencyEvent {
  readonly sequence: number;
  readonly requestId: string;
  readonly lane: RuntimeConcurrencyLane;
  readonly kind: 'admitted' | 'queued' | 'promoted' | 'released' | 'cancelled' | 'rejected' | 'disposed';
  readonly reason?: RuntimeConcurrencyRejection;
}

const LANES: readonly RuntimeConcurrencyLane[] = ['interactive', 'background', 'maintenance'];
const MAX_LIMIT = 100_000;

const assertInteger = (name: string, value: number, minimum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_LIMIT) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${MAX_LIMIT}`);
  }
  return value;
};

const copyLaneCounts = (value: Readonly<Record<RuntimeConcurrencyLane, number>>) =>
  Object.freeze({ interactive: value.interactive, background: value.background, maintenance: value.maintenance });

const validatePolicy = (policy: RuntimeConcurrencyPolicy): RuntimeConcurrencyPolicy => {
  const laneConcurrency = {
    interactive: assertInteger('laneConcurrency.interactive', policy.laneConcurrency.interactive, 1),
    background: assertInteger('laneConcurrency.background', policy.laneConcurrency.background, 1),
    maintenance: assertInteger('laneConcurrency.maintenance', policy.laneConcurrency.maintenance, 1),
  };
  const laneQueue = {
    interactive: assertInteger('laneQueue.interactive', policy.laneQueue.interactive, 0),
    background: assertInteger('laneQueue.background', policy.laneQueue.background, 0),
    maintenance: assertInteger('laneQueue.maintenance', policy.laneQueue.maintenance, 0),
  };
  return Object.freeze({
    globalConcurrency: assertInteger('globalConcurrency', policy.globalConcurrency, 1),
    globalQueue: assertInteger('globalQueue', policy.globalQueue, 0),
    laneConcurrency: Object.freeze(laneConcurrency),
    laneQueue: Object.freeze(laneQueue),
    historyLimit: assertInteger('historyLimit', policy.historyLimit, 1),
  });
};

const validateRequest = (request: RuntimeConcurrencyRequest): RuntimeConcurrencyRequest => {
  if (typeof request.id !== 'string' || request.id.trim().length === 0 || request.id.length > 256) {
    throw new TypeError('request id must be a non-empty string no longer than 256 characters');
  }
  if (!LANES.includes(request.lane)) throw new TypeError(`unsupported runtime lane: ${String(request.lane)}`);
  return Object.freeze({ id: request.id, lane: request.lane });
};

/**
 * Deterministic, transport-neutral admission primitive for runtime work.
 *
 * The governor owns only concurrency accounting. It deliberately does not start
 * timers, perform I/O, repeat failed work, or execute callbacks. Callers retain
 * task lifecycle ownership and must call release/cancel explicitly.
 */
export class RuntimeConcurrencyGovernor {
  readonly #policy: RuntimeConcurrencyPolicy;
  readonly #active = new Map<string, RuntimeConcurrencyRequest>();
  readonly #queued = new Map<string, RuntimeConcurrencyRequest>();
  readonly #queues: Record<RuntimeConcurrencyLane, string[]> = {
    interactive: [], background: [], maintenance: [],
  };
  readonly #activeByLane: Record<RuntimeConcurrencyLane, number> = {
    interactive: 0, background: 0, maintenance: 0,
  };
  readonly #history: RuntimeConcurrencyEvent[] = [];
  #sequence = 0;
  #disposed = false;

  constructor(policy: RuntimeConcurrencyPolicy) {
    this.#policy = validatePolicy(policy);
  }

  get policy(): RuntimeConcurrencyPolicy { return this.#policy; }

  admit(input: RuntimeConcurrencyRequest): RuntimeConcurrencyResult {
    const request = validateRequest(input);
    if (this.#disposed) return this.#reject(request, 'disposed');
    if (this.#active.has(request.id) || this.#queued.has(request.id)) return this.#reject(request, 'duplicate');

    if (this.#canRun(request.lane)) {
      this.#activate(request, 'admitted');
      return Object.freeze({ decision: 'admit', request });
    }

    if (this.#queued.size >= this.#policy.globalQueue || this.#queues[request.lane].length >= this.#policy.laneQueue[request.lane]) {
      return this.#reject(request, 'queue-full');
    }

    this.#queued.set(request.id, request);
    this.#queues[request.lane].push(request.id);
    this.#record(request, 'queued');
    return Object.freeze({ decision: 'queue', request });
  }

  release(requestId: string): readonly RuntimeConcurrencyRequest[] {
    const active = this.#active.get(requestId);
    if (!active) return Object.freeze([]);
    this.#active.delete(requestId);
    this.#activeByLane[active.lane] -= 1;
    this.#record(active, 'released');
    return this.#promote();
  }

  cancel(requestId: string): readonly RuntimeConcurrencyRequest[] {
    const active = this.#active.get(requestId);
    if (active) return this.release(requestId);
    const queued = this.#queued.get(requestId);
    if (!queued) return Object.freeze([]);
    this.#queued.delete(requestId);
    const queue = this.#queues[queued.lane];
    const index = queue.indexOf(requestId);
    if (index >= 0) queue.splice(index, 1);
    this.#record(queued, 'cancelled');
    return Object.freeze([]);
  }

  has(requestId: string): boolean { return this.#active.has(requestId) || this.#queued.has(requestId); }

  snapshot(): RuntimeConcurrencySnapshot {
    return Object.freeze({
      active: this.#active.size,
      queued: this.#queued.size,
      activeByLane: copyLaneCounts(this.#activeByLane),
      queuedByLane: Object.freeze({
        interactive: this.#queues.interactive.length,
        background: this.#queues.background.length,
        maintenance: this.#queues.maintenance.length,
      }),
      disposed: this.#disposed,
    });
  }

  history(): readonly RuntimeConcurrencyEvent[] { return Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const request of this.#queued.values()) this.#record(request, 'disposed');
    this.#queued.clear();
    for (const lane of LANES) this.#queues[lane].length = 0;
  }

  #canRun(lane: RuntimeConcurrencyLane): boolean {
    return this.#active.size < this.#policy.globalConcurrency && this.#activeByLane[lane] < this.#policy.laneConcurrency[lane];
  }

  #activate(request: RuntimeConcurrencyRequest, kind: 'admitted' | 'promoted'): void {
    this.#active.set(request.id, request);
    this.#activeByLane[request.lane] += 1;
    this.#record(request, kind);
  }

  #promote(): readonly RuntimeConcurrencyRequest[] {
    if (this.#disposed) return Object.freeze([]);
    const promoted: RuntimeConcurrencyRequest[] = [];
    // Interactive work wins when capacity becomes available; FIFO is preserved within each lane.
    for (const lane of LANES) {
      while (this.#canRun(lane)) {
        const id = this.#queues[lane].shift();
        if (id === undefined) break;
        const request = this.#queued.get(id);
        if (!request) continue;
        this.#queued.delete(id);
        this.#activate(request, 'promoted');
        promoted.push(request);
      }
      if (this.#active.size >= this.#policy.globalConcurrency) break;
    }
    return Object.freeze(promoted);
  }

  #reject(request: RuntimeConcurrencyRequest, reason: RuntimeConcurrencyRejection): RuntimeConcurrencyResult {
    this.#record(request, 'rejected', reason);
    return Object.freeze({ decision: 'reject', request, reason });
  }

  #record(request: RuntimeConcurrencyRequest, kind: RuntimeConcurrencyEvent['kind'], reason?: RuntimeConcurrencyRejection): void {
    this.#sequence += 1;
    const event = Object.freeze({ sequence: this.#sequence, requestId: request.id, lane: request.lane, kind, ...(reason ? { reason } : {}) });
    this.#history.push(event);
    const overflow = this.#history.length - this.#policy.historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
  }
}
