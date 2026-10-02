import { describe, expect, it } from 'vitest'
import {
  ArcGisEditValidationPolicy,
  type ArcGisEditFeatureMutation,
  type ArcGisEditLayerSchema,
  type ArcGisEditValidationBudget,
  type ArcGisEditValidationRequest,
} from './ArcGisEditValidationPolicy'

const budget: ArcGisEditValidationBudget = {
  maxSchemas: 3,
  maxFieldsPerSchema: 12,
  maxFeaturesPerBatch: 3,
  maxAttributesPerFeature: 6,
  maxStringLength: 32,
  maxFieldNameLength: 32,
  maxAttributeBytesPerFeature: 128,
  maxBatchAttributeBytes: 256,
  maxVerticesPerFeature: 100,
  maxBatchVertices: 150,
}

const schema = (overrides: Partial<ArcGisEditLayerSchema> = {}): ArcGisEditLayerSchema => ({
  layerId: 'parcels',
  revision: 1,
  geometryType: 'polygon',
  wkid: 102100,
  objectIdField: 'OBJECTID',
  globalIdField: 'GlobalID',
  operations: ['add', 'update', 'delete'],
  fields: [
    { name: 'OBJECTID', type: 'oid', editable: false, nullable: false },
    { name: 'GlobalID', type: 'globalid', editable: false, nullable: false },
    { name: 'NAME', type: 'string', editable: true, nullable: false, maxLength: 10 },
    { name: 'SCORE', type: 'double', editable: true, nullable: true },
    { name: 'ENABLED', type: 'boolean', editable: true, nullable: false, hasDefaultValue: true },
    { name: 'UPDATED', type: 'date', editable: true, nullable: true },
    { name: 'CODE', type: 'guid', editable: true, nullable: true },
    { name: 'SERVER_NOTE', type: 'string', editable: false, nullable: true, maxLength: 20 },
  ],
  ...overrides,
})

const addFeature = (overrides: Partial<ArcGisEditFeatureMutation> = {}): ArcGisEditFeatureMutation => ({
  clientId: 'feature-a',
  geometryType: 'polygon',
  wkid: 3857,
  vertexCount: 10,
  attributes: [{ field: 'NAME', value: 'Parcel A' }],
  ...overrides,
})

const updateFeature = (overrides: Partial<ArcGisEditFeatureMutation> = {}): ArcGisEditFeatureMutation => ({
  clientId: 'feature-u',
  objectId: 42,
  geometryType: 'none',
  wkid: 0,
  vertexCount: 0,
  attributes: [{ field: 'SCORE', value: 12.5 }],
  ...overrides,
})

const deleteFeature = (overrides: Partial<ArcGisEditFeatureMutation> = {}): ArcGisEditFeatureMutation => ({
  clientId: 'feature-d',
  objectId: 42,
  geometryType: 'none',
  wkid: 0,
  vertexCount: 0,
  attributes: [],
  ...overrides,
})

const request = (
  operation: ArcGisEditValidationRequest['operation'],
  features: readonly ArcGisEditFeatureMutation[],
  overrides: Partial<ArcGisEditValidationRequest> = {},
): ArcGisEditValidationRequest => ({
  layerId: 'parcels',
  revision: 1,
  operation,
  features,
  ...overrides,
})

const registered = (customBudget = budget, customSchema = schema()) => {
  const policy = new ArcGisEditValidationPolicy(customBudget)
  policy.registerSchema(customSchema)
  return policy
}

describe('ArcGisEditValidationPolicy', () => {
  it('registers bounded schema metadata and canonicalizes Web Mercator aliases', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    const result = policy.registerSchema(schema())
    expect(result).toEqual(expect.objectContaining({ layerId: 'parcels', revision: 1, fieldCount: 8 }))
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(policy.snapshot()).toEqual([{ layerId: 'parcels', revision: 1, fieldCount: 8 }])
  })

  it('requires schema revisions to move monotonically forward', () => {
    const policy = registered()
    expect(() => policy.registerSchema(schema())).toThrow(/revision/)
    expect(() => policy.registerSchema(schema({ revision: 0 }))).toThrow(/revision/)
    expect(() => policy.registerSchema(schema({ revision: 2 }))).not.toThrow()
    expect(policy.currentRevision('parcels')).toBe(2)
  })

  it('bounds registered schema cardinality', () => {
    const policy = new ArcGisEditValidationPolicy({ ...budget, maxSchemas: 1 })
    policy.registerSchema(schema())
    expect(() => policy.registerSchema(schema({ layerId: 'buildings' }))).toThrow(/capacity/)
  })

  it('rejects duplicate schema fields case-insensitively', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    expect(() => policy.registerSchema(schema({
      fields: [...schema().fields, { name: 'name', type: 'string', editable: true, nullable: true }],
    }))).toThrow(/duplicate/)
  })

  it('rejects identity fields with the wrong ArcGIS field type', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    expect(() => policy.registerSchema(schema({ objectIdField: 'NAME' }))).toThrow(/oid-field/)
    expect(() => policy.registerSchema(schema({ globalIdField: 'CODE' }))).toThrow(/globalid-field/)
  })

  it('rejects editable object/global identity fields', () => {
    const fields = schema().fields.map(field => field.name === 'OBJECTID' ? { ...field, editable: true } : field)
    expect(() => new ArcGisEditValidationPolicy(budget).registerSchema(schema({ fields }))).toThrow(/cannot-be-editable/)
  })

  it('requires identity metadata when update or delete is advertised', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    expect(() => policy.registerSchema(schema({ objectIdField: undefined, globalIdField: undefined }))).toThrow(/missing-identity/)
  })

  it('rejects invalid spatial-reference semantics at schema admission', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    expect(() => policy.registerSchema(schema({ geometryType: 'none', wkid: 3857 }))).toThrow(/wkid-zero/)
    expect(() => policy.registerSchema(schema({ geometryType: 'polygon', wkid: 0 }))).toThrow(/requires-wkid/)
  })

  it('rejects duplicate advertised operations', () => {
    expect(() => new ArcGisEditValidationPolicy(budget).registerSchema(schema({ operations: ['add', 'add'] }))).toThrow(/duplicate-schema-operation/)
  })

  it('creates an immutable deterministic add plan', () => {
    const policy = registered()
    const plan = policy.validate(request('add', [addFeature({
      attributes: [
        { field: 'ENABLED', value: true },
        { field: 'NAME', value: 'Parcel A' },
        { field: 'SCORE', value: 4.5 },
      ],
    })]))
    expect(plan).toEqual(expect.objectContaining({
      featureCount: 1,
      attributeCount: 3,
      vertexCount: 10,
      fieldNames: ['ENABLED', 'NAME', 'SCORE'],
      clientIds: ['feature-a'],
    }))
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.fieldNames)).toBe(true)
    expect(plan).not.toHaveProperty('features')
    expect(plan).not.toHaveProperty('geometry')
  })

  it('is deterministic across feature and attribute ordering', () => {
    const first = registered()
    const second = registered()
    const featureA = addFeature({ clientId: 'a', attributes: [{ field: 'NAME', value: 'A' }, { field: 'SCORE', value: 1 }] })
    const featureB = addFeature({ clientId: 'b', attributes: [{ field: 'SCORE', value: 2 }, { field: 'NAME', value: 'B' }] })
    const left = first.validate(request('add', [featureB, featureA]))
    const right = second.validate(request('add', [
      addFeature({ clientId: 'a', attributes: [{ field: 'SCORE', value: 1 }, { field: 'NAME', value: 'A' }] }),
      addFeature({ clientId: 'b', attributes: [{ field: 'NAME', value: 'B' }, { field: 'SCORE', value: 2 }] }),
    ]))
    expect(left.fingerprint).toBe(right.fingerprint)
    expect(left.clientIds).toEqual(['a', 'b'])
  })

  it('changes the fingerprint when scalar mutation content changes', () => {
    const policy = registered()
    const first = policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SCORE', value: 1 }] })]))
    const second = policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SCORE', value: 2 }] })]))
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('fails closed on stale schema revisions and unadvertised operations', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    policy.registerSchema(schema({ operations: ['add'] }))
    expect(() => policy.validate(request('add', [addFeature()], { revision: 0 }))).toThrow(/stale/)
    expect(() => policy.validate(request('delete', [deleteFeature()]))).toThrow(/not-advertised/)
  })

  it('bounds feature cardinality and duplicate client authority', () => {
    const policy = registered({ ...budget, maxFeaturesPerBatch: 2 })
    expect(() => policy.validate(request('add', [addFeature({ clientId: 'a' }), addFeature({ clientId: 'b' }), addFeature({ clientId: 'c' })]))).toThrow(/feature-budget/)
    expect(() => policy.validate(request('add', [addFeature({ clientId: 'dup' }), addFeature({ clientId: 'dup' })]))).toThrow(/duplicate-edit-client-id/)
  })

  it('rejects server object ids on add mutations', () => {
    const policy = registered()
    expect(() => policy.validate(request('add', [addFeature({ objectId: 7 })]))).toThrow(/add-cannot/)
  })

  it('requires declared identity for update and delete', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ objectId: undefined })]))).toThrow(/identity-required/)
    expect(() => policy.validate(request('delete', [deleteFeature({ objectId: undefined })]))).toThrow(/identity-required/)
  })

  it('accepts canonical global-id identity without retaining it in the plan', () => {
    const policy = registered()
    const plan = policy.validate(request('update', [updateFeature({
      objectId: undefined,
      globalId: '{550e8400-e29b-41d4-a716-446655440000}',
    })]))
    expect(plan.featureCount).toBe(1)
    expect(plan).not.toHaveProperty('globalId')
  })

  it('requires delete mutations to remain identity-only', () => {
    const policy = registered()
    expect(() => policy.validate(request('delete', [deleteFeature({ attributes: [{ field: 'NAME', value: 'x' }] })]))).toThrow(/identity-only/)
    expect(() => policy.validate(request('delete', [deleteFeature({ geometryType: 'polygon', wkid: 3857, vertexCount: 4 })]))).toThrow(/identity-only/)
  })

  it('enforces geometry type and spatial reference consistency', () => {
    const policy = registered()
    expect(() => policy.validate(request('add', [addFeature({ geometryType: 'polyline' })]))).toThrow(/geometry-type/)
    expect(() => policy.validate(request('add', [addFeature({ wkid: 4326 })]))).toThrow(/spatial-reference/)
    expect(() => policy.validate(request('add', [addFeature({ wkid: 102113 })]))).not.toThrow()
  })

  it('requires empty geometry metadata for attribute-only updates', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ geometryType: 'polygon', wkid: 3857, vertexCount: 0 })]))).toThrow(/empty-geometry/)
  })

  it('prevents geometry payloads from entering table edits', () => {
    const table = schema({
      layerId: 'owners',
      geometryType: 'none',
      wkid: 0,
      globalIdField: undefined,
      operations: ['add'],
      fields: [
        { name: 'OBJECTID', type: 'oid', editable: false, nullable: false },
        { name: 'NAME', type: 'string', editable: true, nullable: false, maxLength: 10 },
      ],
    })
    const policy = registered(budget, table)
    expect(() => policy.validate(request('add', [addFeature()], { layerId: 'owners' }))).toThrow(/table-edit/)
  })

  it('bounds per-feature and aggregate geometry vertices', () => {
    const policy = registered({ ...budget, maxVerticesPerFeature: 80, maxBatchVertices: 100 })
    expect(() => policy.validate(request('add', [addFeature({ vertexCount: 81 })]))).toThrow(/feature-vertex/)
    expect(() => policy.validate(request('add', [
      addFeature({ clientId: 'a', vertexCount: 60 }),
      addFeature({ clientId: 'b', vertexCount: 50 }),
    ]))).toThrow(/batch-vertex/)
  })

  it('bounds attribute cardinality', () => {
    const policy = registered({ ...budget, maxAttributesPerFeature: 1 })
    expect(() => policy.validate(request('add', [addFeature({
      attributes: [{ field: 'NAME', value: 'A' }, { field: 'SCORE', value: 2 }],
    })]))).toThrow(/attribute-count/)
  })

  it('rejects unknown, duplicate and non-editable fields', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'MISSING', value: 1 }] })]))).toThrow(/not-in-schema/)
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SCORE', value: 1 }, { field: 'score', value: 2 }] })]))).toThrow(/duplicate-edit-attribute/)
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SERVER_NOTE', value: 'x' }] })]))).toThrow(/not-editable/)
  })

  it('rejects direct mutations of identity fields', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'OBJECTID', value: 42 }] })]))).toThrow(/identity-field/)
  })

  it.each([
    ['NAME', 4],
    ['SCORE', 'high'],
    ['ENABLED', 1],
    ['UPDATED', 1.5],
    ['CODE', 'not-a-guid'],
  ] as const)('rejects invalid scalar type/value for %s', (field: string, value: string | number) => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field, value }] })]))).toThrow()
  })

  it('rejects null for non-nullable editable fields', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'NAME', value: null }] })]))).toThrow(/non-nullable/)
  })

  it('enforces string-length budgets from admitted schema', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'NAME', value: '01234567890' }] })]))).toThrow(/string-budget/)
  })

  it('requires non-nullable no-default fields on adds', () => {
    const policy = registered()
    expect(() => policy.validate(request('add', [addFeature({ attributes: [{ field: 'SCORE', value: 1 }] })]))).toThrow(/required-edit-field-missing:NAME/)
    expect(() => policy.validate(request('add', [addFeature({ attributes: [{ field: 'NAME', value: 'A' }] })]))).not.toThrow()
  })

  it('bounds per-feature attribute bytes', () => {
    const policy = registered({ ...budget, maxAttributeBytesPerFeature: 12, maxBatchAttributeBytes: 64 })
    expect(() => policy.validate(request('add', [addFeature({ attributes: [{ field: 'NAME', value: '1234567890' }] })]))).toThrow(/feature-attribute-byte/)
  })

  it('bounds aggregate batch attribute bytes', () => {
    const policy = registered({ ...budget, maxAttributeBytesPerFeature: 20, maxBatchAttributeBytes: 25 })
    expect(() => policy.validate(request('add', [
      addFeature({ clientId: 'a', attributes: [{ field: 'NAME', value: '1234567890' }] }),
      addFeature({ clientId: 'b', attributes: [{ field: 'NAME', value: 'abcdefghij' }] }),
    ]))).toThrow(/batch-attribute-byte/)
  })

  it('accepts finite doubles, integer dates and normalized GUID fields', () => {
    const policy = registered()
    const plan = policy.validate(request('update', [updateFeature({
      attributes: [
        { field: 'SCORE', value: 1.25 },
        { field: 'UPDATED', value: 1_700_000_000_000 },
        { field: 'CODE', value: '{550e8400-e29b-41d4-a716-446655440000}' },
      ],
    })]))
    expect(plan.attributeCount).toBe(3)
  })

  it('rejects NaN and Infinity from numeric fields', () => {
    const policy = registered()
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SCORE', value: NaN }] })]))).toThrow(/type-mismatch/)
    expect(() => policy.validate(request('update', [updateFeature({ attributes: [{ field: 'SCORE', value: Infinity }] })]))).toThrow(/type-mismatch/)
  })

  it('re-registering a higher schema revision invalidates old edit batches', () => {
    const policy = registered()
    policy.registerSchema(schema({ revision: 2 }))
    expect(() => policy.validate(request('update', [updateFeature()], { revision: 1 }))).toThrow(/stale/)
    expect(() => policy.validate(request('update', [updateFeature()], { revision: 2 }))).not.toThrow()
  })

  it('releases layer schema metadata deterministically', () => {
    const policy = registered()
    expect(policy.releaseLayer('parcels')).toBe(true)
    expect(policy.releaseLayer('parcels')).toBe(false)
    expect(() => policy.validate(request('add', [addFeature()]))).toThrow(/not-registered/)
  })

  it('returns sorted detached snapshots and a scalar-only fingerprint', () => {
    const policy = new ArcGisEditValidationPolicy(budget)
    policy.registerSchema(schema({ layerId: 'z-layer' }))
    policy.registerSchema(schema({ layerId: 'a-layer' }))
    const snapshot = policy.snapshot()
    expect(snapshot.map(item => item.layerId)).toEqual(['a-layer', 'z-layer'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(policy.fingerprint()).toMatch(/^[0-9a-f]{8}$/)
    expect(policy.fingerprint()).not.toContain('[object Object]')
  })

  it.each(['', 'bad id', 'x'.repeat(257)])('rejects malformed layer/client identifiers', (invalid: string) => {
    const policy = new ArcGisEditValidationPolicy(budget)
    expect(() => policy.registerSchema(schema({ layerId: invalid }))).toThrow(/invalid-layer-id/)
  })

  it('rejects unsafe or inconsistent budgets', () => {
    expect(() => new ArcGisEditValidationPolicy({ ...budget, maxSchemas: 0 })).toThrow(/positive/)
    expect(() => new ArcGisEditValidationPolicy({ ...budget, maxAttributeBytesPerFeature: 300 })).toThrow(/inconsistent/)
    expect(() => new ArcGisEditValidationPolicy({ ...budget, maxVerticesPerFeature: 200 })).toThrow(/inconsistent/)
  })

  it('dispose clears schema metadata and fails closed afterwards', () => {
    const policy = registered()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.validate(request('add', [addFeature()]))).toThrow(/disposed/)
    expect(() => policy.registerSchema(schema())).toThrow(/disposed/)
  })
})
