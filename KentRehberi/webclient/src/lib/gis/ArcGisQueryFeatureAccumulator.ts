export interface ArcGisFeatureAccumulatorOptions {
  readonly maxFeatures: number
  readonly maxEstimatedBytes: number
  readonly maxPages: number
  readonly maxObjectIdLength: number
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

const DEFAULTS: ArcGisFeatureAccumulatorOptions = Object.freeze({
  maxFeatures: 25_000,
  maxEstimatedBytes: 32 * 1024 * 1024,
  maxPages: 100,
  maxObjectIdLength: 128,
})

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS accumulator ${name} must be a positive integer`)
}

function objectId(attributes: Readonly<Record<string, unknown>>, field: string, maxLength: number): string | number {
  const value = attributes[field]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('ArcGIS accumulator numeric object id must be a safe integer')
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized.length === 0 || normalized.length > maxLength) throw new Error('ArcGIS accumulator string object id is invalid')
    return normalized
  }
  throw new Error('ArcGIS accumulator object id is missing or unsupported')
}

function stableIdKey(value: string | number): string {
  return typeof value === 'number' ? `n:${value}` : `s:${value}`
}

function estimateValue(value: unknown, depth = 0): number {
  if (depth > 12) throw new Error('ArcGIS accumulator value nesting exceeds safe depth')
  if (value === null || value === undefined) return 4
  if (typeof value === 'boolean') return 4
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ArcGIS accumulator values must be finite')
    return 8
  }
  if (typeof value === 'string') return Math.min(value.length * 2 + 8, 1_000_008)
  if (Array.isArray(value)) {
    let bytes = 8
    for (const item of value) bytes += estimateValue(item, depth + 1)
    return bytes
  }
  if (typeof value === 'object') {
    let bytes = 16
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      bytes += key.length * 2 + estimateValue(item, depth + 1)
    }
    return bytes
  }
  throw new Error('ArcGIS accumulator encountered unsupported value type')
}

function estimateFeature(feature: ArcGisFeatureLike): number {
  return 32 + estimateValue(feature.attributes) + (feature.geometry === undefined ? 0 : estimateValue(feature.geometry))
}

export class ArcGisQueryFeatureAccumulator {
  private readonly options: ArcGisFeatureAccumulatorOptions
  private readonly ids = new Set<string>()
  private readonly accepted: ArcGisFeatureLike[] = []
  private pages = 0
  private estimatedBytes = 0
  private nextPageIndex = 0
  private firstId?: string | number
  private lastId?: string | number
  private sealed = false

  constructor(private readonly objectIdField: string, options: Partial<ArcGisFeatureAccumulatorOptions> = {}) {
    const field = objectIdField.trim()
    if (field.length === 0 || field.length > 256) throw new Error('ArcGIS accumulator objectIdField is invalid')
    this.objectIdField = field
    this.options = Object.freeze({ ...DEFAULTS, ...options })
    positiveInteger(this.options.maxFeatures, 'maxFeatures')
    positiveInteger(this.options.maxEstimatedBytes, 'maxEstimatedBytes')
    positiveInteger(this.options.maxPages, 'maxPages')
    positiveInteger(this.options.maxObjectIdLength, 'maxObjectIdLength')
  }

  append(page: ArcGisFeaturePage): ArcGisFeatureAccumulatorSnapshot {
    if (this.sealed) throw new Error('ArcGIS accumulator is sealed')
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) throw new Error('ArcGIS accumulator pageIndex must be a non-negative safe integer')
    if (page.pageIndex !== this.nextPageIndex) throw new Error(`ArcGIS accumulator expected page ${this.nextPageIndex}`)
    if (this.pages + 1 > this.options.maxPages) throw new Error('ArcGIS accumulator page budget exceeded')
    if (this.accepted.length + page.features.length > this.options.maxFeatures) throw new Error('ArcGIS accumulator feature budget exceeded')

    const pendingIds: Array<{ key: string; value: string | number }> = []
    const pendingKeys = new Set<string>()
    let pendingBytes = 0
    for (const feature of page.features) {
      if (!feature || typeof feature !== 'object' || !feature.attributes || typeof feature.attributes !== 'object') {
        throw new Error('ArcGIS accumulator feature attributes are required')
      }
      const id = objectId(feature.attributes, this.objectIdField, this.options.maxObjectIdLength)
      const key = stableIdKey(id)
      if (this.ids.has(key) || pendingKeys.has(key)) throw new Error(`ArcGIS accumulator duplicate object id ${String(id)}`)
      pendingKeys.add(key)
      pendingIds.push({ key, value: id })
      pendingBytes += estimateFeature(feature)
      if (this.estimatedBytes + pendingBytes > this.options.maxEstimatedBytes) throw new Error('ArcGIS accumulator estimated byte budget exceeded')
    }

    for (let index = 0; index < page.features.length; index += 1) {
      const feature = page.features[index]
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
