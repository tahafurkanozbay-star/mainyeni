export type ArcGisSelectionIntent = 'hover' | 'focus' | 'select' | 'pin'
export type ArcGisSelectionGeometryKind = 'point' | 'polyline' | 'polygon' | 'extent' | 'none'

export interface ArcGisSelectionBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxPinnedEntries: number
  maxEstimatedHighlightBytes: number
  maxObjectIdsPerEntry: number
  hoverTtlMs: number
  focusTtlMs: number
  selectionTtlMs: number
}

export interface ArcGisSelectionRequest {
  layerId: string
  featureKey: string
  revision: number
  intent: ArcGisSelectionIntent
  geometryKind: ArcGisSelectionGeometryKind
  objectIds: readonly number[]
  estimatedHighlightBytes: number
  requestedAt: number
}

export interface ArcGisSelectionEntry {
  layerId: string
  featureKey: string
  revision: number
  intent: ArcGisSelectionIntent
  geometryKind: ArcGisSelectionGeometryKind
  objectIds: readonly number[]
  estimatedHighlightBytes: number
  requestedAt: number
  expiresAt: number | null
  sequence: number
}

export interface ArcGisSelectionSnapshot {
  entries: number
  layers: number
  pinned: number
  estimatedHighlightBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisSelectionIntent, number>> = Object.freeze({ hover: 0, focus: 1, select: 2, pin: 3 })

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

function canonicalObjectIds(ids: readonly number[], limit: number): readonly number[] {
  if (ids.length > limit) throw new Error(`objectIds exceeds maxObjectIdsPerEntry (${limit})`)
  const unique = new Set<number>()
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('objectIds must contain non-negative safe integers')
    unique.add(id)
  }
  return Object.freeze([...unique].sort((a, b) => a - b))
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisSelectionLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSelectionBudget>
  readonly #entries = new Map<string, ArcGisSelectionEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisSelectionBudget) {
    assertInteger('maxLayers', budget.maxLayers, 1)
    assertInteger('maxEntries', budget.maxEntries, 1)
    assertInteger('maxEntriesPerLayer', budget.maxEntriesPerLayer, 1)
    assertInteger('maxPinnedEntries', budget.maxPinnedEntries, 0)
    assertFinite('maxEstimatedHighlightBytes', budget.maxEstimatedHighlightBytes, 1)
    assertInteger('maxObjectIdsPerEntry', budget.maxObjectIdsPerEntry, 1)
    assertFinite('hoverTtlMs', budget.hoverTtlMs, 1)
    assertFinite('focusTtlMs', budget.focusTtlMs, 1)
    assertFinite('selectionTtlMs', budget.selectionTtlMs, 1)
    if (budget.maxEntriesPerLayer > budget.maxEntries) throw new Error('maxEntriesPerLayer cannot exceed maxEntries')
    if (budget.maxPinnedEntries > budget.maxEntries) throw new Error('maxPinnedEntries cannot exceed maxEntries')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisSelectionRequest): boolean {
    this.#assertActive()
    const layerId = normalizeId('layerId', request.layerId)
    const featureKey = normalizeId('featureKey', request.featureKey)
    assertInteger('revision', request.revision, 0)
    assertFinite('estimatedHighlightBytes', request.estimatedHighlightBytes, 0)
    assertFinite('requestedAt', request.requestedAt, 0)
    if (request.estimatedHighlightBytes > this.#budget.maxEstimatedHighlightBytes) return false
    const objectIds = canonicalObjectIds(request.objectIds, this.#budget.maxObjectIdsPerEntry)
    const watermark = this.#revisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateLayer(layerId, request.revision)
    if (watermark === undefined && this.#revisions.size >= this.#budget.maxLayers) return false

    const key = this.#key(layerId, featureKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision > request.revision) return false
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false

    const projectedCount = this.#entries.size + (existing ? 0 : 1)
    if (projectedCount > this.#budget.maxEntries) return false
    if (!existing && this.#layerCount(layerId) >= this.#budget.maxEntriesPerLayer) return false
    const projectedPinned = this.#pinnedCount() - (existing?.intent === 'pin' ? 1 : 0) + (request.intent === 'pin' ? 1 : 0)
    if (projectedPinned > this.#budget.maxPinnedEntries) return false
    const projectedBytes = this.#bytes() - (existing?.estimatedHighlightBytes ?? 0) + request.estimatedHighlightBytes
    if (projectedBytes > this.#budget.maxEstimatedHighlightBytes) return false

    const expiresAt = this.#expiry(request.intent, request.requestedAt)
    const entry: ArcGisSelectionEntry = Object.freeze({
      layerId,
      featureKey,
      revision: request.revision,
      intent: request.intent,
      geometryKind: request.geometryKind,
      objectIds,
      estimatedHighlightBytes: request.estimatedHighlightBytes,
      requestedAt: request.requestedAt,
      expiresAt,
      sequence: existing?.sequence ?? this.#sequence++,
    })
    this.#revisions.set(layerId, request.revision)
    this.#entries.set(key, entry)
    return true
  }

  promote(layerId: string, featureKey: string, intent: Exclude<ArcGisSelectionIntent, 'hover'>, now: number): boolean {
    this.#assertActive()
    assertFinite('now', now, 0)
    const key = this.#key(normalizeId('layerId', layerId), normalizeId('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || INTENT_WEIGHT[intent] < INTENT_WEIGHT[entry.intent]) return false
    const projectedPinned = this.#pinnedCount() - (entry.intent === 'pin' ? 1 : 0) + (intent === 'pin' ? 1 : 0)
    if (projectedPinned > this.#budget.maxPinnedEntries) return false
    this.#entries.set(key, Object.freeze({ ...entry, intent, requestedAt: now, expiresAt: this.#expiry(intent, now) }))
    return true
  }

  demote(layerId: string, featureKey: string, intent: Exclude<ArcGisSelectionIntent, 'pin'>, now: number): boolean {
    this.#assertActive()
    assertFinite('now', now, 0)
    const key = this.#key(normalizeId('layerId', layerId), normalizeId('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || INTENT_WEIGHT[intent] >= INTENT_WEIGHT[entry.intent]) return false
    this.#entries.set(key, Object.freeze({ ...entry, intent, requestedAt: now, expiresAt: this.#expiry(intent, now) }))
    return true
  }

  release(layerId: string, featureKey: string): boolean {
    this.#assertActive()
    return this.#entries.delete(this.#key(normalizeId('layerId', layerId), normalizeId('featureKey', featureKey)))
  }

  releaseLayer(layerId: string): number {
    this.#assertActive()
    const id = normalizeId('layerId', layerId)
    let released = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === id) {
        this.#entries.delete(key)
        released += 1
      }
    }
    this.#revisions.delete(id)
    return released
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.#assertActive()
    const id = normalizeId('layerId', layerId)
    assertInteger('revision', revision, 0)
    const current = this.#revisions.get(id)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return 0
    let released = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === id) {
        this.#entries.delete(key)
        released += 1
      }
    }
    this.#revisions.set(id, revision)
    return released
  }

  expire(now: number): number {
    this.#assertActive()
    assertFinite('now', now, 0)
    let expired = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.#entries.delete(key)
        expired += 1
      }
    }
    return expired
  }

  entriesForLayer(layerId: string): readonly ArcGisSelectionEntry[] {
    this.#assertActive()
    const id = normalizeId('layerId', layerId)
    return Object.freeze([...this.#entries.values()]
      .filter(entry => entry.layerId === id)
      .sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.featureKey.localeCompare(b.featureKey)))
  }

  snapshot(): Readonly<ArcGisSelectionSnapshot> {
    this.#assertActive()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.featureKey.localeCompare(b.featureKey))
      .map(entry => `${entry.layerId}:${entry.featureKey}:${entry.revision}:${entry.intent}:${entry.geometryKind}:${entry.objectIds.join(',')}:${entry.estimatedHighlightBytes}`)
      .join('|')
    return Object.freeze({
      entries: this.#entries.size,
      layers: this.#revisions.size,
      pinned: this.#pinnedCount(),
      estimatedHighlightBytes: this.#bytes(),
      revisionWatermark: Object.freeze(revisions),
      fingerprint: stableHash(facts),
    })
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #expiry(intent: ArcGisSelectionIntent, now: number): number | null {
    if (intent === 'pin') return null
    if (intent === 'hover') return now + this.#budget.hoverTtlMs
    if (intent === 'focus') return now + this.#budget.focusTtlMs
    return now + this.#budget.selectionTtlMs
  }

  #key(layerId: string, featureKey: string): string {
    return `${layerId}\u0000${featureKey}`
  }

  #layerCount(layerId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1
    return count
  }

  #pinnedCount(): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.intent === 'pin') count += 1
    return count
  }

  #bytes(): number {
    let bytes = 0
    for (const entry of this.#entries.values()) bytes += entry.estimatedHighlightBytes
    return bytes
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ArcGisSelectionLifecyclePolicy is disposed')
  }
}
