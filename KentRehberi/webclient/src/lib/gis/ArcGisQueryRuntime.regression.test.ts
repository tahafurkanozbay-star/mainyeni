import { describe, expect, it } from 'vitest'
import { ArcGisQueryFeatureAccumulator } from './ArcGisQueryFeatureAccumulator'
import { ArcGisQueryHealthRegistry } from './ArcGisQueryHealthRegistry'
import { ArcGisQueryResultWindow } from './ArcGisQueryResultWindow'

describe('ArcGIS query runtime regression invariants', () => {
  it('preserves accepted state when a later page exceeds its byte budget', () => {
    const accumulator = new ArcGisQueryFeatureAccumulator('OBJECTID', { maxEstimatedBytes: 300 })
    accumulator.append({ pageIndex: 0, features: [{ attributes: { OBJECTID: 1 } }] })
    const before = accumulator.snapshot()
    expect(() => accumulator.append({ pageIndex: 1, features: [{ attributes: { OBJECTID: 2, label: 'x'.repeat(300) } }] })).toThrow(/byte budget/)
    expect(accumulator.snapshot()).toEqual(before)
  })

  it('keeps service health isolated by verified service identity', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 2, unavailableFailureRatio: 0.5 })
    registry.observe({ serviceKey: 'parcels', outcome: 'failure', latencyMs: 1 })
    registry.observe({ serviceKey: 'parcels', outcome: 'failure', latencyMs: 1 })
    registry.observe({ serviceKey: 'roads', outcome: 'success', latencyMs: 1 })
    registry.observe({ serviceKey: 'roads', outcome: 'success', latencyMs: 1 })
    expect(registry.state('parcels')).toBe('unavailable')
    expect(registry.state('roads')).toBe('healthy')
  })

  it('never returns more features than the requested result-window limit', () => {
    const features = Array.from({ length: 100 }, (_, index) => ({ attributes: { OBJECTID: index + 1, score: 100 - index } }))
    const result = new ArcGisQueryResultWindow().select({ features, objectIdField: 'OBJECTID', sort: [{ field: 'score', direction: 'asc' }], offset: 10, limit: 7 })
    expect(result.features).toHaveLength(7)
    expect(result.total).toBe(100)
    expect(result.hasPrevious).toBe(true)
    expect(result.hasNext).toBe(true)
  })
})
