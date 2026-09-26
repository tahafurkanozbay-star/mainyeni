import { describe, expect, it } from 'vitest'
import { normalizeArcGisQueryCapabilities } from './ArcGisQueryCapabilitySnapshot'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'
import { ArcGisQueryHealthRegistry } from './ArcGisQueryHealthRegistry'
import { ArcGisQueryResultWindow } from './ArcGisQueryResultWindow'

describe('ArcGIS query runtime security boundaries', () => {
  it('rejects prototype-like identity field syntax', () => {
    const base = { maxRecordCount: 100, globalIdField: '', supportsPagination: false, supportsOrderBy: false, supportsStatistics: false, supportsDistinct: false, supportsReturningQueryExtent: false, supportsSqlExpression: false, supportedQueryFormats: 'json' }
    expect(() => normalizeArcGisQueryCapabilities({ ...base, objectIdField: '__proto__[x]' })).toThrow(/objectIdField/)
    expect(() => normalizeArcGisQueryCapabilities({ ...base, objectIdField: 'a/b' })).toThrow(/objectIdField/)
  })

  it('rejects oversized service identities before retaining health state', () => {
    const registry = new ArcGisQueryHealthRegistry()
    expect(() => registry.observe({ serviceKey: 'x'.repeat(513), outcome: 'success', latencyMs: 1 })).toThrow(/service key/)
    expect(registry.size).toBe(0)
  })

  it('rejects oversized object ids before accumulating features', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxObjectIdLength: 8 })
    expect(() => accumulator.append({ pageIndex: 0, features: [{ attributes: { OBJECTID: 'x'.repeat(9) } }] })).toThrow(/string object id/)
    expect(accumulator.snapshot().features).toBe(0)
  })

  it('rejects oversized sort strings before producing a result window', () => {
    const window = new ArcGisQueryResultWindow({ maxStringLength: 8 })
    expect(() => window.select({ features: [{ attributes: { OBJECTID: 1, name: 'x'.repeat(9) } }], objectIdField: 'OBJECTID', sort: [{ field: 'name', direction: 'asc' }], offset: 0, limit: 1 })).toThrow(/string sort value/)
  })

  it('does not interpret attribute strings as executable query syntax', () => {
    const window = new ArcGisQueryResultWindow()
    const payload = "1; DROP TABLE parcels; --"
    const result = window.select({ features: [{ attributes: { OBJECTID: 1, label: payload } }], objectIdField: 'OBJECTID', sort: [{ field: 'label', direction: 'asc' }], offset: 0, limit: 1 })
    expect(result.features[0]?.attributes.label).toBe(payload)
  })

  it('keeps geometry payload opaque while enforcing bounded accounting', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxEstimatedBytes: 4096 })
    accumulator.append({ pageIndex: 0, features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } } }] })
    expect(accumulator.snapshot().features).toBe(1)
  })

  it('rejects non-finite geometry numbers during bounded accounting', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    expect(() => accumulator.append({ pageIndex: 0, features: [{ attributes: { OBJECTID: 1 }, geometry: { x: Number.POSITIVE_INFINITY, y: 1 } }] })).toThrow(/finite/)
  })

  it('does not allow cancellation storms to mark a service unavailable', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 2 })
    for (let index = 0; index < 100; index += 1) registry.observe({ serviceKey: 'parcels', outcome: 'cancelled', latencyMs: 0 })
    expect(registry.snapshot('parcels')).toMatchObject({ state: 'healthy', failures: 0, cancellations: 100, samples: 0 })
  })

  it('bounds retained service state under adversarial identity churn', () => {
    let now = 0
    const registry = new ArcGisQueryHealthRegistry({ maxServices: 4, idleTtlMs: 10000 }, () => now)
    for (let index = 0; index < 20; index += 1) {
      now += 1
      registry.observe({ serviceKey: `service-${index}`, outcome: 'success', latencyMs: 1 })
    }
    expect(registry.size).toBe(4)
    expect(registry.snapshot('service-0')).toBeUndefined()
    expect(registry.snapshot('service-19')).toBeDefined()
  })
})
