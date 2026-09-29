import { describe, expect, it } from 'vitest'
import { ArcGisSpatialQueryWindowPolicy, type ArcGisSpatialQueryWindowBudget, type ArcGisSpatialQueryWindowInput } from './ArcGisSpatialQueryWindowPolicy'

const budget: ArcGisSpatialQueryWindowBudget = {
  allowedWkids: [4326, 3857], maxResultRecordCount: 1000, maxResultOffset: 5000,
  maxArea: 10_000, maxWidth: 100, maxHeight: 100, maxTolerance: 20, maxAllowableOffset: 10,
  allowGeometry: true, allowCentroid: true, allowedRelationships: ['intersects', 'within', 'envelope-intersects'],
}
const input = (overrides: Partial<ArcGisSpatialQueryWindowInput> = {}): ArcGisSpatialQueryWindowInput => ({
  geometryType: 'polygon', relationship: 'intersects', extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 4326 },
  resultRecordCount: 100, resultOffset: 0, returnGeometry: true, returnCentroid: false, ...overrides,
})
const policy = (overrides: Partial<ArcGisSpatialQueryWindowBudget> = {}) => new ArcGisSpatialQueryWindowPolicy({ ...budget, ...overrides })

describe('ArcGisSpatialQueryWindowPolicy', () => {
  it('admits a bounded spatial window', () => {
    expect(policy().admit(input())).toMatchObject({ geometryType: 'polygon', relationship: 'intersects', estimatedArea: 100, resultRecordCount: 100 })
  })

  it('returns immutable canonical output', () => {
    const admitted = policy().admit(input())
    expect(Object.isFrozen(admitted)).toBe(true)
    expect(Object.isFrozen(admitted.extent)).toBe(true)
  })

  it('normalizes Web Mercator aliases', () => {
    const admitted = policy().admit(input({ extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 102100 }, outWkid: 900913 }))
    expect(admitted.extent.wkid).toBe(3857)
    expect(admitted.outWkid).toBe(3857)
  })

  it('deduplicates Web Mercator aliases in configuration', () => {
    expect(() => policy({ allowedWkids: [3857, 102100, 900913] })).not.toThrow()
  })

  it('rejects an unapproved input WKID', () => {
    expect(() => policy().admit(input({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 32636 } }))).toThrow('extent.wkid-not-allowed')
  })

  it('rejects an unapproved output WKID', () => {
    expect(() => policy().admit(input({ outWkid: 32636 }))).toThrow('outWkid-not-allowed')
  })

  it('rejects inverted x extent', () => {
    expect(() => policy().admit(input({ extent: { xmin: 5, ymin: 0, xmax: 1, ymax: 1, wkid: 4326 } }))).toThrow('query-window-extent-order-invalid')
  })

  it('rejects inverted y extent', () => {
    expect(() => policy().admit(input({ extent: { xmin: 0, ymin: 5, xmax: 1, ymax: 1, wkid: 4326 } }))).toThrow('query-window-extent-order-invalid')
  })

  it('rejects width beyond budget', () => {
    expect(() => policy({ maxWidth: 5 }).admit(input())).toThrow('query-window-width-budget-exceeded')
  })

  it('rejects height beyond budget', () => {
    expect(() => policy({ maxHeight: 5 }).admit(input())).toThrow('query-window-height-budget-exceeded')
  })

  it('rejects area beyond budget even when dimensions fit', () => {
    expect(() => policy({ maxArea: 99 }).admit(input())).toThrow('query-window-area-budget-exceeded')
  })

  it('accepts zero-area point windows', () => {
    const admitted = policy().admit(input({ geometryType: 'point', extent: { xmin: 1, ymin: 1, xmax: 1, ymax: 1, wkid: 4326 } }))
    expect(admitted.estimatedArea).toBe(0)
  })

  it('rejects unsupported geometry types', () => {
    expect(() => policy().admit(input({ geometryType: 'mesh' as never }))).toThrow('invalid-query-geometry-type')
  })

  it('rejects relationships outside configured allowlist', () => {
    expect(() => policy().admit(input({ relationship: 'contains' }))).toThrow('spatial-relationship-not-allowed')
  })

  it('rejects unknown relationships', () => {
    expect(() => policy().admit(input({ relationship: 'near' as never }))).toThrow('spatial-relationship-not-allowed')
  })

  it('bounds result record count', () => {
    expect(() => policy().admit(input({ resultRecordCount: 1001 }))).toThrow('resultRecordCount')
  })

  it('requires a positive result record count', () => {
    expect(() => policy().admit(input({ resultRecordCount: 0 }))).toThrow('resultRecordCount')
  })

  it('bounds result offset', () => {
    expect(() => policy().admit(input({ resultOffset: 5001 }))).toThrow('resultOffset')
  })

  it('rejects negative result offset', () => {
    expect(() => policy().admit(input({ resultOffset: -1 }))).toThrow('resultOffset')
  })

  it('bounds identify tolerance', () => {
    expect(() => policy().admit(input({ tolerance: 21 }))).toThrow('tolerance')
  })

  it('accepts tolerance at boundary', () => {
    expect(policy().admit(input({ tolerance: 20 })).tolerance).toBe(20)
  })

  it('bounds max allowable offset', () => {
    expect(() => policy().admit(input({ maxAllowableOffset: 11 }))).toThrow('maxAllowableOffset')
  })

  it('rejects geometry return when disabled', () => {
    expect(() => policy({ allowGeometry: false }).admit(input())).toThrow('return-geometry-not-allowed')
  })

  it('rejects centroid return when disabled', () => {
    expect(() => policy({ allowCentroid: false }).admit(input({ returnCentroid: true }))).toThrow('return-centroid-not-allowed')
  })

  it('rejects redundant point centroid return', () => {
    expect(() => policy().admit(input({ geometryType: 'point', returnCentroid: true }))).toThrow('point-centroid-redundant')
  })

  it('permits polygon centroid when enabled', () => {
    expect(policy().admit(input({ returnCentroid: true })).returnCentroid).toBe(true)
  })

  it('creates the same fingerprint for Web Mercator aliases', () => {
    const a = policy().admit(input({ extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 3857 } }))
    const b = policy().admit(input({ extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10, wkid: 102113 } }))
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('fingerprint changes with pagination', () => {
    const a = policy().admit(input())
    const b = policy().admit(input({ resultOffset: 100 }))
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('fingerprint changes with geometry-return semantics', () => {
    const a = policy().admit(input({ returnGeometry: true }))
    const b = policy().admit(input({ returnGeometry: false }))
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('rejects empty allowed WKID configuration', () => {
    expect(() => policy({ allowedWkids: [] })).toThrow('allowedWkids must contain 1..64 entries')
  })

  it('rejects empty relationship configuration', () => {
    expect(() => policy({ allowedRelationships: [] })).toThrow('invalid-allowed-relationships')
  })

  it('rejects invalid configured relationships', () => {
    expect(() => policy({ allowedRelationships: ['near' as never] })).toThrow('invalid-allowed-relationships')
  })

  it('rejects non-finite coordinates', () => {
    expect(() => policy().admit(input({ extent: { xmin: Number.NaN, ymin: 0, xmax: 1, ymax: 1, wkid: 4326 } }))).toThrow('xmin')
  })

  it('rejects unsafe WKID integers', () => {
    expect(() => policy().admit(input({ extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 1.5 } }))).toThrow('wkid')
  })
})
