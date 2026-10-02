export type ArcGisLayerKind = 'feature' | 'map' | 'scene'
export type ArcGisGeometryKind = 'point' | 'polyline' | 'polygon' | 'multipoint' | 'none'
export type ArcGisLayerOperation = 'query' | 'identify' | 'edit' | 'statistics' | 'pagination' | 'attachments'

export interface ArcGisLayerCapabilityBudget {
  maxLayers: number
  maxFieldsPerLayer: number
  maxOperationsPerLayer: number
  maxRecordCountCeiling: number
  maxMetadataBytesPerLayer: number
  maxAggregateMetadataBytes: number
}

export interface ArcGisLayerFieldCapability {
  name: string
  type: 'oid' | 'globalid' | 'guid' | 'string' | 'integer' | 'double' | 'date' | 'boolean'
  editable: boolean
  nullable: boolean
  maxLength?: number
}

export interface ArcGisLayerCapabilityDescriptor {
  serviceId: string
  layerId: string
  revision: number
  kind: ArcGisLayerKind
  geometry: ArcGisGeometryKind
  wkid: number
  maxRecordCount: number
  supportsZ: boolean
  supportsM: boolean
  objectIdField?: string
  globalIdField?: string
  operations: readonly ArcGisLayerOperation[]
  fields: readonly ArcGisLayerFieldCapability[]
  estimatedMetadataBytes: number
}

export interface ArcGisLayerCapabilityView {
  readonly serviceId: string
  readonly layerId: string
  readonly revision: number
  readonly kind: ArcGisLayerKind
  readonly geometry: ArcGisGeometryKind
  readonly wkid: number
  readonly maxRecordCount: number
  readonly supportsZ: boolean
  readonly supportsM: boolean
  readonly objectIdField?: string
  readonly globalIdField?: string
  readonly operations: readonly ArcGisLayerOperation[]
  readonly fieldCount: number
  readonly estimatedMetadataBytes: number
  readonly fingerprint: string
}

interface StoredLayer extends ArcGisLayerCapabilityView {
  readonly fields: ReadonlyMap<string, Readonly<ArcGisLayerFieldCapability>>
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const OP_ORDER: readonly ArcGisLayerOperation[] = ['query', 'identify', 'edit', 'statistics', 'pagination', 'attachments']

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}
function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}
function safeId(name: string, value: string): string {
  const normalized = value.trim()
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function fieldName(name: string): string {
  const normalized = name.trim()
  if (!FIELD.test(normalized)) throw new Error(`field name is invalid: ${name}`)
  return normalized
}
function canonicalWkid(wkid: number): number {
  nonNegativeInteger('wkid', wkid)
  return wkid === 102100 || wkid === 102113 || wkid === 900913 ? 3857 : wkid
}
function hash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * Bounded, payload-free authority for ArcGIS REST layer capability metadata.
 * It deliberately stores only normalized scalar schema/capability facts. URLs,
 * tokens, renderer JSON, popup JSON, feature payloads and SDK Layer instances
 * remain caller-owned. Revision monotonicity prevents stale service metadata
 * from re-enabling operations after a refresh.
 */
export class ArcGisLayerCapabilityRegistry {
  readonly #budget: Readonly<ArcGisLayerCapabilityBudget>
  readonly #layers = new Map<string, StoredLayer>()
  #disposed = false

  constructor(budget: ArcGisLayerCapabilityBudget) {
    positiveInteger('maxLayers', budget.maxLayers)
    positiveInteger('maxFieldsPerLayer', budget.maxFieldsPerLayer)
    positiveInteger('maxOperationsPerLayer', budget.maxOperationsPerLayer)
    positiveInteger('maxRecordCountCeiling', budget.maxRecordCountCeiling)
    positiveInteger('maxMetadataBytesPerLayer', budget.maxMetadataBytesPerLayer)
    positiveInteger('maxAggregateMetadataBytes', budget.maxAggregateMetadataBytes)
    if (budget.maxOperationsPerLayer > OP_ORDER.length) throw new Error('maxOperationsPerLayer is impossible')
    if (budget.maxMetadataBytesPerLayer > budget.maxAggregateMetadataBytes) throw new Error('metadata byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  register(descriptor: ArcGisLayerCapabilityDescriptor): Readonly<ArcGisLayerCapabilityView> {
    this.#active()
    const serviceId = safeId('serviceId', descriptor.serviceId)
    const layerId = safeId('layerId', descriptor.layerId)
    nonNegativeInteger('revision', descriptor.revision)
    nonNegativeInteger('maxRecordCount', descriptor.maxRecordCount)
    positiveInteger('estimatedMetadataBytes', descriptor.estimatedMetadataBytes)
    if (descriptor.maxRecordCount > this.#budget.maxRecordCountCeiling) throw new Error('maxRecordCount exceeds ceiling')
    if (descriptor.estimatedMetadataBytes > this.#budget.maxMetadataBytesPerLayer) throw new Error('metadata exceeds per-layer budget')
    if (descriptor.fields.length > this.#budget.maxFieldsPerLayer) throw new Error('field count exceeds budget')
    if (descriptor.operations.length > this.#budget.maxOperationsPerLayer) throw new Error('operation count exceeds budget')
    if (descriptor.geometry === 'none' && (descriptor.supportsZ || descriptor.supportsM)) throw new Error('non-spatial layer cannot advertise Z or M')

    const key = this.#key(serviceId, layerId)
    const previous = this.#layers.get(key)
    if (previous && descriptor.revision <= previous.revision) throw new Error('layer revision must advance monotonically')
    if (!previous && this.#layers.size >= this.#budget.maxLayers) throw new Error('layer registry capacity exceeded')

    const operations = [...new Set(descriptor.operations)]
    if (operations.length !== descriptor.operations.length) throw new Error('duplicate operation capability')
    operations.sort((a, b) => OP_ORDER.indexOf(a) - OP_ORDER.indexOf(b))
    if (descriptor.kind === 'scene' && operations.includes('edit')) throw new Error('scene layer edit capability is unsupported')
    if (operations.includes('edit') && !descriptor.objectIdField && !descriptor.globalIdField) throw new Error('editable layer requires an identity field')
    if (operations.includes('pagination') && !operations.includes('query')) throw new Error('pagination requires query capability')
    if (operations.includes('statistics') && !operations.includes('query')) throw new Error('statistics requires query capability')

    const fields = new Map<string, Readonly<ArcGisLayerFieldCapability>>()
    for (const source of descriptor.fields) {
      const name = fieldName(source.name)
      const folded = name.toLocaleLowerCase('en-US')
      if (fields.has(folded)) throw new Error(`duplicate field: ${name}`)
      if (source.maxLength !== undefined) {
        positiveInteger(`maxLength:${name}`, source.maxLength)
        if (source.type !== 'string') throw new Error(`maxLength is only valid for string field: ${name}`)
      }
      fields.set(folded, Object.freeze({ ...source, name }))
    }

    const objectIdField = descriptor.objectIdField ? fieldName(descriptor.objectIdField) : undefined
    const globalIdField = descriptor.globalIdField ? fieldName(descriptor.globalIdField) : undefined
    if (objectIdField) {
      const field = fields.get(objectIdField.toLocaleLowerCase('en-US'))
      if (!field || field.type !== 'oid') throw new Error('objectIdField must reference an oid field')
    }
    if (globalIdField) {
      const field = fields.get(globalIdField.toLocaleLowerCase('en-US'))
      if (!field || field.type !== 'globalid') throw new Error('globalIdField must reference a globalid field')
    }

    const aggregate = this.#metadataBytes() - (previous?.estimatedMetadataBytes ?? 0) + descriptor.estimatedMetadataBytes
    if (aggregate > this.#budget.maxAggregateMetadataBytes) throw new Error('aggregate metadata budget exceeded')
    const wkid = canonicalWkid(descriptor.wkid)
    const canonical = [serviceId, layerId, descriptor.revision, descriptor.kind, descriptor.geometry, wkid,
      descriptor.maxRecordCount, Number(descriptor.supportsZ), Number(descriptor.supportsM), objectIdField ?? '', globalIdField ?? '',
      operations.join(','), [...fields.values()].map(f => `${f.name}:${f.type}:${Number(f.editable)}:${Number(f.nullable)}:${f.maxLength ?? ''}`).join(',')].join('|')
    const stored: StoredLayer = Object.freeze({
      serviceId, layerId, revision: descriptor.revision, kind: descriptor.kind, geometry: descriptor.geometry, wkid,
      maxRecordCount: descriptor.maxRecordCount, supportsZ: descriptor.supportsZ, supportsM: descriptor.supportsM,
      objectIdField, globalIdField, operations: Object.freeze(operations), fieldCount: fields.size,
      estimatedMetadataBytes: descriptor.estimatedMetadataBytes, fingerprint: hash(canonical), fields,
    })
    this.#layers.set(key, stored)
    return this.#view(stored)
  }

  get(serviceId: string, layerId: string): Readonly<ArcGisLayerCapabilityView> | undefined {
    this.#active()
    const entry = this.#layers.get(this.#key(safeId('serviceId', serviceId), safeId('layerId', layerId)))
    return entry ? this.#view(entry) : undefined
  }

  supports(serviceId: string, layerId: string, operation: ArcGisLayerOperation): boolean {
    const entry = this.#entry(serviceId, layerId)
    return entry?.operations.includes(operation) ?? false
  }

  field(serviceId: string, layerId: string, name: string): Readonly<ArcGisLayerFieldCapability> | undefined {
    const entry = this.#entry(serviceId, layerId)
    const value = entry?.fields.get(fieldName(name).toLocaleLowerCase('en-US'))
    return value ? Object.freeze({ ...value }) : undefined
  }

  assertRevision(serviceId: string, layerId: string, revision: number): boolean {
    this.#active(); nonNegativeInteger('revision', revision)
    return this.#entry(serviceId, layerId)?.revision === revision
  }

  releaseLayer(serviceId: string, layerId: string): boolean {
    this.#active()
    return this.#layers.delete(this.#key(safeId('serviceId', serviceId), safeId('layerId', layerId)))
  }

  releaseService(serviceId: string): number {
    this.#active(); const service = safeId('serviceId', serviceId)
    let removed = 0
    for (const [key, entry] of this.#layers) if (entry.serviceId === service) { this.#layers.delete(key); removed += 1 }
    return removed
  }

  snapshot(): readonly Readonly<ArcGisLayerCapabilityView>[] {
    this.#active()
    return Object.freeze([...this.#layers.values()]
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.layerId.localeCompare(b.layerId))
      .map(entry => this.#view(entry)))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => `${entry.serviceId}:${entry.layerId}:${entry.revision}:${entry.fingerprint}`).join('|')
  }

  dispose(): void { this.#layers.clear(); this.#disposed = true }

  #entry(serviceId: string, layerId: string): StoredLayer | undefined {
    this.#active(); return this.#layers.get(this.#key(safeId('serviceId', serviceId), safeId('layerId', layerId)))
  }
  #key(serviceId: string, layerId: string): string { return `${serviceId}\u0000${layerId}` }
  #metadataBytes(): number { let total = 0; for (const entry of this.#layers.values()) total += entry.estimatedMetadataBytes; return total }
  #view(entry: StoredLayer): Readonly<ArcGisLayerCapabilityView> {
    return Object.freeze({ serviceId: entry.serviceId, layerId: entry.layerId, revision: entry.revision, kind: entry.kind,
      geometry: entry.geometry, wkid: entry.wkid, maxRecordCount: entry.maxRecordCount, supportsZ: entry.supportsZ,
      supportsM: entry.supportsM, objectIdField: entry.objectIdField, globalIdField: entry.globalIdField,
      operations: Object.freeze([...entry.operations]), fieldCount: entry.fieldCount, estimatedMetadataBytes: entry.estimatedMetadataBytes,
      fingerprint: entry.fingerprint })
  }
  #active(): void { if (this.#disposed) throw new Error('ArcGisLayerCapabilityRegistry is disposed') }
}
