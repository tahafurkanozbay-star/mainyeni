import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const context = { objectIdField: 'OBJECTID' }
const feature = (id: number, extras: Record<string, unknown> = {}) => ({
  attributes: { OBJECTID: id, ...extras },
})

describe('ArcGIS query page-wide attribute integrity', () => {
  it('rejects aggregate attribute fanout across individually valid features', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxAttributesPerFeature: 4,
      maxAttributesPerPage: 5,
    })
    expect(inspector.inspect({
      features: [feature(1, { a: 1, b: 2 }), feature(2, { c: 3, d: 4 })],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'attribute-page-budget', featureIndex: 1 },
    })
  })

  it('rejects page-wide text pressure without exceeding per-field length', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxAttributeTextLength: 10,
      maxAttributeTextCharactersPerPage: 12,
    })
    expect(inspector.inspect({
      features: [feature(1, { name: '1234567' }), feature(2, { name: '1234567' })],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'attribute-text-page-budget', featureIndex: 1, field: 'name' },
    })
  })

  it('rejects an oversized attribute object before processing all fields', () => {
    const inspector = new ArcGisQueryResponseIntegrity({ maxAttributesPerFeature: 3 })
    const attributes = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['field' + i, i]))
    expect(inspector.inspect({ features: [{ attributes }] }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'attribute-budget', featureIndex: 0 },
    })
  })

  it('accepts a multi-feature page within both aggregate budgets', () => {
    const inspector = new ArcGisQueryResponseIntegrity({
      maxAttributesPerPage: 6,
      maxAttributeTextCharactersPerPage: 12,
    })
    const result = inspector.inspect({
      features: [feature(1, { name: 'alpha' }), feature(2, { name: 'bravo' })],
    }, context)
    expect(result.kind).toBe('accepted')
    if (result.kind === 'accepted') expect(result.objectIds).toEqual([1, 2])
  })

  it('rejects invalid aggregate budgets and malformed boolean options', () => {
    expect(() => new ArcGisQueryResponseIntegrity({ maxAttributesPerPage: 0 })).toThrow()
    expect(() => new ArcGisQueryResponseIntegrity({ maxAttributeTextCharactersPerPage: Number.NaN })).toThrow()
    expect(() => new ArcGisQueryResponseIntegrity({ requireObjectId: 'yes' as never })).toThrow()
  })
})
