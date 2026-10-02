import { describe, expect, it } from 'vitest'
import {
  ArcGisLayerVisibilityTransitionLifecyclePolicy,
  type ArcGisVisibilityTransitionBudget,
  type ArcGisVisibilityTransitionRequest,
} from './ArcGisLayerVisibilityTransitionLifecyclePolicy'

const budget: ArcGisVisibilityTransitionBudget = {
  maxTransitions: 6,
  maxTransitionsPerView: 4,
  maxApplying: 2,
  maxSettled: 3,
  maxLayerCountPerTransition: 100,
  maxEstimatedBytesPerTransition: 10000,
  maxAggregateSettledBytes: 20000,
  queueTtlMs: 100,
  applyLeaseMs: 200,
  settledTtlMs: 300,
}

function request(
  overrides: Partial<ArcGisVisibilityTransitionRequest> = {},
): ArcGisVisibilityTransitionRequest {
  return {
    viewId: 'view-1',
    transitionId: 'transition-1',
    revision: 1,
    intent: 'scale',
    requestedAt: 10,
    layerCount: 10,
    estimatedBytes: 1000,
    targetScale: 5000,
    ...overrides,
  }
}

function settle(
  policy: ArcGisLayerVisibilityTransitionLifecyclePolicy,
  id = 'transition-1',
  bytes = 1000,
): boolean {
  policy.takeNext(20)
  return policy.complete('view-1', id, 1, 10, bytes, 30)
}

describe('ArcGisLayerVisibilityTransitionLifecyclePolicy', () => {
  it('prioritizes user then scale then restore', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'restore', intent: 'restore' }))
    policy.enqueue(request({ transitionId: 'scale', intent: 'scale' }))
    policy.enqueue(request({ transitionId: 'user', intent: 'user' }))
    expect(policy.takeNext(20)?.transitionId).toBe('user')
    expect(policy.takeNext(20)?.transitionId).toBe('scale')
  })

  it('uses request time and sequence as deterministic ties', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'later', requestedAt: 6 }))
    policy.enqueue(request({ transitionId: 'first', requestedAt: 5 }))
    policy.enqueue(request({ transitionId: 'second', requestedAt: 5 }))
    expect(policy.takeNext(20)?.transitionId).toBe('first')
    expect(policy.takeNext(20)?.transitionId).toBe('second')
  })

  it('bounds global and per-view cardinality', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy({
      ...budget,
      maxTransitions: 2,
      maxTransitionsPerView: 1,
      maxApplying: 1,
      maxSettled: 1,
    })
    expect(policy.enqueue(request({ transitionId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ transitionId: 'b' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'view-2', transitionId: 'c' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'view-3', transitionId: 'd' }))).toBe(false)
  })

  it('bounds layer and byte admission', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ layerCount: 101 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 10001 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds applying concurrency', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy({
      ...budget,
      maxApplying: 1,
    })
    policy.enqueue(request({ transitionId: 'a' }))
    policy.enqueue(request({ transitionId: 'b' }))
    expect(policy.takeNext(20)?.transitionId).toBe('a')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('records actual settled residency', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(settle(policy)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({
      phase: 'settled',
      appliedLayerCount: 10,
      actualBytes: 1000,
      expiresAt: 330,
    })
  })

  it('rejects late completion', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(
      policy.complete('view-1', 'transition-1', 1, 10, 100, 220),
    ).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects impossible applied layer count', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(
      policy.complete('view-1', 'transition-1', 1, 11, 100, 30),
    ).toBe(false)
  })

  it('bounds aggregate settled bytes', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy({
      ...budget,
      maxAggregateSettledBytes: 10000,
    })
    policy.enqueue(request({ transitionId: 'a' }))
    policy.enqueue(request({ transitionId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'a', 1, 10, 7000, 30)).toBe(true)
    expect(policy.complete('view-1', 'b', 1, 10, 4000, 30)).toBe(false)
  })

  it('bounds settled cardinality', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy({
      ...budget,
      maxSettled: 1,
    })
    policy.enqueue(request({ transitionId: 'a' }))
    policy.enqueue(request({ transitionId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'a', 1, 10, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'b', 1, 10, 100, 30)).toBe(false)
  })

  it('touch extends only matching live settled state', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    settle(policy)
    expect(policy.touch('view-1', 'transition-1', 1, 40)).toBe(true)
    expect(policy.snapshot()[0]?.expiresAt).toBe(340)
    expect(policy.touch('view-1', 'transition-1', 2, 50)).toBe(false)
  })

  it('consume releases settled ownership', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    settle(policy)
    expect(policy.consume('view-1', 'transition-1', 2)).toBe(false)
    expect(policy.consume('view-1', 'transition-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancel requires matching revision', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('view-1', 'transition-1', 2)).toBe(false)
    expect(policy.cancel('view-1', 'transition-1', 1)).toBe(true)
  })

  it('rejects stale and replaces newer duplicate revision', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 2 }))).toBe(true)
    expect(policy.enqueue(request({ revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ revision: 3 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(1)
    expect(policy.snapshot()[0]?.revision).toBe(3)
  })

  it('invalidates stale view work', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ transitionId: 'a' }))
    policy.enqueue(request({ transitionId: 'b' }))
    expect(policy.invalidateView('view-1', 2)).toBe(2)
    expect(policy.enqueue(request({ transitionId: 'old', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ transitionId: 'new', revision: 2 }))).toBe(true)
  })

  it('does not regress revision watermark', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.invalidateView('view-1', 2)).toBe(0)
    expect(policy.enqueue(request({ transitionId: 'old', revision: 2 }))).toBe(false)
  })

  it('expires queue at exact ttl boundary', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.expire(109)).toBe(0)
    expect(policy.expire(110)).toBe(1)
  })

  it('expires settled state at exact ttl boundary', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    settle(policy)
    expect(policy.expire(329)).toBe(0)
    expect(policy.expire(330)).toBe(1)
  })

  it('release view clears ownership and watermark', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.releaseView('view-1')).toBe(1)
    expect(policy.enqueue(request({ transitionId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('normalizes identifiers and rejects unsafe ids', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    expect(
      policy.enqueue(request({ viewId: ' view ', transitionId: ' transition ' })),
    ).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({
      viewId: 'view',
      transitionId: 'transition',
    })
    expect(policy.enqueue(request({ transitionId: 'bad|id' }))).toBe(false)
  })

  it('rejects invalid numeric inputs', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 0 }))).toBe(false)
    expect(policy.enqueue(request({ requestedAt: Number.NaN }))).toBe(false)
    expect(policy.enqueue(request({ targetScale: 0 }))).toBe(false)
    expect(policy.enqueue(request({ layerCount: -1 }))).toBe(false)
  })

  it('returns detached snapshots', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    const snapshot = policy.snapshot()[0]!
    snapshot.transitionId = 'mutated'
    expect(policy.snapshot()[0]?.transitionId).toBe('transition-1')
  })

  it('fingerprint is deterministic scalar state', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.fingerprint()).toContain(
      'view-1:transition-1:1:queued:scale:10',
    )
    expect(policy.fingerprint()).not.toContain('[object Object]')
  })

  it('validates construction fail closed', () => {
    expect(
      () => new ArcGisLayerVisibilityTransitionLifecyclePolicy({
        ...budget,
        maxTransitions: 0,
      }),
    ).toThrow(RangeError)
    expect(
      () => new ArcGisLayerVisibilityTransitionLifecyclePolicy({
        ...budget,
        maxTransitions: 2,
        maxTransitionsPerView: 3,
      }),
    ).toThrow(RangeError)
  })

  it('dispose clears all authority state', () => {
    const policy = new ArcGisLayerVisibilityTransitionLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.dispose()
    expect(policy.snapshot()).toHaveLength(0)
  })
})