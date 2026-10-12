import { describe, expect, it } from 'vitest'
import { ArcGisQuerySchedulerPolicy, type ArcGisQuerySchedulerBudget } from './ArcGisQuerySchedulerPolicy'

const budget: ArcGisQuerySchedulerBudget = {
  maxQueued: 4,
  maxRunning: 2,
  maxPerLayerRunning: 1,
  maxEstimatedResponseBytes: 100,
  maxAggregateRunningBytes: 150,
  maxWaitMs: 1_000,
  maxRunMs: 500,
  maxLayerIdLength: 32,
  maxRequestIdLength: 32,
}

function scheduler(overrides: Partial<ArcGisQuerySchedulerBudget> = {}) {
  return new ArcGisQuerySchedulerPolicy({ ...budget, ...overrides })
}

function enqueue(policy: ArcGisQuerySchedulerPolicy, requestId: string, layerId = 'layer-a', priority: 'interactive' | 'foreground' | 'background' = 'foreground', bytes = 20, revision = 1, nowMs = 10) {
  return policy.enqueue({ requestId, layerId, priority, estimatedResponseBytes: bytes, revision, nowMs, waitMs: 100 })
}

describe('ArcGisQuerySchedulerPolicy', () => {
  it('orders interactive work before foreground and background work', () => {
    const policy = scheduler()
    enqueue(policy, 'background', 'a', 'background')
    enqueue(policy, 'foreground', 'b', 'foreground')
    enqueue(policy, 'interactive', 'c', 'interactive')
    expect(policy.startNext(20)?.requestId).toBe('interactive')
  })

  it('uses deadline and id as deterministic tie breakers', () => {
    const policy = scheduler()
    policy.enqueue({ requestId: 'z', layerId: 'a', revision: 1, priority: 'foreground', estimatedResponseBytes: 1, nowMs: 10, waitMs: 80 })
    policy.enqueue({ requestId: 'b', layerId: 'b', revision: 1, priority: 'foreground', estimatedResponseBytes: 1, nowMs: 10, waitMs: 50 })
    policy.enqueue({ requestId: 'a', layerId: 'c', revision: 1, priority: 'foreground', estimatedResponseBytes: 1, nowMs: 10, waitMs: 50 })
    expect(policy.startNext(20)?.requestId).toBe('a')
  })

  it('rejects duplicate request identities across queued work', () => {
    const policy = scheduler()
    enqueue(policy, 'same')
    expect(() => enqueue(policy, 'same')).toThrow('duplicate-query-request')
  })

  it('rejects duplicate request identities while running', () => {
    const policy = scheduler()
    enqueue(policy, 'same')
    policy.startNext(20)
    expect(() => enqueue(policy, 'same')).toThrow('duplicate-query-request')
  })

  it('enforces queue cardinality', () => {
    const policy = scheduler({ maxQueued: 2 })
    enqueue(policy, 'a')
    enqueue(policy, 'b')
    expect(() => enqueue(policy, 'c')).toThrow('query-queue-budget-exceeded')
  })

  it('enforces global running concurrency', () => {
    const policy = scheduler({ maxRunning: 1, maxPerLayerRunning: 1 })
    enqueue(policy, 'a', 'a')
    enqueue(policy, 'b', 'b')
    expect(policy.startNext(20)?.requestId).toBe('a')
    expect(policy.startNext(20)).toBeUndefined()
  })

  it('skips a saturated layer without starving another layer', () => {
    const policy = scheduler()
    enqueue(policy, 'a1', 'a', 'interactive')
    enqueue(policy, 'a2', 'a', 'interactive')
    enqueue(policy, 'b1', 'b', 'foreground')
    expect(policy.startNext(20)?.requestId).toBe('a1')
    expect(policy.startNext(20)?.requestId).toBe('b1')
  })

  it('enforces aggregate estimated response bytes', () => {
    const policy = scheduler({ maxAggregateRunningBytes: 100, maxEstimatedResponseBytes: 100 })
    enqueue(policy, 'a', 'a', 'foreground', 80)
    enqueue(policy, 'b', 'b', 'foreground', 30)
    policy.startNext(20)
    expect(policy.startNext(20)).toBeUndefined()
  })

  it('removes expired queued work before scheduling', () => {
    const policy = scheduler()
    enqueue(policy, 'old')
    expect(policy.startNext(110)).toBeUndefined()
    expect(policy.snapshot().queued).toHaveLength(0)
  })

  it('expires running leases and releases byte accounting', () => {
    const policy = scheduler()
    enqueue(policy, 'a', 'a', 'foreground', 70)
    policy.startNext(20)
    expect(policy.snapshot().runningBytes).toBe(70)
    expect(policy.tick(520)).toEqual({ queuedExpired: 0, runningExpired: 1 })
    expect(policy.snapshot().runningBytes).toBe(0)
  })

  it('completes only the admitted revision', () => {
    const policy = scheduler()
    enqueue(policy, 'a', 'a', 'foreground', 20, 7)
    policy.startNext(20)
    expect(policy.complete('a', 6)).toBe(false)
    expect(policy.snapshot().running).toHaveLength(1)
    expect(policy.complete('a', 7)).toBe(true)
    expect(policy.snapshot().running).toHaveLength(0)
  })

  it('releases failed work', () => {
    const policy = scheduler()
    enqueue(policy, 'a')
    policy.startNext(20)
    expect(policy.fail('a')).toBe(true)
    expect(policy.fail('a')).toBe(false)
  })

  it('cancels only queued work', () => {
    const policy = scheduler()
    enqueue(policy, 'a')
    expect(policy.cancel('a')).toBe(true)
    expect(policy.cancel('a')).toBe(false)
  })

  it('invalidates stale revisions in queued and running sets', () => {
    const policy = scheduler()
    enqueue(policy, 'old-running', 'a', 'foreground', 10, 1)
    policy.startNext(20)
    enqueue(policy, 'old-queued', 'a', 'foreground', 10, 2)
    enqueue(policy, 'current', 'a', 'foreground', 10, 3)
    expect(policy.invalidateLayerRevision('a', 3)).toBe(2)
    expect(policy.snapshot().queued.map((entry) => entry.requestId)).toEqual(['current'])
    expect(policy.snapshot().runningBytes).toBe(0)
  })

  it('returns immutable snapshot containers', () => {
    const policy = scheduler()
    enqueue(policy, 'a')
    const snapshot = policy.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.queued)).toBe(true)
    expect(Object.isFrozen(snapshot.queued[0])).toBe(true)
  })

  it('rejects malformed identifiers and control characters', () => {
    const policy = scheduler()
    expect(() => enqueue(policy, '   ')).toThrow('invalid-request-id')
    expect(() => enqueue(policy, 'ok', 'bad\nlayer')).toThrow('invalid-layer-id')
  })

  it('rejects unsafe budget relationships', () => {
    expect(() => scheduler({ maxRunning: 1, maxPerLayerRunning: 2 })).toThrow('maxPerLayerRunning must be <= maxRunning')
    expect(() => scheduler({ maxAggregateRunningBytes: 50, maxEstimatedResponseBytes: 60 })).toThrow('maxEstimatedResponseBytes must be <= maxAggregateRunningBytes')
  })

  it('rejects oversized response estimates at admission', () => {
    const policy = scheduler()
    expect(() => enqueue(policy, 'a', 'a', 'foreground', 101)).toThrow('estimatedResponseBytes')
  })

  it('fails closed after disposal and clears retained metadata', () => {
    const policy = scheduler()
    enqueue(policy, 'a')
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('arcgis-query-scheduler-disposed')
    expect(() => enqueue(policy, 'b')).toThrow('arcgis-query-scheduler-disposed')
  })
  it('never starts a future-dated interactive query ahead of eligible background work', () => {
    const policy = scheduler()
    enqueue(policy, 'future', 'future-layer', 'interactive', 20, 1, 500)
    enqueue(policy, 'ready', 'ready-layer', 'background', 20, 1, 10)
    expect(policy.startNext(20)?.requestId).toBe('ready')
    expect(policy.startNext(499)).toBeUndefined()
    expect(policy.snapshot().queued.map(entry => entry.requestId)).toEqual(['future'])
    expect(policy.startNext(500)?.requestId).toBe('future')
  })

  it('keeps a clock rollback from resurrecting work already expired', () => {
    const policy = scheduler()
    enqueue(policy, 'expired', 'a', 'foreground', 20, 1, 10)
    expect(policy.tick(110)).toEqual({ queuedExpired: 1, runningExpired: 0 })
    expect(policy.startNext(15)).toBeUndefined()
    expect(policy.snapshot().queued).toHaveLength(0)
    enqueue(policy, 'new', 'b', 'foreground', 20, 1, 20)
    // Enqueued at 20 with a deadline of 120: the monotonic scheduler
    // must not treat 30 as if the clock returned to the beginning.
    expect(policy.startNext(30)?.startedAtMs).toBe(110)
  })

  it('enforces a monotonically observed lease start time after a forward tick', () => {
    const policy = scheduler()
    policy.tick(500)
    enqueue(policy, 'late', 'layer-x', 'interactive', 20, 1, 10)
    const lease = policy.startNext(11)
    expect(lease?.startedAtMs).toBeUndefined() // enqueuedAt=10, deadline=110 already expired
    enqueue(policy, 'new', 'layer-y', 'interactive', 20, 1, 450)
    const active = policy.startNext(480)
    expect(active?.startedAtMs).toBe(500)
    expect(active?.expiresAtMs).toBe(1000)
    expect(policy.tick(950).runningExpired).toBe(0)
    expect(policy.tick(900).runningExpired).toBe(0)
    expect(policy.tick(1000).runningExpired).toBe(1)
    expect(policy.snapshot().runningBytes).toBe(0)
  })

  it('rejects invalid control characters before normalization instead of aliasing identifiers', () => {
    const policy = scheduler()
    for (const character of ['\n', '\r', '\t', '\u0000', '\u007f', '\u001f']) {
      expect(() => enqueue(policy, `${character}a`)).toThrow('invalid-request-id')
      expect(() => enqueue(policy, `a${character}`)).toThrow('invalid-request-id')
      expect(() => enqueue(policy, 'safe', `${character}layer`)).toThrow('invalid-layer-id')
      expect(() => policy.cancel(`a${character}`)).toThrow('invalid-request-id')
    }
    expect(policy.snapshot()).toMatchObject({ queued: [], running: [], runningBytes: 0 })
  })

  it('fails without draining live metadata when the next lease deadline overflows', () => {
    const policy = scheduler()
    enqueue(policy, 'queued', 'layer-a', 'foreground', 20, 1, 10)
    const before = policy.snapshot()
    expect(() => policy.startNext(Number.MAX_SAFE_INTEGER)).toThrow('query-lease-overflow')
    const after = policy.snapshot()
    expect(after).toEqual(before)
    expect(policy.cancel('queued')).toBe(true)
    expect(policy.snapshot().runningBytes).toBe(0)
  })

  it('retains deterministic priority after a future-dated query becomes eligible', () => {
    const policy = scheduler({ maxRunning: 2, maxPerLayerRunning: 1 })
    enqueue(policy, 'later', 'future', 'interactive', 20, 1, 200)
    enqueue(policy, 'visible', 'visible', 'foreground', 20, 1, 150)
    enqueue(policy, 'background', 'bg', 'background', 20, 1, 100)
    expect(policy.startNext(101)?.requestId).toBe('background')
    expect(policy.startNext(151)?.requestId).toBe('visible')
    expect(policy.startNext(201)).toBeUndefined() // two physical reservations remain
    expect(policy.complete('background', 1)).toBe(true)
    expect(policy.startNext(202)?.requestId).toBe('later')
  })

})
