import { describe, expect, it } from 'vitest'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'

const feature = (OBJECTID: number | string, extra: Record<string, unknown> = {}) => ({ attributes: { OBJECTID, ...extra } })

describe('ArcGisQueryFeatureAccumulator', () => {
  it('accumulates ordered pages and exposes bounded snapshots', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(accumulator.append({ pageIndex: 0, features: [feature(1), feature(2)] })).toMatchObject({ pages: 1, features: 2, firstObjectId: 1, lastObjectId: 2 })
    expect(accumulator.append({ pageIndex: 1, features: [feature(3)] })).toMatchObject({ pages: 2, features: 3, lastObjectId: 3 })
    expect(accumulator.finish()).toHaveLength(3)
  })

  it('rejects duplicate identities across pages', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature(1)] })
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(1)] })).toThrow(/duplicate object id/)
  })

  it('rejects duplicate identities within one page atomically', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(1), feature(1)] })).toThrow(/duplicate object id/)
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0, estimatedBytes: 0 })
  })

  it('requires contiguous page ordering', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(1)] })).toThrow(/expected page 0/)
    accumulator.append({ pageIndex: 0, features: [feature(1)] })
    expect(() => accumulator.append({ pageIndex: 2, features: [feature(2)] })).toThrow(/expected page 1/)
  })

  it('enforces feature budget before mutating state', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxFeatures: 2 })
    accumulator.append({ pageIndex: 0, features: [feature(1)] })
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(2), feature(3)] })).toThrow(/feature budget/)
    expect(accumulator.snapshot()).toMatchObject({ pages: 1, features: 1 })
  })

  it('enforces page budget', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxPages: 1 })
    accumulator.append({ pageIndex: 0, features: [feature(1)] })
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(2)] })).toThrow(/page budget/)
  })

  it('enforces estimated byte budget atomically', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxEstimatedBytes: 100 })
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(1, { label: 'x'.repeat(100) })] })).toThrow(/byte budget/)
    expect(accumulator.snapshot()).toMatchObject({ pages: 0, features: 0, estimatedBytes: 0 })
  })

  it('accepts stable string ids after trimming', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature('  abc  ')] })
    expect(accumulator.snapshot()).toMatchObject({ firstObjectId: 'abc', lastObjectId: 'abc' })
  })

  it('keeps numeric and string identity namespaces distinct', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature(1), feature('1')] })
    expect(accumulator.snapshot().features).toBe(2)
  })

  it('rejects missing and malformed object ids', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [{ attributes: {} }] })).toThrow(/object id/)
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(Number.NaN)] })).toThrow(/safe integer/)
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(' ')] })).toThrow(/string object id/)
  })

  it('rejects non-finite nested values used in byte accounting', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(1, { score: Number.POSITIVE_INFINITY })] })).toThrow(/finite/)
  })

  it('rejects pathological nested values', () => {
    let nested: unknown = 1
    for (let index = 0; index < 14; index += 1) nested = [nested]
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [feature(1, { nested })] })).toThrow(/nesting/)
  })

  it('seals after finish and returns a frozen result', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature(1)] })
    const result = accumulator.finish()
    expect(Object.isFrozen(result)).toBe(true)
    expect(accumulator.isSealed).toBe(true)
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(2)] })).toThrow(/sealed/)
  })

  it('allows an empty terminal page', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [] })
    expect(accumulator.snapshot()).toMatchObject({ pages: 1, features: 0 })
  })

  it('validates construction fail closed', () => {
    expect(() => new ArcGisQueryFeatureAccumulator(' ')).toThrow(/objectIdField/)
    expect(() => new ArcGisQueryFeatureAccumulator('OBJECTID', { maxFeatures: 0 })).toThrow(/maxFeatures/)
    expect(() => new ArcGisQueryFeatureAccumulator('OBJECTID', { maxPages: 0 })).toThrow(/maxPages/)
    expect(() => new ArcGisQueryFeatureAccumulator('OBJECTID', { maxEstimatedBytes: -1 })).toThrow(/maxEstimatedBytes/)
  })

  it('validates page indexes fail closed', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: -1, features: [] })).toThrow(/pageIndex/)
    expect(() => accumulator.append({ pageIndex: Number.NaN, features: [] })).toThrow(/pageIndex/)
  })
})
