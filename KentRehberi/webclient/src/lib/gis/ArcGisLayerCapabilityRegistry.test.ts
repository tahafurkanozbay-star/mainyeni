import { describe, expect, it } from 'vitest'
import { ArcGisLayerCapabilityRegistry, type ArcGisLayerCapabilityBudget, type ArcGisLayerCapabilityDescriptor } from './ArcGisLayerCapabilityRegistry'

const budget: ArcGisLayerCapabilityBudget = { maxLayers: 3, maxFieldsPerLayer: 8, maxOperationsPerLayer: 6, maxRecordCountCeiling: 10_000, maxMetadataBytesPerLayer: 8_000, maxAggregateMetadataBytes: 16_000 }
const layer = (overrides: Partial<ArcGisLayerCapabilityDescriptor> = {}): ArcGisLayerCapabilityDescriptor => ({
  serviceId: 'planning', layerId: 'parcels', revision: 1, kind: 'feature', geometry: 'polygon', wkid: 102100,
  maxRecordCount: 2_000, supportsZ: false, supportsM: false, objectIdField: 'OBJECTID', globalIdField: 'GlobalID',
  operations: ['query', 'identify', 'edit', 'statistics', 'pagination'], estimatedMetadataBytes: 2_000,
  fields: [
    { name: 'OBJECTID', type: 'oid', editable: false, nullable: false },
    { name: 'GlobalID', type: 'globalid', editable: false, nullable: false },
    { name: 'NAME', type: 'string', editable: true, nullable: false, maxLength: 80 },
    { name: 'SCORE', type: 'double', editable: true, nullable: true },
  ], ...overrides,
})

describe('ArcGisLayerCapabilityRegistry', () => {
  it('canonicalizes Web Mercator aliases and returns frozen detached views', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); const view = registry.register(layer())
    expect(view.wkid).toBe(3857); expect(view.fieldCount).toBe(4); expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.operations)).toBe(true); expect(view).not.toHaveProperty('fields')
  })
  it.each([102100, 102113, 900913, 3857])('canonicalizes wkid %s deterministically', wkid => {
    expect(new ArcGisLayerCapabilityRegistry(budget).register(layer({ wkid })).wkid).toBe(3857)
  })
  it('requires monotonic layer metadata revisions', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer())
    expect(() => registry.register(layer())).toThrow(/revision/); expect(() => registry.register(layer({ revision: 0 }))).toThrow(/revision/); expect(registry.register(layer({ revision: 2 })).revision).toBe(2)
  })
  it('bounds layer cardinality', () => {
    const registry = new ArcGisLayerCapabilityRegistry({ ...budget, maxLayers: 1 }); registry.register(layer()); expect(() => registry.register(layer({ layerId: 'buildings' }))).toThrow(/capacity/)
  })
  it('bounds fields and operations', () => {
    const fields = [...layer().fields, ...Array.from({ length: 5 }, (_, i) => ({ name: `F_${i}`, type: 'integer' as const, editable: true, nullable: true }))]
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ fields }))).toThrow(/field count/)
    expect(() => new ArcGisLayerCapabilityRegistry({ ...budget, maxOperationsPerLayer: 2 }).register(layer())).toThrow(/operation count/)
  })
  it('rejects duplicate fields case-insensitively', () => {
    const fields = [...layer().fields, { name: 'name', type: 'string' as const, editable: true, nullable: true }]
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ fields }))).toThrow(/duplicate field/)
  })
  it('validates identity field references and types', () => {
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ objectIdField: 'MISSING' }))).toThrow(/oid field/)
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ objectIdField: 'NAME' }))).toThrow(/oid field/)
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ globalIdField: 'NAME' }))).toThrow(/globalid field/)
  })
  it('requires identity when edit capability is advertised', () => {
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ objectIdField: undefined, globalIdField: undefined }))).toThrow(/identity/)
  })
  it('rejects scene edit capability', () => { expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ kind: 'scene' }))).toThrow(/scene layer edit/) })
  it('enforces operation dependencies', () => {
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ operations: ['pagination'] }))).toThrow(/requires query/)
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ operations: ['statistics'] }))).toThrow(/requires query/)
  })
  it('rejects duplicate operations', () => { expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ operations: ['query', 'query'] }))).toThrow(/duplicate operation/) })
  it('rejects impossible non-spatial Z/M metadata', () => {
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ geometry: 'none', supportsZ: true }))).toThrow(/non-spatial/)
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ geometry: 'none', supportsM: true }))).toThrow(/non-spatial/)
  })
  it('bounds record count and metadata residency', () => {
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ maxRecordCount: 10_001 }))).toThrow(/ceiling/)
    expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ estimatedMetadataBytes: 8_001 }))).toThrow(/per-layer/)
  })
  it('bounds aggregate metadata and accounts replacement', () => {
    const registry = new ArcGisLayerCapabilityRegistry({ ...budget, maxAggregateMetadataBytes: 9_000 })
    registry.register(layer({ estimatedMetadataBytes: 5_000 })); registry.register(layer({ layerId: 'buildings', operations: ['query'], objectIdField: undefined, globalIdField: undefined, estimatedMetadataBytes: 4_000 }))
    expect(() => registry.register(layer({ layerId: 'roads', operations: ['query'], objectIdField: undefined, globalIdField: undefined, estimatedMetadataBytes: 1_000 }))).toThrow(/aggregate/)
    expect(() => registry.register(layer({ revision: 2, estimatedMetadataBytes: 6_000 }))).toThrow(/aggregate/); expect(registry.register(layer({ revision: 2, estimatedMetadataBytes: 4_000 })).estimatedMetadataBytes).toBe(4_000)
  })
  it('queries operation capability without exposing payload metadata', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); expect(registry.supports('planning', 'parcels', 'query')).toBe(true); expect(registry.supports('planning', 'parcels', 'attachments')).toBe(false); expect(registry.supports('planning', 'missing', 'query')).toBe(false)
  })
  it('returns detached field capability metadata', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); const field = registry.field('planning', 'parcels', 'name')
    expect(field).toEqual({ name: 'NAME', type: 'string', editable: true, nullable: false, maxLength: 80 }); expect(Object.isFrozen(field)).toBe(true); expect(registry.field('planning', 'parcels', 'UNKNOWN')).toBeUndefined()
  })
  it('binds consumers to exact service metadata revision', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); expect(registry.assertRevision('planning', 'parcels', 1)).toBe(true); expect(registry.assertRevision('planning', 'parcels', 2)).toBe(false); registry.register(layer({ revision: 2 })); expect(registry.assertRevision('planning', 'parcels', 1)).toBe(false)
  })
  it('releases layer and service metadata deterministically', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); registry.register(layer({ layerId: 'buildings', operations: ['query'], objectIdField: undefined, globalIdField: undefined })); expect(registry.releaseLayer('planning', 'parcels')).toBe(true); expect(registry.releaseLayer('planning', 'parcels')).toBe(false); expect(registry.releaseService('planning')).toBe(1); expect(registry.snapshot()).toEqual([])
  })
  it('sorts snapshots independent of registration order', () => {
    const a = new ArcGisLayerCapabilityRegistry(budget); const b = new ArcGisLayerCapabilityRegistry(budget); const second = layer({ layerId: 'buildings', operations: ['query'], objectIdField: undefined, globalIdField: undefined }); a.register(layer()); a.register(second); b.register(second); b.register(layer()); expect(a.snapshot()).toEqual(b.snapshot()); expect(a.fingerprint()).toBe(b.fingerprint())
  })
  it('changes fingerprint when capability semantics change', () => {
    const a = new ArcGisLayerCapabilityRegistry(budget); const b = new ArcGisLayerCapabilityRegistry(budget); a.register(layer()); b.register(layer({ operations: ['query', 'identify', 'edit', 'pagination'] })); expect(a.fingerprint()).not.toBe(b.fingerprint())
  })
  it('fingerprints exclude endpoint/token/payload objects', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); const value = registry.fingerprint(); expect(value).not.toContain('http'); expect(value).not.toContain('token'); expect(value).not.toContain('[object Object]')
  })
  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed service identifiers %s', serviceId => { expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ serviceId }))).toThrow(/invalid/) })
  it.each(['', 'bad field', '1FIELD'])('rejects malformed field names %s', name => {
    const fields = [{ name, type: 'string' as const, editable: true, nullable: true }]; expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ operations: ['query'], objectIdField: undefined, globalIdField: undefined, fields }))).toThrow(/field name/)
  })
  it('rejects maxLength on non-string field', () => {
    const fields = [{ name: 'COUNT', type: 'integer' as const, editable: true, nullable: true, maxLength: 4 }]; expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ operations: ['query'], objectIdField: undefined, globalIdField: undefined, fields }))).toThrow(/only valid for string/)
  })
  it.each([NaN, Infinity, -Infinity, -1, 1.5])('rejects invalid wkid %s', wkid => { expect(() => new ArcGisLayerCapabilityRegistry(budget).register(layer({ wkid }))).toThrow() })
  it('rejects invalid budgets eagerly', () => {
    expect(() => new ArcGisLayerCapabilityRegistry({ ...budget, maxLayers: 0 })).toThrow(/positive/); expect(() => new ArcGisLayerCapabilityRegistry({ ...budget, maxOperationsPerLayer: 7 })).toThrow(/impossible/); expect(() => new ArcGisLayerCapabilityRegistry({ ...budget, maxMetadataBytesPerLayer: 20_000 })).toThrow(/inconsistent/)
  })
  it('dispose clears authority and fails closed afterwards', () => {
    const registry = new ArcGisLayerCapabilityRegistry(budget); registry.register(layer()); registry.dispose(); expect(() => registry.snapshot()).toThrow(/disposed/); expect(() => registry.register(layer({ revision: 2 }))).toThrow(/disposed/)
  })
})
