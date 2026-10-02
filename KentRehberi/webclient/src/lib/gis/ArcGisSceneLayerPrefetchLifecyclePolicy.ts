export type ArcGisScenePrefetchIntent = 'visible' | 'navigation' | 'background'
export type ArcGisScenePrefetchPhase = 'queued' | 'loading' | 'resident'

export interface ArcGisScenePrefetchBudget {
  maxTiles: number
  maxTilesPerView: number
  maxLoading: number
  maxResident: number
  maxTrianglesPerTile: number
  maxEstimatedBytesPerTile: number
  maxAggregateResidentBytes: number
  queueTtlMs: number
  loadLeaseMs: number
  residentTtlMs: number
}
export interface ArcGisScenePrefetchRequest {
  viewId: string
  layerId: string
  tileId: string
  revision: number
  intent: ArcGisScenePrefetchIntent
  requestedAt: number
  lod: number
  estimatedTriangles: number
  estimatedBytes: number
}
export interface ArcGisScenePrefetchEntry extends ArcGisScenePrefetchRequest {
  phase: ArcGisScenePrefetchPhase
  sequence: number
  expiresAt: number
  actualBytes?: number
  actualTriangles?: number
}
const priority: Record<ArcGisScenePrefetchIntent, number> = { visible: 0, navigation: 1, background: 2 }
const safeId = /^[A-Za-z0-9_.:@/-]{1,180}$/
const positive = (value:number) => Number.isSafeInteger(value) && value > 0
const nonNegative = (value:number) => Number.isSafeInteger(value) && value >= 0

export class ArcGisSceneLayerPrefetchLifecyclePolicy {
  private readonly entries = new Map<string, ArcGisScenePrefetchEntry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0

  constructor(private readonly budget: ArcGisScenePrefetchBudget) {
    const values = [budget.maxTiles,budget.maxTilesPerView,budget.maxLoading,budget.maxResident,budget.maxTrianglesPerTile,budget.maxEstimatedBytesPerTile,budget.maxAggregateResidentBytes,budget.queueTtlMs,budget.loadLeaseMs,budget.residentTtlMs]
    if (!values.every(positive)) throw new RangeError('scene prefetch budgets must be positive safe integers')
    if (budget.maxTilesPerView > budget.maxTiles || budget.maxLoading > budget.maxTiles || budget.maxResident > budget.maxTiles) throw new RangeError('scene prefetch sub-budget exceeds aggregate')
  }

  enqueue(raw: ArcGisScenePrefetchRequest): boolean {
    const request = this.normalize(raw)
    if (!request) return false
    const watermark = this.revisions.get(request.viewId) ?? 0
    if (request.revision < watermark) return false
    const key = this.key(request.viewId, request.layerId, request.tileId)
    const existing = this.entries.get(key)
    if (existing && request.revision <= existing.revision) return false
    const perView = [...this.entries.values()].filter(entry => entry.viewId === request.viewId && this.key(entry.viewId,entry.layerId,entry.tileId) !== key).length
    if (perView >= this.budget.maxTilesPerView || (!existing && this.entries.size >= this.budget.maxTiles)) return false
    if (existing) this.entries.delete(key)
    this.revisions.set(request.viewId, Math.max(watermark, request.revision))
    this.entries.set(key, { ...request, phase:'queued', sequence:++this.sequence, expiresAt:request.requestedAt + this.budget.queueTtlMs })
    return true
  }

  takeNext(now:number): ArcGisScenePrefetchEntry | undefined {
    if (!Number.isFinite(now)) return undefined
    this.expire(now)
    if ([...this.entries.values()].filter(entry => entry.phase === 'loading').length >= this.budget.maxLoading) return undefined
    const next = [...this.entries.values()].filter(entry => entry.phase === 'queued').sort((a,b) => priority[a.intent]-priority[b.intent] || b.lod-a.lod || a.requestedAt-b.requestedAt || a.sequence-b.sequence)[0]
    if (!next) return undefined
    next.phase='loading'
    next.expiresAt=now+this.budget.loadLeaseMs
    return { ...next }
  }

  complete(viewId:string, layerId:string, tileId:string, revision:number, actualTriangles:number, actualBytes:number, now:number): boolean {
    const entry=this.get(viewId,layerId,tileId)
    if (!entry || entry.phase !== 'loading' || entry.revision !== revision || !nonNegative(actualTriangles) || !nonNegative(actualBytes) || !Number.isFinite(now)) return false
    const key=this.key(entry.viewId,entry.layerId,entry.tileId)
    if (now >= entry.expiresAt || revision < (this.revisions.get(entry.viewId) ?? 0)) { this.entries.delete(key); return false }
    if (actualTriangles > this.budget.maxTrianglesPerTile || actualBytes > this.budget.maxEstimatedBytesPerTile) { this.entries.delete(key); return false }
    const resident=[...this.entries.values()].filter(candidate => candidate.phase === 'resident')
    if (resident.length >= this.budget.maxResident || resident.reduce((sum,candidate)=>sum+(candidate.actualBytes??0),0)+actualBytes > this.budget.maxAggregateResidentBytes) { this.entries.delete(key); return false }
    entry.phase='resident'; entry.actualTriangles=actualTriangles; entry.actualBytes=actualBytes; entry.expiresAt=now+this.budget.residentTtlMs
    return true
  }

  touch(viewId:string,layerId:string,tileId:string,revision:number,now:number):boolean {
    const entry=this.get(viewId,layerId,tileId)
    if (!entry || entry.phase!=='resident' || entry.revision!==revision || !Number.isFinite(now) || now>=entry.expiresAt) return false
    entry.expiresAt=now+this.budget.residentTtlMs
    return true
  }

  consume(viewId:string,layerId:string,tileId:string,revision:number):boolean {
    const entry=this.get(viewId,layerId,tileId)
    return !!entry && entry.phase==='resident' && entry.revision===revision && this.entries.delete(this.key(entry.viewId,entry.layerId,entry.tileId))
  }

  cancel(viewId:string,layerId:string,tileId:string,revision:number):boolean {
    const entry=this.get(viewId,layerId,tileId)
    return !!entry && entry.revision===revision && this.entries.delete(this.key(entry.viewId,entry.layerId,entry.tileId))
  }

  invalidateView(viewId:string,revision:number):number {
    const id=viewId.trim()
    if (!safeId.test(id) || !positive(revision) || revision <= (this.revisions.get(id) ?? 0)) return 0
    this.revisions.set(id,revision)
    let removed=0
    for (const [key,entry] of this.entries) if (entry.viewId===id && entry.revision<revision) { this.entries.delete(key); removed++ }
    return removed
  }

  expire(now:number):number {
    if (!Number.isFinite(now)) return 0
    let removed=0
    for (const [key,entry] of this.entries) if (now>=entry.expiresAt) { this.entries.delete(key); removed++ }
    return removed
  }

  releaseLayer(viewId:string,layerId:string):number {
    const view=viewId.trim(),layer=layerId.trim()
    if (!safeId.test(view)||!safeId.test(layer)) return 0
    let removed=0
    for (const [key,entry] of this.entries) if (entry.viewId===view&&entry.layerId===layer) { this.entries.delete(key); removed++ }
    return removed
  }

  releaseView(viewId:string):number {
    const view=viewId.trim()
    if (!safeId.test(view)) return 0
    let removed=0
    for (const [key,entry] of this.entries) if (entry.viewId===view) { this.entries.delete(key); removed++ }
    this.revisions.delete(view)
    return removed
  }

  snapshot():ArcGisScenePrefetchEntry[] { return [...this.entries.values()].map(entry=>({...entry})) }
  fingerprint():string { return this.snapshot().sort((a,b)=>a.sequence-b.sequence).map(entry=>`${entry.viewId}:${entry.layerId}:${entry.tileId}:${entry.revision}:${entry.phase}:${entry.intent}:${entry.lod}:${entry.actualBytes??0}`).join('|') }
  dispose():void { this.entries.clear(); this.revisions.clear(); this.sequence=0 }

  private key(viewId:string,layerId:string,tileId:string){return `${viewId}|${layerId}|${tileId}`}
  private get(viewId:string,layerId:string,tileId:string){const a=viewId.trim(),b=layerId.trim(),c=tileId.trim();return safeId.test(a)&&safeId.test(b)&&safeId.test(c)?this.entries.get(this.key(a,b,c)):undefined}
  private normalize(raw:ArcGisScenePrefetchRequest):ArcGisScenePrefetchRequest|undefined {
    const viewId=raw.viewId.trim(),layerId=raw.layerId.trim(),tileId=raw.tileId.trim()
    if (!safeId.test(viewId)||!safeId.test(layerId)||!safeId.test(tileId)||!positive(raw.revision)||!Number.isFinite(raw.requestedAt)||!nonNegative(raw.lod)||!nonNegative(raw.estimatedTriangles)||raw.estimatedTriangles>this.budget.maxTrianglesPerTile||!nonNegative(raw.estimatedBytes)||raw.estimatedBytes>this.budget.maxEstimatedBytesPerTile||!(raw.intent in priority)) return undefined
    return {...raw,viewId,layerId,tileId}
  }
}