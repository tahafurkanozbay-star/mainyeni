export interface EditIdempotencyBudget {
  maxLayers: number
  maxKeys: number
  maxKeysPerLayer: number
  ttlMs: number
}

export interface EditIdempotencyRequest {
  key: string
  layerId: string
  revision: number
  operationDigest: string
  createdAt: number
}

export interface EditIdempotencyView extends EditIdempotencyRequest {
  readonly sequence: number
  readonly expiresAt: number
}

interface Entry extends EditIdempotencyRequest {
  sequence: number
  expiresAt: number
}

function safe(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('revision must be a non-negative safe integer')
}

function time(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Bounded scalar idempotency authority for edit submissions.
 * It deliberately stores only caller-generated keys and non-sensitive operation digests;
 * geometry, attributes, credentials and request bodies remain outside authority state.
 */
export class ArcGisEditIdempotencyWindowPolicy {
  readonly #budget: Readonly<EditIdempotencyBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditIdempotencyBudget) {
    for (const key of ['maxLayers', 'maxKeys', 'maxKeysPerLayer'] as const) {
      if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) throw new Error(`${key} must be positive`)
    }
    time('ttlMs', budget.ttlMs)
    if (budget.maxKeysPerLayer > budget.maxKeys) throw new Error('maxKeysPerLayer cannot exceed maxKeys')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, next: number): number {
    this.#live()
    const layer = safe('layerId', layerId)
    revision(next)
    const current = this.#revisions.get(layer)
    if (current !== undefined && next < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, next)
    if (current === undefined || current === next) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer && entry.revision !== next) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  register(request: EditIdempotencyRequest): 'accepted' | 'duplicate' | 'conflict' | 'rejected' {
    this.#live()
    const key = safe('key', request.key)
    const layerId = safe('layerId', request.layerId)
    const operationDigest = safe('operationDigest', request.operationDigest)
    revision(request.revision)
    time('createdAt', request.createdAt)
    if (this.#revisions.get(layerId) !== request.revision) return 'rejected'
    const existing = this.#entries.get(key)
    if (existing) return existing.layerId === layerId && existing.revision === request.revision && existing.operationDigest === operationDigest ? 'duplicate' : 'conflict'
    if (this.#entries.size >= this.#budget.maxKeys || this.#layerCount(layerId) >= this.#budget.maxKeysPerLayer) return 'rejected'
    this.#entries.set(key, { ...request, key, layerId, operationDigest, sequence: ++this.#sequence, expiresAt: request.createdAt + this.#budget.ttlMs })
    return 'accepted'
  }

  has(key: string, revisionValue: number, now: number): boolean {
    this.#live()
    const normalized = safe('key', key)
    revision(revisionValue)
    time('now', now)
    this.expire(now)
    const entry = this.#entries.get(normalized)
    return Boolean(entry && entry.revision === revisionValue && this.#revisions.get(entry.layerId) === revisionValue)
  }

  releaseLayer(layerId: string): number {
    this.#live()
    const layer = safe('layerId', layerId)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(key)
        removed++
      }
    }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#live()
    time('now', now)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  snapshot(): Readonly<{ layers: number; keys: number }> {
    this.#live()
    return Object.freeze({ layers: this.#revisions.size, keys: this.#entries.size })
  }

  fingerprint(): string {
    this.#live()
    return [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.sequence - b.sequence)
      .map(entry => `${entry.layerId}:${entry.key}:${entry.revision}:${entry.operationDigest}`)
      .join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #layerCount(layerId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++
    return count
  }

  #live(): void {
    if (this.#disposed) throw new Error('edit idempotency window policy is disposed')
  }
}
