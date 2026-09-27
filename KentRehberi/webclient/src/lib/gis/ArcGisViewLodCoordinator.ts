export type ArcGisLodViewMode = '2d' | '3d';
export type ArcGisLodWorkload = 'critical' | 'visible' | 'background';

export interface ArcGisViewLodPolicy {
  readonly maxLayers: number;
  readonly maxFeatureBudget: number;
  readonly maxDrawCalls: number;
  readonly maxGpuBytes: number;
  readonly maxLevel: number;
  readonly pressureHighWatermark: number;
  readonly pressureLowWatermark: number;
  readonly recoveryFrames: number;
}

export interface ArcGisViewLodRequest {
  readonly layerId: string;
  readonly viewMode: ArcGisLodViewMode;
  readonly workload: ArcGisLodWorkload;
  readonly desiredLevel: number;
  readonly minLevel: number;
  readonly estimatedFeatures: number;
  readonly estimatedDrawCalls: number;
  readonly estimatedGpuBytes: number;
}

export interface ArcGisViewLodSnapshot extends ArcGisViewLodRequest {
  readonly effectiveLevel: number;
  readonly generation: number;
  readonly admittedAt: number;
  readonly lastUpdatedAt: number;
  readonly degraded: boolean;
}

interface MutableLod extends ArcGisViewLodRequest {
  effectiveLevel: number;
  generation: number;
  admittedAt: number;
  lastUpdatedAt: number;
  degraded: boolean;
}

const RANK: Readonly<Record<ArcGisLodWorkload, number>> = Object.freeze({ critical: 3, visible: 2, background: 1 });

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be within (0, 1]`);
  return value;
}
function layerId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error('layerId must contain 1..256 characters');
  return normalized;
}
function snap(entry: MutableLod): ArcGisViewLodSnapshot { return Object.freeze({ ...entry }); }

export class ArcGisViewLodCoordinator {
  private readonly policy: ArcGisViewLodPolicy;
  private readonly layers = new Map<string, MutableLod>();
  private generation = 1;
  private recoveryCounter = 0;
  private disposed = false;

  constructor(policy: ArcGisViewLodPolicy) {
    const high = ratio(policy.pressureHighWatermark, 'pressureHighWatermark');
    const low = ratio(policy.pressureLowWatermark, 'pressureLowWatermark');
    if (low >= high) throw new Error('pressureLowWatermark must be lower than pressureHighWatermark');
    this.policy = Object.freeze({
      maxLayers: positive(policy.maxLayers, 'maxLayers'),
      maxFeatureBudget: positive(policy.maxFeatureBudget, 'maxFeatureBudget'),
      maxDrawCalls: positive(policy.maxDrawCalls, 'maxDrawCalls'),
      maxGpuBytes: positive(policy.maxGpuBytes, 'maxGpuBytes'),
      maxLevel: nonNegative(policy.maxLevel, 'maxLevel'),
      pressureHighWatermark: high,
      pressureLowWatermark: low,
      recoveryFrames: positive(policy.recoveryFrames, 'recoveryFrames'),
    });
  }

  upsert(request: ArcGisViewLodRequest, nowInput: number): ArcGisViewLodSnapshot {
    this.assertUsable();
    const now = nonNegative(nowInput, 'now');
    const normalized = this.normalize(request);
    const existing = this.layers.get(normalized.layerId);
    if (!existing && this.layers.size >= this.policy.maxLayers) this.evictOne(normalized.workload);
    if (!existing && this.layers.size >= this.policy.maxLayers) throw new Error('LOD layer capacity exhausted');
    if (existing && existing.viewMode !== normalized.viewMode) throw new Error('layer viewMode cannot change without removal');
    const entry: MutableLod = existing ?? { ...normalized, effectiveLevel: normalized.desiredLevel, generation: this.generation++, admittedAt: now, lastUpdatedAt: now, degraded: false };
    Object.assign(entry, normalized);
    entry.lastUpdatedAt = now;
    entry.effectiveLevel = Math.min(entry.effectiveLevel, entry.desiredLevel);
    this.layers.set(entry.layerId, entry);
    this.rebalance();
    return snap(entry);
  }

  remove(layerIdInput: string): ArcGisViewLodSnapshot | null {
    this.assertUsable();
    const id = layerId(layerIdInput);
    const entry = this.layers.get(id);
    if (!entry) return null;
    this.layers.delete(id);
    return snap(entry);
  }

  recordFrame(nowInput: number): readonly ArcGisViewLodSnapshot[] {
    this.assertUsable();
    const now = nonNegative(nowInput, 'now');
    const pressure = this.pressure();
    if (pressure >= this.policy.pressureHighWatermark) {
      this.recoveryCounter = 0;
      this.degradeOne(now);
    } else if (pressure <= this.policy.pressureLowWatermark) {
      this.recoveryCounter += 1;
      if (this.recoveryCounter >= this.policy.recoveryFrames) {
        this.recoveryCounter = 0;
        this.recoverOne(now);
      }
    } else {
      this.recoveryCounter = 0;
    }
    this.rebalance();
    return this.list();
  }

  get(layerIdInput: string): ArcGisViewLodSnapshot | null {
    this.assertUsable();
    const entry = this.layers.get(layerId(layerIdInput));
    return entry ? snap(entry) : null;
  }

  list(viewMode?: ArcGisLodViewMode): readonly ArcGisViewLodSnapshot[] {
    this.assertUsable();
    if (viewMode !== undefined && viewMode !== '2d' && viewMode !== '3d') throw new Error('invalid viewMode');
    return Object.freeze([...this.layers.values()].filter(x => viewMode === undefined || x.viewMode === viewMode).sort((a,b) => a.layerId.localeCompare(b.layerId)).map(snap));
  }

  budgetSnapshot(): Readonly<{layers:number;features:number;drawCalls:number;gpuBytes:number;pressure:number}> {
    this.assertUsable();
    let features=0, drawCalls=0, gpuBytes=0;
    for (const entry of this.layers.values()) {
      const factor = this.factor(entry);
      features += Math.ceil(entry.estimatedFeatures * factor);
      drawCalls += Math.ceil(entry.estimatedDrawCalls * factor);
      gpuBytes += Math.ceil(entry.estimatedGpuBytes * factor);
    }
    return Object.freeze({ layers:this.layers.size, features, drawCalls, gpuBytes, pressure:Math.max(features/this.policy.maxFeatureBudget, drawCalls/this.policy.maxDrawCalls, gpuBytes/this.policy.maxGpuBytes) });
  }

  dispose(): void { if (this.disposed) return; this.disposed=true; this.layers.clear(); this.recoveryCounter=0; }

  private normalize(request: ArcGisViewLodRequest): ArcGisViewLodRequest {
    const id=layerId(request.layerId);
    if (request.viewMode !== '2d' && request.viewMode !== '3d') throw new Error('invalid viewMode');
    if (!(request.workload in RANK)) throw new Error('invalid workload');
    const desired=nonNegative(request.desiredLevel,'desiredLevel');
    const min=nonNegative(request.minLevel,'minLevel');
    if (desired > this.policy.maxLevel || min > desired) throw new Error('invalid LOD level range');
    const features=positive(request.estimatedFeatures,'estimatedFeatures');
    const draws=positive(request.estimatedDrawCalls,'estimatedDrawCalls');
    const gpu=nonNegative(request.estimatedGpuBytes,'estimatedGpuBytes');
    if (features > this.policy.maxFeatureBudget || draws > this.policy.maxDrawCalls || gpu > this.policy.maxGpuBytes) throw new Error('single layer exceeds LOD budget');
    return Object.freeze({layerId:id,viewMode:request.viewMode,workload:request.workload,desiredLevel:desired,minLevel:min,estimatedFeatures:features,estimatedDrawCalls:draws,estimatedGpuBytes:gpu});
  }

  private factor(entry: MutableLod): number {
    if (entry.desiredLevel === entry.minLevel) return 1;
    const span=entry.desiredLevel-entry.minLevel;
    return 0.25 + 0.75*((entry.effectiveLevel-entry.minLevel)/span);
  }
  private pressure(): number { return this.budgetSnapshot().pressure; }
  private rebalance(): void {
    let guard=this.layers.size*(this.policy.maxLevel+1)+1;
    while (this.pressure()>1 && guard-- > 0) {
      const changed=this.degradeOne(0);
      if (!changed) break;
    }
    if (this.pressure()>1) throw new Error('LOD budgets cannot satisfy minimum layer levels');
  }
  private degradeOne(now:number): boolean {
    const candidate=[...this.layers.values()].filter(x=>x.effectiveLevel>x.minLevel).sort((a,b)=>RANK[a.workload]-RANK[b.workload] || b.effectiveLevel-a.effectiveLevel || a.lastUpdatedAt-b.lastUpdatedAt || a.layerId.localeCompare(b.layerId))[0];
    if (!candidate) return false;
    candidate.effectiveLevel-=1; candidate.degraded=true; if(now>candidate.lastUpdatedAt) candidate.lastUpdatedAt=now; return true;
  }
  private recoverOne(now:number): boolean {
    const candidate=[...this.layers.values()].filter(x=>x.effectiveLevel<x.desiredLevel).sort((a,b)=>RANK[b.workload]-RANK[a.workload] || a.effectiveLevel-b.effectiveLevel || a.layerId.localeCompare(b.layerId))[0];
    if (!candidate) return false;
    const previous=candidate.effectiveLevel; candidate.effectiveLevel+=1; candidate.degraded=candidate.effectiveLevel<candidate.desiredLevel;
    if (this.pressure()>this.policy.pressureHighWatermark) { candidate.effectiveLevel=previous; candidate.degraded=true; return false; }
    if(now>candidate.lastUpdatedAt) candidate.lastUpdatedAt=now; return true;
  }
  private evictOne(incoming: ArcGisLodWorkload): void {
    const candidate=[...this.layers.values()].filter(x=>RANK[x.workload]<RANK[incoming]).sort((a,b)=>RANK[a.workload]-RANK[b.workload] || a.lastUpdatedAt-b.lastUpdatedAt || a.layerId.localeCompare(b.layerId))[0];
    if(candidate) this.layers.delete(candidate.layerId);
  }
  private assertUsable():void { if(this.disposed) throw new Error('ArcGisViewLodCoordinator is disposed'); }
}
