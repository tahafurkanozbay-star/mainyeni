import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshPolicy } from './ArcGisLayerRefreshPolicy'

describe('ArcGIS governance hard bounds', () => {
  it('rejects unsafe unbounded refresh configuration', () => {
    const base = {
      maxLayers: 1, maxQueued: 1, maxRunning: 1, maxRunningPerGroup: 1,
      maxEstimatedBytesInFlight: 1, minRefreshIntervalMs: 0,
      maxQueueAgeMs: 1, maxRunLeaseMs: 1, maxBackoffMs: 0,
    }
    expect(() => new ArcGisLayerRefreshPolicy({ ...base, maxQueued: 0 })).toThrow()
    expect(() => new ArcGisLayerRefreshPolicy({ ...base, maxRunning: 0 })).toThrow()
    expect(() => new ArcGisLayerRefreshPolicy({ ...base, maxRunLeaseMs: 0 })).toThrow()
  })

  it('does not admit malformed layer or group identities', () => {
    const policy = new ArcGisLayerRefreshPolicy({ maxLayers: 1, maxQueued: 1, maxRunning: 1, maxRunningPerGroup: 1, maxEstimatedBytesInFlight: 10, minRefreshIntervalMs: 0, maxQueueAgeMs: 10, maxRunLeaseMs: 10, maxBackoffMs: 0 })
    expect(() => policy.enqueue({ layerId: '', groupId: 'g', revision: 1, priority: 'foreground', estimatedBytes: 1, requestedAt: 0 })).toThrow()
    expect(() => policy.enqueue({ layerId: 'l', groupId: '', revision: 1, priority: 'foreground', estimatedBytes: 1, requestedAt: 0 })).toThrow()
  })
})
