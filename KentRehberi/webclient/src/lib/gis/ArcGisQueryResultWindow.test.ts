import { describe, expect, it } from 'vitest'
import { ArcGisQueryResultWindow } from './ArcGisQueryResultWindow'

const feature = (OBJECTID: number | string, attributes: Record<string, unknown> = {}) => ({ attributes: { OBJECTID, ...attributes } })

describe('ArcGisQueryResultWindow', () => {
  it('returns a bounded window with navigation facts', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1), feature(2), feature(3)], objectIdField: 'OBJECTID', sort: [], offset: 1, limit: 1 })
    expect(result.features[0]?.attributes.OBJECTID).toBe(2)
    expect(result).toMatchObject({ total: 3, hasPrevious: true, hasNext: true, firstObjectId: 2, lastObjectId: 2 })
  })

  it('sorts numeric values deterministically', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1, { score: 20 }), feature(2, { score: 10 })], objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 0, limit: 10 })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([2, 1])
  })

  it('supports descending sort', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1, { score: 10 }), feature(2, { score: 20 })], objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'desc' }], offset: 0, limit: 10 })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([2, 1])
  })

  it('uses stable object id as final tie breaker', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(3, { score: 1 }), feature(1, { score: 1 }), feature(2, { score: 1 })], objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 0, limit: 10 })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([1, 2, 3])
  })

  it('sorts Turkish strings with deterministic locale semantics', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1, { name: 'İzmir' }), feature(2, { name: 'Ankara' })], objectIdField: 'OBJECTID', sort: [{ field: 'name', direction: 'asc' }], offset: 0, limit: 10 })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([2, 1])
  })

  it('orders null values before concrete values in ascending order', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1, { score: 1 }), feature(2, { score: null })], objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 0, limit: 10 })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([2, 1])
  })

  it('keeps numeric and string object id namespaces distinct', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1), feature('1')], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 10 })
    expect(result.total).toBe(2)
  })

  it('rejects duplicate object ids', () => {
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [feature(1), feature(1)], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 10 })).toThrow(/duplicate object id/)
  })

  it('rejects malformed object ids', () => {
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [{ attributes: {} }], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 10 })).toThrow(/stable object id/)
    expect(() => window.select({ features: [feature(Number.NaN)], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 10 })).toThrow(/stable object id/)
  })

  it('rejects non scalar sort values', () => {
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [feature(1, { nested: { x: 1 } })], objectIdField: 'OBJECTID', sort: [{ field: 'nested', direction: 'asc' }], offset: 0, limit: 10 })).toThrow(/scalar/)
  })

  it('rejects non finite numeric sort values', () => {
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [feature(1, { score: Number.NaN })], objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 0, limit: 10 })).toThrow(/finite/)
  })

  it('enforces feature budget', () => {
    const window = new ArcGisQueryResultWindow({ maxFeatures: 1 })
    expect(() => window.select({ features: [feature(1), feature(2)], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 10 })).toThrow(/feature budget/)
  })

  it('enforces sort field budget', () => {
    const window = new ArcGisQueryResultWindow({ maxSortFields: 1 })
    expect(() => window.select({ features: [feature(1)], objectIdField: 'OBJECTID', sort: [{ field: 'a', direction: 'asc' }, { field: 'b', direction: 'asc' }], offset: 0, limit: 10 })).toThrow(/sort field budget/)
  })

  it('rejects duplicate sort fields case insensitively', () => {
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [feature(1)], objectIdField: 'OBJECTID', sort: [{ field: 'Name', direction: 'asc' }, { field: 'name', direction: 'desc' }], offset: 0, limit: 10 })).toThrow(/duplicate sort field/)
  })

  it('returns an immutable empty window beyond the result set', () => {
    const window = new ArcGisQueryResultWindow()
    const result = window.select({ features: [feature(1)], objectIdField: 'OBJECTID', sort: [], offset: 5, limit: 2 })
    expect(result.features).toEqual([])
    expect(result.hasPrevious).toBe(true)
    expect(result.hasNext).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.features)).toBe(true)
  })

  it('validates input and options fail closed', () => {
    expect(() => new ArcGisQueryResultWindow({ maxFeatures: 0 })).toThrow(/maxFeatures/)
    const window = new ArcGisQueryResultWindow()
    expect(() => window.select({ features: [], objectIdField: ' ', sort: [], offset: 0, limit: 1 })).toThrow(/objectIdField/)
    expect(() => window.select({ features: [], objectIdField: 'OBJECTID', sort: [], offset: -1, limit: 1 })).toThrow(/offset/)
    expect(() => window.select({ features: [], objectIdField: 'OBJECTID', sort: [], offset: 0, limit: 0 })).toThrow(/limit/)
  })
})
