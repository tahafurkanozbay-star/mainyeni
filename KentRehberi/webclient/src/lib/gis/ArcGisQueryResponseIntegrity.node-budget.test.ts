import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const context = { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 4326 }
const feature = (id: number, geometry: unknown) => ({
  attributes: { OBJECTID: id }, geometry,
})
const response = (...features: ReturnType<typeof feature>[]) => ({
  spatialReference: { wkid: 4326 }, features,
})

describe('ArcGIS geometry traversal budgets', () => {
  it('rejects a wide shallow geometry even when it has no coordinates', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 8,
      maxGeometryNodesPerPage: 100,
    })
    const geometry = { paths: Array.from({ length: 20 }, () => []) }
    expect(inspector.inspect(response(feature(1, geometry)), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-node-budget', featureIndex: 0 },
    })
  })

  it('bounds total traversal across features without retaining partial results', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 20,
      maxGeometryNodesPerPage: 10,
    })
    const geometry = () => ({ rings: [[], []] })
    expect(inspector.inspect(response(
      feature(1, geometry()), feature(2, geometry()), feature(3, geometry()),
    ), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-page-node-budget', featureIndex: 2 },
    })
  })

  it('accepts valid shallow geometries within both budgets', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 8,
      maxGeometryNodesPerPage: 12,
    })
    const result = inspector.inspect(response(
      feature(1, { x: 29, y: 41 }),
      feature(2, { paths: [[29, 41]] }),
    ), context)
    expect(result.kind).toBe('accepted')
    if (result.kind === 'accepted') expect(result.objectIds).toEqual([1, 2])
  })

  it('bounds wide object property traversal without building an entries array', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 8,
      maxGeometryNodesPerPage: 100,
    })
    const geometry = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => ['field' + index, null]),
    )
    expect(inspector.inspect(response(feature(1, geometry)), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-node-budget', featureIndex: 0 },
    })
  })

  it('validates new node budget options before inspecting untrusted payloads', () => {
    expect(() => new ArcGisQueryResponseIntegrity({ maxGeometryNodesPerFeature: 0 })).toThrow()
    expect(() => new ArcGisQueryResponseIntegrity({ maxGeometryNodesPerPage: Infinity })).toThrow()
  })

  it('keeps coordinate finiteness and spatial reference integrity enforced', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 100,
      maxGeometryNodesPerPage: 100,
    })
    expect(inspector.inspect(response(feature(1, { x: Number.NaN, y: 2 })), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-coordinate', featureIndex: 0 },
    })
    expect(inspector.inspect(response(feature(1, {
      x: 29, y: 41, spatialReference: { wkid: 3857 },
    })), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'spatial-reference-mismatch', featureIndex: 0 },
    })
  })
})
