export type ArcGisSnapViewMode = '2d' | '3d';
export type ArcGisSnapKind = 'vertex' | 'edge' | 'endpoint' | 'intersection';

export interface ArcGisSnapPoint { readonly x: number; readonly y: number; readonly z: number | null; readonly wkid: number; }
export interface ArcGisSnapCandidate {
  readonly id: string;
  readonly layerKey: string;
  readonly objectId: string | number;
  readonly kind: ArcGisSnapKind;
  readonly point: ArcGisSnapPoint;
  readonly distancePx: number;
  readonly observedAtMs: number;
}
export interface ArcGisSnappingPolicy {
  readonly maxCandidates: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly maxDistancePx: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}
export interface ArcGisSnappingSnapshot {
  readonly generation: number;
  readonly mode: ArcGisSnapViewMode;
  readonly activeId: string | null;
  readonly candidates: readonly ArcGisSnapCandidate[];
}

function positiveInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`); return value; }
function nonNegative(value: number, name: string): number { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`); return value; }
function text(value: string, max: number, name: string): string { const normalized = value.trim(); if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`); return normalized; }
function mode(value: ArcGisSnapViewMode): ArcGisSnapViewMode { if (value !== '2d' && value !== '3d') throw new Error('invalid snapping view mode'); return value; }
function kind(value: ArcGisSnapKind): ArcGisSnapKind { if (!['vertex','edge','endpoint','intersection'].includes(value)) throw new Error('invalid snapping kind'); return value; }
function objectId(value: string | number): string | number { if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('numeric objectId must be safe integer'); return value; } const normalized = value.trim(); if (!normalized || normalized.includes('\0')) throw new Error('invalid string objectId'); return normalized; }
function point(value: ArcGisSnapPoint): ArcGisSnapPoint { if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('snap coordinates must be finite'); if (value.z !== null && !Number.isFinite(value.z)) throw new Error('snap elevation must be finite or null'); if (!Number.isSafeInteger(value.wkid) || value.wkid <= 0) throw new Error('wkid must be positive safe integer'); return Object.freeze({ ...value }); }
function freezeCandidate(value: ArcGisSnapCandidate): ArcGisSnapCandidate { return Object.freeze({ ...value, point: point(value.point) }); }

/** Primitive-only snapping authority. ArcGIS Graphic/Geometry/LayerView handles remain external. */
export class ArcGisSnappingStateCoordinator {
  private readonly policy: ArcGisSnappingPolicy;
  private readonly candidates = new Map<string, ArcGisSnapCandidate>();
  private activeId: string | null = null;
  private currentMode: ArcGisSnapViewMode = '2d';
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisSnappingPolicy) {
    this.policy = Object.freeze({ maxCandidates: positiveInteger(policy.maxCandidates,'maxCandidates'), maxIdLength: positiveInteger(policy.maxIdLength,'maxIdLength'), maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength,'maxLayerKeyLength'), maxDistancePx: nonNegative(policy.maxDistancePx,'maxDistancePx'), retentionMs: positiveInteger(policy.retentionMs,'retentionMs'), maxClockSkewMs: positiveInteger(policy.maxClockSkewMs,'maxClockSkewMs') });
  }

  observe(input: Omit<ArcGisSnapCandidate,'observedAtMs'>, timestampMs: number): ArcGisSnapCandidate {
    this.assertUsable(); const now = nonNegative(timestampMs,'timestampMs'); this.prune(now);
    const id = text(input.id,this.policy.maxIdLength,'candidate id'); const existing = this.candidates.get(id);
    if (existing && now + this.policy.maxClockSkewMs < existing.observedAtMs) throw new Error('stale snapping observation rejected');
    const distancePx = nonNegative(input.distancePx,'distancePx'); if (distancePx > this.policy.maxDistancePx) throw new Error('snap candidate exceeds distance budget');
    const next = freezeCandidate({ id, layerKey: text(input.layerKey,this.policy.maxLayerKeyLength,'layerKey'), objectId: objectId(input.objectId), kind: kind(input.kind), point: point(input.point), distancePx, observedAtMs: now });
    this.candidates.set(id,next); this.enforceCapacity(id); this.generation += 1; return next;
  }

  selectBest(viewMode: ArcGisSnapViewMode, timestampMs: number): ArcGisSnapCandidate | null {
    this.assertUsable(); const now = nonNegative(timestampMs,'timestampMs'); this.prune(now); this.currentMode = mode(viewMode);
    const best = [...this.candidates.values()].sort((a,b) => a.distancePx-b.distancePx || b.observedAtMs-a.observedAtMs || a.id.localeCompare(b.id))[0] ?? null;
    const nextId = best?.id ?? null; if (this.activeId !== nextId) { this.activeId = nextId; this.generation += 1; } return best;
  }

  remove(id: string): boolean { this.assertUsable(); const key = text(id,this.policy.maxIdLength,'candidate id'); if (!this.candidates.delete(key)) return false; if (this.activeId === key) this.activeId = null; this.generation += 1; return true; }
  clear(): void { this.assertUsable(); if (!this.candidates.size && this.activeId === null) return; this.candidates.clear(); this.activeId = null; this.generation += 1; }
  snapshot(timestampMs: number): ArcGisSnappingSnapshot { this.assertUsable(); this.prune(nonNegative(timestampMs,'timestampMs')); const candidates = [...this.candidates.values()].sort((a,b)=>a.observedAtMs-b.observedAtMs || a.id.localeCompare(b.id)).map(freezeCandidate); return Object.freeze({ generation:this.generation, mode:this.currentMode, activeId:this.activeId, candidates:Object.freeze(candidates) }); }

  restore(snapshot: Pick<ArcGisSnappingSnapshot,'mode'|'activeId'|'candidates'>, timestampMs: number): void {
    this.assertUsable(); const now = nonNegative(timestampMs,'timestampMs'); if (!Array.isArray(snapshot.candidates) || snapshot.candidates.length > this.policy.maxCandidates) throw new Error('snapping snapshot exceeds capacity');
    const staged = new Map<string,ArcGisSnapCandidate>();
    for (const source of snapshot.candidates) { const id = text(source.id,this.policy.maxIdLength,'candidate id'); if (staged.has(id)) throw new Error('duplicate snapping candidate'); const observedAtMs = nonNegative(source.observedAtMs,'observedAtMs'); if (observedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future snapping candidate rejected'); if (now-observedAtMs > this.policy.retentionMs) continue; const distancePx=nonNegative(source.distancePx,'distancePx'); if (distancePx>this.policy.maxDistancePx) throw new Error('snap candidate exceeds distance budget'); staged.set(id,freezeCandidate({ id, layerKey:text(source.layerKey,this.policy.maxLayerKeyLength,'layerKey'), objectId:objectId(source.objectId), kind:kind(source.kind), point:point(source.point), distancePx, observedAtMs })); }
    let activeId:string|null=null; if (snapshot.activeId!==null) { activeId=text(snapshot.activeId,this.policy.maxIdLength,'active candidate id'); if (!staged.has(activeId)) throw new Error('active snapping candidate missing'); }
    this.candidates.clear(); for (const [key,value] of staged) this.candidates.set(key,value); this.currentMode=mode(snapshot.mode); this.activeId=activeId; this.generation += 1;
  }

  dispose(): void { if (this.disposed) return; this.disposed=true; this.candidates.clear(); this.activeId=null; }
  private prune(now:number):void { let changed=false; for (const [key,value] of this.candidates) { if (now-value.observedAtMs<=this.policy.retentionMs) continue; this.candidates.delete(key); if (this.activeId===key) this.activeId=null; changed=true; } if (changed) this.generation += 1; }
  private enforceCapacity(protectedId:string):void { while(this.candidates.size>this.policy.maxCandidates){ const victim=[...this.candidates.values()].filter(v=>v.id!==protectedId).sort((a,b)=>a.observedAtMs-b.observedAtMs || b.distancePx-a.distancePx || a.id.localeCompare(b.id))[0]; if(!victim) throw new Error('snapping capacity cannot be satisfied'); this.candidates.delete(victim.id); if(this.activeId===victim.id)this.activeId=null; } }
  private assertUsable():void { if(this.disposed) throw new Error('ArcGisSnappingStateCoordinator is disposed'); }
}
