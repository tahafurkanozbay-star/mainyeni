import { hasAsciiControl } from './ArcGisScalarValidation'

export interface ArcGisFeatureAccumulatorOptions {
  readonly maxFeatures: number
  readonly maxEstimatedBytes: number
  readonly maxPages: number
  readonly maxObjectIdLength: number
  readonly maxNodesPerFeature?: number
}

export interface ArcGisFeatureLike {
  readonly attributes: Readonly<Record<string, unknown>>
  readonly geometry?: unknown
}

export interface ArcGisFeaturePage {
  readonly pageIndex: number
  readonly features: readonly ArcGisFeatureLike[]
}

export interface ArcGisFeatureAccumulatorSnapshot {
  readonly pages: number
  readonly features: number
  readonly estimatedBytes: number
  readonly firstObjectId?: string | number
  readonly lastObjectId?: string | number
}

const DEFAULTS: Required<ArcGisFeatureAccumulatorOptions> = Object.freeze({
  maxFeatures: 25_000,
  maxEstimatedBytes: 32 * 1024 * 1024,
  maxPages: 100,
  maxObjectIdLength: 128,
  maxNodesPerFeature: 250_000,
})

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS accumulator ${name} must be a positive integer`)
}

function objectId(attributes: Readonly<Record<string, unknown>>, field: string, maxLength: number): string | number {
  const descriptor = Object.getOwnPropertyDescriptor(attributes, field)
  const value = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('ArcGIS accumulator numeric object id must be a safe integer')
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (hasAsciiControl(value) || normalized.length === 0 || normalized.length > maxLength) throw new Error('ArcGIS accumulator string object id is invalid')
    return normalized
  }
  throw new Error('ArcGIS accumulator object id is missing or unsupported')
}

function stableIdKey(value: string | number): string {
  return typeof value === 'number' ? `n:${value}` : `s:${value}`
}

interface SnapshotBudget {
  nodes: number
  bytes: number
  readonly maxNodes: number
  readonly maxBytes: number
  readonly visited: WeakSet<object>
}

function consumeBudget(state: SnapshotBudget, bytes: number): void {
  state.nodes += 1
  state.bytes += bytes
  if (state.nodes > state.maxNodes) throw new Error('ArcGIS accumulator value node budget exceeded')
  if (!Number.isSafeInteger(state.bytes) || state.bytes > state.maxBytes) {
    throw new Error('ArcGIS accumulator estimated byte budget exceeded')
  }
}

/**
 * Snapshot a JSON-like ArcGIS feature payload while measuring its full retained
 * tree. Descriptors prevent getters from executing. An object encountered twice
 * is not a JSON tree (cycle or alias), so reject it instead of double-accounting.
 * The bounded walk freezes every nested object and array before acceptance.
 */
function snapshotValue(value: unknown, depth: number, state: SnapshotBudget): unknown {
  if (depth > 12) throw new Error('ArcGIS accumulator value nesting exceeds safe depth')
  if (value === null || value === undefined) {
    consumeBudget(state, 4)
    return value
  }
  if (typeof value === 'boolean') {
    consumeBudget(state, 4)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ArcGIS accumulator values must be finite')
    consumeBudget(state, 8)
    return value
  }
  if (typeof value === 'string') {
    consumeBudget(state, Math.min(value.length * 2 + 8, 1_000_008))
    return value
  }
  if (typeof value !== 'object') throw new Error('ArcGIS accumulator encountered unsupported value type')
  if (state.visited.has(value)) throw new Error('ArcGIS accumulator cyclic or shared payload object is invalid')
  state.visited.add(value)

  if (Array.isArray(value)) {
    consumeBudget(state, 8)
    if (value.length > state.maxNodes - state.nodes) {
      throw new Error('ArcGIS accumulator value node budget exceeded')
    }
    const snapshot: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('ArcGIS accumulator sparse or accessor array is invalid')
      }
      snapshot.push(snapshotValue(descriptor.value, depth + 1, state))
    }
    return Object.freeze(snapshot)
  }

  consumeBudget(state, 16)
  const snapshot: Record<string, unknown> = {}
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('ArcGIS accumulator accessor value is invalid')
    }
    // Preserve an own '__proto__' data field without invoking prototype setters.
    consumeBudget(state, key.length * 2)
    const captured = snapshotValue(descriptor.value, depth + 1, state)
    Object.defineProperty(snapshot, key, {
      value: captured, enumerable: true, writable: false, configurable: false,
    })
  }
  return Object.freeze(snapshot)
}

function snapshotFeature(feature: ArcGisFeatureLike, maxNodes: number, maxBytes: number):
  { readonly copy: ArcGisFeatureLike; readonly bytes: number } {
  if (feature === null || typeof feature !== 'object' || Array.isArray(feature)) {
    throw new Error('ArcGIS accumulator feature attributes are required')
  }
  const attributeDescriptor = Object.getOwnPropertyDescriptor(feature, 'attributes')
  const geometryDescriptor = Object.getOwnPropertyDescriptor(feature, 'geometry')
  if (attributeDescriptor === undefined || !('value' in attributeDescriptor) ||
      (geometryDescriptor !== undefined && !('value' in geometryDescriptor)) ||
      attributeDescriptor.value === null || typeof attributeDescriptor.value !== 'object' ||
      Array.isArray(attributeDescriptor.value)) {
    throw new Error('ArcGIS accumulator feature attributes are required')
  }
  const state: SnapshotBudget = {
    nodes: 0, bytes: 32, maxNodes, maxBytes, visited: new WeakSet<object>(),
  }
  const attributes = snapshotValue(attributeDescriptor.value, 0, state) as Readonly<Record<string, unknown>>
  const geometry = geometryDescriptor === undefined ? undefined : snapshotValue(geometryDescriptor.value, 0, state)
  return {
    copy: Object.freeze({ attributes, ...(geometryDescriptor === undefined ? {} : { geometry }) }),
    bytes: state.bytes,
  }
}

export class ArcGisQueryFeatureAccumulator {
  private readonly options: Required<ArcGisFeatureAccumulatorOptions>
  private readonly ids = new Set<string>()
  private readonly accepted: ArcGisFeatureLike[] = []
  private pages = 0
  private estimatedBytes = 0
  private nextPageIndex = 0
  private firstId?: string | number
  private lastId?: string | number
  private sealed = false

  constructor(private readonly objectIdField: string, options: Partial<ArcGisFeatureAccumulatorOptions> = {}) {
    const field = typeof objectIdField === 'string' ? objectIdField.trim() : ''
    if (typeof objectIdField !== 'string' || hasAsciiControl(objectIdField) || field.length === 0 || field.length > 256) throw new Error('ArcGIS accumulator objectIdField is invalid')
    this.objectIdField = field
    this.options = Object.freeze({ ...DEFAULTS, ...options })
    positiveInteger(this.options.maxFeatures, 'maxFeatures')
    positiveInteger(this.options.maxEstimatedBytes, 'maxEstimatedBytes')
    positiveInteger(this.options.maxPages, 'maxPages')
    positiveInteger(this.options.maxObjectIdLength, 'maxObjectIdLength')
    positiveInteger(this.options.maxNodesPerFeature, 'maxNodesPerFeature')
  }

  append(page: ArcGisFeaturePage): ArcGisFeatureAccumulatorSnapshot {
    if (this.sealed) throw new Error('ArcGIS accumulator is sealed')
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) throw new Error('ArcGIS accumulator pageIndex must be a non-negative safe integer')
    if (page.pageIndex !== this.nextPageIndex) throw new Error(`ArcGIS accumulator expected page ${this.nextPageIndex}`)
    if (this.pages + 1 > this.options.maxPages) throw new Error('ArcGIS accumulator page budget exceeded')
    if (this.accepted.length + page.features.length > this.options.maxFeatures) throw new Error('ArcGIS accumulator feature budget exceeded')

    if (!Array.isArray(page.features)) throw new Error('ArcGIS accumulator page features are invalid')
    const pendingIds: Array<{ key: string; value: string | number }> = []
    const pendingFeatures: ArcGisFeatureLike[] = []
    const pendingKeys = new Set<string>()
    let pendingBytes = 0
    for (let index = 0; index < page.features.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(page.features, String(index))
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('ArcGIS accumulator sparse or accessor page is invalid')
      }
      const captured = snapshotFeature(
        descriptor.value as ArcGisFeatureLike,
        this.options.maxNodesPerFeature,
        this.options.maxEstimatedBytes - this.estimatedBytes - pendingBytes,
      )
      const id = objectId(captured.copy.attributes, this.objectIdField, this.options.maxObjectIdLength)
      const key = stableIdKey(id)
      if (this.ids.has(key) || pendingKeys.has(key)) throw new Error(`ArcGIS accumulator duplicate object id ${String(id)}`)
      pendingKeys.add(key)
      pendingIds.push({ key, value: id })
      pendingFeatures.push(captured.copy)
      pendingBytes += captured.bytes
      if (this.estimatedBytes + pendingBytes > this.options.maxEstimatedBytes) {
        throw new Error('ArcGIS accumulator estimated byte budget exceeded')
      }
    }

    for (let index = 0; index < page.features.length; index += 1) {
      const feature = pendingFeatures[index]
      const id = pendingIds[index]
      if (!feature || !id) throw new Error('ArcGIS accumulator internal page alignment failure')
      this.ids.add(id.key)
      this.accepted.push(feature)
      if (this.firstId === undefined) this.firstId = id.value
      this.lastId = id.value
    }
    this.estimatedBytes += pendingBytes
    this.pages += 1
    this.nextPageIndex += 1
    return this.snapshot()
  }

  snapshot(): ArcGisFeatureAccumulatorSnapshot {
    const result: ArcGisFeatureAccumulatorSnapshot = {
      pages: this.pages,
      features: this.accepted.length,
      estimatedBytes: this.estimatedBytes,
      ...(this.firstId === undefined ? {} : { firstObjectId: this.firstId }),
      ...(this.lastId === undefined ? {} : { lastObjectId: this.lastId }),
    }
    return Object.freeze(result)
  }

  finish(): readonly ArcGisFeatureLike[] {
    this.sealed = true
    return Object.freeze([...this.accepted])
  }

  get isSealed(): boolean { return this.sealed }
}
