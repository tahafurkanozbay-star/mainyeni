export type ArcGisSelectionDimension = '2d' | '3d'
export type ArcGisSelectionMode = 'replace' | 'add' | 'remove' | 'toggle'

export interface ArcGisSelectionCandidate {
  readonly layerId: number
  readonly objectId: number
  readonly revision: string
  readonly estimatedBytes: number
  readonly priority: number
  readonly dimension: ArcGisSelectionDimension
}

export interface ArcGisSelectionRequest {
  readonly mode: ArcGisSelectionMode
  readonly dimension: ArcGisSelectionDimension
  readonly candidates: readonly ArcGisSelectionCandidate[]
}

export interface ArcGisSelectionBudget {
  readonly maxCandidates: number
  readonly maxSelectedFeatures: number
  readonly maxSelectedLayers: number
  readonly maxEstimatedBytes: number
  readonly maxRevisionLength: number
  readonly maxPriority: number
}

export interface ArcGisSelectionItem {
  readonly layerId: number
  readonly objectId: number
  readonly revision: string
  readonly estimatedBytes: number
  readonly priority: number
}

export interface ArcGisSelectionSnapshot {
  readonly generation: number
  readonly dimension: ArcGisSelectionDimension
  readonly items: readonly ArcGisSelectionItem[]
  readonly layerIds: readonly number[]
  readonly estimatedBytes: number
  readonly fingerprint: string
}

const MAX_CANDIDATES = 100_000
const MAX_SELECTED = 50_000
const MAX_BYTES = 256 * 1024 * 1024

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function key(layerId: number, objectId: number): string {
  return `${layerId}:${objectId}`
}

function freezeItems(items: readonly ArcGisSelectionItem[]): readonly ArcGisSelectionItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })))
}

function fingerprint(generation: number, dimension: ArcGisSelectionDimension, items: readonly ArcGisSelectionItem[]): string {
  return ['selection-v1', generation, dimension, ...items.map((item) => `${item.layerId}:${item.objectId}:${item.revision}`)].join('|')
}

/** Transport-independent, bounded authority for 2D/3D ArcGIS feature selection. */
export class ArcGisSelectionPolicy {
  private readonly budget: Readonly<ArcGisSelectionBudget>
  private generation = 0
  private dimension: ArcGisSelectionDimension = '2d'
  private items = new Map<string, ArcGisSelectionItem>()

  constructor(budget: ArcGisSelectionBudget) {
    this.budget = Object.freeze({
      maxCandidates: integer(budget.maxCandidates, 'maxCandidates', 1, MAX_CANDIDATES),
      maxSelectedFeatures: integer(budget.maxSelectedFeatures, 'maxSelectedFeatures', 1, MAX_SELECTED),
      maxSelectedLayers: integer(budget.maxSelectedLayers, 'maxSelectedLayers', 1, 10_000),
      maxEstimatedBytes: integer(budget.maxEstimatedBytes, 'maxEstimatedBytes', 1, MAX_BYTES),
      maxRevisionLength: integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 256),
      maxPriority: integer(budget.maxPriority, 'maxPriority', 0, 1_000_000),
    })
  }

  apply(request: ArcGisSelectionRequest): ArcGisSelectionSnapshot {
    if (!['replace', 'add', 'remove', 'toggle'].includes(request.mode)) throw new Error('invalid-selection-mode')
    if (request.dimension !== '2d' && request.dimension !== '3d') throw new Error('invalid-selection-dimension')
    if (!Array.isArray(request.candidates)) throw new Error('selection-candidates-must-be-array')
    if (request.candidates.length > this.budget.maxCandidates) throw new Error('selection-candidate-budget-exceeded')

    const canonical = this.canonicalCandidates(request.candidates, request.dimension)
    const next = request.mode === 'replace' ? new Map<string, ArcGisSelectionItem>() : new Map(this.items)

    for (const item of canonical) {
      const itemKey = key(item.layerId, item.objectId)
      if (request.mode === 'remove') next.delete(itemKey)
      else if (request.mode === 'toggle' && next.has(itemKey)) next.delete(itemKey)
      else next.set(itemKey, item)
    }

    const ordered = [...next.values()].sort((a, b) => b.priority - a.priority || a.layerId - b.layerId || a.objectId - b.objectId)
    if (ordered.length > this.budget.maxSelectedFeatures) throw new Error('selected-feature-budget-exceeded')
    const layerIds = [...new Set(ordered.map((item) => item.layerId))].sort((a, b) => a - b)
    if (layerIds.length > this.budget.maxSelectedLayers) throw new Error('selected-layer-budget-exceeded')
    let estimatedBytes = 0
    for (const item of ordered) {
      if (item.estimatedBytes > this.budget.maxEstimatedBytes - estimatedBytes) throw new Error('selected-byte-budget-exceeded')
      estimatedBytes += item.estimatedBytes
    }

    this.items = new Map(ordered.map((item) => [key(item.layerId, item.objectId), item]))
    this.dimension = request.dimension
    this.generation += 1
    return this.snapshot()
  }

  clear(): ArcGisSelectionSnapshot {
    this.items.clear()
    this.generation += 1
    return this.snapshot()
  }

  invalidateLayer(layerIdValue: number, revisionValue?: string): ArcGisSelectionSnapshot {
    const layerId = integer(layerIdValue, 'layerId', 0, 1_000_000)
    const revision = revisionValue === undefined ? undefined : text(revisionValue, 'revision', this.budget.maxRevisionLength)
    let changed = false
    for (const [itemKey, item] of this.items) {
      if (item.layerId === layerId && (revision === undefined || item.revision !== revision)) {
        this.items.delete(itemKey)
        changed = true
      }
    }
    if (changed) this.generation += 1
    return this.snapshot()
  }

  snapshot(): ArcGisSelectionSnapshot {
    const items = freezeItems([...this.items.values()].sort((a, b) => b.priority - a.priority || a.layerId - b.layerId || a.objectId - b.objectId))
    const layerIds = Object.freeze([...new Set(items.map((item) => item.layerId))].sort((a, b) => a - b))
    const estimatedBytes = items.reduce((total, item) => total + item.estimatedBytes, 0)
    return Object.freeze({
      generation: this.generation,
      dimension: this.dimension,
      items,
      layerIds,
      estimatedBytes,
      fingerprint: fingerprint(this.generation, this.dimension, items),
    })
  }

  private canonicalCandidates(values: readonly ArcGisSelectionCandidate[], dimension: ArcGisSelectionDimension): readonly ArcGisSelectionItem[] {
    const seen = new Set<string>()
    const result: ArcGisSelectionItem[] = []
    for (const value of values) {
      if (value.dimension !== dimension) throw new Error('selection-dimension-mismatch')
      const layerId = integer(value.layerId, 'layerId', 0, 1_000_000)
      const objectId = integer(value.objectId, 'objectId', 0, Number.MAX_SAFE_INTEGER)
      const itemKey = key(layerId, objectId)
      if (seen.has(itemKey)) throw new Error(`duplicate-selection-candidate:${itemKey}`)
      seen.add(itemKey)
      result.push(Object.freeze({
        layerId,
        objectId,
        revision: text(value.revision, 'revision', this.budget.maxRevisionLength),
        estimatedBytes: integer(value.estimatedBytes, 'estimatedBytes', 0, this.budget.maxEstimatedBytes),
        priority: integer(value.priority, 'priority', 0, this.budget.maxPriority),
      }))
    }
    return Object.freeze(result)
  }
}
