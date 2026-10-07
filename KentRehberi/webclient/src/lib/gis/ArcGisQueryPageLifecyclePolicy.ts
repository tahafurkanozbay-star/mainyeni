export type ArcGisPageIntent = "interactive" | "visible" | "background";

export interface ArcGisQueryPageRequest {
  requestId: string;
  layerId: string;
  revision: number;
  signature: string;
  offset: number;
  pageSize: number;
  intent: ArcGisPageIntent;
  now: number;
}

export interface ArcGisQueryPageLease {
  requestId: string;
  layerId: string;
  revision: number;
  signature: string;
  offset: number;
  pageSize: number;
  expiresAt: number;
}

export interface ArcGisQueryPageResult {
  requestId: string;
  featureCount: number;
  exceededTransferLimit: boolean;
  actualBytes: number;
  now: number;
}

export interface ArcGisQueryPagePolicyOptions {
  maxConcurrent: number;
  maxConcurrentPerLayer: number;
  maxQueued: number;
  maxResidentPages: number;
  maxResidentBytes: number;
  queueTtlMs: number;
  leaseTtlMs: number;
  residentTtlMs: number;
}

type Queued = ArcGisQueryPageRequest & { sequence: number };
type Running = Queued & { expiresAt: number };
type Resident = {
  key: string; layerId: string; revision: number; signature: string; offset: number;
  pageSize: number; featureCount: number; exceededTransferLimit: boolean;
  actualBytes: number; touchedAt: number; expiresAt: number; sequence: number;
};

const rank: Record<ArcGisPageIntent, number> = { interactive: 0, visible: 1, background: 2 };
const finiteInt = (value: number, name: string, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`);
  return value;
};
const nonEmpty = (value: string, name: string) => {
  const v = value.trim();
  if (!v) throw new Error(`${name} must be non-empty`);
  return v;
};

export class ArcGisQueryPageLifecyclePolicy {
  private readonly options: ArcGisQueryPagePolicyOptions;
  private readonly revisions = new Map<string, number>();
  private readonly queued = new Map<string, Queued>();
  private readonly running = new Map<string, Running>();
  private readonly resident = new Map<string, Resident>();
  private sequence = 0;
  private disposed = false;

  constructor(options: ArcGisQueryPagePolicyOptions) {
    this.options = {
      maxConcurrent: finiteInt(options.maxConcurrent, "maxConcurrent", 1),
      maxConcurrentPerLayer: finiteInt(options.maxConcurrentPerLayer, "maxConcurrentPerLayer", 1),
      maxQueued: finiteInt(options.maxQueued, "maxQueued", 1),
      maxResidentPages: finiteInt(options.maxResidentPages, "maxResidentPages", 1),
      maxResidentBytes: finiteInt(options.maxResidentBytes, "maxResidentBytes", 1),
      queueTtlMs: finiteInt(options.queueTtlMs, "queueTtlMs", 1),
      leaseTtlMs: finiteInt(options.leaseTtlMs, "leaseTtlMs", 1),
      residentTtlMs: finiteInt(options.residentTtlMs, "residentTtlMs", 1),
    };
  }

  setRevision(layerId: string, revision: number): void {
    this.assertActive();
    const layer = nonEmpty(layerId, "layerId");
    finiteInt(revision, "revision");
    const current = this.revisions.get(layer);
    if (current !== undefined && revision < current) throw new Error("revision must be monotonic");
    if (current === revision) return;
    this.revisions.set(layer, revision);
    this.invalidateLayer(layer);
  }

  enqueue(request: ArcGisQueryPageRequest): "queued" | "deduped" {
    this.assertActive();
    this.sweep(request.now);
    const normalized = this.normalize(request);
    this.assertRevision(normalized.layerId, normalized.revision);
    const existing = this.findLogical(normalized);
    if (existing) return "deduped";
    if (this.queued.size >= this.options.maxQueued) this.evictQueued();
    this.queued.set(normalized.requestId, { ...normalized, sequence: this.sequence++ });
    return "queued";
  }

  acquire(now: number): ArcGisQueryPageLease | undefined {
    this.assertActive();
    finiteInt(now, "now");
    this.sweep(now);
    if (this.running.size >= this.options.maxConcurrent) return undefined;
    const candidates = [...this.queued.values()]
      .filter(q => this.runningForLayer(q.layerId) < this.options.maxConcurrentPerLayer)
      .sort((a, b) => rank[a.intent] - rank[b.intent] || a.sequence - b.sequence);
    const next = candidates[0];
    if (!next) return undefined;
    this.queued.delete(next.requestId);
    const expiresAt = now + this.options.leaseTtlMs;
    this.running.set(next.requestId, { ...next, expiresAt });
    return Object.freeze({
      requestId: next.requestId, layerId: next.layerId, revision: next.revision,
      signature: next.signature, offset: next.offset, pageSize: next.pageSize, expiresAt,
    });
  }

  renew(requestId: string, now: number): ArcGisQueryPageLease {
    this.assertActive();
    finiteInt(now, "now");
    this.sweep(now);
    const id = nonEmpty(requestId, "requestId");
    const item = this.running.get(id);
    if (!item) throw new Error("request is not running");
    item.expiresAt = now + this.options.leaseTtlMs;
    return Object.freeze({
      requestId: item.requestId, layerId: item.layerId, revision: item.revision,
      signature: item.signature, offset: item.offset, pageSize: item.pageSize, expiresAt: item.expiresAt,
    });
  }

  complete(result: ArcGisQueryPageResult): void {
    this.assertActive();
    finiteInt(result.now, "now");
    finiteInt(result.featureCount, "featureCount");
    finiteInt(result.actualBytes, "actualBytes");
    this.sweep(result.now);
    const item = this.running.get(nonEmpty(result.requestId, "requestId"));
    if (!item) throw new Error("request is not running");
    this.running.delete(item.requestId);
    this.assertRevision(item.layerId, item.revision);
    const key = this.logicalKey(item);
    this.resident.set(key, {
      key, layerId: item.layerId, revision: item.revision, signature: item.signature,
      offset: item.offset, pageSize: item.pageSize, featureCount: result.featureCount,
      exceededTransferLimit: result.exceededTransferLimit, actualBytes: result.actualBytes,
      touchedAt: result.now, expiresAt: result.now + this.options.residentTtlMs, sequence: this.sequence++,
    });
    this.trimResidents();
  }

  lookup(layerId: string, revision: number, signature: string, offset: number, pageSize: number, now: number) {
    this.assertActive();
    this.sweep(now);
    const key = this.logicalKey({ layerId: nonEmpty(layerId,"layerId"), revision, signature: nonEmpty(signature,"signature"), offset, pageSize });
    const item = this.resident.get(key);
    if (!item) return undefined;
    item.touchedAt = now;
    item.expiresAt = now + this.options.residentTtlMs;
    return Object.freeze({ featureCount: item.featureCount, exceededTransferLimit: item.exceededTransferLimit });
  }

  cancel(requestId: string): boolean {
    this.assertActive();
    const id = nonEmpty(requestId, "requestId");
    return this.queued.delete(id) || this.running.delete(id);
  }

  releaseLayer(layerId: string): void {
    this.assertActive();
    const layer = nonEmpty(layerId, "layerId");
    this.invalidateLayer(layer);
    this.revisions.delete(layer);
  }

  snapshot(now: number) {
    this.assertActive();
    this.sweep(now);
    const residentBytes = [...this.resident.values()].reduce((sum, x) => sum + x.actualBytes, 0);
    return Object.freeze({ queued: this.queued.size, running: this.running.size, resident: this.resident.size, residentBytes });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queued.clear(); this.running.clear(); this.resident.clear(); this.revisions.clear();
  }

  private normalize(r: ArcGisQueryPageRequest): ArcGisQueryPageRequest {
    return {
      ...r, requestId: nonEmpty(r.requestId,"requestId"), layerId: nonEmpty(r.layerId,"layerId"),
      signature: nonEmpty(r.signature,"signature"), revision: finiteInt(r.revision,"revision"),
      offset: finiteInt(r.offset,"offset"), pageSize: finiteInt(r.pageSize,"pageSize",1),
      now: finiteInt(r.now,"now"),
    };
  }
  private logicalKey(x: {layerId:string;revision:number;signature:string;offset:number;pageSize:number}) {
    return JSON.stringify([x.layerId,x.revision,x.signature,x.offset,x.pageSize]);
  }
  private findLogical(r: ArcGisQueryPageRequest) {
    const key=this.logicalKey(r);
    return [...this.queued.values(),...this.running.values()].some(x=>this.logicalKey(x)===key)||this.resident.has(key);
  }
  private assertRevision(layerId:string, revision:number) {
    const current=this.revisions.get(layerId);
    if(current===undefined) this.revisions.set(layerId,revision);
    else if(current!==revision) throw new Error("stale layer revision");
  }
  private runningForLayer(layerId:string) { return [...this.running.values()].filter(x=>x.layerId===layerId).length; }
  private evictQueued() {
    const victim=[...this.queued.values()].sort((a,b)=>rank[b.intent]-rank[a.intent]||a.sequence-b.sequence)[0];
    if(victim) this.queued.delete(victim.requestId);
  }
  private invalidateLayer(layerId:string) {
    for(const [id,x] of this.queued) if(x.layerId===layerId) this.queued.delete(id);
    for(const [id,x] of this.running) if(x.layerId===layerId) this.running.delete(id);
    for(const [id,x] of this.resident) if(x.layerId===layerId) this.resident.delete(id);
  }
  private sweep(now:number) {
    finiteInt(now,"now");
    for(const [id,x] of this.queued) if(now-x.now>=this.options.queueTtlMs) this.queued.delete(id);
    for(const [id,x] of this.running) if(now>=x.expiresAt) this.running.delete(id);
    for(const [id,x] of this.resident) if(now>=x.expiresAt) this.resident.delete(id);
  }
  private trimResidents() {
    const order=()=>[...this.resident.values()].sort((a,b)=>a.touchedAt-b.touchedAt||a.sequence-b.sequence);
    while(this.resident.size>this.options.maxResidentPages) this.resident.delete(order()[0]!.key);
    while([...this.resident.values()].reduce((s,x)=>s+x.actualBytes,0)>this.options.maxResidentBytes && this.resident.size)
      this.resident.delete(order()[0]!.key);
  }
  private assertActive() { if(this.disposed) throw new Error("policy is disposed"); }
}
