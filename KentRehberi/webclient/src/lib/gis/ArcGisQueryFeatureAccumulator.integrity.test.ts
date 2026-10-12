import { describe, expect, it } from 'vitest'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'

describe('ArcGIS feature accumulator transport ownership and resource integrity', () => {
  it('does not retain mutable feature attributes or geometry graphs', () => {
    const original = {
      attributes: { OBJECTID: 5, label: 'before', profile: { owner: 'Alice' } },
      geometry: { paths: [[[29, 40], [30, 41]]] },
    }
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [original] })
    original.attributes.label = 'after'
    original.attributes.profile.owner = 'changed'
    original.geometry.paths[0][0][0] = 999
    const accepted = accumulator.finish()[0]
    expect(accepted?.attributes.label).toBe('before')
    expect(accepted?.attributes.profile).toEqual({ owner: 'Alice' })
    expect(accepted?.geometry).toEqual({ paths: [[[29, 40], [30, 41]]] })
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted?.attributes)).toBe(true)
    expect(Object.isFrozen(accepted?.geometry)).toBe(true)
  })

  it('does not execute getter properties in untrusted attribute data', () => {
    let called = 0
    const attributes: Record<string, unknown> = { OBJECTID: 1 }
    Object.defineProperty(attributes, 'secret', {
      enumerable: true,
      get() { called += 1; throw new Error('untrusted getter') },
    })
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [{ attributes }] })).toThrow('accessor')
    expect(called).toBe(0)
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0 })
  })

  it('does not execute accessor-backed page indexes', () => {
    let called = 0
    const features: Array<{ attributes: { OBJECTID: number } }> = []
    Object.defineProperty(features, '0', {
      enumerable: true, configurable: true,
      get() { called += 1; throw new Error('must not execute') },
    })
    features.length = 1
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features })).toThrow('accessor page')
    expect(called).toBe(0)
    expect(accumulator.snapshot().pages).toBe(0)
  })

  it('rejects sparse geometry coordinate arrays without committing partial pages', () => {
    const missing: unknown[] = []
    missing.length = 2
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 1 }, geometry: { rings: [missing] } }],
    })).toThrow('sparse')
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, estimatedBytes: 0 })
  })

  it('rejects cyclic and aliased object trees before committing any feature', () => {
    const cyclical: Record<string, unknown> = {}
    cyclical.self = cyclical
    const shared = { x: 1 }
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 1 }, geometry: cyclical }],
    })).toThrow('cyclic')
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 1 }, geometry: { a: shared, b: shared } }],
    })).toThrow('shared')
    expect(accumulator.snapshot().features).toBe(0)
  })

  it('limits geometry and attribute tree nodes independent of byte pressure', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', {
      maxNodesPerFeature: 5, maxEstimatedBytes: 100_000,
    })
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{
        attributes: { OBJECTID: 1 },
        geometry: { paths: [[[1, 2], [3, 4]]] },
      }],
    })).toThrow('node budget')
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0, estimatedBytes: 0 })
  })

  it('counts full string payload bytes rather than truncating size estimates', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxEstimatedBytes: 2_000_000 })
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 1, label: 'x'.repeat(1_100_000) } }],
    })).toThrow('byte budget')
    expect(accumulator.snapshot().estimatedBytes).toBe(0)
  })

  it('preserves special JSON property names without prototype pollution', () => {
    const attributes = JSON.parse('{"OBJECTID":12,"__proto__":{"isAdmin":true}}') as Record<string, unknown>
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [{ attributes }] })
    const accepted = accumulator.finish()[0]
    expect(Object.prototype.hasOwnProperty.call(accepted?.attributes, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(accepted?.attributes)).toBe(Object.prototype)
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined()
  })

  it('rejects control characters in feature identity fields', () => {
    expect(() => new ArcGisQueryFeatureAccumulator('OBJECTID\n')).toThrow('objectIdField')
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 'prefix\r' } }],
    })).toThrow('string object id')
    expect(accumulator.snapshot().pages).toBe(0)
  })

  it('applies all-or-nothing page commits when a later feature is malformed', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    const badAttributes = { OBJECTID: 2, geometry: Number.POSITIVE_INFINITY }
    expect(() => accumulator.append({
      pageIndex: 0,
      features: [{ attributes: { OBJECTID: 1 } }, { attributes: badAttributes }],
    })).toThrow('finite')
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0, estimatedBytes: 0 })
    expect(accumulator.append({ pageIndex: 0, features: [{ attributes: { OBJECTID: 3 } }] }).features).toBe(1)
  })
})
