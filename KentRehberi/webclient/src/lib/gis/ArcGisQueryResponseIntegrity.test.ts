import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const context = { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 4326 }

function response(features: unknown[], extra: Record<string, unknown> = {}) {
  return { features, spatialReference: { wkid: 4326 }, ...extra }
}

function feature(id: unknown, geometry: unknown = { x: 29, y: 41 }, extra: Record<string, unknown> = {}) {
  return { attributes: { OBJECTID: id, name: `feature-${String(id)}`, ...extra }, geometry }
}

describe('ArcGisQueryResponseIntegrity', () => {
  it('accepts bounded ArcGIS features and preserves deterministic object ids', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect(response([feature(4), feature(9)]), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.objectIds).toEqual([4, 9])
    expect(result.spatialReferenceWkid).toBe(4326)
    expect(result.exceededTransferLimit).toBe(false)
  })

  it('accepts latestWkid as canonical response wkid', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect({
      features: [feature(1)],
      spatialReference: { wkid: 102100, latestWkid: 3857 },
    }, { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 3857 })
    expect(result.kind).toBe('accepted')
  })

  it.each([
    [null, 'invalid-response'],
    [{}, 'invalid-features'],
    [{ features: 'nope' }, 'invalid-features'],
    [{ features: [], exceededTransferLimit: 'true' }, 'invalid-transfer-limit'],
  ])('rejects malformed response %#', (value, code) => {
    expect(new ArcGisQueryResponseIntegrity().inspect(value, context)).toMatchObject({ kind: 'rejected', issue: { code } })
  })

  it('enforces the per-page feature budget', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ maxFeaturesPerPage: 2 })
    expect(runtime.inspect(response([feature(1), feature(2), feature(3)]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'feature-budget' },
    })
  })

  it('rejects missing object ids by default', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([{ attributes: { name: 'x' } }]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'missing-object-id', featureIndex: 0 },
    })
  })

  it('can allow missing object ids for aggregate queries', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ requireObjectId: false })
    const result = runtime.inspect(response([{ attributes: { count: 4 } }]), context)
    expect(result.kind).toBe('accepted')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1'])('rejects invalid object id %p', id => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([feature(id)]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-object-id' },
    })
  })

  it('rejects duplicate object ids within a page', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([feature(7), feature(7)]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'duplicate-object-id', featureIndex: 1 },
    })
  })

  it('rejects ids outside an object-id page request', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect(response([feature(8)]), {
      ...context,
      expectedObjectIds: [7, 9],
    })
    expect(result).toMatchObject({ kind: 'rejected', issue: { code: 'unexpected-object-id' } })
  })

  it('accepts a subset of expected ids because services may filter rows', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect(response([feature(7)]), {
      ...context,
      expectedObjectIds: [7, 9],
    })
    expect(result.kind).toBe('accepted')
  })

  it('rejects too many attributes', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ maxAttributesPerFeature: 2 })
    expect(runtime.inspect(response([feature(1, undefined, { extra: 1 })]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'attribute-budget' },
    })
  })

  it('rejects oversized attribute text', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ maxAttributeTextLength: 4 })
    expect(runtime.inspect(response([{ attributes: { OBJECTID: 1, name: '12345' } }]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'attribute-text-budget', field: 'name' },
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects non-finite attribute number %p', value => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([{ attributes: { OBJECTID: 1, score: value } }]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-attributes', field: 'score' },
    })
  })

  it('rejects nested attribute objects', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([{ attributes: { OBJECTID: 1, nested: { x: 1 } } }]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-attributes', field: 'nested' },
    })
  })

  it('rejects malformed spatial reference', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect({ features: [], spatialReference: { wkid: -1 } }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference' },
    })
  })

  it('rejects spatial reference mismatch', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect({ features: [], spatialReference: { wkid: 3857 } }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'spatial-reference-mismatch' },
    })
  })

  it('allows absent response spatial reference when service context is implicit', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect({ features: [] }, context).kind).toBe('accepted')
  })

  it('rejects invalid expected wkid', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect({ features: [] }, {
      objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 0,
    })).toMatchObject({ kind: 'rejected', issue: { code: 'invalid-spatial-reference' } })
  })

  it.each(['', 'bad field', '1OBJECTID'])('rejects invalid object id field %p', objectIdField => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([]), { objectIdField })).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-object-id' },
    })
  })

  it('accepts point, path and ring coordinate structures', () => {
    const runtime = new ArcGisQueryResponseIntegrity()
    expect(runtime.inspect(response([feature(1, { x: 1, y: 2, z: 3 })]), context).kind).toBe('accepted')
    expect(runtime.inspect(response([feature(2, { paths: [[[1, 2], [3, 4]]] })]), context).kind).toBe('accepted')
    expect(runtime.inspect(response([feature(3, { rings: [[[1, 2], [3, 4], [1, 2]]] })]), context).kind).toBe('accepted')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects non-finite geometry coordinate %p', value => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([feature(1, { x: value, y: 1 })]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-coordinate' },
    })
  })

  it('enforces geometry coordinate budget', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ maxGeometryCoordinates: 3 })
    expect(runtime.inspect(response([feature(1, { paths: [[[1, 2], [3, 4]]] })]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-coordinate-budget' },
    })
  })

  it('enforces geometry nesting depth', () => {
    const runtime = new ArcGisQueryResponseIntegrity({ maxGeometryDepth: 2 })
    expect(runtime.inspect(response([feature(1, { paths: [[[[1, 2]]]] })]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-depth-budget' },
    })
  })

  it('rejects primitive geometry payloads', () => {
    expect(new ArcGisQueryResponseIntegrity().inspect(response([feature(1, 'POINT')]), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry' },
    })
  })

  it('reports exceededTransferLimit exactly', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect(response([feature(1)], { exceededTransferLimit: true }), context)
    expect(result).toMatchObject({ kind: 'accepted', exceededTransferLimit: true })
  })

  it('freezes accepted collections against accidental mutation', () => {
    const result = new ArcGisQueryResponseIntegrity().inspect(response([feature(1)]), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(Object.isFrozen(result.features)).toBe(true)
    expect(Object.isFrozen(result.objectIds)).toBe(true)
    expect(Object.isFrozen(result.features[0])).toBe(true)
  })

  it.each([
    [{ maxFeaturesPerPage: 0 }, 'maxFeaturesPerPage'],
    [{ maxAttributesPerFeature: -1 }, 'maxAttributesPerFeature'],
    [{ maxAttributeTextLength: 1.5 }, 'maxAttributeTextLength'],
    [{ maxGeometryDepth: Number.NaN }, 'maxGeometryDepth'],
    [{ maxGeometryCoordinates: 0 }, 'maxGeometryCoordinates'],
  ])('rejects invalid option %#', (options, name) => {
    expect(() => new ArcGisQueryResponseIntegrity(options)).toThrow(name)
  })
})
