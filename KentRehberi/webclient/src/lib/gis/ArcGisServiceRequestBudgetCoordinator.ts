export type ArcGisRequestPriority = 'interactive' | 'foreground' | 'background';

export interface ArcGisServiceRequestBudgetPolicy {
  readonly maxServices: number;
  readonly maxServiceKeyLength: number;
  readonly maxConcurrentGlobal: number;
  readonly maxConcurrentPerService: number;
  readonly maxQueuedGlobal: number;
  readonly maxQueuedPerService: number;
  readonly maxEstimatedBytes: number;
  readonly maxEstimatedFeatures: number;
  readonly maxQueueAgeMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisServiceRequestDescriptor {
  readonly requestId: string;
  readonly serviceKey: string;
  readonly priority: ArcGisRequestPriority;
  readonly estimatedBytes: number;
  readonly estimatedFeatures: number;
  readonly enqueuedAtMs: number;
}

export interface ArcGisServiceRequestAdmission {
  readonly requestId: string;
  readonly serviceKey: string;
  readonly admitted: boolean;
  readonly reason: 'admitted' | 'queued' | 'capacity' | 'budget' | 'expired';
}

export interface ArcGisServiceRequestBudgetSnapshot {
  readonly generation: number;
  readonly active: readonly ArcGisServiceRequestDescriptor[];
  readonly queued: readonly ArcGisServiceRequestDescriptor[];
}

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
};
const nonNegative = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
};
const key = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};
const priorityRank = (value: ArcGisRequestPriority): number => value === 'interactive' ? 0 : value === 'foreground' ? 1 : 2;
const freezeDescriptor = (value: ArcGisServiceRequestDescriptor): ArcGisServiceRequestDescriptor => Object.freeze({ ...value });

/** Primitive-only admission authority for already-governed ArcGIS REST adapters. */
export class ArcGisServiceRequestBudgetCoordinator {
  private readonly policy: Readonly<ArcGisServiceRequestBudgetPolicy>;
  private readonly active = new Map<string, ArcGisServiceRequestDescriptor>();
  private readonly queued = new Map<string, ArcGisServiceRequestDescriptor>();
  private generation = 0;
  private disposed = false;
  private lastObservedAtMs = 0;

  constructor(policy: ArcGisServiceRequestBudgetPolicy) {
    this.policy = Object.freeze({
      maxServices: positive(policy.maxServices, 'maxServices'), maxServiceKeyLength: positive(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxConcurrentGlobal: positive(policy.maxConcurrentGlobal, 'maxConcurrentGlobal'), maxConcurrentPerService: positive(policy.maxConcurrentPerService, 'maxConcurrentPerService'),
      maxQueuedGlobal: positive(policy.maxQueuedGlobal, 'maxQueuedGlobal'), maxQueuedPerService: positive(policy.maxQueuedPerService, 'maxQueuedPerService'),
      maxEstimatedBytes: positive(policy.maxEstimatedBytes, 'maxEstimatedBytes'), maxEstimatedFeatures: positive(policy.maxEstimatedFeatures, 'maxEstimatedFeatures'),
      maxQueueAgeMs: positive(policy.maxQueueAgeMs, 'maxQueueAgeMs'), maxClockSkewMs: positive(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
    if (this.policy.maxConcurrentPerService > this.policy.maxConcurrentGlobal) throw new Error('per-service concurrency cannot exceed global concurrency');
    if (this.policy.maxQueuedPerService > this.policy.maxQueuedGlobal) throw new Error('per-service queue cannot exceed global queue');
  }

  submit(input: Omit<ArcGisServiceRequestDescriptor, 'enqueuedAtMs'>, timestampMs: number): ArcGisServiceRequestAdmission {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.prune(now);
    const descriptor = this.validate({ ...input, enqueuedAtMs: now });
    if (this.active.has(descriptor.requestId) || this.queued.has(descriptor.requestId)) throw new Error('duplicate request id');
    if (this.serviceCount(descriptor.serviceKey) === 0 && this.distinctServices() >= this.policy.maxServices) return this.admission(descriptor, false, 'capacity');
    if (descriptor.estimatedBytes > this.policy.maxEstimatedBytes || descriptor.estimatedFeatures > this.policy.maxEstimatedFeatures) return this.admission(descriptor, false, 'budget');
    if (this.canRun(descriptor.serviceKey)) {
      this.active.set(descriptor.requestId, descriptor); this.generation += 1;
      return this.admission(descriptor, true, 'admitted');
    }
    if (this.queued.size >= this.policy.maxQueuedGlobal || this.count(this.queued, descriptor.serviceKey) >= this.policy.maxQueuedPerService) return this.admission(descriptor, false, 'capacity');
    this.queued.set(descriptor.requestId, descriptor); this.generation += 1;
    return this.admission(descriptor, false, 'queued');
  }

  complete(requestIdValue: string, timestampMs: number): readonly ArcGisServiceRequestDescriptor[] {
    this.assertUsable(); const now = this.time(timestampMs); this.prune(now);
    const requestId = key(requestIdValue, 128, 'request id');
    if (!this.active.delete(requestId)) throw new Error('active request not found');
    this.generation += 1;
    return this.promote();
  }

  cancel(requestIdValue: string, timestampMs: number): readonly ArcGisServiceRequestDescriptor[] {
    this.assertUsable(); const now = this.time(timestampMs); this.prune(now);
    const requestId = key(requestIdValue, 128, 'request id');
    const wasActive = this.active.delete(requestId); const wasQueued = this.queued.delete(requestId);
    if (!wasActive && !wasQueued) return Object.freeze([]);
    this.generation += 1;
    return wasActive ? this.promote() : Object.freeze([]);
  }

  snapshot(timestampMs: number): ArcGisServiceRequestBudgetSnapshot {
    this.assertUsable(); this.prune(this.time(timestampMs));
    const active = [...this.active.values()].sort((a,b) => a.enqueuedAtMs-b.enqueuedAtMs || a.requestId.localeCompare(b.requestId)).map(freezeDescriptor);
    const queued = this.sortedQueue().map(freezeDescriptor);
    return Object.freeze({ generation: this.generation, active: Object.freeze(active), queued: Object.freeze(queued) });
  }

  restore(snapshot: Pick<ArcGisServiceRequestBudgetSnapshot, 'active'|'queued'>, timestampMs: number): void {
    this.assertUsable(); const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.active) || !Array.isArray(snapshot.queued)) throw new Error('invalid request budget snapshot');
    if (snapshot.active.length > this.policy.maxConcurrentGlobal || snapshot.queued.length > this.policy.maxQueuedGlobal) throw new Error('snapshot exceeds global capacity');
    const nextActive = new Map<string, ArcGisServiceRequestDescriptor>(); const nextQueued = new Map<string, ArcGisServiceRequestDescriptor>();
    for (const raw of snapshot.active) this.restoreOne(nextActive, nextQueued, raw, true, now);
    for (const raw of snapshot.queued) this.restoreOne(nextQueued, nextActive, raw, false, now);
    const services = new Set([...nextActive.values(), ...nextQueued.values()].map(item => item.serviceKey));
    if (services.size > this.policy.maxServices) throw new Error('snapshot exceeds service capacity');
    for (const serviceKey of services) {
      if (this.count(nextActive, serviceKey) > this.policy.maxConcurrentPerService || this.count(nextQueued, serviceKey) > this.policy.maxQueuedPerService) throw new Error('snapshot exceeds per-service capacity');
    }
    this.active.clear(); this.queued.clear(); for (const [id,item] of nextActive) this.active.set(id,item); for (const [id,item] of nextQueued) this.queued.set(id,item);
    this.lastObservedAtMs = now; this.generation += 1;
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.active.clear(); this.queued.clear(); this.generation += 1; }

  private restoreOne(target: Map<string, ArcGisServiceRequestDescriptor>, other: Map<string, ArcGisServiceRequestDescriptor>, raw: ArcGisServiceRequestDescriptor, active: boolean, now: number): void {
    const item = this.validate(raw); if (target.has(item.requestId) || other.has(item.requestId)) throw new Error('duplicate request id in snapshot');
    if (item.enqueuedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future request state');
    if (!active && now - item.enqueuedAtMs > this.policy.maxQueueAgeMs) return;
    if (item.estimatedBytes > this.policy.maxEstimatedBytes || item.estimatedFeatures > this.policy.maxEstimatedFeatures) throw new Error('snapshot request exceeds budget');
    target.set(item.requestId, item);
  }
  private validate(raw: ArcGisServiceRequestDescriptor): ArcGisServiceRequestDescriptor {
    const requestId = key(raw.requestId,128,'request id'); const serviceKey = key(raw.serviceKey,this.policy.maxServiceKeyLength,'service key');
    if (raw.priority !== 'interactive' && raw.priority !== 'foreground' && raw.priority !== 'background') throw new Error('invalid request priority');
    return freezeDescriptor({ requestId, serviceKey, priority: raw.priority, estimatedBytes: nonNegative(raw.estimatedBytes,'estimatedBytes'), estimatedFeatures: nonNegative(raw.estimatedFeatures,'estimatedFeatures'), enqueuedAtMs: nonNegative(raw.enqueuedAtMs,'enqueuedAtMs') });
  }
  private promote(): readonly ArcGisServiceRequestDescriptor[] {
    const promoted: ArcGisServiceRequestDescriptor[] = [];
    for (const candidate of this.sortedQueue()) {
      if (this.active.size >= this.policy.maxConcurrentGlobal) break;
      if (!this.canRun(candidate.serviceKey)) continue;
      this.queued.delete(candidate.requestId); this.active.set(candidate.requestId,candidate); promoted.push(candidate); this.generation += 1;
    }
    return Object.freeze(promoted.map(freezeDescriptor));
  }
  private sortedQueue(): ArcGisServiceRequestDescriptor[] { return [...this.queued.values()].sort((a,b) => priorityRank(a.priority)-priorityRank(b.priority) || a.enqueuedAtMs-b.enqueuedAtMs || a.requestId.localeCompare(b.requestId)); }
  private canRun(serviceKey: string): boolean { return this.active.size < this.policy.maxConcurrentGlobal && this.count(this.active,serviceKey) < this.policy.maxConcurrentPerService; }
  private count(source: Map<string,ArcGisServiceRequestDescriptor>, serviceKey: string): number { let count=0; for (const item of source.values()) if (item.serviceKey===serviceKey) count+=1; return count; }
  private serviceCount(serviceKey: string): number { return this.count(this.active,serviceKey)+this.count(this.queued,serviceKey); }
  private distinctServices(): number { return new Set([...this.active.values(),...this.queued.values()].map(item=>item.serviceKey)).size; }
  private admission(item: ArcGisServiceRequestDescriptor, admitted: boolean, reason: ArcGisServiceRequestAdmission['reason']): ArcGisServiceRequestAdmission { return Object.freeze({requestId:item.requestId,serviceKey:item.serviceKey,admitted,reason}); }
  private prune(now: number): void { let changed=false; for (const [id,item] of this.queued) if (now>item.enqueuedAtMs && now-item.enqueuedAtMs>this.policy.maxQueueAgeMs) { this.queued.delete(id); changed=true; } if (changed) this.generation+=1; }
  private time(value: number): number { const now=nonNegative(value,'timestampMs'); if (now+this.policy.maxClockSkewMs<this.lastObservedAtMs) throw new Error('stale request-budget clock'); this.lastObservedAtMs=Math.max(this.lastObservedAtMs,now); return now; }
  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisServiceRequestBudgetCoordinator is disposed'); }
}
