export type ArcGisEditValidationOperation = 'add' | 'update' | 'delete'
export type ArcGisEditGeometryType = 'none' | 'point' | 'multipoint' | 'polyline' | 'polygon'
export type ArcGisEditFieldType = 'string' | 'integer' | 'double' | 'boolean' | 'date' | 'guid' | 'oid' | 'globalid'

export interface ArcGisEditValidationBudget {
  maxSchemas: number
  maxFieldsPerSchema: number
  maxFeaturesPerBatch: number
  maxAttributesPerFeature: number
  maxStringLength: number
  maxFieldNameLength: number
  maxAttributeBytesPerFeature: number
  maxBatchAttributeBytes: number
  maxVerticesPerFeature: number
  maxBatchVertices: number
}

export interface ArcGisEditFieldDefinition {
  name: string
  type: ArcGisEditFieldType
  editable: boolean
  nullable: boolean
  hasDefaultValue?: boolean
  maxLength?: number
}

export interface ArcGisEditLayerSchema {
  layerId: string
  revision: number
  geometryType: ArcGisEditGeometryType
  wkid: number
  objectIdField?: string
  globalIdField?: string
  operations: readonly ArcGisEditValidationOperation[]
  fields: readonly ArcGisEditFieldDefinition[]
}

export interface ArcGisEditAttribute {
  field: string
  value: string | number | boolean | null
}

export interface ArcGisEditFeatureMutation {
  clientId: string
  objectId?: number
  globalId?: string
  geometryType: ArcGisEditGeometryType
  wkid: number
  vertexCount: number
  attributes: readonly ArcGisEditAttribute[]
}

export interface ArcGisEditValidationRequest {
  layerId: string
  revision: number
  operation: ArcGisEditValidationOperation
  features: readonly ArcGisEditFeatureMutation[]
}

export interface ArcGisEditValidationPlan {
  readonly layerId: string
  readonly revision: number
  readonly operation: ArcGisEditValidationOperation
  readonly featureCount: number
  readonly attributeCount: number
  readonly attributeBytes: number
  readonly vertexCount: number
  readonly clientIds: readonly string[]
  readonly fieldNames: readonly string[]
  readonly fingerprint: string
}

interface NormalizedField {
  readonly name: string
  readonly key: string
  readonly type: ArcGisEditFieldType
  readonly editable: boolean
  readonly nullable: boolean
  readonly hasDefaultValue: boolean
  readonly maxLength: number
}

interface RegisteredSchema {
  readonly layerId: string
  readonly revision: number
  readonly geometryType: ArcGisEditGeometryType
  readonly wkid: number
  readonly objectIdFieldKey: string | null
  readonly globalIdFieldKey: string | null
  readonly operations: ReadonlySet<ArcGisEditValidationOperation>
  readonly fields: ReadonlyMap<string, NormalizedField>
}

const FIELD_TYPES = new Set<ArcGisEditFieldType>(['string', 'integer', 'double', 'boolean', 'date', 'guid', 'oid', 'globalid'])
const GEOMETRY_TYPES = new Set<ArcGisEditGeometryType>(['none', 'point', 'multipoint', 'polyline', 'polygon'])
const OPERATIONS = new Set<ArcGisEditValidationOperation>(['add', 'update', 'delete'])
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_ID = /^[A-Za-z0-9_.:-]+$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function identifier(name: string, value: string, maxLength = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || !SAFE_ID.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function fieldName(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || !FIELD_NAME.test(normalized)) throw new Error('invalid-field-name')
  return normalized
}

function fieldKey(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function geometryType(value: ArcGisEditGeometryType): ArcGisEditGeometryType {
  if (!GEOMETRY_TYPES.has(value)) throw new Error('invalid-geometry-type')
  return value
}

function operation(value: ArcGisEditValidationOperation): ArcGisEditValidationOperation {
  if (!OPERATIONS.has(value)) throw new Error('invalid-edit-operation')
  return value
}

function canonicalWkid(value: number): number {
  const wkid = nonNegativeInteger('wkid', value)
  if (wkid === 102100 || wkid === 102113) return 3857
  return wkid
}

function normalizeGuid(value: string): string {
  const normalized = value.trim().replace(/^\{|\}$/g, '').toLowerCase()
  if (!GUID.test(normalized)) throw new Error('invalid-global-id')
  return normalized
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

function scalarFingerprint(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `s:${value}`
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0'
  return `n:${String(value)}`
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
 * Payload-free schema and mutation admission authority for ArcGIS FeatureServer
 * applyEdits callers. The policy validates scalar attribute values transiently
 * but retains only bounded schema metadata; Graphic/Geometry objects, feature
 * payloads, credentials, request bodies and transport handles remain caller-owned.
 *
 * Registered layer revisions are monotonic. A mutation must target the exact
 * admitted revision so schema drift cannot silently reinterpret fields while an
 * edit batch is in flight.
 */
export class ArcGisEditValidationPolicy {
  readonly #budget: Readonly<ArcGisEditValidationBudget>
  readonly #schemas = new Map<string, RegisteredSchema>()
  #disposed = false

  constructor(budget: ArcGisEditValidationBudget) {
    const normalized = {
      maxSchemas: positiveInteger('maxSchemas', budget.maxSchemas),
      maxFieldsPerSchema: positiveInteger('maxFieldsPerSchema', budget.maxFieldsPerSchema),
      maxFeaturesPerBatch: positiveInteger('maxFeaturesPerBatch', budget.maxFeaturesPerBatch),
      maxAttributesPerFeature: positiveInteger('maxAttributesPerFeature', budget.maxAttributesPerFeature),
      maxStringLength: positiveInteger('maxStringLength', budget.maxStringLength),
      maxFieldNameLength: positiveInteger('maxFieldNameLength', budget.maxFieldNameLength),
      maxAttributeBytesPerFeature: positiveInteger('maxAttributeBytesPerFeature', budget.maxAttributeBytesPerFeature),
      maxBatchAttributeBytes: positiveInteger('maxBatchAttributeBytes', budget.maxBatchAttributeBytes),
      maxVerticesPerFeature: positiveInteger('maxVerticesPerFeature', budget.maxVerticesPerFeature),
      maxBatchVertices: positiveInteger('maxBatchVertices', budget.maxBatchVertices),
    }
    if (normalized.maxAttributeBytesPerFeature > normalized.maxBatchAttributeBytes) throw new Error('attribute byte budget is inconsistent')
    if (normalized.maxVerticesPerFeature > normalized.maxBatchVertices) throw new Error('vertex budget is inconsistent')
    this.#budget = Object.freeze(normalized)
  }

  registerSchema(input: ArcGisEditLayerSchema): Readonly<{ layerId: string; revision: number; fieldCount: number; fingerprint: string }> {
    this.#active()
    const layerId = identifier('layer-id', input.layerId)
    const revision = nonNegativeInteger('revision', input.revision)
    const layerGeometry = geometryType(input.geometryType)
    const wkid = canonicalWkid(input.wkid)
    if (layerGeometry === 'none' && wkid !== 0) throw new Error('table-schema-must-use-wkid-zero')
    if (layerGeometry !== 'none' && wkid === 0) throw new Error('spatial-schema-requires-wkid')
    if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > this.#budget.maxFieldsPerSchema) throw new Error('schema-field-budget-exceeded')
    if (!Array.isArray(input.operations) || input.operations.length < 1) throw new Error('schema-operations-required')

    const current = this.#schemas.get(layerId)
    if (current && revision <= current.revision) throw new Error('schema-revision-must-advance')
    if (!current && this.#schemas.size >= this.#budget.maxSchemas) throw new Error('schema-capacity-exceeded')

    const fields = new Map<string, NormalizedField>()
    for (const definition of input.fields) {
      const name = fieldName(definition.name, this.#budget.maxFieldNameLength)
      const key = fieldKey(name)
      if (fields.has(key)) throw new Error('duplicate-schema-field')
      if (!FIELD_TYPES.has(definition.type)) throw new Error('invalid-field-type')
      const maxLength = definition.type === 'string'
        ? positiveInteger(`maxLength:${name}`, definition.maxLength ?? this.#budget.maxStringLength)
        : 0
      if (maxLength > this.#budget.maxStringLength) throw new Error('field-string-budget-exceeded')
      fields.set(key, Object.freeze({
        name,
        key,
        type: definition.type,
        editable: definition.editable === true,
        nullable: definition.nullable === true,
        hasDefaultValue: definition.hasDefaultValue === true,
        maxLength,
      }))
    }

    const objectIdFieldKey = this.#identityField(input.objectIdField, fields, 'oid')
    const globalIdFieldKey = this.#identityField(input.globalIdField, fields, 'globalid')
    const operations = new Set<ArcGisEditValidationOperation>()
    for (const candidate of input.operations) {
      const normalizedOperation = operation(candidate)
      if (operations.has(normalizedOperation)) throw new Error('duplicate-schema-operation')
      operations.add(normalizedOperation)
    }
    if ((operations.has('update') || operations.has('delete')) && !objectIdFieldKey && !globalIdFieldKey) throw new Error('mutation-schema-missing-identity')

    const schema: RegisteredSchema = Object.freeze({
      layerId,
      revision,
      geometryType: layerGeometry,
      wkid,
      objectIdFieldKey,
      globalIdFieldKey,
      operations,
      fields,
    })
    this.#schemas.set(layerId, schema)
    const fingerprint = hash([
      layerId, String(revision), layerGeometry, String(wkid),
      ...[...operations].sort(),
      ...[...fields.values()].sort((a, b) => a.key.localeCompare(b.key)).map(field => `${field.key}:${field.type}:${field.editable ? 1 : 0}:${field.nullable ? 1 : 0}:${field.hasDefaultValue ? 1 : 0}:${field.maxLength}`),
    ])
    return Object.freeze({ layerId, revision, fieldCount: fields.size, fingerprint })
  }

  validate(request: ArcGisEditValidationRequest): ArcGisEditValidationPlan {
    this.#active()
    const layerId = identifier('layer-id', request.layerId)
    const revision = nonNegativeInteger('revision', request.revision)
    const editOperation = operation(request.operation)
    const schema = this.#schemas.get(layerId)
    if (!schema) throw new Error('edit-schema-not-registered')
    if (revision !== schema.revision) throw new Error('stale-edit-schema-revision')
    if (!schema.operations.has(editOperation)) throw new Error('edit-operation-not-advertised')
    if (!Array.isArray(request.features) || request.features.length < 1 || request.features.length > this.#budget.maxFeaturesPerBatch) throw new Error('edit-feature-budget-exceeded')

    const clientIds = new Set<string>()
    const fieldNames = new Map<string, string>()
    const fingerprintParts: string[] = [layerId, String(revision), editOperation]
    let attributeCount = 0
    let attributeBytes = 0
    let vertexCount = 0

    const features = [...request.features].map(feature => this.#normalizeFeature(schema, editOperation, feature))
      .sort((left, right) => left.clientId.localeCompare(right.clientId))

    for (const feature of features) {
      if (clientIds.has(feature.clientId)) throw new Error('duplicate-edit-client-id')
      clientIds.add(feature.clientId)
      attributeCount += feature.attributeCount
      attributeBytes += feature.attributeBytes
      vertexCount += feature.vertexCount
      if (attributeBytes > this.#budget.maxBatchAttributeBytes) throw new Error('edit-batch-attribute-byte-budget-exceeded')
      if (vertexCount > this.#budget.maxBatchVertices) throw new Error('edit-batch-vertex-budget-exceeded')
      for (const name of feature.fieldNames) fieldNames.set(fieldKey(name), name)
      fingerprintParts.push(feature.fingerprint)
    }

    return Object.freeze({
      layerId,
      revision,
      operation: editOperation,
      featureCount: features.length,
      attributeCount,
      attributeBytes,
      vertexCount,
      clientIds: Object.freeze([...clientIds].sort()),
      fieldNames: Object.freeze([...fieldNames.values()].sort((a, b) => a.localeCompare(b))),
      fingerprint: hash(fingerprintParts),
    })
  }

  currentRevision(layerIdInput: string): number | undefined {
    this.#active()
    return this.#schemas.get(identifier('layer-id', layerIdInput))?.revision
  }

  releaseLayer(layerIdInput: string): boolean {
    this.#active()
    return this.#schemas.delete(identifier('layer-id', layerIdInput))
  }

  snapshot(): readonly Readonly<{ layerId: string; revision: number; fieldCount: number }>[] {
    this.#active()
    return Object.freeze([...this.#schemas.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId))
      .map(schema => Object.freeze({ layerId: schema.layerId, revision: schema.revision, fieldCount: schema.fields.size })))
  }

  fingerprint(): string {
    this.#active()
    return hash([...this.#schemas.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId))
      .map(schema => `${schema.layerId}:${schema.revision}:${schema.geometryType}:${schema.wkid}:${schema.fields.size}`))
  }

  dispose(): void {
    this.#schemas.clear()
    this.#disposed = true
  }

  #identityField(value: string | undefined, fields: Map<string, NormalizedField>, requiredType: 'oid' | 'globalid'): string | null {
    if (!value) return null
    const name = fieldName(value, this.#budget.maxFieldNameLength)
    const key = fieldKey(name)
    const definition = fields.get(key)
    if (!definition || definition.type !== requiredType) throw new Error(`invalid-${requiredType}-field`)
    if (definition.editable) throw new Error(`${requiredType}-field-cannot-be-editable`)
    return key
  }

  #normalizeFeature(schema: RegisteredSchema, editOperation: ArcGisEditValidationOperation, feature: ArcGisEditFeatureMutation): {
    clientId: string
    attributeCount: number
    attributeBytes: number
    vertexCount: number
    fieldNames: readonly string[]
    fingerprint: string
  } {
    const clientId = identifier('client-id', feature.clientId)
    const geometry = geometryType(feature.geometryType)
    const wkid = canonicalWkid(feature.wkid)
    const vertices = nonNegativeInteger('vertexCount', feature.vertexCount)
    if (vertices > this.#budget.maxVerticesPerFeature) throw new Error('edit-feature-vertex-budget-exceeded')
    if (!Array.isArray(feature.attributes) || feature.attributes.length > this.#budget.maxAttributesPerFeature) throw new Error('edit-attribute-count-budget-exceeded')

    const objectId = feature.objectId === undefined ? null : nonNegativeInteger('objectId', feature.objectId)
    const globalId = feature.globalId === undefined ? null : normalizeGuid(feature.globalId)
    if (editOperation === 'add' && objectId !== null) throw new Error('add-cannot-provide-object-id')
    if ((editOperation === 'update' || editOperation === 'delete') && objectId === null && globalId === null) throw new Error('mutation-identity-required')
    if (objectId !== null && !schema.objectIdFieldKey) throw new Error('object-id-not-declared')
    if (globalId !== null && !schema.globalIdFieldKey) throw new Error('global-id-not-declared')

    if (editOperation === 'delete') {
      if (feature.attributes.length !== 0 || vertices !== 0 || geometry !== 'none' || wkid !== 0) throw new Error('delete-must-be-identity-only')
      return {
        clientId,
        attributeCount: 0,
        attributeBytes: 0,
        vertexCount: 0,
        fieldNames: Object.freeze([]),
        fingerprint: hash([clientId, String(objectId ?? ''), globalId ?? '', 'delete']),
      }
    }

    if (schema.geometryType === 'none') {
      if (geometry !== 'none' || wkid !== 0 || vertices !== 0) throw new Error('table-edit-cannot-contain-geometry')
    } else if (vertices > 0) {
      if (geometry !== schema.geometryType) throw new Error('edit-geometry-type-mismatch')
      if (wkid !== schema.wkid) throw new Error('edit-spatial-reference-mismatch')
    } else if (geometry !== 'none' || wkid !== 0) {
      throw new Error('empty-geometry-must-use-none')
    }

    const seen = new Set<string>()
    const normalizedAttributes: Array<{ name: string; key: string; bytes: number; fingerprint: string; isNull: boolean }> = []
    for (const attribute of feature.attributes) {
      const name = fieldName(attribute.field, this.#budget.maxFieldNameLength)
      const key = fieldKey(name)
      if (seen.has(key)) throw new Error('duplicate-edit-attribute')
      seen.add(key)
      const field = schema.fields.get(key)
      if (!field) throw new Error('edit-field-not-in-schema')
      if (key === schema.objectIdFieldKey || key === schema.globalIdFieldKey) throw new Error('identity-field-cannot-be-mutated')
      if (!field.editable) throw new Error('edit-field-not-editable')
      const scalar = this.#validateScalar(field, attribute.value)
      normalizedAttributes.push({
        name: field.name,
        key,
        bytes: utf8Bytes(field.name) + scalar.bytes,
        fingerprint: `${key}:${scalar.fingerprint}`,
        isNull: attribute.value === null,
      })
    }

    if (editOperation === 'add') {
      for (const field of schema.fields.values()) {
        if (!field.editable || field.nullable || field.hasDefaultValue || field.key === schema.objectIdFieldKey || field.key === schema.globalIdFieldKey) continue
        const supplied = normalizedAttributes.find(attribute => attribute.key === field.key)
        if (!supplied || supplied.isNull) throw new Error(`required-edit-field-missing:${field.name}`)
      }
    }

    const attributeBytes = normalizedAttributes.reduce((sum, attribute) => sum + attribute.bytes, 0)
    if (attributeBytes > this.#budget.maxAttributeBytesPerFeature) throw new Error('edit-feature-attribute-byte-budget-exceeded')
    normalizedAttributes.sort((a, b) => a.key.localeCompare(b.key))
    return {
      clientId,
      attributeCount: normalizedAttributes.length,
      attributeBytes,
      vertexCount: vertices,
      fieldNames: Object.freeze(normalizedAttributes.map(attribute => attribute.name)),
      fingerprint: hash([
        clientId,
        String(objectId ?? ''),
        globalId ?? '',
        geometry,
        String(wkid),
        String(vertices),
        ...normalizedAttributes.map(attribute => attribute.fingerprint),
      ]),
    }
  }

  #validateScalar(field: NormalizedField, value: string | number | boolean | null): { bytes: number; fingerprint: string } {
    if (value === null) {
      if (!field.nullable) throw new Error(`non-nullable-edit-field:${field.name}`)
      return { bytes: 0, fingerprint: 'null' }
    }
    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') throw new Error(`edit-field-type-mismatch:${field.name}`)
        if (value.length > field.maxLength || value.length > this.#budget.maxStringLength) throw new Error(`edit-string-budget-exceeded:${field.name}`)
        return { bytes: utf8Bytes(value), fingerprint: scalarFingerprint(value) }
      case 'integer':
      case 'oid':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`edit-field-type-mismatch:${field.name}`)
        return { bytes: 8, fingerprint: scalarFingerprint(value) }
      case 'double':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`edit-field-type-mismatch:${field.name}`)
        return { bytes: 8, fingerprint: scalarFingerprint(value) }
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`edit-field-type-mismatch:${field.name}`)
        return { bytes: 1, fingerprint: scalarFingerprint(value) }
      case 'date':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`edit-field-type-mismatch:${field.name}`)
        return { bytes: 8, fingerprint: scalarFingerprint(value) }
      case 'guid':
      case 'globalid':
        if (typeof value !== 'string') throw new Error(`edit-field-type-mismatch:${field.name}`)
        return { bytes: 36, fingerprint: `g:${normalizeGuid(value)}` }
    }
  }

  #active(): void {
    if (this.#disposed) throw new Error('ArcGisEditValidationPolicy is disposed')
  }
}
