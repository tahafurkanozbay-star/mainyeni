import { describe, expect, it } from 'vitest'
import { assertArcGisQueryCapability, normalizeArcGisQueryCapabilities, sameArcGisQueryCapabilities } from './ArcGisQueryCapabilitySnapshot'

const raw = () => ({ maxRecordCount: 2000, objectIdField: 'OBJECTID', globalIdField: 'GlobalID', supportsPagination: true, supportsOrderBy: true, supportsStatistics: true, supportsDistinct: true, supportsReturningQueryExtent: true, supportsSqlExpression: true, supportedQueryFormats: 'JSON, geoJSON' })

describe('ArcGisQueryCapabilitySnapshot', () => {
  it('normalizes verified service metadata', () => {
    const snapshot = normalizeArcGisQueryCapabilities(raw())
    expect(snapshot).toMatchObject({ maxRecordCount: 2000, identityField: 'OBJECTID', identityKind: 'object-id', supportsPagination: true })
    expect(snapshot.supportedQueryFormats).toEqual(['geojson', 'json'])
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('falls back to verified global id when object id is blank', () => {
    const snapshot = normalizeArcGisQueryCapabilities({ ...raw(), objectIdField: ' ' })
    expect(snapshot.identityField).toBe('GlobalID')
    expect(snapshot.identityKind).toBe('global-id')
  })

  it('prefers object id when both identities exist', () => {
    expect(normalizeArcGisQueryCapabilities(raw()).identityKind).toBe('object-id')
  })

  it('deduplicates and sorts query formats', () => {
    const snapshot = normalizeArcGisQueryCapabilities({ ...raw(), supportedQueryFormats: 'pbf, JSON, pbf' })
    expect(snapshot.supportedQueryFormats).toEqual(['json', 'pbf'])
  })

  it('produces stable fingerprints for semantically equal metadata', () => {
    const a = normalizeArcGisQueryCapabilities(raw())
    const b = normalizeArcGisQueryCapabilities({ ...raw(), supportedQueryFormats: 'geoJSON,JSON' })
    expect(sameArcGisQueryCapabilities(a, b)).toBe(true)
  })

  it('changes fingerprint when verified capacity changes', () => {
    const a = normalizeArcGisQueryCapabilities(raw())
    const b = normalizeArcGisQueryCapabilities({ ...raw(), maxRecordCount: 1000 })
    expect(sameArcGisQueryCapabilities(a, b)).toBe(false)
  })

  it('asserts individual capabilities', () => {
    const snapshot = normalizeArcGisQueryCapabilities(raw())
    expect(() => assertArcGisQueryCapability(snapshot, 'pagination')).not.toThrow()
    const restricted = normalizeArcGisQueryCapabilities({ ...raw(), supportsPagination: false, supportsStatistics: false })
    expect(() => assertArcGisQueryCapability(restricted, 'statistics')).toThrow(/not verified/)
  })

  it('rejects pagination without deterministic order by support', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), supportsOrderBy: false })).toThrow(/pagination requires/)
  })

  it('rejects missing identity metadata', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), objectIdField: ' ', globalIdField: '' })).toThrow(/identity field/)
  })

  it('rejects malformed identity fields', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), objectIdField: 'OBJECT ID' })).toThrow(/objectIdField/)
  })

  it('rejects invalid record count bounds', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), maxRecordCount: 0 })).toThrow(/maxRecordCount/)
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), maxRecordCount: 1_000_001 })).toThrow(/maxRecordCount/)
  })

  it('rejects non boolean capability flags', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), supportsPagination: 'true' })).toThrow(/supportsPagination/)
  })

  it('rejects missing and malformed query formats', () => {
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), supportedQueryFormats: '' })).toThrow(/supportedQueryFormats/)
    expect(() => normalizeArcGisQueryCapabilities({ ...raw(), supportedQueryFormats: 'json, bad format' })).toThrow(/query format/)
  })
})
