export type SpatialWorkloadLane = 'query' | 'identify' | 'cluster' | 'scene' | 'tile';
export type SpatialWorkloadPriority = 'background' | 'normal' | 'interactive' | 'critical';
export type SpatialPressureLevel = 'normal' | 'elevated' | 'critical';
export type SpatialAdmissionDecision = 'start' | 'queue' | 'reject' | 'preempt';

export interface SpatialWorkloadBudget {
  maxActive: number;
  maxQueued: number;
  maxEstimatedBytes: number;
  timeoutMs: number;
}

export interface SpatialWorkloadRequest {
  id: string;
  lane: SpatialWorkloadLane;
  priority?: SpatialWorkloadPriority;
  estimatedBytes?: number;
  estimatedCpuMs?: number;
  cancellable?: boolean;
  createdAt?: number;
}

export interface SpatialPerformanceSample {
  frameMs?: number;
  gpuPressure?: number;
  heapPressure?: number;
  memoryGb?: number;
  networkBacklog?: number;
  timestamp?: number;
}

export interface SpatialAdmissionResult {
  decision: SpatialAdmissionDecision;
  request: NormalizedSpatialWorkloadRequest;
  pressure: SpatialPressureLevel;
  reason: string;
  preemptRequestId: string | null;
}

export interface NormalizedSpatialWorkloadRequest {
  id: string;
  lane: SpatialWorkloadLane;
  priority: SpatialWorkloadPriority;
  estimatedBytes: number;
  estimatedCpuMs: number;
  cancellable: boolean;
  createdAt: number;
  sequence: number;
}

export interface SpatialWorkloadCompletion {
  id: string;
  lane: SpatialWorkloadLane;
  durationMs: number;
  success: boolean;
  bytes: number;
}

export interface SpatialWorkloadLaneSnapshot {
  lane: SpatialWorkloadLane;
  active: number;
  queued: number;
  activeBytes: number;
  queuedBytes: number;
  budget: SpatialWorkloadBudget;
}

export interface SpatialWorkloadSnapshot {
  pressure: SpatialPressureLevel;
  pressureStableSamples: number;
  totalActive: number;
  totalQueued: number;
  admitted: number;
  queued: number;
  rejected: number;
  preemptions: number;
  completed: number;
  failed: number;
  cancelled: number;
  lanes: readonly SpatialWorkloadLaneSnapshot[];
  disposed: boolean;
}

export interface SpatialWorkloadGovernorConfiguration {
  budgets?: Partial<Record<SpatialWorkloadLane, Partial<SpatialWorkloadBudget>>>;
  pressureHysteresisSamples?: number;
  elevatedFrameMs?: number;
  criticalFrameMs?: number;
}

interface ActiveRecord {
  request: NormalizedSpatialWorkloadRequest;
  startedAt: number;
}

const LANES: readonly SpatialWorkloadLane[] = Object.freeze(['query', 'identify', 'cluster', 'scene', 'tile']);

const DEFAULT_BUDGETS: Readonly<Record<SpatialWorkloadLane, SpatialWorkloadBudget>> = Object.freeze({
  query: Object.freeze({ maxActive: 6, maxQueued: 64, maxEstimatedBytes: 32 * 1024 * 1024, timeoutMs: 30_000 }),
  identify: Object.freeze({ maxActive: 3, maxQueued: 24, maxEstimatedBytes: 8 * 1024 * 1024, timeoutMs: 12_000 }),
  cluster: Object.freeze({ maxActive: 2, maxQueued: 8, maxEstimatedBytes: 64 * 1024 * 1024, timeoutMs: 8_000 }),
  scene: Object.freeze({ maxActive: 3, maxQueued: 16, maxEstimatedBytes: 256 * 1024 * 1024, timeoutMs: 45_000 }),
  tile: Object.freeze({ maxActive: 8, maxQueued: 128, maxEstimatedBytes: 128 * 1024 * 1024, timeoutMs: 20_000 }),
});

const PRIORITY_RANK: Readonly<Record<SpatialWorkloadPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  interactive: 2,
  critical: 3,
});

const finite = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const integer = (value: unknown, fallback: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, Math.floor(finite(value, fallback))))
);

const normalizeBudget = (
  base: SpatialWorkloadBudget,
  override: Partial<SpatialWorkloadBudget> | undefined,
): SpatialWorkloadBudget => Object.freeze({
  maxActive: integer(override?.maxActive, base.maxActive, 1, 128),
  maxQueued: integer(override?.maxQueued, base.maxQueued, 0, 10_000),
  maxEstimatedBytes: integer(override?.maxEstimatedBytes, base.maxEstimatedBytes, 1_024, 4 * 1024 * 1024 * 1024),
  timeoutMs: integer(override?.timeoutMs, base.timeoutMs, 100, 10 * 60_000),
});

const normalizeBudgets = (
  configuration: SpatialWorkloadGovernorConfiguration,
): Readonly<Record<SpatialWorkloadLane, SpatialWorkloadBudget>> => Object.freeze({
  query: normalizeBudget(DEFAULT_BUDGETS.query, configuration.budgets?.query),
  identify: normalizeBudget(DEFAULT_BUDGETS.identify, configuration.budgets?.identify),
  cluster: normalizeBudget(DEFAULT_BUDGETS.cluster, configuration.budgets?.cluster),
  scene: normalizeBudget(DEFAULT_BUDGETS.scene, configuration.budgets?.scene),
  tile: normalizeBudget(DEFAULT_BUDGETS.tile, configuration.budgets?.tile),
});

const normalizePriority = (value: SpatialWorkloadPriority | undefined): SpatialWorkloadPriority => value ?? 'normal';

const pressureRank = (value: SpatialPressureLevel): number => value === 'critical' ? 2 : value === 'elevated' ? 1 : 0;

export const deriveSpatialPressure = (
  sample: SpatialPerformanceSample = {},
  configuration: Pick<SpatialWorkloadGovernorConfiguration, 'elevatedFrameMs' | 'criticalFrameMs'> = {},
): SpatialPressureLevel => {
  const elevatedFrameMs = Math.max(16, finite(configuration.elevatedFrameMs, 25));
  const criticalFrameMs = Math.max(elevatedFrameMs + 1, finite(configuration.criticalFrameMs, 42));
  const frameMs = Math.max(0, finite(sample.frameMs, 16.67));
  const gpuPressure = Math.min(1, Math.max(0, finite(sample.gpuPressure, 0)));
  const heapPressure = Math.min(1, Math.max(0, finite(sample.heapPressure, 0)));
  const memoryGb = Math.max(0.25, finite(sample.memoryGb, 4));
  const networkBacklog = Math.max(0, finite(sample.networkBacklog, 0));

  if (
    frameMs >= criticalFrameMs
    || gpuPressure >= 0.9
    || heapPressure >= 0.9
    || memoryGb < 1.5
    || networkBacklog >= 64
  ) return 'critical';
  if (
    frameMs >= elevatedFrameMs
    || gpuPressure >= 0.7
    || heapPressure >= 0.7
    || memoryGb < 3
    || networkBacklog >= 24
  ) return 'elevated';
  return 'normal';
};

const pressureConcurrencyFactor = (pressure: SpatialPressureLevel): number => (
  pressure === 'critical' ? 0.4 : pressure === 'elevated' ? 0.7 : 1
);

const effectiveActiveBudget = (budget: SpatialWorkloadBudget, pressure: SpatialPressureLevel): number => (
  Math.max(1, Math.floor(budget.maxActive * pressureConcurrencyFactor(pressure)))
);

const compareQueue = (left: NormalizedSpatialWorkloadRequest, right: NormalizedSpatialWorkloadRequest): number => (
  PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
  || left.createdAt - right.createdAt
  || left.sequence - right.sequence
  || left.id.localeCompare(right.id)
);

const totalBytes = (requests: readonly NormalizedSpatialWorkloadRequest[]): number => requests.reduce(
  (total, request) => total + request.estimatedBytes,
  0,
);

export class SpatialWorkloadGovernor {
  #budgets: Readonly<Record<SpatialWorkloadLane, SpatialWorkloadBudget>>;
  #pressure: SpatialPressureLevel = 'normal';
  #pressureCandidate: SpatialPressureLevel = 'normal';
  #pressureCandidateSamples = 0;
  #pressureHysteresisSamples: number;
  #elevatedFrameMs: number;
  #criticalFrameMs: number;
  #active = new Map<string, ActiveRecord>();
  #queued = new Map<string, NormalizedSpatialWorkloadRequest>();
  #sequence = 0;
  #admitted = 0;
  #queuedCount = 0;
  #rejected = 0;
  #preemptions = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #disposed = false;

  constructor(configuration: SpatialWorkloadGovernorConfiguration = {}) {
    this.#budgets = normalizeBudgets(configuration);
    this.#pressureHysteresisSamples = integer(configuration.pressureHysteresisSamples, 3, 1, 30);
    this.#elevatedFrameMs = Math.max(16, finite(configuration.elevatedFrameMs, 25));
    this.#criticalFrameMs = Math.max(this.#elevatedFrameMs + 1, finite(configuration.criticalFrameMs, 42));
  }

  samplePerformance(sample: SpatialPerformanceSample): SpatialPressureLevel {
    this.#assertActive();
    const next = deriveSpatialPressure(sample, {
      elevatedFrameMs: this.#elevatedFrameMs,
      criticalFrameMs: this.#criticalFrameMs,
    });
    if (pressureRank(next) > pressureRank(this.#pressure)) {
      this.#pressure = next;
      this.#pressureCandidate = next;
      this.#pressureCandidateSamples = 0;
      return this.#pressure;
    }
    if (next === this.#pressure) {
      this.#pressureCandidate = next;
      this.#pressureCandidateSamples = 0;
      return this.#pressure;
    }
    if (this.#pressureCandidate !== next) {
      this.#pressureCandidate = next;
      this.#pressureCandidateSamples = 1;
      return this.#pressure;
    }
    this.#pressureCandidateSamples += 1;
    if (this.#pressureCandidateSamples >= this.#pressureHysteresisSamples) {
      this.#pressure = next;
      this.#pressureCandidateSamples = 0;
    }
    return this.#pressure;
  }

  admit(requestInput: SpatialWorkloadRequest): SpatialAdmissionResult {
    this.#assertActive();
    const request = this.#normalizeRequest(requestInput);
    if (this.#active.has(request.id) || this.#queued.has(request.id)) {
      this.#rejected += 1;
      return Object.freeze({
        decision: 'reject',
        request,
        pressure: this.#pressure,
        reason: 'duplicate-request-id',
        preemptRequestId: null,
      });
    }

    const budget = this.#budgets[request.lane];
    if (request.estimatedBytes > budget.maxEstimatedBytes) {
      this.#rejected += 1;
      return Object.freeze({
        decision: 'reject',
        request,
        pressure: this.#pressure,
        reason: 'request-byte-budget-exceeded',
        preemptRequestId: null,
      });
    }

    const laneActive = this.#activeForLane(request.lane);
    const activeBudget = effectiveActiveBudget(budget, this.#pressure);
    if (laneActive.length < activeBudget) {
      this.#start(request, request.createdAt);
      return Object.freeze({
        decision: 'start',
        request,
        pressure: this.#pressure,
        reason: 'capacity-available',
        preemptRequestId: null,
      });
    }

    const preemptible = laneActive
      .filter((record) => record.request.cancellable)
      .filter((record) => PRIORITY_RANK[record.request.priority] < PRIORITY_RANK[request.priority])
      .sort((left, right) => (
        PRIORITY_RANK[left.request.priority] - PRIORITY_RANK[right.request.priority]
        || right.startedAt - left.startedAt
      ))[0];
    if (preemptible && request.priority === 'critical') {
      this.#active.delete(preemptible.request.id);
      this.#preemptions += 1;
      this.#cancelled += 1;
      this.#start(request, request.createdAt);
      return Object.freeze({
        decision: 'preempt',
        request,
        pressure: this.#pressure,
        reason: 'critical-priority-preemption',
        preemptRequestId: preemptible.request.id,
      });
    }

    const laneQueue = this.#queuedForLane(request.lane);
    const queuedBytes = totalBytes(laneQueue);
    if (laneQueue.length >= budget.maxQueued || queuedBytes + request.estimatedBytes > budget.maxEstimatedBytes) {
      this.#rejected += 1;
      return Object.freeze({
        decision: 'reject',
        request,
        pressure: this.#pressure,
        reason: laneQueue.length >= budget.maxQueued ? 'queue-capacity-exceeded' : 'queue-byte-budget-exceeded',
        preemptRequestId: null,
      });
    }

    this.#queued.set(request.id, request);
    this.#queuedCount += 1;
    return Object.freeze({
      decision: 'queue',
      request,
      pressure: this.#pressure,
      reason: 'active-capacity-exhausted',
      preemptRequestId: null,
    });
  }

  complete(idInput: string, options: { success?: boolean; completedAt?: number } = {}): SpatialWorkloadCompletion | null {
    this.#assertActive();
    const id = String(idInput ?? '').trim();
    const active = this.#active.get(id);
    if (!active) return null;
    this.#active.delete(id);
    const completedAt = Math.max(active.startedAt, finite(options.completedAt, Date.now()));
    const success = options.success !== false;
    if (success) this.#completed += 1;
    else this.#failed += 1;
    const completion = Object.freeze({
      id,
      lane: active.request.lane,
      durationMs: completedAt - active.startedAt,
      success,
      bytes: active.request.estimatedBytes,
    });
    this.#promote(active.request.lane, completedAt);
    return completion;
  }

  cancel(idInput: string): boolean {
    this.#assertActive();
    const id = String(idInput ?? '').trim();
    if (this.#queued.delete(id)) {
      this.#cancelled += 1;
      return true;
    }
    const active = this.#active.get(id);
    if (!active || !active.request.cancellable) return false;
    this.#active.delete(id);
    this.#cancelled += 1;
    this.#promote(active.request.lane, Date.now());
    return true;
  }

  drainExpired(nowInput = Date.now()): readonly string[] {
    this.#assertActive();
    const now = finite(nowInput, Date.now());
    const expired: string[] = [];
    for (const [id, active] of this.#active) {
      const budget = this.#budgets[active.request.lane];
      if (!active.request.cancellable || now - active.startedAt <= budget.timeoutMs) continue;
      this.#active.delete(id);
      this.#cancelled += 1;
      expired.push(id);
      this.#promote(active.request.lane, now);
    }
    return Object.freeze(expired);
  }

  snapshot(): SpatialWorkloadSnapshot {
    return Object.freeze({
      pressure: this.#pressure,
      pressureStableSamples: this.#pressureCandidateSamples,
      totalActive: this.#active.size,
      totalQueued: this.#queued.size,
      admitted: this.#admitted,
      queued: this.#queuedCount,
      rejected: this.#rejected,
      preemptions: this.#preemptions,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      lanes: Object.freeze(LANES.map((lane) => {
        const active = this.#activeForLane(lane).map((record) => record.request);
        const queued = this.#queuedForLane(lane);
        return Object.freeze({
          lane,
          active: active.length,
          queued: queued.length,
          activeBytes: totalBytes(active),
          queuedBytes: totalBytes(queued),
          budget: this.#budgets[lane],
        });
      })),
      disposed: this.#disposed,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelled += this.#active.size + this.#queued.size;
    this.#active.clear();
    this.#queued.clear();
  }

  #normalizeRequest(request: SpatialWorkloadRequest): NormalizedSpatialWorkloadRequest {
    const id = String(request.id ?? '').trim();
    if (!id) throw new Error('Spatial workload request id is required.');
    if (!LANES.includes(request.lane)) throw new Error(`Unsupported spatial workload lane: ${String(request.lane)}`);
    this.#sequence += 1;
    return Object.freeze({
      id,
      lane: request.lane,
      priority: normalizePriority(request.priority),
      estimatedBytes: integer(request.estimatedBytes, 0, 0, 4 * 1024 * 1024 * 1024),
      estimatedCpuMs: Math.max(0, finite(request.estimatedCpuMs, 0)),
      cancellable: request.cancellable !== false,
      createdAt: Math.max(0, finite(request.createdAt, Date.now())),
      sequence: this.#sequence,
    });
  }

  #activeForLane(lane: SpatialWorkloadLane): ActiveRecord[] {
    return [...this.#active.values()].filter((record) => record.request.lane === lane);
  }

  #queuedForLane(lane: SpatialWorkloadLane): NormalizedSpatialWorkloadRequest[] {
    return [...this.#queued.values()].filter((request) => request.lane === lane).sort(compareQueue);
  }

  #start(request: NormalizedSpatialWorkloadRequest, startedAt: number): void {
    this.#active.set(request.id, { request, startedAt });
    this.#admitted += 1;
  }

  #promote(lane: SpatialWorkloadLane, now: number): void {
    const budget = this.#budgets[lane];
    const activeBudget = effectiveActiveBudget(budget, this.#pressure);
    while (this.#activeForLane(lane).length < activeBudget) {
      const next = this.#queuedForLane(lane)[0];
      if (!next) return;
      this.#queued.delete(next.id);
      this.#start(next, now);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw Object.assign(new Error('Spatial workload governor has been disposed.'), {
        code: 'SPATIAL_WORKLOAD_GOVERNOR_DISPOSED',
      });
    }
  }
}

export const createSpatialWorkloadGovernor = (
  configuration: SpatialWorkloadGovernorConfiguration = {},
): SpatialWorkloadGovernor => new SpatialWorkloadGovernor(configuration);
