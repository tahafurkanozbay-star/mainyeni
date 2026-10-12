import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const context = { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 4326 }
const response = (geometry: unknown) => ({
  spatialReference: { wkid: 4326 },
  features: [{ attributes: { OBJECTID: 7 }, geometry }],
})

describe('ArcGIS response geometry snapshot integrity', () => {
  it('owns and deeply freezes accepted coordinates and spatial reference metadata', () => {
    const input = {
      paths: [[[1, 2], [3, 4]]],
      spatialReference: { wkid: 4326 },
    }
    const result = new ArcGisQueryResponseIntegrity().inspect(response(input), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const snapshot = result.features[0]?.geometry as typeof input
    expect(snapshot).not.toBe(input)
    expect(snapshot.paths).not.toBe(input.paths)
    expect(snapshot.paths[0]).not.toBe(input.paths[0])
    expect(snapshot.spatialReference).not.toBe(input.spatialReference)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.paths)).toBe(true)
    expect(Object.isFrozen(snapshot.paths[0]?.[0])).toBe(true)
    expect(Object.isFrozen(snapshot.spatialReference)).toBe(true)

    input.paths[0]![0]![0] = 999
    input.spatialReference.wkid = 3857
    expect(snapshot.paths[0]?.[0]?.[0]).toBe(1)
    expect(snapshot.spatialReference.wkid).toBe(4326)
    expect(() => { snapshot.paths[0]![0]![0] = 5 }).toThrow(TypeError)
  })

  it('rejects cycles and repeated references instead of returning aliased geometry', () => {
    const cyclic: Record<string, unknown> = { x: 1, y: 2 }
    cyclic.self = cyclic
    const inspector = new ArcGisQueryResponseIntegrity()
    expect(inspector.inspect(response(cyclic), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
    const shared = [1, 2]
    expect(inspector.inspect(response({ paths: [shared, shared] }), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
  })

  it('rejects accessor properties without invoking arbitrary getters', () => {
    let invoked = 0
    const geometry: Record<string, unknown> = { x: 1, y: 2 }
    Object.defineProperty(geometry, 'paths', {
      enumerable: true,
      get: () => { invoked += 1; return [[1, 2]] },
    })
    expect(new ArcGisQueryResponseIntegrity().inspect(response(geometry), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
    expect(invoked).toBe(0)
  })

  it('preserves own JSON keys without allowing prototype changes', () => {
    const geometry: unknown = JSON.parse('{"x":1,"y":2,"__proto__":{"safe":true}}')
    const result = new ArcGisQueryResponseIntegrity().inspect(response(geometry), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const snapshot = result.features[0]?.geometry as Record<string, unknown>
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true)
    expect(snapshot['__proto__']).toEqual({ safe: true })
    expect(Object.isFrozen(snapshot['__proto__'])).toBe(true)
  })

  it('charges spatial-reference metadata to the same feature geometry node budget', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxGeometryNodesPerFeature: 5,
      maxGeometryNodesPerPage: 50,
    })
    const geometry = {
      x: 1, y: 2,
      spatialReference: { wkid: 4326, latestWkid: 4326, vcsWkid: 5703 },
    }
    expect(inspector.inspect(response(geometry), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-node-budget', featureIndex: 0 },
    })
  })

  it('rejects sparse arrays with enormous declared lengths before allocation', () => {
    const paths: unknown[] = []
    paths.length = 1_000_000
    const inspector = new ArcGisQueryResponseIntegrity({ maxGeometryNodesPerFeature: 100 })
    expect(inspector.inspect(response({ paths }), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'geometry-node-budget', featureIndex: 0 },
    })
  })
})
