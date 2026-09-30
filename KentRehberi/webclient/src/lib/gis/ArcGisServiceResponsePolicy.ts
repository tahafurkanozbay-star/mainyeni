export type ArcGisServiceResponseKind = 'query' | 'identify' | 'legend' | 'metadata'

export interface ArcGisServiceResponseBudget {
  readonly maxLayers: number
  readonly maxFeatures: number
  readonly maxFields: number
  readonly maxBytes: number
  readonly maxObjectIdCount: number
  readonly maxStringLength: number
  readonly maxFieldNameLength: number
  readonly maxLayerIdLength: number
}

export interface ArcGisServiceResponseInput {
  readonly requestId: string
  readonly layerId: string
  readonly revision: number
  readonly kind: ArcGisServiceResponseKind
  readonly byteLength: number
  readonly featureCount: number
  readonly fieldNames: readonly string[]
  readonly objectIds?: readonly number[]
  readonly exceededTransferLimit?: boolean
  readonly sourceLayerCount?: number
}

export interface ArcGisServiceResponsePlan {
  readonly requestId: string
  readonly layerId: string
  readonly revision: number
  readonly kind: ArcGisServiceResponseKind
  readonly byteLength: number
  readonly featureCount: number
  readonly fieldNames: readonly string[]
  readonly objectIds: readonly number[]
  readonly sourceLayerCount: number
  readonly exceededTransferLimit: boolean
  readonly requiresContinuation: boolean
  readonly fingerprint: string
}

const KINDS = new Set<ArcGisServiceResponseKind>(['query', 'identify', 'legend', 'metadata'])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function responseKind(value: ArcGisServiceResponseKind): ArcGisServiceResponseKind {
  if (!KINDS.has(value)) throw new Error('invalid-response-kind')
  return value
}

function hash(parts: readonly string[]): string {
  let value = 2166136261
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      value ^= part.charCodeAt(index)
      value = Math.imul(value, 16777619)
    }
    value ^= 31
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * Transport-independent integrity gate for already received ArcGIS REST response
 * metadata. The policy intentionally does not retain payloads, geometries, SDK
 * objects, fetch handles or service URLs. Existing service adapters remain the
 * sole network authority; this class only decides whether bounded response facts
 * are safe to admit into downstream GIS state.
 */
export class ArcGisServiceResponsePolicy {
  private readonly budget: Readonly<ArcGisServiceResponseBudget>
  private readonly latestRevisionByLayer = new Map<string, number>()
  private disposed = false

  constructor(budget: ArcGisServiceResponseBudget) {
    this.budget = Object.freeze({
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1, 100_000),
      maxFeatures: integer(budget.maxFeatures, 'maxFeatures', 0, 10_000_000),
      maxFields: integer(budget.maxFields, 'maxFields', 0, 10_000),
      maxBytes: integer(budget.maxBytes, 'maxBytes', 1, 2 * 1024 * 1024 * 1024),
      maxObjectIdCount: integer(budget.maxObjectIdCount, 'maxObjectIdCount', 0, 10_000_000),
      maxStringLength: integer(budget.maxStringLength, 'maxStringLength', 1, 65_536),
      maxFieldNameLength: integer(budget.maxFieldNameLength, 'maxFieldNameLength', 1, 512),
      maxLayerIdLength: integer(budget.maxLayerIdLength, 'maxLayerIdLength', 1, 512),
    })
  }

  admit(input: ArcGisServiceResponseInput): ArcGisServiceResponsePlan {
    this.assertLive()
    const requestId = text(input.requestId, 'request-id', this.budget.maxStringLength)
    const layerId = text(input.layerId, 'layer-id', this.budget.maxLayerIdLength)
    const revision = integer(input.revision, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const kind = responseKind(input.kind)
    const byteLength = integer(input.byteLength, 'byteLength', 0, this.budget.maxBytes)
    const featureCount = integer(input.featureCount, 'featureCount', 0, this.budget.maxFeatures)
    const sourceLayerCount = integer(input.sourceLayerCount ?? 1, 'sourceLayerCount', 0, this.budget.maxLayers)
    const fieldNames = this.normalizeFields(input.fieldNames)
    const objectIds = this.normalizeObjectIds(input.objectIds ?? [])
    const latestRevision = this.latestRevisionByLayer.get(layerId)
    if (latestRevision !== undefined && revision < latestRevision) throw new Error('stale-service-response')
    this.validateShape(kind, featureCount, fieldNames.length, objectIds.length, sourceLayerCount)
    this.latestRevisionByLayer.set(layerId, revision)
    const exceededTransferLimit = input.exceededTransferLimit === true
    const requiresContinuation = exceededTransferLimit && kind === 'query'
    const fingerprint = hash([
      requestId,
      layerId,
      String(revision),
      kind,
      String(byteLength),
      String(featureCount),
      String(sourceLayerCount),
      exceededTransferLimit ? '1' : '0',
      ...fieldNames,
      ...objectIds.map(String),
    ])
    return Object.freeze({
      requestId,
      layerId,
      revision,
      kind,
      byteLength,
      featureCount,
      fieldNames,
      objectIds,
      sourceLayerCount,
      exceededTransferLimit,
      requiresContinuation,
      fingerprint,
    })
  }

  invalidateLayer(layerIdInput: string, minimumRevisionInput: number): void {
    this.assertLive()
    const layerId = text(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const minimumRevision = integer(minimumRevisionInput, 'minimumRevision', 0, Number.MAX_SAFE_INTEGER)
    const current = this.latestRevisionByLayer.get(layerId)
    if (current === undefined || minimumRevision > current) this.latestRevisionByLayer.set(layerId, minimumRevision)
  }

  latestRevision(layerIdInput: string): number | undefined {
    this.assertLive()
    const layerId = text(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    return this.latestRevisionByLayer.get(layerId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.latestRevisionByLayer.clear()
  }

  private normalizeFields(values: readonly string[]): readonly string[] {
    if (!Array.isArray(values) || values.length > this.budget.maxFields) throw new Error('response-field-budget-exceeded')
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const value of values) {
      const field = text(value, 'field-name', this.budget.maxFieldNameLength)
      const key = field.toLocaleLowerCase('en-US')
      if (seen.has(key)) throw new Error('duplicate-response-field')
      seen.add(key)
      normalized.push(field)
    }
    return Object.freeze(normalized.sort((left, right) => left.localeCompare(right)))
  }

  private normalizeObjectIds(values: readonly number[]): readonly number[] {
    if (!Array.isArray(values) || values.length > this.budget.maxObjectIdCount) throw new Error('response-object-id-budget-exceeded')
    const seen = new Set<number>()
    const normalized: number[] = []
    for (const value of values) {
      const objectId = integer(value, 'objectId', 0, Number.MAX_SAFE_INTEGER)
      if (seen.has(objectId)) throw new Error('duplicate-response-object-id')
      seen.add(objectId)
      normalized.push(objectId)
    }
    return Object.freeze(normalized.sort((left, right) => left - right))
  }

  private validateShape(kind: ArcGisServiceResponseKind, featureCount: number, fieldCount: number, objectIdCount: number, sourceLayerCount: number): void {
    if (kind === 'metadata' && featureCount !== 0) throw new Error('metadata-response-cannot-contain-features')
    if (kind === 'legend' && objectIdCount !== 0) throw new Error('legend-response-cannot-contain-object-ids')
    if (kind === 'identify' && sourceLayerCount === 0 && featureCount > 0) throw new Error('identify-response-missing-source-layer')
    if (kind === 'query' && objectIdCount > 0 && featureCount > 0 && objectIdCount !== featureCount) throw new Error('query-object-id-count-mismatch')
    if ((kind === 'query' || kind === 'identify') && featureCount > 0 && fieldCount === 0) throw new Error('feature-response-missing-fields')
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-service-response-policy-disposed')
  }
}
