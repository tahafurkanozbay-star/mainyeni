import { describe, expect, it } from 'vitest'
import { ArcGisCameraTransitionLifecyclePolicy, type ArcGisCameraTransitionBudget, type ArcGisCameraTransitionRequest } from './ArcGisCameraTransitionLifecyclePolicy'

const budget: ArcGisCameraTransitionBudget = {
  maxTransitions: 6, maxTransitionsPerView: 4, maxRunning: 2, maxSettled: 3,
  maxWaypointsPerTransition: 32, maxEstimatedBytesPerTransition: 10000,
  maxAggregateSettledBytes: 20000, queueTtlMs: 100, runLeaseMs: 200, settledTtlMs: 300,
}

function request(overrides: Partial<ArcGisCameraTransitionRequest> = {}): ArcGisCameraTransitionRequest {
  return { viewId: 'view-1', transitionId: 'transition-1', revision: 1, intent: 'selection', requestedAt: 10, waypointCount: 2, estimatedBytes: 1000, targetScale: 5000, ...overrides }
}

function settle(policy: ArcGisCameraTransitionLifecyclePolicy, id = 'transition-1', bytes = 1000): boolean {
  policy.takeNext(20)
  return policy.complete('view-1', id, 1, bytes, 30)
}

describe('ArcGisCameraTransitionLifecyclePolicy', () => {
  it('prioritizes user, selection, then restore transitions', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'restore', intent: 'restore', requestedAt: 1 }))
    policy.enqueue(request({ transitionId: 'selection', intent: 'selection', requestedAt: 2 }))
    policy.enqueue(request({ transitionId: 'user', intent: 'user', requestedAt: 3 }))
    expect(policy.takeNext(20)?.transitionId).toBe('user')
    expect(policy.takeNext(21)?.transitionId).toBe('selection')
  })

  it('uses request time and sequence as deterministic tie breaks', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'later', requestedAt: 6 }))
    policy.enqueue(request({ transitionId: 'first', requestedAt: 5 }))
    policy.enqueue(request({ transitionId: 'second', requestedAt: 5 }))
    expect(policy.takeNext(20)?.transitionId).toBe('first')
    expect(policy.takeNext(20)?.transitionId).toBe('second')
  })

  it('bounds global and per-view cardinality', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxTransitions: 2, maxTransitionsPerView: 1, maxRunning: 1, maxSettled: 1 })
    expect(policy.enqueue(request({ transitionId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ transitionId: 'b' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'view-2', transitionId: 'c' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'view-3', transitionId: 'd' }))).toBe(false)
  })

  it('bounds waypoint and estimated-byte admission', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ waypointCount: 33 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 10001 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds concurrent running transitions', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxRunning: 1 })
    policy.enqueue(request({ transitionId: 'a' }))
    policy.enqueue(request({ transitionId: 'b' }))
    expect(policy.takeNext(20)?.transitionId).toBe('a')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('accepts matching completion and records actual residency', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(settle(policy, 'transition-1', 1234)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'settled', actualBytes: 1234, expiresAt: 330 })
  })

  it('rejects late completion after the run lease', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(policy.complete('view-1', 'transition-1', 1, 100, 220)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects completion beyond per-transition bytes', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(policy.complete('view-1', 'transition-1', 1, 10001, 30)).toBe(false)
  })

  it('bounds aggregate settled bytes using actual bytes', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxAggregateSettledBytes: 10000 })
    policy.enqueue(request({ transitionId: 'a' })); policy.enqueue(request({ transitionId: 'b' }))
    policy.takeNext(20); policy.takeNext(20)
    expect(policy.complete('view-1', 'a', 1, 7000, 30)).toBe(true)
    expect(policy.complete('view-1', 'b', 1, 4000, 30)).toBe(false)
  })

  it('bounds settled cardinality', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxSettled: 1 })
    policy.enqueue(request({ transitionId: 'a' })); policy.enqueue(request({ transitionId: 'b' }))
    policy.takeNext(20); policy.takeNext(20)
    expect(policy.complete('view-1', 'a', 1, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'b', 1, 100, 30)).toBe(false)
  })

  it('touch extends only live settled residency', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request()); settle(policy)
    expect(policy.touch('view-1', 'transition-1', 1, 40)).toBe(true)
    expect(policy.snapshot()[0]?.expiresAt).toBe(340)
    expect(policy.touch('view-1', 'transition-1', 2, 50)).toBe(false)
  })

  it('consume releases settled ownership', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request()); settle(policy)
    expect(policy.consume('view-1', 'transition-1', 2)).toBe(false)
    expect(policy.consume('view-1', 'transition-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancel requires matching revision', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('view-1', 'transition-1', 2)).toBe(false)
    expect(policy.cancel('view-1', 'transition-1', 1)).toBe(true)
  })

  it('rejects stale revisions and replaces older duplicate ownership', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 2 }))).toBe(true)
    expect(policy.enqueue(request({ revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ revision: 3 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(1)
    expect(policy.snapshot()[0]?.revision).toBe(3)
  })

  it('invalidates stale work when view revision advances', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'a' })); policy.enqueue(request({ transitionId: 'b' }))
    expect(policy.invalidateView('view-1', 2)).toBe(2)
    expect(policy.enqueue(request({ transitionId: 'stale', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ transitionId: 'fresh', revision: 2 }))).toBe(true)
  })

  it('does not regress a revision watermark', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.invalidateView('view-1', 2)).toBe(0)
    expect(policy.enqueue(request({ transitionId: 'old', revision: 2 }))).toBe(false)
  })

  it('expires queue and settled entries at exact TTL boundaries', () => {
    const queued = new ArcGisCameraTransitionLifecyclePolicy(budget)
    queued.enqueue(request({ requestedAt: 10 }))
    expect(queued.expire(109)).toBe(0); expect(queued.expire(110)).toBe(1)
    const settled = new ArcGisCameraTransitionLifecyclePolicy(budget)
    settled.enqueue(request()); settle(settled)
    expect(settled.expire(329)).toBe(0); expect(settled.expire(330)).toBe(1)
  })

  it('releaseView clears entries and revision watermark', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.releaseView('view-1')).toBe(1)
    expect(policy.enqueue(request({ transitionId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('normalizes identifiers and rejects unsafe identifiers', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ viewId: ' view ', transitionId: ' transition ' }))).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ viewId: 'view', transitionId: 'transition' })
    expect(policy.enqueue(request({ transitionId: 'bad|id' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'bad\nview', transitionId: 'other' }))).toBe(false)
  })

  it('rejects invalid numeric inputs', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 0 }))).toBe(false)
    expect(policy.enqueue(request({ requestedAt: Number.NaN }))).toBe(false)
    expect(policy.enqueue(request({ targetScale: 0 }))).toBe(false)
    expect(policy.enqueue(request({ waypointCount: -1 }))).toBe(false)
  })

  it('returns detached snapshots', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    const snapshot = policy.snapshot()[0]!
    snapshot.transitionId = 'mutated'
    expect(policy.snapshot()[0]?.transitionId).toBe('transition-1')
  })

  it('has deterministic scalar fingerprint without SDK payloads', () => {
    const policy = new ArcGisCameraTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    const fingerprint = policy.fingerprint()
    expect(fingerprint).toContain('view-1:transition-1:1:queued:selection')
    expect(fingerprint).not.toContain('[object Object]')
  })

  it('validates budget construction fail closed', () => {
    expect(() => new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxTransitions: 0 })).toThrow(RangeError)
    expect(() => new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxTransitions: 2, maxTransitionsPerView: 3 })).toThrow(RangeError)
    expect(() => new ArcGisCameraTransitionLifecyclePolicy({ ...budget, maxTransitions: 2, maxRunning: 3 })).toThrow(RangeError)
  })
})
