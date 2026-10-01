import { describe, expect, it } from 'vitest'
import { ArcGisIdentifyLifecyclePolicy, type ArcGisIdentifyBudget, type ArcGisIdentifyRequest } from './ArcGisIdentifyLifecyclePolicy'

const budget: ArcGisIdentifyBudget = { maxRequests: 4, maxRunning: 1, maxReady: 2, maxResults: 100, queueTtlMs: 100, runLeaseMs: 50, readyTtlMs: 200 }
const request = (overrides: Partial<ArcGisIdentifyRequest> = {}): ArcGisIdentifyRequest => ({ viewId: 'map-2d', requestKey: '10:20', revision: 1, intent: 'visible', requestedAt: 10, estimatedResults: 20, spatialReferenceWkid: 3857, ...overrides })

describe('ArcGisIdentifyLifecyclePolicy', () => {
  it('validates budgets and request metadata', () => {
    expect(() => new ArcGisIdentifyLifecyclePolicy({ ...budget, maxRequests: 0 })).toThrow(/maxRequests/)
    expect(() => new ArcGisIdentifyLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow(/phase limits/)
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    expect(() => policy.admit(request({ viewId: ' ' }))).toThrow(/viewId/)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ spatialReferenceWkid: 0 }))).toThrow(/spatialReferenceWkid/)
  })

  it('rejects oversized requests and bounds cardinality', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy({ ...budget, maxRequests: 2 })
    expect(policy.admit(request({ estimatedResults: 101 }))).toBe(false)
    expect(policy.admit(request({ requestKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ requestKey: 'b' }))).toBe(true)
    expect(policy.admit(request({ requestKey: 'c' }))).toBe(false)
  })

  it('schedules interactive work before visible and hover work', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    policy.admit(request({ requestKey: 'hover', intent: 'hover' }))
    policy.admit(request({ requestKey: 'visible', intent: 'visible' }))
    policy.admit(request({ requestKey: 'click', intent: 'interactive' }))
    expect(policy.next(20)?.requestKey).toBe('click')
  })

  it('preserves FIFO ordering within an intent class', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy({ ...budget, maxRunning: 2 })
    policy.admit(request({ requestKey: 'first' })); policy.admit(request({ requestKey: 'second' }))
    expect(policy.next(20)?.requestKey).toBe('first')
    expect(policy.next(21)?.requestKey).toBe('second')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    policy.admit(request({ requestKey: 'a' })); policy.admit(request({ requestKey: 'b' }))
    expect(policy.next(20)?.requestKey).toBe('a'); expect(policy.next(21)).toBeNull()
  })

  it('expires queued requests before dispatch', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request())
    expect(policy.next(111)).toBeNull(); expect(policy.snapshot().requests).toBe(0)
  })

  it('rejects stale completion after run lease', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request()); policy.next(20)
    expect(policy.complete('map-2d', '10:20', 1, 71)).toBe(false)
  })

  it('requires running phase and exact revision for completion', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request())
    expect(policy.complete('map-2d', '10:20', 1, 20)).toBe(false)
    policy.next(20); expect(policy.complete('map-2d', '10:20', 2, 21)).toBe(false); expect(policy.complete('map-2d', '10:20', 1, 21)).toBe(true)
  })

  it('rejects oversized actual results', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request()); policy.next(20)
    expect(policy.complete('map-2d', '10:20', 1, 21, 101)).toBe(false)
  })

  it('bounds ready residency', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy({ ...budget, maxRunning: 2, maxReady: 1 })
    policy.admit(request({ requestKey: 'a' })); policy.admit(request({ requestKey: 'b' })); policy.next(20); policy.next(20)
    expect(policy.complete('map-2d', 'a', 1, 21)).toBe(true); expect(policy.complete('map-2d', 'b', 1, 21)).toBe(false)
  })

  it('consumes only ready exact revisions', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request()); policy.next(20); policy.complete('map-2d', '10:20', 1, 21)
    expect(policy.consume('map-2d', '10:20', 2)).toBe(false); expect(policy.consume('map-2d', '10:20', 1)).toBe(true); expect(policy.snapshot().requests).toBe(0)
  })

  it('invalidates older work when view revision advances', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    policy.admit(request({ requestKey: 'a', revision: 1 })); policy.admit(request({ requestKey: 'b', revision: 1 }))
    expect(policy.invalidateView('map-2d', 2)).toBe(2); expect(policy.admit(request({ revision: 1 }))).toBe(false); expect(policy.admit(request({ revision: 2 }))).toBe(true)
  })

  it('automatically invalidates stale work on newer admission', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    policy.admit(request({ requestKey: 'old', revision: 1 })); expect(policy.admit(request({ requestKey: 'new', revision: 2 }))).toBe(true); expect(policy.snapshot().requests).toBe(1)
  })

  it('does not downgrade duplicate priority', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true); expect(policy.admit(request({ intent: 'hover' }))).toBe(false); expect(policy.snapshot().requests).toBe(1)
  })

  it('releases all work and watermark for one view', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    policy.admit(request({ requestKey: 'a' })); policy.admit(request({ requestKey: 'b' })); expect(policy.releaseView('map-2d')).toBe(2); expect(policy.snapshot().requests).toBe(0)
    expect(policy.admit(request({ revision: 0 }))).toBe(true)
  })

  it('expires ready residency independently', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request()); policy.next(20); policy.complete('map-2d', '10:20', 1, 21)
    expect(policy.expire(221)).toBe(0); expect(policy.expire(222)).toBe(1)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget); policy.admit(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/); expect(() => policy.admit(request())).toThrow(/disposed/)
  })

  it('does not retain arbitrary runtime payload fields', () => {
    const policy = new ArcGisIdentifyLifecyclePolicy(budget)
    const payload = { geometry: { x: 1 }, graphic: { attributes: { secret: 'not-policy-state' } } }
    policy.admit({ ...request(), ...payload } as ArcGisIdentifyRequest)
    expect(JSON.stringify(policy.snapshot())).not.toContain('not-policy-state')
  })
})
