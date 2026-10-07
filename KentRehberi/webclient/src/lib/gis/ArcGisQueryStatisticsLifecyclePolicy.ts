export type ArcGisStatisticsIntent = "interactive" | "visible" | "background";

export interface ArcGisStatisticsBudget {
  maxLayers: number;
  maxQueued: number;
  maxRunning: number;
  maxRunningPerLayer: number;
  maxResidentGroups: number;
  maxResidentBytes: number;
  queueTtlMs: number;
  leaseTtlMs: number;
  residentTtlMs: number;
}

export interface ArcGisStatisticsRequest {
  requestId: string;
  layerId: string;
  revision: number;
  signature: string;
  groupBySignature: string;
  statisticSignature: string;
  intent: ArcGisStatisticsIntent;
  queuedAt: number;
}

export interface ArcGisStatisticsLease {
  readonly requestId: string;
  readonly layerId: string;
  readonly revision: number;
  readonly signature: string;
  readonly groupBySignature: string;
  readonly statisticSignature: string;
  readonly intent: ArcGisStatisticsIntent;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export interface ArcGisStatisticsCompletion {
  requestId: string;
  revision: number;
  groupCount: number;
  actualBytes: number;
  completedAt: number;
}

export interface ArcGisStatisticsResident {
  readonly requestId: string;
  readonly layerId: string;
  readonly revision: number;
  readonly signature: string;
  readonly groupBySignature: string;
  readonly statisticSignature: string;
  readonly groupCount: number;
  readonly actualBytes: number;
  readonly capturedAt: number;
  readonly expiresAt: number;
}

type Queued = ArcGisStatisticsRequest & { sequence: number; expiresAt: number };
type Running = Queued & { startedAt: number; leaseExpiresAt: number };
type Resident = {
  requestId: string; layerId: string; revision: number; signature: string;
  groupBySignature: string; statisticSignature: string; groupCount: number;
  actualBytes: number; capturedAt: number; expiresAt: number; touchedAt: number; sequence: number;
};

const rank: Readonly<Record<ArcGisStatisticsIntent, number>> = Object.freeze({
  interactive: 2, visible: 1, background: 0,
});
const validIntents: readonly ArcGisStatisticsIntent[] = ["interactive", "visible", "background"];

function identity(name: string, value: string, max = 2048): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}
function natural(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function timestamp(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

export class ArcGisQueryStatisticsLifecyclePolicy {
  readonly #budget: Readonly<ArcGisStatisticsBudget>;
  readonly #revisions = new Map<string, number>();
  readonly #queued = new Map<string, Queued>();
  readonly #running = new Map<string, Running>();
  readonly #resident = new Map<string, Resident>();
  #sequence = 0;
  #disposed = false;

  constructor(budget: ArcGisStatisticsBudget) {
    for (const key of ["maxLayers","maxQueued","maxRunning","maxRunningPerLayer","maxResidentGroups","maxResidentBytes"] as const) {
      positive(key, budget[key]);
    }
    for (const key of ["queueTtlMs","leaseTtlMs","residentTtlMs"] as const) positive(key, budget[key]);
    if (budget.maxRunningPerLayer > budget.maxRunning) throw new Error("maxRunningPerLayer cannot exceed maxRunning");
    this.#budget = Object.freeze({ ...budget });
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive();
    const layer = identity("layerId", layerId, 512);
    natural("revision", revision);
    const current = this.#revisions.get(layer);
    if (current !== undefined && revision < current) return -1;
    if (current === revision) return 0;
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) throw new Error("maxLayers exceeded");
    this.#revisions.set(layer, revision);
    let removed = 0;
    for (const map of [this.#queued, this.#running, this.#resident]) {
      for (const [key, item] of map) {
        if (item.layerId === layer && item.revision !== revision) { map.delete(key); removed += 1; }
      }
    }
    return removed;
  }

  enqueue(request: ArcGisStatisticsRequest): "queued" | "deduped" | "rejected" {
    this.#assertLive();
    const item = this.#normalize(request);
    this.expire(item.queuedAt);
    if (this.#revisions.get(item.layerId) !== item.revision) return "rejected";
    const collision = this.#find(item.requestId);
    if (collision) {
      return this.#sameLogical(collision, item) ? "deduped" : "rejected";
    }
    if (this.#hasLogical(item)) return "deduped";
    if (this.#queued.size >= this.#budget.maxQueued && !this.#evictQueued(item.intent)) return "rejected";
    this.#queued.set(item.requestId, {
      ...item, sequence: ++this.#sequence, expiresAt: item.queuedAt + this.#budget.queueTtlMs,
    });
    return "queued";
  }

  acquire(now: number): ArcGisStatisticsLease | null {
    this.#assertLive();
    timestamp("now", now);
    this.expire(now);
    if (this.#running.size >= this.#budget.maxRunning) return null;
    const candidate = [...this.#queued.values()]
      .filter((item) => this.#runningForLayer(item.layerId) < this.#budget.maxRunningPerLayer)
      .sort((a,b) => rank[b.intent]-rank[a.intent] || a.sequence-b.sequence || a.requestId.localeCompare(b.requestId))[0];
    if (!candidate) return null;
    this.#queued.delete(candidate.requestId);
    const running: Running = { ...candidate, startedAt: now, leaseExpiresAt: now + this.#budget.leaseTtlMs };
    this.#running.set(running.requestId, running);
    return this.#lease(running);
  }

  renew(requestId: string, revision: number, now: number): ArcGisStatisticsLease | null {
    this.#assertLive();
    const key = identity("requestId", requestId, 512);
    natural("revision", revision); timestamp("now", now);
    const running = this.#running.get(key);
    if (!running || running.revision !== revision || this.#revisions.get(running.layerId) !== revision || now >= running.leaseExpiresAt) return null;
    running.leaseExpiresAt = now + this.#budget.leaseTtlMs;
    return this.#lease(running);
  }

  complete(completion: ArcGisStatisticsCompletion): ArcGisStatisticsResident | null {
    this.#assertLive();
    const key = identity("requestId", completion.requestId, 512);
    natural("revision", completion.revision); natural("groupCount", completion.groupCount);
    natural("actualBytes", completion.actualBytes); timestamp("completedAt", completion.completedAt);
    const running = this.#running.get(key);
    if (!running || running.revision !== completion.revision ||
        this.#revisions.get(running.layerId) !== completion.revision ||
        completion.completedAt >= running.leaseExpiresAt) return null;
    this.#running.delete(key);
    const resident: Resident = {
      requestId: key, layerId: running.layerId, revision: running.revision, signature: running.signature,
      groupBySignature: running.groupBySignature, statisticSignature: running.statisticSignature,
      groupCount: completion.groupCount, actualBytes: completion.actualBytes, capturedAt: completion.completedAt,
      expiresAt: completion.completedAt + this.#budget.residentTtlMs, touchedAt: completion.completedAt,
      sequence: running.sequence,
    };
    this.#resident.set(this.#logicalKey(resident), resident);
    this.#applyPressure(this.#logicalKey(resident));
    return this.#view(resident);
  }

  lookup(layerId: string, revision: number, signature: string, groupBySignature: string, statisticSignature: string, now: number): ArcGisStatisticsResident | null {
    this.#assertLive();
    const probe = {
      layerId: identity("layerId", layerId, 512), revision: natural("revision", revision),
      signature: identity("signature", signature), groupBySignature: identity("groupBySignature", groupBySignature),
      statisticSignature: identity("statisticSignature", statisticSignature),
    };
    timestamp("now", now);
    this.expire(now);
    if (this.#revisions.get(probe.layerId) !== revision) return null;
    const resident = this.#resident.get(this.#logicalKey(probe));
    if (!resident) return null;
    resident.touchedAt = now;
    resident.expiresAt = now + this.#budget.residentTtlMs;
    return this.#view(resident);
  }

  cancel(requestId: string): boolean {
    this.#assertLive();
    const key = identity("requestId", requestId, 512);
    return this.#queued.delete(key) || this.#running.delete(key);
  }

  releaseLayer(layerId: string): number {
    this.#assertLive();
    const layer = identity("layerId", layerId, 512);
    let removed = 0;
    for (const map of [this.#queued, this.#running, this.#resident]) {
      for (const [key,item] of map) if (item.layerId === layer) { map.delete(key); removed += 1; }
    }
    this.#revisions.delete(layer);
    return removed;
  }

  expire(now: number): number {
    this.#assertLive(); timestamp("now", now);
    let removed = 0;
    for (const [key,item] of this.#queued) if (now >= item.expiresAt) { this.#queued.delete(key); removed += 1; }
    for (const [key,item] of this.#running) if (now >= item.leaseExpiresAt) { this.#running.delete(key); removed += 1; }
    for (const [key,item] of this.#resident) if (now >= item.expiresAt) { this.#resident.delete(key); removed += 1; }
    return removed;
  }

  snapshot() {
    this.#assertLive();
    let residentBytes = 0, residentGroups = 0;
    for (const item of this.#resident.values()) { residentBytes += item.actualBytes; residentGroups += item.groupCount; }
    return Object.freeze({ layers:this.#revisions.size, queued:this.#queued.size, running:this.#running.size,
      resident:this.#resident.size, residentGroups, residentBytes });
  }

  fingerprint(): string {
    this.#assertLive();
    return [
      ...[...this.#queued.values()].map(x=>`q:${x.layerId}:${x.revision}:${x.signature}:${x.groupBySignature}:${x.statisticSignature}`),
      ...[...this.#running.values()].map(x=>`r:${x.layerId}:${x.revision}:${x.signature}:${x.groupBySignature}:${x.statisticSignature}`),
      ...[...this.#resident.values()].map(x=>`c:${x.layerId}:${x.revision}:${x.signature}:${x.groupBySignature}:${x.statisticSignature}:${x.groupCount}:${x.actualBytes}`),
    ].sort().join("|");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#queued.clear(); this.#running.clear(); this.#resident.clear(); this.#revisions.clear(); this.#disposed = true;
  }

  #normalize(request: ArcGisStatisticsRequest): ArcGisStatisticsRequest {
    if (!validIntents.includes(request.intent)) throw new Error("intent is invalid");
    return { requestId:identity("requestId",request.requestId,512), layerId:identity("layerId",request.layerId,512),
      revision:natural("revision",request.revision), signature:identity("signature",request.signature),
      groupBySignature:identity("groupBySignature",request.groupBySignature),
      statisticSignature:identity("statisticSignature",request.statisticSignature),
      intent:request.intent, queuedAt:timestamp("queuedAt",request.queuedAt) };
  }
  #sameLogical(a:{layerId:string;revision:number;signature:string;groupBySignature:string;statisticSignature:string}, b:{layerId:string;revision:number;signature:string;groupBySignature:string;statisticSignature:string}) {
    return a.layerId===b.layerId && a.revision===b.revision && a.signature===b.signature &&
      a.groupBySignature===b.groupBySignature && a.statisticSignature===b.statisticSignature;
  }
  #logicalKey(x:{layerId:string;revision:number;signature:string;groupBySignature:string;statisticSignature:string}) {
    return JSON.stringify([x.layerId,x.revision,x.signature,x.groupBySignature,x.statisticSignature]);
  }
  #find(key:string): Queued|Running|Resident|undefined { return this.#queued.get(key) ?? this.#running.get(key) ?? [...this.#resident.values()].find(x=>x.requestId===key); }
  #hasLogical(item:ArcGisStatisticsRequest) {
    const key=this.#logicalKey(item);
    return [...this.#queued.values(),...this.#running.values()].some(x=>this.#logicalKey(x)===key) || this.#resident.has(key);
  }
  #runningForLayer(layer:string) { let n=0; for(const x of this.#running.values()) if(x.layerId===layer)n++; return n; }
  #evictQueued(intent:ArcGisStatisticsIntent) {
    const victim=[...this.#queued.values()].filter(x=>rank[x.intent]<=rank[intent])
      .sort((a,b)=>rank[a.intent]-rank[b.intent] || a.sequence-b.sequence || a.requestId.localeCompare(b.requestId))[0];
    if(!victim)return false; this.#queued.delete(victim.requestId); return true;
  }
  #applyPressure(protectedKey:string) {
    const totals=()=>{let groups=0,bytes=0;for(const x of this.#resident.values()){groups+=x.groupCount;bytes+=x.actualBytes}return{groups,bytes}};
    for (;;) {
      const t=totals();
      if(t.groups<=this.#budget.maxResidentGroups && t.bytes<=this.#budget.maxResidentBytes)return;
      const victim=[...this.#resident.entries()].filter(([key])=>key!==protectedKey)
        .sort((a,b)=>a[1].touchedAt-b[1].touchedAt || a[1].sequence-b[1].sequence || a[0].localeCompare(b[0]))[0];
      if(!victim){this.#resident.delete(protectedKey);return} this.#resident.delete(victim[0]);
    }
  }
  #lease(x:Running):ArcGisStatisticsLease { return Object.freeze({requestId:x.requestId,layerId:x.layerId,revision:x.revision,
    signature:x.signature,groupBySignature:x.groupBySignature,statisticSignature:x.statisticSignature,intent:x.intent,startedAt:x.startedAt,expiresAt:x.leaseExpiresAt}); }
  #view(x:Resident):ArcGisStatisticsResident { return Object.freeze({requestId:x.requestId,layerId:x.layerId,revision:x.revision,
    signature:x.signature,groupBySignature:x.groupBySignature,statisticSignature:x.statisticSignature,groupCount:x.groupCount,
    actualBytes:x.actualBytes,capturedAt:x.capturedAt,expiresAt:x.expiresAt}); }
  #assertLive(){if(this.#disposed)throw new Error("ArcGisQueryStatisticsLifecyclePolicy is disposed")}
}
