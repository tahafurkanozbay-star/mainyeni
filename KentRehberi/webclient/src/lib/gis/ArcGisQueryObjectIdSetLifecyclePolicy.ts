export type QueryObjectIdIntent = 'interactive' | 'visible' | 'background'

export interface QueryObjectIdSetBudget {
  maxLayers: number
  maxSets: number
  maxSetsPerLayer: number
  maxIdsPerSet: number
  maxResidentIds: number
  ttlMs: number
}

export interface QueryObjectIdSetRequest {
  setKey: string
  layerId: string
  revision: number
  intent: QueryObjectIdIntent
  objectIdField: string
  objectIds: readonly number[]
  capturedAt: number
  signature: string
}

export interface QueryObjectIdSetView {
  readonly setKey: string
  readonly layerId: string
  readonly revision: number
  readonly intent: QueryObjectIdIntent
  readonly objectIdField: string
  readonly objectIds: readonly number[]
  readonly capturedAt: number
  readonly signature: string
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

export interface QueryObjectIdSetSnapshot {
  readonly layers: number
  readonly sets: number
  readonly residentIds: number
}

interface ObjectIdSetEntry {
  setKey: string
  layerId: string
  revision: number
  intent: QueryObjectIdIntent
  objectIdField: string
  objectIds: readonly number[]
  capturedAt: number
  signature: string
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intents: readonly QueryObjectIdIntent[] = ['interactive', 'visible', 'background']
const intentRank: Readonly<Record<QueryObjectIdIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function identifier(name: string, value: string, max = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}

function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Bounded authority for ArcGIS REST returnIdsOnly/queryObjectIds result identity.
 *
 * Only canonical numeric object identifiers are retained. Feature attributes, geometries, SDK
 * objects, credentials, request objects and response envelopes stay caller-local. Canonicalizing
 * the set makes logically equivalent server responses deterministic even when page/order behavior
 * differs, while revision watermarks prevent stale IDs from crossing layer refresh boundaries.
 */
export class ArcGisQueryObjectIdSetLifecyclePolicy {
  readonly #budget: Readonly<QueryObjectIdSetBudget>
  readonly #entries = new Map<string, ObjectIdSetEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryObjectIdSetBudget) {
    for (const key of ['maxLayers', 'maxSets', 'maxSetsPerLayer', 'maxIdsPerSet', 'maxResidentIds'] as const) positiveInteger(key, budget[key])
    clock('ttlMs', budget.ttlMs)
    if (budget.ttlMs === 0) throw new Error('ttlMs must be positive')
    if (budget.maxSetsPerLayer > budget.maxSets) throw new Error('maxSetsPerLayer cannot exceed maxSets')
    if (budget.maxResidentIds < budget.maxIdsPerSet) throw new Error('maxResidentIds cannot be smaller than maxIdsPerSet')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    nonNegativeInteger('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === revision) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) throw new Error('maxLayers exceeded')
    this.#revisions.set(layer, revision)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer && entry.revision !== revision) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  admit(request: QueryObjectIdSetRequest): QueryObjectIdSetView | null {
    this.#assertLive()
    const normalized = this.#normalize(request)
    if (this.#revisions.get(normalized.layerId) !== normalized.revision) return null
    if (normalized.objectIds.length > this.#budget.maxIdsPerSet) return null

    const existing = this.#entries.get(normalized.setKey)
    if (existing) {
      if (!this.#sameIdentity(existing, normalized)) return null
      existing.touchedAt = normalized.capturedAt
      existing.expiresAt = normalized.capturedAt + this.#budget.ttlMs
      return this.#view(existing)
    }

    const logical = [...this.#entries.values()].find(entry =>
      entry.layerId === normalized.layerId &&
      entry.revision === normalized.revision &&
      entry.objectIdField === normalized.objectIdField &&
      entry.signature === normalized.signature &&
      this.#sameIds(entry.objectIds, normalized.objectIds),
    )
    if (logical) {
      logical.touchedAt = normalized.capturedAt
      logical.expiresAt = normalized.capturedAt + this.#budget.ttlMs
      return this.#view(logical)
    }

    if (this.#layerCount(normalized.layerId) >= this.#budget.maxSetsPerLayer && !this.#evictOne(normalized.intent, normalized.layerId)) return null
    if (this.#entries.size >= this.#budget.maxSets && !this.#evictOne(normalized.intent)) return null

    const entry: ObjectIdSetEntry = {
      ...normalized,
      sequence: ++this.#sequence,
      touchedAt: normalized.capturedAt,
      expiresAt: normalized.capturedAt + this.#budget.ttlMs,
    }
    this.#entries.set(entry.setKey, entry)
    if (!this.#relievePressure(entry)) {
      this.#entries.delete(entry.setKey)
      return null
    }
    return this.#view(entry)
  }

  get(setKey: string, revision: number, now: number): QueryObjectIdSetView | null {
    this.#assertLive()
    const key = identifier('setKey', setKey)
    nonNegativeInteger('revision', revision)
    clock('now', now)
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    if (now >= entry.expiresAt) {
      this.#entries.delete(key)
      return null
    }
    return this.#view(entry)
  }

  touch(setKey: string, revision: number, now: number): boolean {
    this.#assertLive()
    const key = identifier('setKey', setKey)
    nonNegativeInteger('revision', revision)
    clock('now', now)
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision || now >= entry.expiresAt) return false
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.ttlMs
    return true
  }

  consume(setKey: string, revision: number, now: number): QueryObjectIdSetView | null {
    const view = this.get(setKey, revision, now)
    if (!view) return null
    this.#entries.delete(view.setKey)
    return view
  }

  invalidate(setKey: string): boolean {
    this.#assertLive()
    return this.#entries.delete(identifier('setKey', setKey))
  }

  releaseLayer(layerId: string): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#assertLive()
    clock('now', now)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  snapshot(): QueryObjectIdSetSnapshot {
    this.#assertLive()
    return Object.freeze({ layers: this.#revisions.size, sets: this.#entries.size, residentIds: this.#residentIds() })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.setKey.localeCompare(b.setKey))
      .map(entry => `${entry.layerId}:${entry.setKey}:${entry.revision}:${entry.intent}:${entry.objectIdField}:${entry.signature}:${entry.objectIds.join(',')}`)
      .join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #normalize(request: QueryObjectIdSetRequest): Omit<ObjectIdSetEntry, 'sequence' | 'touchedAt' | 'expiresAt'> {
    const setKey = identifier('setKey', request.setKey)
    const layerId = identifier('layerId', request.layerId)
    const signature = identifier('signature', request.signature, 512)
    const objectIdField = identifier('objectIdField', request.objectIdField, 128)
    if (!fieldPattern.test(objectIdField)) throw new Error('objectIdField is invalid')
    nonNegativeInteger('revision', request.revision)
    clock('capturedAt', request.capturedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (!Array.isArray(request.objectIds)) throw new Error('objectIds must be an array')
    const ids = request.objectIds.map(value => {
      positiveInteger('objectId', value)
      return value
    })
    ids.sort((a, b) => a - b)
    for (let index = 1; index < ids.length; index += 1) if (ids[index] === ids[index - 1]) throw new Error('objectIds must be unique')
    return { setKey, layerId, revision: request.revision, intent: request.intent, objectIdField, objectIds: Object.freeze(ids), capturedAt: request.capturedAt, signature }
  }

  #sameIdentity(entry: ObjectIdSetEntry, request: Omit<ObjectIdSetEntry, 'sequence' | 'touchedAt' | 'expiresAt'>): boolean {
    return entry.layerId === request.layerId && entry.revision === request.revision && entry.objectIdField === request.objectIdField && entry.signature === request.signature && this.#sameIds(entry.objectIds, request.objectIds)
  }

  #sameIds(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  #layerCount(layerId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1
    return count
  }

  #residentIds(): number {
    let total = 0
    for (const entry of this.#entries.values()) total += entry.objectIds.length
    return total
  }

  #relievePressure(protectedEntry: ObjectIdSetEntry): boolean {
    while (this.#residentIds() > this.#budget.maxResidentIds) {
      const candidate = this.#evictionCandidate(protectedEntry.intent, undefined, protectedEntry.setKey)
      if (!candidate) return false
      this.#entries.delete(candidate.setKey)
    }
    return true
  }

  #evictOne(incomingIntent: QueryObjectIdIntent, layerId?: string): boolean {
    const candidate = this.#evictionCandidate(incomingIntent, layerId)
    if (!candidate) return false
    this.#entries.delete(candidate.setKey)
    return true
  }

  #evictionCandidate(incomingIntent: QueryObjectIdIntent, layerId?: string, protectedKey?: string): ObjectIdSetEntry | null {
    const candidates = [...this.#entries.values()].filter(entry =>
      entry.setKey !== protectedKey &&
      (layerId === undefined || entry.layerId === layerId) &&
      intentRank[entry.intent] <= intentRank[incomingIntent],
    )
    candidates.sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || a.touchedAt - b.touchedAt || a.sequence - b.sequence || a.setKey.localeCompare(b.setKey))
    return candidates[0] ?? null
  }

  #view(entry: ObjectIdSetEntry): QueryObjectIdSetView {
    return Object.freeze({
      setKey: entry.setKey,
      layerId: entry.layerId,
      revision: entry.revision,
      intent: entry.intent,
      objectIdField: entry.objectIdField,
      objectIds: Object.freeze([...entry.objectIds]),
      capturedAt: entry.capturedAt,
      signature: entry.signature,
      sequence: entry.sequence,
      touchedAt: entry.touchedAt,
      expiresAt: entry.expiresAt,
    })
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('ArcGisQueryObjectIdSetLifecyclePolicy is disposed')
  }
}
