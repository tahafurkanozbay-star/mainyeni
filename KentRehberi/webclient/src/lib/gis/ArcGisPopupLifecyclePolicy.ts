export type ArcGisPopupIntent = 'hover' | 'inspect' | 'selected' | 'pinned'
export type ArcGisPopupState = 'queued' | 'loading' | 'ready' | 'error'

export interface ArcGisPopupBudget {
  maxLayers: number
  maxPopups: number
  maxPopupsPerLayer: number
  maxPinnedPopups: number
  maxLoadingPopups: number
  maxEstimatedContentBytes: number
  maxEstimatedContentBytesPerPopup: number
  maxFieldsPerPopup: number
  hoverTtlMs: number
  inspectTtlMs: number
  selectedTtlMs: number
  loadingLeaseMs: number
}

export interface ArcGisPopupRequest {
  layerId: string
  featureKey: string
  revision: number
  intent: ArcGisPopupIntent
  fieldNames: readonly string[]
  estimatedContentBytes: number
  requestedAt: number
}

export interface ArcGisPopupEntry {
  layerId: string
  featureKey: string
  revision: number
  intent: ArcGisPopupIntent
  state: ArcGisPopupState
  fieldNames: readonly string[]
  estimatedContentBytes: number
  requestedAt: number
  expiresAt: number | null
  loadingLeaseUntil: number | null
  sequence: number
  errorCode: string | null
}

export interface ArcGisPopupSnapshot {
  popups: number
  layers: number
  pinned: number
  loading: number
  estimatedContentBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisPopupIntent, number>> = Object.freeze({ hover: 0, inspect: 1, selected: 2, pinned: 3 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192) throw new Error(`${name} must contain 1..192 characters`)
  return normalized
}

function fields(values: readonly string[], limit: number): readonly string[] {
  if (values.length > limit) throw new Error(`fieldNames exceeds maxFieldsPerPopup (${limit})`)
  const unique = new Set<string>()
  for (const value of values) unique.add(id('fieldName', value))
  return Object.freeze([...unique].sort((a, b) => a.localeCompare(b)))
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisPopupLifecyclePolicy {
  readonly #budget: Readonly<ArcGisPopupBudget>
  readonly #entries = new Map<string, ArcGisPopupEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisPopupBudget) {
    integer('maxLayers', budget.maxLayers, 1)
    integer('maxPopups', budget.maxPopups, 1)
    integer('maxPopupsPerLayer', budget.maxPopupsPerLayer, 1)
    integer('maxPinnedPopups', budget.maxPinnedPopups, 0)
    integer('maxLoadingPopups', budget.maxLoadingPopups, 1)
    finite('maxEstimatedContentBytes', budget.maxEstimatedContentBytes, 1)
    finite('maxEstimatedContentBytesPerPopup', budget.maxEstimatedContentBytesPerPopup, 1)
    integer('maxFieldsPerPopup', budget.maxFieldsPerPopup, 1)
    finite('hoverTtlMs', budget.hoverTtlMs, 1)
    finite('inspectTtlMs', budget.inspectTtlMs, 1)
    finite('selectedTtlMs', budget.selectedTtlMs, 1)
    finite('loadingLeaseMs', budget.loadingLeaseMs, 1)
    if (budget.maxPopupsPerLayer > budget.maxPopups) throw new Error('maxPopupsPerLayer cannot exceed maxPopups')
    if (budget.maxPinnedPopups > budget.maxPopups) throw new Error('maxPinnedPopups cannot exceed maxPopups')
    if (budget.maxLoadingPopups > budget.maxPopups) throw new Error('maxLoadingPopups cannot exceed maxPopups')
    if (budget.maxEstimatedContentBytesPerPopup > budget.maxEstimatedContentBytes) throw new Error('per-popup byte budget cannot exceed aggregate byte budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisPopupRequest): boolean {
    this.#active()
    const layerId = id('layerId', request.layerId)
    const featureKey = id('featureKey', request.featureKey)
    integer('revision', request.revision, 0)
    finite('estimatedContentBytes', request.estimatedContentBytes, 0)
    finite('requestedAt', request.requestedAt, 0)
    if (request.estimatedContentBytes > this.#budget.maxEstimatedContentBytesPerPopup) return false
    const fieldNames = fields(request.fieldNames, this.#budget.maxFieldsPerPopup)
    const watermark = this.#revisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateLayer(layerId, request.revision)
    if (watermark === undefined && this.#revisions.size >= this.#budget.maxLayers) return false
    const key = this.#key(layerId, featureKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxPopups) return false
    if (!existing && this.#layerCount(layerId) >= this.#budget.maxPopupsPerLayer) return false
    const pinned = this.#pinned() - (existing?.intent === 'pinned' ? 1 : 0) + (request.intent === 'pinned' ? 1 : 0)
    if (pinned > this.#budget.maxPinnedPopups) return false
    const bytes = this.#bytes() - (existing?.estimatedContentBytes ?? 0) + request.estimatedContentBytes
    if (bytes > this.#budget.maxEstimatedContentBytes) return false
    this.#revisions.set(layerId, request.revision)
    this.#entries.set(key, Object.freeze({ layerId, featureKey, revision: request.revision, intent: request.intent, state: 'queued', fieldNames, estimatedContentBytes: request.estimatedContentBytes, requestedAt: request.requestedAt, expiresAt: this.#expiry(request.intent, request.requestedAt), loadingLeaseUntil: null, sequence: existing?.sequence ?? this.#sequence++, errorCode: null }))
    return true
  }

  beginLoading(layerId: string, featureKey: string, now: number): boolean {
    this.#active(); finite('now', now, 0)
    const key = this.#key(id('layerId', layerId), id('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.state === 'loading' || this.#loading() >= this.#budget.maxLoadingPopups) return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'loading', loadingLeaseUntil: now + this.#budget.loadingLeaseMs, errorCode: null }))
    return true
  }

  resolve(layerId: string, featureKey: string, revision: number, now: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now, 0)
    const key = this.#key(id('layerId', layerId), id('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'loading') return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'ready', loadingLeaseUntil: null, expiresAt: this.#expiry(entry.intent, now), errorCode: null }))
    return true
  }

  fail(layerId: string, featureKey: string, revision: number, errorCode: string, now: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now, 0)
    const key = this.#key(id('layerId', layerId), id('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'loading') return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'error', loadingLeaseUntil: null, expiresAt: this.#expiry(entry.intent, now), errorCode: id('errorCode', errorCode) }))
    return true
  }

  promote(layerId: string, featureKey: string, intent: Exclude<ArcGisPopupIntent, 'hover'>, now: number): boolean {
    this.#active(); finite('now', now, 0)
    const key = this.#key(id('layerId', layerId), id('featureKey', featureKey))
    const entry = this.#entries.get(key)
    if (!entry || INTENT_WEIGHT[intent] < INTENT_WEIGHT[entry.intent]) return false
    const pinned = this.#pinned() - (entry.intent === 'pinned' ? 1 : 0) + (intent === 'pinned' ? 1 : 0)
    if (pinned > this.#budget.maxPinnedPopups) return false
    this.#entries.set(key, Object.freeze({ ...entry, intent, requestedAt: now, expiresAt: this.#expiry(intent, now) }))
    return true
  }

  release(layerId: string, featureKey: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(id('layerId', layerId), id('featureKey', featureKey)))
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.#active(); const normalized = id('layerId', layerId); integer('revision', revision, 0)
    const current = this.#revisions.get(normalized)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === normalized) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(normalized, revision)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now, 0); let removed = 0
    for (const [key, entry] of this.#entries) {
      const leaseExpired = entry.state === 'loading' && entry.loadingLeaseUntil !== null && now > entry.loadingLeaseUntil
      const ttlExpired = entry.expiresAt !== null && now > entry.expiresAt
      if (leaseExpired || ttlExpired) { this.#entries.delete(key); removed += 1 }
    }
    return removed
  }

  entriesForLayer(layerId: string): readonly ArcGisPopupEntry[] {
    this.#active(); const normalized = id('layerId', layerId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.layerId === normalized).sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.featureKey.localeCompare(b.featureKey)))
  }

  snapshot(): Readonly<ArcGisPopupSnapshot> {
    this.#active()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.featureKey.localeCompare(b.featureKey)).map(entry => `${entry.layerId}:${entry.featureKey}:${entry.revision}:${entry.intent}:${entry.state}:${entry.fieldNames.join(',')}:${entry.estimatedContentBytes}`).join('|')
    return Object.freeze({ popups: this.#entries.size, layers: this.#revisions.size, pinned: this.#pinned(), loading: this.#loading(), estimatedContentBytes: this.#bytes(), revisionWatermark: Object.freeze(revisions), fingerprint: hash(facts) })
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #expiry(intent: ArcGisPopupIntent, now: number): number | null { if (intent === 'pinned') return null; if (intent === 'hover') return now + this.#budget.hoverTtlMs; if (intent === 'inspect') return now + this.#budget.inspectTtlMs; return now + this.#budget.selectedTtlMs }
  #key(layerId: string, featureKey: string): string { return `${layerId}\u0000${featureKey}` }
  #layerCount(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1; return count }
  #pinned(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.intent === 'pinned') count += 1; return count }
  #loading(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.state === 'loading') count += 1; return count }
  #bytes(): number { let bytes = 0; for (const entry of this.#entries.values()) bytes += entry.estimatedContentBytes; return bytes }
  #active(): void { if (this.#disposed) throw new Error('ArcGisPopupLifecyclePolicy is disposed') }
}
