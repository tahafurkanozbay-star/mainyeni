export type AdmissionPriority = 'critical' | 'high' | 'normal' | 'background';
export type AdmissionDecision = 'admit' | 'queue' | 'shed';

export interface AdmissionRequest {
  readonly key: string;
  readonly lane?: string;
  readonly priority?: AdmissionPriority;
  readonly cost?: number;
  readonly signal?: AbortSignal;
}

export interface AdmissionPolicy {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxCost: number;
  readonly maxQueueAgeMs: number;
  readonly laneMaxActive?: Readonly<Record<string, number>>;
  readonly laneMaxQueued?: Readonly<Record<string, number>>;
}

export interface AdmissionSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeCost: number;
  readonly admitted: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly shed: number;
  readonly expired: number;
  readonly lanes: Readonly<Record<string, Readonly<{ active: number; queued: number; cost: number }>>>;
}

export interface AdmissionLease {
  readonly id: string;
  readonly key: string;
  readonly lane: string;
  readonly cost: number;
  readonly release: () => void;
}

export class AdmissionRejectedError extends Error {
  readonly code = 'PLATFORM_ADMISSION_SHED';
  constructor(message = 'Runtime capacity is exhausted.') {
    super(message);
    this.name = 'AdmissionRejectedError';
  }
}

export class AdmissionCancelledError extends Error {
  readonly code = 'PLATFORM_ADMISSION_CANCELLED';
  constructor(message = 'Admission request was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

interface QueueEntry {
  readonly id: string;
  readonly request: Required<Pick<AdmissionRequest, 'key' | 'lane' | 'priority' | 'cost'>> & Pick<AdmissionRequest, 'signal'>;
  readonly createdAt: number;
  readonly resolve: (lease: AdmissionLease) => void;
  readonly reject: (reason: unknown) => void;
  cleanup?: () => void;
}

const priorityRank: Readonly<Record<AdmissionPriority, number>> = Object.freeze({ critical: 0, high: 1, normal: 2, background: 3 });
const positive = (value: number, fallback: number): number => Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export const createAdmissionController = (input: AdmissionPolicy, now: () => number = () => Date.now()) => {
  const policy = Object.freeze({ maxActive: positive(input.maxActive, 8), maxQueued: positive(input.maxQueued, 64), maxCost: positive(input.maxCost, 32), maxQueueAgeMs: positive(input.maxQueueAgeMs, 30_000), laneMaxActive: Object.freeze({ ...(input.laneMaxActive ?? {}) }), laneMaxQueued: Object.freeze({ ...(input.laneMaxQueued ?? {}) }) });
  const active = new Map<string, AdmissionLease>();
  const queue: QueueEntry[] = [];
  let sequence = 0, admitted = 0, completed = 0, cancelled = 0, shed = 0, expired = 0, disposed = false;
  const nextId = (): string => `admission-${(++sequence).toString(36)}`;
  const laneActive = (lane: string): AdmissionLease[] => [...active.values()].filter((lease) => lease.lane === lane);
  const laneQueued = (lane: string): number => queue.reduce((count, entry) => count + Number(entry.request.lane === lane), 0);
  const activeCost = (): number => [...active.values()].reduce((sum, lease) => sum + lease.cost, 0);
  const canAdmit = (request: QueueEntry['request']): boolean => { if (active.size >= policy.maxActive || activeCost() + request.cost > policy.maxCost) return false; const limit = policy.laneMaxActive[request.lane]; return limit === undefined || laneActive(request.lane).length < positive(limit, policy.maxActive); };
  const normalize = (request: AdmissionRequest): QueueEntry['request'] => ({ key: request.key.trim(), lane: request.lane?.trim() || 'default', priority: request.priority ?? 'normal', cost: Math.min(policy.maxCost, positive(request.cost ?? 1, 1)), ...(request.signal ? { signal: request.signal } : {}) });
  const removeQueued = (entry: QueueEntry): boolean => { const index = queue.indexOf(entry); if (index < 0) return false; queue.splice(index, 1); entry.cleanup?.(); return true; };
  const createLease = (entry: QueueEntry): AdmissionLease => { let released = false; const lease: AdmissionLease = Object.freeze({ id: entry.id, key: entry.request.key, lane: entry.request.lane, cost: entry.request.cost, release: () => { if (released) return; released = true; if (active.delete(entry.id)) completed += 1; pump(); } }); active.set(entry.id, lease); admitted += 1; return lease; };
  const expireStale = (): void => { const timestamp = now(); for (let index = queue.length - 1; index >= 0; index -= 1) { const entry = queue[index]; if (!entry || timestamp - entry.createdAt <= policy.maxQueueAgeMs) continue; queue.splice(index, 1); entry.cleanup?.(); expired += 1; entry.reject(new AdmissionRejectedError('Admission request expired while queued.')); } };
  function pump(): void { if (disposed) return; expireStale(); queue.sort((left, right) => priorityRank[left.request.priority] - priorityRank[right.request.priority] || left.createdAt - right.createdAt); let progressed = true; while (progressed) { progressed = false; for (let index = 0; index < queue.length; index += 1) { const entry = queue[index]; if (!entry || !canAdmit(entry.request)) continue; queue.splice(index, 1); entry.cleanup?.(); entry.resolve(createLease(entry)); progressed = true; break; } } }
  const acquire = (request: AdmissionRequest): Promise<AdmissionLease> => { if (disposed) return Promise.reject(new AdmissionRejectedError('Admission controller is disposed.')); const normalized = normalize(request); if (!normalized.key) return Promise.reject(new AdmissionRejectedError('Admission key is required.')); if (normalized.signal?.aborted) return Promise.reject(normalized.signal.reason instanceof Error ? normalized.signal.reason : new AdmissionCancelledError()); const laneQueueLimit = policy.laneMaxQueued[normalized.lane]; if (queue.length >= policy.maxQueued || (laneQueueLimit !== undefined && laneQueued(normalized.lane) >= positive(laneQueueLimit, policy.maxQueued))) { shed += 1; return Promise.reject(new AdmissionRejectedError()); } const id = nextId(); return new Promise<AdmissionLease>((resolve, reject) => { const entry: QueueEntry = { id, request: normalized, createdAt: now(), resolve, reject }; if (normalized.signal) { const onAbort = (): void => { if (!removeQueued(entry)) return; cancelled += 1; reject(normalized.signal?.reason instanceof Error ? normalized.signal.reason : new AdmissionCancelledError()); }; normalized.signal.addEventListener('abort', onAbort, { once: true }); entry.cleanup = () => normalized.signal?.removeEventListener('abort', onAbort); } queue.push(entry); pump(); }); };
  const cancelQueued = (predicate: (request: Readonly<AdmissionRequest>) => boolean = () => true): number => { let count = 0; for (let index = queue.length - 1; index >= 0; index -= 1) { const entry = queue[index]; if (!entry || !predicate(entry.request)) continue; queue.splice(index, 1); entry.cleanup?.(); entry.reject(new AdmissionCancelledError()); cancelled += 1; count += 1; } return count; };
  const snapshot = (): AdmissionSnapshot => { const lanes: Record<string, { active: number; queued: number; cost: number }> = {}; for (const lease of active.values()) { const lane = lanes[lease.lane] ?? { active: 0, queued: 0, cost: 0 }; lane.active += 1; lane.cost += lease.cost; lanes[lease.lane] = lane; } for (const entry of queue) { const lane = lanes[entry.request.lane] ?? { active: 0, queued: 0, cost: 0 }; lane.queued += 1; lanes[entry.request.lane] = lane; } return Object.freeze({ active: active.size, queued: queue.length, activeCost: activeCost(), admitted, completed, cancelled, shed, expired, lanes: Object.freeze(lanes) }); };
  const dispose = (): void => { if (disposed) return; disposed = true; cancelQueued(); active.clear(); };
  return Object.freeze({ acquire, cancelQueued, snapshot, dispose });
};
