import { describe, expect, it } from 'vitest'
import { ArcGisServiceResponsePolicy, type ArcGisServiceResponseBudget } from './ArcGisServiceResponsePolicy'

const budget: ArcGisServiceResponseBudget = {
  maxLayers: 8,
  maxFeatures: 100,
  maxFields: 12,
  maxBytes: 1024 * 1024,
  maxObjectIdCount: 100,
  maxStringLength: 128,
  maxFieldNameLength: 64,
  maxLayerIdLength: 64,
}

function policy(): ArcGisServiceResponsePolicy {
  return new ArcGisServiceResponsePolicy(budget)
}

describe('ArcGisServiceResponsePolicy', () => {
  it('admits bounded query metadata and canonicalizes unordered identities', () => {
    const authority = policy()
    const plan = authority.admit({
      requestId: 'request-1',
      layerId: 'roads',
      revision: 4,
      kind: 'query',
      byteLength: 4096,
      featureCount: 3,
      fieldNames: ['TYPE', 'OBJECTID', 'NAME'],
      objectIds: [9, 2, 5],
    })
    expect(plan.fieldNames).toEqual(['NAME', 'OBJECTID', 'TYPE'])
    expect(plan.objectIds).toEqual([2, 5, 9])
    expect(plan.requiresContinuation).toBe(false)
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('produces the same fingerprint for semantically identical ordering', () => {
    const first = policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 100, featureCount: 2, fieldNames: ['B', 'A'], objectIds: [2, 1] })
    const second = policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 100, featureCount: 2, fieldNames: ['A', 'B'], objectIds: [1, 2] })
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  it('marks transfer-limited queries for continuation without inventing transport', () => {
    const plan = policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 100, featureCount: 1, fieldNames: ['OBJECTID'], objectIds: [1], exceededTransferLimit: true })
    expect(plan.exceededTransferLimit).toBe(true)
    expect(plan.requiresContinuation).toBe(true)
  })

  it('does not mark non-query responses for continuation', () => {
    const plan = policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'identify', byteLength: 100, featureCount: 1, fieldNames: ['OBJECTID'], objectIds: [1], exceededTransferLimit: true, sourceLayerCount: 1 })
    expect(plan.requiresContinuation).toBe(false)
  })

  it('rejects stale layer revisions after a newer response', () => {
    const authority = policy()
    authority.admit({ requestId: 'new', layerId: 'l', revision: 8, kind: 'metadata', byteLength: 10, featureCount: 0, fieldNames: [] })
    expect(() => authority.admit({ requestId: 'old', layerId: 'l', revision: 7, kind: 'metadata', byteLength: 10, featureCount: 0, fieldNames: [] })).toThrow('stale-service-response')
  })

  it('supports explicit revision invalidation before late responses arrive', () => {
    const authority = policy()
    authority.invalidateLayer('l', 5)
    expect(authority.latestRevision('l')).toBe(5)
    expect(() => authority.admit({ requestId: 'late', layerId: 'l', revision: 4, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: [] })).toThrow('stale-service-response')
  })

  it('never moves an invalidation watermark backwards', () => {
    const authority = policy()
    authority.invalidateLayer('l', 9)
    authority.invalidateLayer('l', 3)
    expect(authority.latestRevision('l')).toBe(9)
  })

  it('rejects response bytes beyond the configured admission budget', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'metadata', byteLength: budget.maxBytes + 1, featureCount: 0, fieldNames: [] })).toThrow('byteLength')
  })

  it('rejects feature cardinality beyond the configured budget', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: budget.maxFeatures + 1, fieldNames: ['A'] })).toThrow('featureCount')
  })

  it('rejects too many fields before retaining response metadata', () => {
    const fields = Array.from({ length: budget.maxFields + 1 }, (_, index) => `F${index}`)
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: fields })).toThrow('response-field-budget-exceeded')
  })

  it('rejects duplicate fields case-insensitively', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: ['OBJECTID', 'objectid'] })).toThrow('duplicate-response-field')
  })

  it('rejects duplicate object ids', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: 2, fieldNames: ['OBJECTID'], objectIds: [1, 1] })).toThrow('duplicate-response-object-id')
  })

  it('rejects object id counts beyond the configured budget', () => {
    const ids = Array.from({ length: budget.maxObjectIdCount + 1 }, (_, index) => index)
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: 0, fieldNames: [], objectIds: ids })).toThrow('response-object-id-budget-exceeded')
  })

  it('rejects query feature and object-id cardinality disagreement', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: 2, fieldNames: ['OBJECTID'], objectIds: [1] })).toThrow('query-object-id-count-mismatch')
  })

  it('rejects feature responses that omit field metadata', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: 1, fieldNames: [] })).toThrow('feature-response-missing-fields')
  })

  it('rejects metadata responses that claim feature rows', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'metadata', byteLength: 1, featureCount: 1, fieldNames: ['A'] })).toThrow('metadata-response-cannot-contain-features')
  })

  it('rejects legend object ids because they are not legend integrity facts', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'legend', byteLength: 1, featureCount: 0, fieldNames: [], objectIds: [1] })).toThrow('legend-response-cannot-contain-object-ids')
  })

  it('requires a source layer when identify reports features', () => {
    expect(() => policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'identify', byteLength: 1, featureCount: 1, fieldNames: ['A'], sourceLayerCount: 0 })).toThrow('identify-response-missing-source-layer')
  })

  it('rejects control characters and blank identities', () => {
    expect(() => policy().admit({ requestId: ' ', layerId: 'l', revision: 1, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: [] })).toThrow('invalid-request-id')
    expect(() => policy().admit({ requestId: 'r', layerId: 'bad\nlayer', revision: 1, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: [] })).toThrow('invalid-layer-id')
  })

  it('freezes admitted collection boundaries', () => {
    const plan = policy().admit({ requestId: 'r', layerId: 'l', revision: 1, kind: 'query', byteLength: 1, featureCount: 1, fieldNames: ['A'], objectIds: [1] })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.fieldNames)).toBe(true)
    expect(Object.isFrozen(plan.objectIds)).toBe(true)
  })

  it('fails closed after disposal and releases revision metadata', () => {
    const authority = policy()
    authority.invalidateLayer('l', 3)
    authority.dispose()
    authority.dispose()
    expect(() => authority.latestRevision('l')).toThrow('arcgis-service-response-policy-disposed')
    expect(() => authority.admit({ requestId: 'r', layerId: 'l', revision: 3, kind: 'metadata', byteLength: 1, featureCount: 0, fieldNames: [] })).toThrow('arcgis-service-response-policy-disposed')
  })

  it('validates budget relationships and primitive bounds at construction', () => {
    expect(() => new ArcGisServiceResponsePolicy({ ...budget, maxLayers: 0 })).toThrow('maxLayers')
    expect(() => new ArcGisServiceResponsePolicy({ ...budget, maxFieldNameLength: 0 })).toThrow('maxFieldNameLength')
    expect(() => new ArcGisServiceResponsePolicy({ ...budget, maxBytes: Number.MAX_SAFE_INTEGER })).toThrow('maxBytes')
  })
})
