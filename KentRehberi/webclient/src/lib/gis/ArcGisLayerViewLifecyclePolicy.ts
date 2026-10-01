export type ArcGisLayerViewIntent = 'prefetch' | 'background' | 'visible' | 'interactive'
export type ArcGisLayerViewPhase = 'queued' | 'loading' | 'ready'

export interface ArcGisLayerViewBudget {
  maxViews: number
  maxEntries: number
  maxEntriesPerView: number
  maxLoading: number
  maxReady: number
  maxEstimatedCpuBytes: number
  maxEstimatedGpuBytes: number
  maxEstimatedCpuBytesPerEntry: number
  maxEstimatedGpuBytesPerEntry: number
  queueTtlMs: number
  loadLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisLayerViewRequest {
  viewId: string
  layerId: string
  revision: number
  intent: ArcGisLayerViewIntent
  requestedAt: number
  estimatedCpuBytes: number
  estimatedGpuBytes: number
  minScale?: number
  maxScale?: number
}

export interface ArcGisLayerViewEntry extends ArcGisLayerViewRequest {
  phase: ArcGisLayerViewPhase
  sequence: number
  phaseStartedAt: number
  expiresAt: number
}

export interface ArcGisLayerViewSnapshot {
  views: number
  entries: number
  queued: number
  loading: number
  ready: number
  estimatedCpuBytes: number
  estimatedGpuBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisLayerViewIntent, number>> = Object.freeze({ prefetch: 0, background: 1, visible: 2, interactive: 3 })

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function assertFinite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function normalizeId(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192) throw new Error(`${name} must contain 1..192 characters`)
  return normalized
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisLayerViewLifecyclePolicy {
  readonly #budget: Readonly<ArcGisLayerViewBudget>
  readonly #entries = new Map<string, ArcGisLayerViewEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLayerViewBudget) {
    assertInteger('maxViews', budget.maxViews, 1)
    assertInteger('maxEntries', budget.maxEntries, 1)
    assertInteger('maxEntriesPerView', budget.maxEntriesPerView, 1)
    assertInteger('maxLoading', budget.maxLoading, 1)
    assertInteger('maxReady', budget.maxReady, 1)
    assertFinite('maxEstimatedCpuBytes', budget.maxEstimatedCpuBytes, 1)
    assertFinite('maxEstimatedGpuBytes', budget.maxEstimatedGpuBytes, 1)
    assertFinite('maxEstimatedCpuBytesPerEntry', budget.maxEstimatedCpuBytesPerEntry, 1)
    assertFinite('maxEstimatedGpuBytesPerEntry', budget.maxEstimatedGpuBytesPerEntry, 1)
    assertFinite('queueTtlMs', budget.queueTtlMs, 1)
    assertFinite('loadLeaseMs', budget.loadLeaseMs, 1)
    assertFinite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxEntriesPerView > budget.maxEntries) throw new Error('maxEntriesPerView cannot exceed maxEntries')
    if (budget.maxLoading > budget.maxEntries) throw new Error('maxLoading cannot exceed maxEntries')
    if (budget.maxReady > budget.maxEntries) throw new Error('maxReady cannot exceed maxEntries')
    if (budget.maxEstimatedCpuBytesPerEntry > budget.maxEstimatedCpuBytes) throw new Error('per-entry CPU budget cannot exceed aggregate budget')
    if (budget.maxEstimatedGpuBytesPerEntry > budget.maxEstimatedGpuBytes) throw new Error('per-entry GPU budget cannot exceed aggregate budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisLayerViewRequest): boolean {
    this.#assertActive()
    const viewId = normalizeId('viewId', request.viewId)
    const layerId = normalizeId('layerId', request.layerId)
    assertInteger('revision', request.revision, 0)
    assertFinite('requestedAt', request.requestedAt, 0)
    assertFinite('estimatedCpuBytes', request.estimatedCpuBytes, 0)
    assertFinite('estimatedGpuBytes', request.estimatedGpuBytes, 0)
    this.#validateScale(request.minScale, request.maxScale)
    if (request.estimatedCpuBytes > this.#budget.maxEstimatedCpuBytesPerEntry) return false
    if (request.estimatedGpuBytes > this.#budget.maxEstimatedGpuBytesPerEntry) return false

    const revisionKey = this.#revisionKey(viewId, layerId)
    const watermark = this.#revisions.get(revisionKey)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidate(viewId, layerId, request.revision)
    const key = this.#key(viewId, layerId)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxEntries) return false
    if (!existing && this.#entryCountForView(viewId) >= this.#budget.maxEntriesPerView) return false
    if (!existing && !this.#hasView(viewId) && this.#viewCount() >= this.#budget.maxViews) return false

    const cpu = this.#cpuBytes() - (existing?.estimatedCpuBytes ?? 0) + request.estimatedCpuBytes
    const gpu = this.#gpuBytes() - (existing?.estimatedGpuBytes ?? 0) + request.estimatedGpuBytes
    if (cpu > this.#budget.maxEstimatedCpuBytes || gpu > this.#budget.maxEstimatedGpuBytes) return false

    const entry: ArcGisLayerViewEntry = Object.freeze({
      ...request,
      viewId,
      layerId,
      phase: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      phaseStartedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    })
    this.#revisions.set(revisionKey, request.revision)
    this.#entries.set(key, entry)
    return true
  }

  next(now: number): Readonly<ArcGisLayerViewEntry> | null {
    this.#assertActive()
    assertFinite('now', now, 0)
    this.expire(now)
    if (this.#phaseCount('loading') >= this.#budget.maxLoading) return null
    const candidate = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued')
      .sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.layerId.localeCompare(b.layerId))[0]
    if (!candidate) return null
    const loading = Object.freeze({ ...candidate, phase: 'loading' as const, phaseStartedAt: now, expiresAt: now + this.#budget.loadLeaseMs })
    this.#entries.set(this.#key(candidate.viewId, candidate.layerId), loading)
    return loading
  }

  complete(viewId: string, layerId: string, revision: number, now: number): boolean {
    this.#assertActive()
    assertInteger('revision', revision, 0)
    assertFinite('now', now, 0)
    const key = this.#key(normalizeId('viewId', viewId), normalizeId('layerId', layerId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'loading' || entry.revision !== revision || now > entry.expiresAt) return false
    if (this.#phaseCount('ready') >= this.#budget.maxReady) return false
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'ready', phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  touch(viewId: string, layerId: string, now: number): boolean {
    this.#assertActive()
    assertFinite('now', now, 0)
    const key = this.#key(normalizeId('viewId', viewId), normalizeId('layerId', layerId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  cancel(viewId: string, layerId: string): boolean {
    this.#assertActive()
    return this.#entries.delete(this.#key(normalizeId('viewId', viewId), normalizeId('layerId', layerId)))
  }

  releaseView(viewId: string): number {
    this.#assertActive()
    const id = normalizeId('viewId', viewId)
    let released = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === id) { this.#entries.delete(key); released += 1 }
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${id}\u0000`)) this.#revisions.delete(key)
    return released
  }

  invalidate(viewId: string, layerId: string, revision: number): number {
    this.#assertActive()
    const v = normalizeId('viewId', viewId)
    const l = normalizeId('layerId', layerId)
    assertInteger('revision', revision, 0)
    const revisionKey = this.#revisionKey(v, l)
    const current = this.#revisions.get(revisionKey)
    if (current !== undefined && revision <= current) return 0
    const removed = this.#entries.delete(this.#key(v, l)) ? 1 : 0
    this.#revisions.set(revisionKey, revision)
    return removed
  }

  expire(now: number): number {
    this.#assertActive()
    assertFinite('now', now, 0)
    let expired = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); expired += 1 }
    return expired
  }

  entriesForView(viewId: string): readonly ArcGisLayerViewEntry[] {
    this.#assertActive()
    const id = normalizeId('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === id).sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence))
  }

  snapshot(): Readonly<ArcGisLayerViewSnapshot> {
    this.#assertActive()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.layerId.localeCompare(b.layerId)).map(entry => `${entry.viewId}:${entry.layerId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.estimatedCpuBytes}:${entry.estimatedGpuBytes}`).join('|')
    return Object.freeze({ views: this.#viewCount(), entries: this.#entries.size, queued: this.#phaseCount('queued'), loading: this.#phaseCount('loading'), ready: this.#phaseCount('ready'), estimatedCpuBytes: this.#cpuBytes(), estimatedGpuBytes: this.#gpuBytes(), revisionWatermark: Object.freeze(revisions), fingerprint: stableHash(facts) })
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #validateScale(minScale?: number, maxScale?: number): void {
    if (minScale !== undefined) assertFinite('minScale', minScale, 0)
    if (maxScale !== undefined) assertFinite('maxScale', maxScale, 0)
    if (minScale !== undefined && maxScale !== undefined && minScale > 0 && maxScale > 0 && minScale < maxScale) throw new Error('minScale must be >= maxScale for ArcGIS scale semantics')
  }

  #key(viewId: string, layerId: string): string { return `${viewId}\u0000${layerId}` }
  #revisionKey(viewId: string, layerId: string): string { return this.#key(viewId, layerId) }
  #hasView(viewId: string): boolean { for (const entry of this.#entries.values()) if (entry.viewId === viewId) return true; return false }
  #viewCount(): number { return new Set([...this.#entries.values()].map(entry => entry.viewId)).size }
  #entryCountForView(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count += 1; return count }
  #phaseCount(phase: ArcGisLayerViewPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #cpuBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) bytes += entry.estimatedCpuBytes; return bytes }
  #gpuBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) bytes += entry.estimatedGpuBytes; return bytes }
  #assertActive(): void { if (this.#disposed) throw new Error('ArcGisLayerViewLifecyclePolicy is disposed') }
}
