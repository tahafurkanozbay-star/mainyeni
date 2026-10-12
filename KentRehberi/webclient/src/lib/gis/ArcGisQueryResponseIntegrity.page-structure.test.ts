import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const inspector = new ArcGisQueryResponseIntegrity()
const context = { objectIdField: 'OBJECTID' }
const feature = (id: number, geometry: unknown = { x: 1, y: 2 }) => ({
  attributes: { OBJECTID: id }, geometry,
})

describe('ArcGIS REST page structure and expected-ID budgets', () => {
  it('rejects an accessor array element without invoking the getter', () => {
    let calls = 0
    const features = [feature(1)]
    Object.defineProperty(features, '0', {
      enumerable: true,
      get: () => { calls += 1; return feature(99) },
    })
    expect(inspector.inspect({ features }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: 0 },
    })
    expect(calls).toBe(0)
  })

  it('rejects a sparse feature array before treating holes as empty features', () => {
    const features: unknown[] = []
    features.length = 2
    features[0] = feature(1)
    expect(inspector.inspect({ features }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: 1 },
    })
  })

  it('rejects sparse coordinate arrays instead of accepting missing coordinates', () => {
    const coordinates: unknown[] = [1, 2]
    coordinates.length = 3
    expect(inspector.inspect({
      features: [feature(1, { paths: [[coordinates]] })],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
  })

  it('rejects explicit undefined geometry array elements', () => {
    expect(inspector.inspect({
      features: [feature(1, { rings: [[[1, 2], undefined]] })],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
  })

  it('rejects undefined nested geometry metadata while allowing absent optional metadata', () => {
    expect(inspector.inspect({
      features: [feature(1, { x: 1, y: 2, m: undefined })],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
    expect(inspector.inspect({
      features: [feature(1, { x: 1, y: 2 })],
    }, context).kind).toBe('accepted')
  })

  it.each([
    [null],
    [[0]],
    [[1.25]],
    [['7']],
    [[7, 7]],
  ])('rejects malformed expected object IDs %#', expectedObjectIds => {
    expect(inspector.inspect({
      features: [feature(7)],
    }, { objectIdField: 'OBJECTID', expectedObjectIds: expectedObjectIds as never })).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-object-id' },
    })
  })

  it('rejects an oversized expected-ID list before allocating an unbounded Set', () => {
    const limited = new ArcGisQueryResponseIntegrity({ maxFeaturesPerPage: 2 })
    expect(limited.inspect({
      features: [feature(1)],
    }, { objectIdField: 'OBJECTID', expectedObjectIds: [1, 2, 3] })).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-object-id' },
    })
  })

  it('rejects malformed object-ID field metadata before reading attributes', () => {
    expect(inspector.inspect({ features: [feature(1)] }, {
      objectIdField: ' OBJECTID ',
    })).toMatchObject({ kind: 'rejected', issue: { code: 'invalid-object-id' } })
    expect(inspector.inspect({ features: [] }, {
      objectIdField: 7 as never,
    })).toMatchObject({ kind: 'rejected', issue: { code: 'invalid-object-id' } })
  })

  it('accepts valid bounded expected IDs and JSON coordinates', () => {
    const result = inspector.inspect({
      features: [feature(1, { paths: [[[1, 2], [3, 4]]] }), feature(2)],
    }, { objectIdField: 'OBJECTID', expectedObjectIds: [1, 2] })
    expect(result.kind).toBe('accepted')
    if (result.kind === 'accepted') expect(result.objectIds).toEqual([1, 2])
  })
})
