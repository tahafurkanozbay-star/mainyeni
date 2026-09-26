import { describe, expect, it } from 'vitest'
import { ArcGisQueryAdaptiveSizer } from './ArcGisQueryAdaptiveSizer'

describe('ArcGisQueryAdaptiveSizer', () => {
  it('starts conservatively and never exceeds verified service capacity', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 200, maxPageSize: 2_000 })
    expect(sizer.recommend('parcels', 1_000)).toBe(200)
    expect(sizer.recommend('small-service', 75)).toBe(75)
  })

  it('additively increases after fast full pages', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 100, targetLatencyMs: 500 })
    expect(sizer.recommend('parcels', 2_000)).toBe(100)
    sizer.observe({ queryKey: 'parcels', requested: 100, returned: 100, latencyMs: 100, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
  })

  it('multiplicatively decreases on high latency', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 400, decreaseFactor: 0.5, highLatencyMs: 1_000 })
    expect(sizer.recommend('parcels', 2_000)).toBe(400)
    sizer.observe({ queryKey: 'parcels', requested: 400, returned: 400, latencyMs: 2_000, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
  })

  it('decreases on transfer-limit pressure even when latency is low', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 50, increaseStep: 400, decreaseFactor: 0.5 })
    expect(sizer.recommend('parcels', 2_000)).toBe(400)
    sizer.observe({ queryKey: 'parcels', requested: 400, returned: 400, latencyMs: 50, exceededTransferLimit: true, outcome: 'success' })
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
  })

  it('decreases on failures but ignores caller cancellation', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 400, decreaseFactor: 0.5 })
    expect(sizer.recommend('parcels', 2_000)).toBe(400)
    sizer.observe({ queryKey: 'parcels', requested: 400, returned: 0, latencyMs: 10, exceededTransferLimit: false, outcome: 'cancelled' })
    expect(sizer.recommend('parcels', 2_000)).toBe(400)
    sizer.observe({ queryKey: 'parcels', requested: 400, returned: 0, latencyMs: 10, exceededTransferLimit: false, outcome: 'failure' })
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
    expect(sizer.snapshot('parcels')).toMatchObject({ failedPages: 1, successfulPages: 0 })
  })

  it('uses an EWMA instead of reacting to a single low-latency sample', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({
      minPageSize: 100,
      increaseStep: 200,
      targetLatencyMs: 500,
      highLatencyMs: 2_000,
      latencyAlpha: 0.25,
    })
    sizer.recommend('parcels', 2_000)
    sizer.observe({ queryKey: 'parcels', requested: 200, returned: 200, latencyMs: 1_500, exceededTransferLimit: false, outcome: 'success' })
    sizer.observe({ queryKey: 'parcels', requested: 200, returned: 200, latencyMs: 100, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.snapshot('parcels')?.smoothedLatencyMs).toBe(1_150)
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
  })

  it('does not grow on sparse terminal pages', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 200, targetLatencyMs: 500 })
    sizer.recommend('parcels', 2_000)
    sizer.observe({ queryKey: 'parcels', requested: 200, returned: 20, latencyMs: 20, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('parcels', 2_000)).toBe(200)
  })

  it('re-clamps learned state when verified service capacity shrinks', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 500, maxPageSize: 2_000 })
    expect(sizer.recommend('parcels', 2_000)).toBe(500)
    expect(sizer.recommend('parcels', 250)).toBe(250)
    expect(sizer.snapshot('parcels')?.pageSize).toBe(250)
  })

  it('keeps independent query identities isolated', () => {
    const sizer = new ArcGisQueryAdaptiveSizer({ minPageSize: 100, increaseStep: 100 })
    sizer.recommend('a', 1_000)
    sizer.recommend('b', 1_000)
    sizer.observe({ queryKey: 'a', requested: 100, returned: 100, latencyMs: 20, exceededTransferLimit: false, outcome: 'success' })
    expect(sizer.recommend('a', 1_000)).toBe(200)
    expect(sizer.recommend('b', 1_000)).toBe(100)
  })

  it('evicts idle records and bounds retained adaptive state', () => {
    let now = 0
    const sizer = new ArcGisQueryAdaptiveSizer({ maxTrackedQueries: 2, idleTtlMs: 10 }, () => now)
    sizer.recommend('a', 1_000)
    now = 1
    sizer.recommend('b', 1_000)
    now = 11
    sizer.recommend('c', 1_000)
    expect(sizer.size).toBe(1)
    expect(sizer.snapshot('a')).toBeUndefined()
    expect(sizer.snapshot('b')).toBeUndefined()
  })

  it('evicts least-recently-touched state at hard capacity', () => {
    let now = 0
    const sizer = new ArcGisQueryAdaptiveSizer({ maxTrackedQueries: 2, idleTtlMs: 1_000 }, () => now)
    sizer.recommend('old', 1_000)
    now = 5
    sizer.recommend('new', 1_000)
    now = 6
    sizer.recommend('third', 1_000)
    expect(sizer.snapshot('old')).toBeUndefined()
    expect(sizer.size).toBe(2)
  })

  it('supports reset and clear', () => {
    const sizer = new ArcGisQueryAdaptiveSizer()
    sizer.recommend('a', 1_000)
    expect(sizer.reset('a')).toBe(true)
    expect(sizer.reset('a')).toBe(false)
    sizer.recommend('b', 1_000)
    sizer.clear()
    expect(sizer.size).toBe(0)
  })

  it('fails closed for invalid options and observations', () => {
    expect(() => new ArcGisQueryAdaptiveSizer({ minPageSize: 500, maxPageSize: 100 })).toThrow(/minPageSize/)
    expect(() => new ArcGisQueryAdaptiveSizer({ targetLatencyMs: 500, highLatencyMs: 500 })).toThrow(/targetLatencyMs/)
    expect(() => new ArcGisQueryAdaptiveSizer({ decreaseFactor: 1 })).toThrow(/decreaseFactor/)
    expect(() => new ArcGisQueryAdaptiveSizer({ latencyAlpha: 0 })).toThrow(/latencyAlpha/)
    const sizer = new ArcGisQueryAdaptiveSizer()
    expect(() => sizer.recommend(' ', 1_000)).toThrow(/query key/)
    expect(() => sizer.recommend('a', 0)).toThrow(/verifiedMaxRecordCount/)
    sizer.recommend('a', 1_000)
    expect(() => sizer.observe({ queryKey: 'a', requested: 10, returned: 11, latencyMs: 1, exceededTransferLimit: false, outcome: 'success' })).toThrow(/returned count/)
    expect(() => sizer.observe({ queryKey: 'a', requested: 10, returned: 1, latencyMs: Number.NaN, exceededTransferLimit: false, outcome: 'success' })).toThrow(/latency/)
  })
})
