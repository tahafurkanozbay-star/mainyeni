import { describe, expect, it } from 'vitest'
import { ArcGisRequestScheduler } from './ArcGisRequestScheduler'

const budget = { maxConcurrent: 2, maxQueued: 3, maxEstimatedInflightBytes: 100, maxTimeoutMs: 10_000, maxKeyLength: 64 }
const request = (key: string, priority = 0, bytes = 20) => ({ key, priority, estimatedResponseBytes: bytes, timeoutMs: 1000, cacheable: true })

describe('ArcGisRequestScheduler', () => {
  it('activates within concurrency and byte budgets', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    scheduler.schedule(request('a', 0, 30))
    scheduler.schedule(request('b', 0, 40))
    expect(scheduler.snapshot()).toMatchObject({ estimatedInflightBytes: 70 })
    expect(scheduler.snapshot().active.map(x => x.key)).toEqual(['a', 'b'])
  })

  it('queues when concurrency is saturated', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    scheduler.schedule(request('a'))
    scheduler.schedule(request('b'))
    scheduler.schedule(request('c'))
    expect(scheduler.snapshot().queued.map(x => x.key)).toEqual(['c'])
  })

  it('queues when byte budget prevents activation', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    scheduler.schedule(request('a', 0, 90))
    scheduler.schedule(request('b', 0, 20))
    expect(scheduler.snapshot().active.map(x => x.key)).toEqual(['a'])
    expect(scheduler.snapshot().queued.map(x => x.key)).toEqual(['b'])
  })

  it('drains highest priority eligible request after completion', () => {
    const scheduler = new ArcGisRequestScheduler({ ...budget, maxConcurrent: 1 })
    const a = scheduler.schedule(request('a'))
    scheduler.schedule(request('low', 1))
    scheduler.schedule(request('high', 10))
    expect(scheduler.complete(a)).toBe(true)
    expect(scheduler.snapshot().active.map(x => x.key)).toEqual(['high'])
  })

  it('deduplicates active and queued request keys', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    scheduler.schedule(request('same'))
    expect(() => scheduler.schedule(request(' same '))).toThrow('duplicate-request:same')
  })

  it('rejects unsafe request keys', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    expect(() => scheduler.schedule(request('bad\nkey'))).toThrow('invalid-request-key')
  })

  it('enforces queue cardinality', () => {
    const scheduler = new ArcGisRequestScheduler({ ...budget, maxConcurrent: 1, maxQueued: 1 })
    scheduler.schedule(request('a'))
    scheduler.schedule(request('b'))
    expect(() => scheduler.schedule(request('c'))).toThrow('request-queue-budget-exceeded')
  })

  it('cancels queued requests without changing inflight bytes', () => {
    const scheduler = new ArcGisRequestScheduler({ ...budget, maxConcurrent: 1 })
    scheduler.schedule(request('a', 0, 30))
    const b = scheduler.schedule(request('b', 0, 40))
    expect(scheduler.cancel(b)).toBe(true)
    expect(scheduler.snapshot()).toMatchObject({ estimatedInflightBytes: 30, queued: [] })
  })

  it('cancels active requests and drains the queue', () => {
    const scheduler = new ArcGisRequestScheduler({ ...budget, maxConcurrent: 1 })
    const a = scheduler.schedule(request('a'))
    scheduler.schedule(request('b'))
    expect(scheduler.cancel(a)).toBe(true)
    expect(scheduler.snapshot().active.map(x => x.key)).toEqual(['b'])
  })

  it('rejects stale completion tickets', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    const first = scheduler.schedule(request('a'))
    scheduler.cancel(first)
    const second = scheduler.schedule(request('a'))
    expect(scheduler.complete(first)).toBe(false)
    expect(scheduler.complete(second)).toBe(true)
  })

  it('orders snapshots deterministically', () => {
    const scheduler = new ArcGisRequestScheduler({ ...budget, maxConcurrent: 1 })
    scheduler.schedule(request('z'))
    scheduler.schedule(request('b', 2))
    scheduler.schedule(request('a', 2))
    expect(scheduler.snapshot().queued.map(x => x.key)).toEqual(['b', 'a'])
  })

  it('bounds timeouts', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    expect(() => scheduler.schedule({ ...request('a'), timeoutMs: 10_001 })).toThrow('timeoutMs')
  })

  it('bounds estimated response bytes', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    expect(() => scheduler.schedule({ ...request('a'), estimatedResponseBytes: Number.MAX_SAFE_INTEGER })).toThrow('estimatedResponseBytes')
  })

  it('disposes deterministically and rejects future scheduling', () => {
    const scheduler = new ArcGisRequestScheduler(budget)
    scheduler.schedule(request('a'))
    scheduler.dispose()
    scheduler.dispose()
    expect(scheduler.snapshot()).toMatchObject({ active: [], queued: [], estimatedInflightBytes: 0 })
    expect(() => scheduler.schedule(request('b'))).toThrow('request-scheduler-disposed')
  })
})
