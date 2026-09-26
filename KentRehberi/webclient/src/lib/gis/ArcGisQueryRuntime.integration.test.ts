import { describe, expect, it } from 'vitest'
import { normalizeArcGisQueryCapabilities } from './ArcGisQueryCapabilitySnapshot'
import { ArcGisQueryAdaptiveSizer } from './ArcGisQueryAdaptiveSizer'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'
import { ArcGisQueryHealthRegistry } from './ArcGisQueryHealthRegistry'
import { ArcGisQueryResultWindow } from './ArcGisQueryResultWindow'

const capabilities = () => normalizeArcGisQueryCapabilities({
  maxRecordCount: 1000,
  objectIdField: 'OBJECTID',
  globalIdField: 'GlobalID',
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: true,
  supportsDistinct: true,
  supportsReturningQueryExtent: true,
  supportsSqlExpression: true,
  supportedQueryFormats: 'json,geojson',
})

const feature = (OBJECTID: number, score: number) => ({ attributes: { OBJECTID, score } })

describe('ArcGIS bounded query runtime composition', () => {
  it('uses verified service capacity as adaptive sizing ceiling', () => {
    const service = capabilities()
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 500, maxPageSize: 5000 })
    expect(sizer.recommend('parcels', service.maxRecordCount)).toBe(500)
    sizer.observe({ queryKey: 'parcels', requested: 500, returned: 500, latencyMs: 50, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('parcels', service.maxRecordCount)).toBe(1000)
    sizer.observe({ queryKey: 'parcels', requested: 1000, returned: 1000, latencyMs: 50, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('parcels', service.maxRecordCount)).toBe(1000)
  })

  it('feeds successful page latency into service health without false failure', () => {
    const health = new ArcGisQueryHealthRegistry({ minimumSamples: 2, slowLatencyMs: 500 })
    health.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 100 })
    const snapshot = health.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 120 })
    expect(snapshot.state).toBe('healthy')
    expect(snapshot.failures).toBe(0)
  })

  it('keeps caller cancellation neutral across health and adaptive sizing', () => {
    const health = new ArcGisQueryHealthRegistry({ minimumSamples: 2 })
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 400 })
    const size = sizer.recommend('parcels', 1000)
    health.observe({ serviceKey: 'parcels', outcome: 'cancelled', latencyMs: 0 })
    sizer.observe({ queryKey: 'parcels', requested: size, returned: 0, latencyMs: 0, exceededTransferLimit: false, outcome: 'cancelled' })
    expect(health.snapshot('parcels')).toMatchObject({ state: 'healthy', failures: 0, cancellations: 1 })
    expect(sizer.recommend('parcels', 1000)).toBe(size)
  })

  it('accumulates verified pages then creates deterministic UI windows', () => {
    const service = capabilities()
    const accumulator = new ArcGisQueryFeatureAccumulator(service.identityField)
    accumulator.append({ pageIndex: 0, features: [feature(3, 30), feature(1, 10)] })
    accumulator.append({ pageIndex: 1, features: [feature(2, 20)] })
    const result = new ArcGisQueryResultWindow().select({
      features: accumulator.finish(),
      objectIdField: service.identityField,
      sort: [{ field: 'score', direction: 'asc' }],
      offset: 0,
      limit: 2,
    })
    expect(result.features.map(item => item.attributes.OBJECTID)).toEqual([1, 2])
    expect(result.hasNext).toBe(true)
  })

  it('rejects cross-page duplicate identity before result-window projection', () => {
    const service = capabilities()
    const accumulator = new ArcGisQueryFeatureAccumulator(service.identityField)
    accumulator.append({ pageIndex: 0, features: [feature(1, 10)] })
    expect(() => accumulator.append({ pageIndex: 1, features: [feature(1, 20)] })).toThrow(/duplicate object id/)
    expect(accumulator.snapshot()).toMatchObject({ pages: 1, features: 1 })
  })

  it('keeps capability shrink authoritative over learned page size', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 500, maxPageSize: 5000 })
    expect(sizer.recommend('parcels', 2000)).toBe(500)
    expect(sizer.recommend('parcels', 250)).toBe(250)
    expect(sizer.snapshot('parcels')?.pageSize).toBe(250)
  })

  it('propagates service degradation independently from data acceptance', () => {
    const health = new ArcGisQueryHealthRegistry({ minimumSamples: 2, degradedFailureRatio: 0.25, unavailableFailureRatio: 0.75 })
    health.observe({ serviceKey: 'parcels', outcome: 'failure', latencyMs: 100 })
    health.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 100 })
    expect(health.state('parcels')).toBe('degraded')
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature(1, 10)] })
    expect(accumulator.snapshot().features).toBe(1)
  })

  it('fails closed when service metadata cannot prove deterministic pagination', () => {
    expect(() => normalizeArcGisQueryCapabilities({
      maxRecordCount: 1000,
      objectIdField: 'OBJECTID',
      supportsPagination: true,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsDistinct: false,
      supportsReturningQueryExtent: false,
      supportsSqlExpression: false,
      supportedQueryFormats: 'json',
    })).toThrow(/pagination requires/)
  })

  it('does not let a result window mutate accumulated order', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID')
    accumulator.append({ pageIndex: 0, features: [feature(2, 20), feature(1, 10)] })
    const accepted = accumulator.finish()
    new ArcGisQueryResultWindow().select({ features: accepted, objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 0, limit: 10 })
    expect(accepted.map(item => item.attributes.OBJECTID)).toEqual([2, 1])
  })
})
