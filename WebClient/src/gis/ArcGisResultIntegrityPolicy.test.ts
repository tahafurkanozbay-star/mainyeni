import { describe, expect, it } from 'vitest'
import { ArcGisResultIntegrityPolicy, type ArcGisResultPage } from './ArcGisResultIntegrityPolicy'

const policy = () => new ArcGisResultIntegrityPolicy({
  maxFeatures: 3,
  maxAttributesPerFeature: 4,
  maxAttributeNameLength: 40,
  maxStringValueLength: 20,
  maxTotalStringCharacters: 30,
  maxGeometryJsonBytes: 200,
})
const page = (extra: Partial<ArcGisResultPage> = {}): ArcGisResultPage => ({
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false },
    { name: 'name', type: 'esriFieldTypeString', nullable: true },
  ],
  objectIdFieldName: 'OBJECTID',
  features: [{ attributes: { OBJECTID: 1, name: 'Park' }, geometry: { x: 1, y: 2 } }],
  ...extra,
})

describe('ArcGisResultIntegrityPolicy', () => {
  it('admits a bounded immutable page', () => {
    const result = policy().admit(page())
    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/)
      expect(Object.isFrozen(result.page.features)).toBe(true)
      expect(Object.isFrozen(result.page.features[0].attributes)).toBe(true)
    }
  })

  it('produces deterministic fingerprints', () => {
    const first = policy().admit(page())
    const second = policy().admit(page())
    expect(first.accepted && second.accepted && first.fingerprint).toBe(second.accepted && second.fingerprint)
  })

  it('rejects feature cardinality overflow', () => {
    const feature = { attributes: { OBJECTID: 1, name: 'x' } }
    expect(policy().admit(page({ features: [feature, feature, feature, feature] }))).toMatchObject({ accepted: false, reason: 'feature-budget-exceeded' })
  })

  it('rejects duplicate schema fields case-insensitively', () => {
    expect(policy().admit(page({ fields: [
      { name: 'Name', type: 'esriFieldTypeString' },
      { name: 'name', type: 'esriFieldTypeString' },
    ] }))).toMatchObject({ accepted: false, reason: 'duplicate-field:name' })
  })

  it('rejects unsupported ArcGIS field types', () => {
    expect(policy().admit(page({ fields: [{ name: 'blob', type: 'esriFieldTypeBlob' }] }))).toMatchObject({ accepted: false, reason: 'unsupported-field-type:esriFieldTypeBlob' })
  })

  it('requires declared object id field', () => {
    expect(policy().admit(page({ objectIdFieldName: 'missing' }))).toMatchObject({ accepted: false, reason: 'object-id-field-not-in-schema' })
  })

  it('rejects undeclared attributes', () => {
    expect(policy().admit(page({ features: [{ attributes: { OBJECTID: 1, rogue: 'x' } }] }))).toMatchObject({ accepted: false, reason: 'attribute-not-in-schema:rogue' })
  })

  it('rejects null for non-nullable fields', () => {
    expect(policy().admit(page({ features: [{ attributes: { OBJECTID: null } }] }))).toMatchObject({ accepted: false, reason: 'null-for-non-nullable:OBJECTID' })
  })

  it('rejects unsafe integer values', () => {
    expect(policy().admit(page({ features: [{ attributes: { OBJECTID: 1.5 } }] }))).toMatchObject({ accepted: false, reason: 'invalid integer:OBJECTID' })
  })

  it('rejects non-finite numeric values', () => {
    expect(policy().admit(page({ fields: [{ name: 'value', type: 'esriFieldTypeDouble' }], objectIdFieldName: undefined, features: [{ attributes: { value: Infinity } }] }))).toMatchObject({ accepted: false, reason: 'invalid number:value' })
  })

  it('rejects overlong strings', () => {
    expect(policy().admit(page({ features: [{ attributes: { OBJECTID: 1, name: 'x'.repeat(21) } }] }))).toMatchObject({ accepted: false, reason: 'invalid value:name' })
  })

  it('rejects aggregate string budget overflow', () => {
    expect(policy().admit(page({ features: [
      { attributes: { OBJECTID: 1, name: 'x'.repeat(16) } },
      { attributes: { OBJECTID: 2, name: 'y'.repeat(16) } },
    ] }))).toMatchObject({ accepted: false, reason: 'string-character-budget-exceeded' })
  })

  it('rejects duplicate object identities', () => {
    expect(policy().admit(page({ features: [
      { attributes: { OBJECTID: 7, name: 'a' } },
      { attributes: { OBJECTID: 7, name: 'b' } },
    ] }))).toMatchObject({ accepted: false, reason: 'duplicate-object-identity:o:7' })
  })

  it('supports global id duplicate protection', () => {
    const result = policy().admit(page({
      fields: [{ name: 'gid', type: 'esriFieldTypeGlobalID' }],
      objectIdFieldName: undefined,
      globalIdFieldName: 'gid',
      features: [{ attributes: { gid: 'ABC' } }, { attributes: { gid: 'abc' } }],
    }))
    expect(result).toMatchObject({ accepted: false, reason: 'duplicate-global-identity:g:abc' })
  })

  it('rejects attribute cardinality overflow', () => {
    const result = new ArcGisResultIntegrityPolicy({ maxFeatures: 2, maxAttributesPerFeature: 1, maxAttributeNameLength: 20, maxStringValueLength: 20, maxTotalStringCharacters: 20, maxGeometryJsonBytes: 100 })
    expect(result.admit(page())).toMatchObject({ accepted: false, reason: 'attribute-budget-exceeded' })
  })

  it('rejects geometry serialization beyond budget', () => {
    const result = new ArcGisResultIntegrityPolicy({ maxFeatures: 2, maxAttributesPerFeature: 4, maxAttributeNameLength: 40, maxStringValueLength: 20, maxTotalStringCharacters: 30, maxGeometryJsonBytes: 10 })
    expect(result.admit(page())).toMatchObject({ accepted: false, reason: 'geometry-json-budget-exceeded' })
  })

  it('preserves exceeded transfer limit explicitly', () => {
    const result = policy().admit(page({ exceededTransferLimit: true }))
    expect(result.accepted && result.page.exceededTransferLimit).toBe(true)
  })

  it('rejects control characters in field names', () => {
    expect(policy().admit(page({ fields: [{ name: 'bad\nfield', type: 'esriFieldTypeString' }], objectIdFieldName: undefined }))).toMatchObject({ accepted: false, reason: 'invalid field name' })
  })
})
