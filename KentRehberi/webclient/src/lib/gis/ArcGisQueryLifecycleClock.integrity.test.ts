import { describe, expect, it } from 'vitest'
import {
  ArcGisQueryCountLifecyclePolicy,
  type QueryCountBudget,
} from './ArcGisQueryCountLifecyclePolicy'
import {
  ArcGisQueryExtentLifecyclePolicy,
  type ArcGisExtentBudget,
} from './ArcGisQueryExtentLifecyclePolicy'

const countBudget: QueryCountBudget = {
  maxLayers: 2, maxQueued: 4, maxRunning: 2, maxRunningPerLayer: 1,
  maxResident: 4, queueTtlMs: 100, leaseTtlMs: 30, residentTtlMs: 40,
}
const extentBudget: ArcGisExtentBudget = {
  maxLayers: 2, maxQueued: 4, maxRunning: 2, maxRunningPerLayer: 1,
  maxResident: 4, queueTtlMs: 100, leaseTtlMs: 30, residentTtlMs: 40,
}

function countRequest(key: string, queuedAt: number) {
  return { key, layerId: 'parcels', revision: 1, intent: 'visible' as const, signature: key, queuedAt }
}

function extentRequest(requestId: string, queuedAt: number) {
  return { requestId, layerId: 'parcels', revision: 1, intent: 'visible' as const,
    signature: requestId, queuedAt }
}

function extentResult(requestId: string, completedAt: number) {
  return { requestId, revision: 1, xmin: 29, ymin: 40, xmax: 30, ymax: 41,
    spatialReferenceWkid: 4326, completedAt }
}

describe('ArcGIS count and extent lifecycle clock integrity', () => {
  it('never starts future-dated count work before its admission time', () => {
    const p = new ArcGisQueryCountLifecyclePolicy(countBudget)
    p.setRevision('parcels', 1)
    expect(p.enqueue(countRequest('future', 100))).toBe(true)
    expect(p.startNext(99)).toBeNull()
    expect(p.snapshot().queued).toBe(1)
    expect(p.startNext(100)?.key).toBe('future')
  })

  it('rejects count lease renewal/completion before its actual start time', () => {
    const p = new ArcGisQueryCountLifecyclePolicy(countBudget)
    p.setRevision('parcels', 1)
    p.enqueue(countRequest('a', 10))
    expect(p.startNext(20)?.startedAt).toBe(20)
    expect(p.renew('a', 1, 19)).toBe(false)
    expect(p.complete('a', 1, 3, 19)).toBeNull()
    expect(p.snapshot().running).toBe(1)
    expect(p.complete('a', 1, 3, 20)?.count).toBe(3)
    expect(p.get('a', 1, 19)).toBeNull()
    expect(p.get('a', 1, 20)?.count).toBe(3)
  })

  it('never starts future-dated extent work before its admission time', () => {
    const p = new ArcGisQueryExtentLifecyclePolicy(extentBudget)
    p.setRevision('parcels', 1)
    expect(p.enqueue(extentRequest('future', 100))).toBe('queued')
    expect(p.acquire(99)).toBeNull()
    expect(p.snapshot().queued).toBe(1)
    expect(p.acquire(100)?.requestId).toBe('future')
  })

  it('rejects extent lease renewal/completion before acquisition and preserves the lease', () => {
    const p = new ArcGisQueryExtentLifecyclePolicy(extentBudget)
    p.setRevision('parcels', 1)
    p.enqueue(extentRequest('a', 10))
    expect(p.acquire(20)?.requestId).toBe('a')
    expect(p.renew('a', 1, 19)).toBeNull()
    expect(p.complete(extentResult('a', 19))).toBeNull()
    expect(p.snapshot().running).toBe(1)
    expect(p.complete(extentResult('a', 20))?.capturedAt).toBe(20)
    expect(p.lookup('parcels', 1, 'a', 19)).toBeNull()
    expect(p.lookup('parcels', 1, 'a', 20)?.xmin).toBe(29)
  })

  it('does not let a future-dated extent enqueue purge earlier residents', () => {
    const p = new ArcGisQueryExtentLifecyclePolicy(extentBudget)
    p.setRevision('parcels', 1)
    p.enqueue(extentRequest('first', 1))
    p.acquire(2)
    expect(p.complete(extentResult('first', 3))).not.toBeNull()
    expect(p.enqueue(extentRequest('future', 1000))).toBe('queued')
    expect(p.lookup('parcels', 1, 'first', 4)).not.toBeNull()
  })

  it('rejects control characters even if they would be removed by trimming', () => {
    const count = new ArcGisQueryCountLifecyclePolicy(countBudget)
    const extent = new ArcGisQueryExtentLifecyclePolicy(extentBudget)
    expect(() => count.setRevision('parcels\n', 1)).toThrow('layerId')
    expect(() => extent.setRevision('parcels\n', 1)).toThrow('layerId')
  })
})
