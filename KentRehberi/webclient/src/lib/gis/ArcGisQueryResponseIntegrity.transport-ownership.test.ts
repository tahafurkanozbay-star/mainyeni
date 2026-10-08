import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const inspector = new ArcGisQueryResponseIntegrity()
const context = { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 4326 }
const page = (attributes: unknown, geometry: unknown = { x: 1, y: 2 }) => ({
  features: [{ attributes, geometry }],
  spatialReference: { wkid: 4326 },
})

describe('ArcGIS REST response transport ownership', () => {
  it('rejects attribute accessors without invoking the getter', () => {
    let calls = 0
    const attributes: Record<string, unknown> = { OBJECTID: 7 }
    Object.defineProperty(attributes, 'name', {
      enumerable: true,
      get: () => { calls += 1; return 'unexpected' },
    })
    expect(inspector.inspect(page(attributes), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-attributes', featureIndex: 0, field: 'name' },
    })
    expect(calls).toBe(0)
  })

  it('does not expose mutable transport attributes after acceptance', () => {
    const attributes = { OBJECTID: 7, name: 'original' }
    const result = inspector.inspect(page(attributes), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const accepted = result.features[0]?.attributes as typeof attributes
    expect(accepted).not.toBe(attributes)
    expect(Object.isFrozen(accepted)).toBe(true)
    attributes.name = 'changed'
    expect(accepted.name).toBe('original')
  })

  it('rejects feature attribute and geometry accessors without running them', () => {
    let calls = 0
    const feature: Record<string, unknown> = { attributes: { OBJECTID: 7 } }
    Object.defineProperty(feature, 'geometry', {
      enumerable: true, get: () => { calls += 1; return { x: 1, y: 2 } },
    })
    expect(inspector.inspect({ features: [feature] }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: 0 },
    })
    expect(calls).toBe(0)
  })

  it('rejects response accessors without invoking them', () => {
    let calls = 0
    const response: Record<string, unknown> = { features: [] }
    Object.defineProperty(response, 'spatialReference', {
      enumerable: true, get: () => { calls += 1; return { wkid: 4326 } },
    })
    expect(inspector.inspect(response, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference' },
    })
    expect(calls).toBe(0)
  })

  it('rejects spatial-reference accessors and invalid legacy IDs', () => {
    let calls = 0
    const spatialReference: Record<string, unknown> = { latestWkid: 4326 }
    Object.defineProperty(spatialReference, 'wkid', {
      enumerable: true, get: () => { calls += 1; return 4326 },
    })
    expect(inspector.inspect({ features: [], spatialReference }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference' },
    })
    expect(calls).toBe(0)
    expect(inspector.inspect({
      features: [], spatialReference: { latestWkid: 4326, wkid: -1 },
    }, context)).toMatchObject({ kind: 'rejected', issue: { code: 'invalid-spatial-reference' } })
  })

  it('preserves ordinary accepted response contracts', () => {
    const result = inspector.inspect(page({ OBJECTID: 7, name: 'road' }), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.objectIds).toEqual([7])
    expect(result.features[0]?.attributes).toEqual({ OBJECTID: 7, name: 'road' })
  })
  it('preserves own JSON attribute keys without changing the snapshot prototype', () => {
    const attributes = JSON.parse('{"OBJECTID":7,"__proto__":"data"}') as Record<string, unknown>
    const result = inspector.inspect(page(attributes), context)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const accepted = result.features[0]?.attributes as Record<string, unknown>
    expect(Object.getPrototypeOf(accepted)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(accepted, '__proto__')).toBe(true)
    expect(accepted['__proto__']).toBe('data')
    expect(Object.isFrozen(accepted)).toBe(true)
  })

  it('does not invoke an object-ID accessor during classification', () => {
    let calls = 0
    const attributes: Record<string, unknown> = {}
    Object.defineProperty(attributes, 'OBJECTID', {
      enumerable: true, get: () => { calls += 1; return 7 },
    })
    expect(inspector.inspect(page(attributes), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-attributes', featureIndex: 0, field: 'OBJECTID' },
    })
    expect(calls).toBe(0)
  })

  it('rejects an accessor for the top-level features collection without reading it', () => {
    let calls = 0
    const response: Record<string, unknown> = {}
    Object.defineProperty(response, 'features', {
      enumerable: true, get: () => { calls += 1; return [] },
    })
    expect(inspector.inspect(response, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-features' },
    })
    expect(calls).toBe(0)
  })

  it('rejects an accessor for transfer-limit metadata without evaluating it', () => {
    let calls = 0
    const response: Record<string, unknown> = { features: [] }
    Object.defineProperty(response, 'exceededTransferLimit', {
      enumerable: true, get: () => { calls += 1; return false },
    })
    expect(inspector.inspect(response, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-transfer-limit' },
    })
    expect(calls).toBe(0)
  })

  it('rejects feature spatial-reference accessors without invoking them', () => {
    let calls = 0
    const geometry: Record<string, unknown> = { x: 1, y: 2 }
    Object.defineProperty(geometry, 'spatialReference', {
      enumerable: true, get: () => { calls += 1; return { wkid: 4326 } },
    })
    expect(inspector.inspect(page({ OBJECTID: 7 }, geometry), context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference', featureIndex: 0 },
    })
    expect(calls).toBe(0)
  })

})
