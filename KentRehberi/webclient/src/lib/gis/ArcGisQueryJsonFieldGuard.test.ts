import { describe, expect, it } from 'vitest'
import { captureArcGisJsonArray, captureArcGisJsonFields } from './ArcGisQueryJsonFieldGuard'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'
import { snapshotArcGisQueryResult } from './ArcGisQueryResultSnapshot'

describe('ArcGIS JSON descriptor boundary', () => {
  it('captures enumerable own fields without executing getters or inherited values', () => {
    const data = JSON.parse('{"OBJECTID":1,"__proto__":{"safe":true},"label":"Park"}') as object
    const fields = captureArcGisJsonFields(data, 4)
    expect(fields.map(field => field.key)).toEqual(['OBJECTID', '__proto__', 'label'])
    expect(fields[1]?.value).toEqual({ safe: true })
    expect(({} as { safe?: boolean }).safe).toBeUndefined()
  })

  it('accepts null-prototype records but rejects instances and custom prototypes', () => {
    const data = Object.create(null) as Record<string, unknown>
    data.OBJECTID = 7
    expect(captureArcGisJsonFields(data, 2)).toEqual([{ key: 'OBJECTID', value: 7 }])
    expect(() => captureArcGisJsonFields(new Date(), 10)).toThrow('non-plain')
    expect(() => captureArcGisJsonFields(Object.create({ inherited: 1 }) as object, 10)).toThrow('non-plain')
  })

  it('rejects non-enumerable and accessor fields rather than silently dropping data', () => {
    let calls = 0
    const hidden = { OBJECTID: 1 }
    Object.defineProperty(hidden, 'geometry', { value: { x: 1 }, enumerable: false })
    expect(() => captureArcGisJsonFields(hidden, 10)).toThrow('hidden')
    const accessor = { OBJECTID: 2 }
    Object.defineProperty(accessor, 'geometry', {
      enumerable: true, get() { calls += 1; throw new Error('untrusted getter') },
    })
    expect(() => captureArcGisJsonFields(accessor, 10)).toThrow('accessor')
    expect(calls).toBe(0)
  })

  it('rejects symbol keys and oversized object graphs before copying fields', () => {
    const symbol = { OBJECTID: 1, [Symbol('private')]: 'secret' }
    expect(() => captureArcGisJsonFields(symbol, 10)).toThrow('key')
    expect(() => captureArcGisJsonFields({ a: 1, b: 2 }, 1)).toThrow('budget')
    expect(() => captureArcGisJsonFields({ a: 1 }, -1)).toThrow('budget')
    expect(() => captureArcGisJsonFields({ ['x'.repeat(257)]: 1 }, 2)).toThrow('key')
  })

  it('copies dense array data through descriptors and rejects sparse/extra fields', () => {
    const source = [1, 2, 3]
    const copy = captureArcGisJsonArray(source, 3)
    expect(copy).toEqual([1, 2, 3])
    source[0] = 99
    expect(copy[0]).toBe(1)
    expect(() => captureArcGisJsonArray([1, 2], 1)).toThrow('budget')
    const sparse = new Array<number>(2)
    sparse[0] = 1
    expect(() => captureArcGisJsonArray(sparse, 3)).toThrow('sparse')
    const extra = [1]
    Object.defineProperty(extra, 'transport', { value: 'hidden' })
    expect(() => captureArcGisJsonArray(extra, 3)).toThrow('extra')
    const withSymbol = [1] as number[] & { [key: symbol]: unknown }
    const symbol = Symbol('secret')
    withSymbol[symbol] = 'hidden'
    expect(() => captureArcGisJsonArray(withSymbol, 3)).toThrow('extra')
  })

  it('rejects accessor array elements without triggering them', () => {
    let calls = 0
    const data = [1, 2]
    Object.defineProperty(data, '0', {
      enumerable: true, configurable: true,
      get() { calls += 1; throw new Error('should not execute') },
    })
    expect(() => captureArcGisJsonArray(data, 2)).toThrow('accessor')
    expect(calls).toBe(0)
  })

  it('does not execute Proxy traps beyond descriptor enumeration on rejection', () => {
    const payload = new Proxy({ OBJECTID: 1 }, {
      ownKeys() { throw new Error('untrusted proxy') },
    })
    expect(() => captureArcGisJsonFields(payload, 10)).toThrow('untrusted proxy')
  })
})

describe('ArcGIS snapshot integration for hidden payloads', () => {
  it('rejects hidden identity and geometry without committing a page', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    const hiddenId: Record<string, unknown> = {}
    Object.defineProperty(hiddenId, 'OBJECTID', { value: 5, enumerable: false })
    expect(() => accumulator.append({
      pageIndex: 0, features: [{ attributes: hiddenId }],
    })).toThrow('hidden')
    const hiddenGeometry = { x: 1, y: 2 }
    Object.defineProperty(hiddenGeometry, 'z', { value: 3, enumerable: false })
    expect(() => accumulator.append({
      pageIndex: 0, features: [{ attributes: { OBJECTID: 6 }, geometry: hiddenGeometry }],
    })).toThrow('hidden')
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0 })
  })

  it('rejects hidden and symbol-backed geometry before forwarding executor data', () => {
    const limits = {
      maxFeaturesPerEntry: 10, maxBytesPerEntry: 10_000, maxNodesPerEntry: 1_000,
    }
    const geometry = { x: 1, y: 2 }
    Object.defineProperty(geometry, 'z', { value: 3, enumerable: false })
    expect(snapshotArcGisQueryResult({
      kind: 'completed', key: 'parcel', pagesCompleted: 1,
      objectIds: [1], features: [{ attributes: { OBJECTID: 1 }, geometry }],
    }, 'parcel', limits)).toBeNull()
    const attrs = { OBJECTID: 1, [Symbol('unsafe')]: 'secret' }
    expect(snapshotArcGisQueryResult({
      kind: 'completed', key: 'parcel', pagesCompleted: 1,
      objectIds: [1], features: [{ attributes: attrs }],
    }, 'parcel', limits)).toBeNull()
  })

  it('preserves ordinary JSON features through both snapshot authorities', () => {
    const feature = {
      attributes: { OBJECTID: 7, label: 'Park' },
      geometry: { rings: [[[29.1, 40.2], [29.2, 40.3]]] },
    }
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature] })
    const accepted = accumulator.finish()[0]
    expect(accepted).toEqual(feature)
    expect(Object.isFrozen(accepted?.geometry)).toBe(true)
    const result = snapshotArcGisQueryResult({
      kind: 'completed', key: 'park', pagesCompleted: 1,
      objectIds: [7], features: [feature],
    }, 'park', { maxFeaturesPerEntry: 10, maxBytesPerEntry: 10_000, maxNodesPerEntry: 1_000 })
    expect(result?.result.kind).toBe('completed')
    if (result?.result.kind === 'completed') {
      expect(result.result.features[0]).toEqual(feature)
    }
  })
})
