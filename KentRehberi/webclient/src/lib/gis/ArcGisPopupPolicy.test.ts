import { describe, expect, it } from 'vitest'
import { ArcGisPopupPolicy, type ArcGisPopupField, type ArcGisPopupRequest } from './ArcGisPopupPolicy'

const policy = () => new ArcGisPopupPolicy({
  maxFields: 3, maxTitleLength: 80, maxFieldNameLength: 40, maxFieldLabelLength: 80,
  maxFieldValueLength: 100, maxRevisionLength: 40, maxEstimatedBytes: 500, maxPriority: 100,
})

const fields: ArcGisPopupField[] = [
  { name: 'ada', label: 'Ada', value: 12, priority: 10 },
  { name: 'parsel', label: 'Parsel', value: '34', priority: 20 },
]

const request = (overrides: Partial<ArcGisPopupRequest> = {}): ArcGisPopupRequest => ({
  dimension: '2d', layerId: 4, objectId: 99, revision: 'r1', title: 'Parsel Bilgisi', fields,
  x: 32.85, y: 39.93, spatialReferenceWkid: 102100, ...overrides,
})

describe('ArcGisPopupPolicy', () => {
  it('canonicalizes Web Mercator aliases', () => expect(policy().plan(request()).point.spatialReferenceWkid).toBe(3857))
  it('orders fields by priority then name', () => expect(policy().plan(request()).fields.map((field) => field.name)).toEqual(['parsel', 'ada']))
  it('normalizes bounded text', () => expect(policy().plan(request({ title: '  Parsel   Bilgisi ' })).title).toBe('Parsel Bilgisi'))
  it('rejects duplicate field names', () => expect(() => policy().plan(request({ fields: [fields[0]!, fields[0]!] }))).toThrow('duplicate-popup-field:ada'))
  it('rejects field cardinality overflow', () => expect(() => policy().plan(request({ fields: [...fields, fields[0]!, fields[1]!] }))).toThrow('popup-field-budget-exceeded'))
  it('rejects aggregate byte overflow', () => expect(() => new ArcGisPopupPolicy({ maxFields: 3, maxTitleLength: 80, maxFieldNameLength: 40, maxFieldLabelLength: 80, maxFieldValueLength: 100, maxRevisionLength: 40, maxEstimatedBytes: 10, maxPriority: 100 }).plan(request())).toThrow('popup-byte-budget-exceeded'))
  it('rejects non-finite coordinates', () => expect(() => policy().plan(request({ x: Number.NaN }))).toThrow('x-must-be-finite'))
  it('rejects non-finite numeric field values', () => expect(() => policy().plan(request({ fields: [{ name: 'x', label: 'X', value: Number.POSITIVE_INFINITY, priority: 1 }] }))).toThrow('popup-field-number-must-be-finite'))
  it('rejects control characters instead of emitting unsafe text', () => expect(() => policy().plan(request({ title: 'bad\ntitle' }))).toThrow('invalid-popup-title'))
  it('preserves strings as text without interpreting markup', () => expect(policy().plan(request({ fields: [{ name: 'x', label: 'X', value: '<b>text</b>', priority: 1 }] })).fields[0]?.value).toBe('<b>text</b>'))
  it('changes fingerprint when revision changes', () => expect(policy().plan(request()).fingerprint).not.toBe(policy().plan(request({ revision: 'r2' })).fingerprint))
  it('changes fingerprint when coordinates change', () => expect(policy().plan(request()).fingerprint).not.toBe(policy().plan(request({ x: 33 })).fingerprint))
  it('is stable across input field ordering', () => expect(policy().plan(request()).fingerprint).toBe(policy().plan(request({ fields: [...fields].reverse() })).fingerprint))
  it('returns deeply immutable plan boundaries', () => {
    const plan = policy().plan(request())
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.point)).toBe(true)
    expect(Object.isFrozen(plan.fields)).toBe(true)
    expect(Object.isFrozen(plan.fields[0])).toBe(true)
  })
  it('accepts null and boolean values deterministically', () => {
    const plan = policy().plan(request({ fields: [{ name: 'a', label: 'A', value: null, priority: 1 }, { name: 'b', label: 'B', value: true, priority: 2 }] }))
    expect(plan.fields.map((field) => field.value)).toEqual([true, null])
  })
  it('rejects invalid dimensions', () => expect(() => policy().plan(request({ dimension: '4d' as '2d' }))).toThrow('invalid-popup-dimension'))
  it('rejects empty revisions', () => expect(() => policy().plan(request({ revision: ' ' }))).toThrow('invalid-revision'))
  it('rejects invalid object identifiers', () => expect(() => policy().plan(request({ objectId: -1 }))).toThrow('objectId-out-of-range'))
})
