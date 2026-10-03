import { describe, expect, it } from 'vitest'
import { ArcGisSketchSessionLifecyclePolicy, type SketchSessionBudget, type SketchSessionRequest } from './ArcGisSketchSessionLifecyclePolicy'

const budget: SketchSessionBudget = {
  maxViews: 3,
  maxSessions: 8,
  maxSessionsPerView: 4,
  maxActive: 2,
  maxActivePerView: 1,
  maxResident: 3,
  maxResidentPerView: 2,
  maxVerticesPerSession: 100,
  maxBytesPerSession: 1_000,
  maxResidentVertices: 180,
  maxResidentBytes: 1_800,
  queueTtlMs: 50,
  activeLeaseMs: 100,
  residentTtlMs: 200,
}

function request(overrides: Partial<SketchSessionRequest> = {}): SketchSessionRequest {
  return {
    sessionId: 'session-a',
    viewId: 'view-a',
    revision: 1,
    intent: 'interactive',
    geometryKind: 'polygon',
    vertexCount: 20,
    estimatedBytes: 200,
    requestedAt: 10,
    ...overrides,
  }
}

function policy(custom: Partial<SketchSessionBudget> = {}): ArcGisSketchSessionLifecyclePolicy {
  return new ArcGisSketchSessionLifecyclePolicy({ ...budget, ...custom })
}

describe('ArcGisSketchSessionLifecyclePolicy', () => {
  it('rejects inconsistent budgets', () => {
    expect(() => policy({ maxSessionsPerView: 9 })).toThrow(/maxSessionsPerView/)
    expect(() => policy({ maxActivePerView: 3 })).toThrow(/maxActivePerView/)
    expect(() => policy({ maxResidentPerView: 4 })).toThrow(/maxResidentPerView/)
    expect(() => policy({ maxVerticesPerSession: 181 })).toThrow(/vertex budgets/)
    expect(() => policy({ maxBytesPerSession: 1_801 })).toThrow(/byte budgets/)
  })

  it('requires an explicit current view revision before admission', () => {
    const subject = policy()
    expect(subject.admit(request())).toBe(false)
    expect(subject.setRevision('view-a', 1)).toBe(0)
    expect(subject.admit(request())).toBe(true)
    expect(subject.snapshot()).toMatchObject({ views: 1, sessions: 1, queued: 1 })
  })

  it('fails closed for unsafe identifiers and invalid scalar inputs', () => {
    const subject = policy(); subject.setRevision('view-a', 1)
    expect(() => subject.admit(request({ sessionId: '\u0000bad' }))).toThrow(/sessionId/)
    expect(() => subject.admit(request({ vertexCount: -1 }))).toThrow(/vertexCount/)
    expect(() => subject.admit(request({ estimatedBytes: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/estimatedBytes/)
    expect(() => subject.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
  })

  it('bounds view cardinality and refuses revision rollback', () => {
    const subject = policy({ maxViews: 2 })
    expect(subject.setRevision('a', 2)).toBe(0)
    expect(subject.setRevision('b', 1)).toBe(0)
    expect(subject.setRevision('c', 1)).toBe(-1)
    expect(subject.setRevision('a', 1)).toBe(-1)
    expect(subject.snapshot().views).toBe(2)
  })

  it('invalidates stale queued, active and resident sessions on revision advance', () => {
    const subject = policy({ maxActivePerView: 2 })
    subject.setRevision('view-a', 1)
    subject.admit(request({ sessionId: 'queued' }))
    subject.admit(request({ sessionId: 'active', requestedAt: 11 }))
    expect(subject.startNext(12)?.sessionId).toBe('queued')
    expect(subject.complete('queued', 1, 20, 200, 13)).toBe(true)
    expect(subject.startNext(14)?.sessionId).toBe('active')
    expect(subject.setRevision('view-a', 2)).toBe(2)
    expect(subject.snapshot()).toMatchObject({ sessions: 0, queued: 0, active: 0, resident: 0 })
  })

  it('schedules interactive before visible before background with FIFO tie breaking', () => {
    const subject = policy({ maxActive: 3, maxActivePerView: 3 })
    subject.setRevision('view-a', 1)
    subject.admit(request({ sessionId: 'background', intent: 'background', requestedAt: 1 }))
    subject.admit(request({ sessionId: 'visible', intent: 'visible', requestedAt: 2 }))
    subject.admit(request({ sessionId: 'interactive-1', intent: 'interactive', requestedAt: 3 }))
    subject.admit(request({ sessionId: 'interactive-2', intent: 'interactive', requestedAt: 4 }))
    expect(subject.startNext(5)?.sessionId).toBe('interactive-1')
    expect(subject.startNext(6)?.sessionId).toBe('interactive-2')
    expect(subject.startNext(7)?.sessionId).toBe('visible')
  })

  it('enforces global and per-view active concurrency independently', () => {
    const subject = policy({ maxActive: 2, maxActivePerView: 1 })
    subject.setRevision('a', 1); subject.setRevision('b', 1)
    subject.admit(request({ sessionId: 'a1', viewId: 'a' }))
    subject.admit(request({ sessionId: 'a2', viewId: 'a', requestedAt: 11 }))
    subject.admit(request({ sessionId: 'b1', viewId: 'b', requestedAt: 12 }))
    expect(subject.startNext(13)?.sessionId).toBe('a1')
    expect(subject.startNext(14)?.sessionId).toBe('b1')
    expect(subject.startNext(15)).toBeNull()
  })

  it('reconciles estimated metadata to bounded actual completion values', () => {
    const subject = policy(); subject.setRevision('view-a', 1); subject.admit(request({ estimatedBytes: 900, vertexCount: 90 }))
    expect(subject.startNext(11)?.phase).toBe('active')
    expect(subject.complete('session-a', 1, 25, 250, 12)).toBe(true)
    expect(subject.snapshot()).toMatchObject({ resident: 1, residentVertices: 25, residentBytes: 250 })
    expect(subject.consume('session-a', 1)).toMatchObject({ vertexCount: 25, bytes: 250, phase: 'resident' })
  })

  it('drops an active session when actual completion exceeds hard per-session budgets', () => {
    const subject = policy(); subject.setRevision('view-a', 1); subject.admit(request()); subject.startNext(11)
    expect(subject.complete('session-a', 1, 101, 200, 12)).toBe(false)
    expect(subject.snapshot().sessions).toBe(0)
  })

  it('evicts lower intent resident work deterministically under global memory pressure', () => {
    const subject = policy({ maxResidentBytes: 500, maxResidentVertices: 100, maxBytesPerSession: 500 })
    subject.setRevision('a', 1); subject.setRevision('b', 1)
    subject.admit(request({ sessionId: 'background', viewId: 'a', intent: 'background', estimatedBytes: 300 }))
    subject.startNext(11); expect(subject.complete('background', 1, 30, 300, 12)).toBe(true)
    subject.admit(request({ sessionId: 'interactive', viewId: 'b', intent: 'interactive', estimatedBytes: 300, requestedAt: 13 }))
    subject.startNext(14); expect(subject.complete('interactive', 1, 30, 300, 15)).toBe(true)
    expect(subject.consume('background', 1)).toBeNull()
    expect(subject.consume('interactive', 1)?.intent).toBe('interactive')
  })

  it('uses recency after intent when choosing pressure victims', () => {
    const subject = policy({ maxResident: 2, maxResidentPerView: 2 })
    subject.setRevision('a', 1); subject.setRevision('b', 1)
    for (const [id, view, at] of [['old', 'a', 1], ['new', 'a', 2]] as const) {
      subject.admit(request({ sessionId: id, viewId: view, intent: 'background', requestedAt: at })); subject.startNext(at + 1); subject.complete(id, 1, 10, 100, at + 2)
    }
    expect(subject.touch('new', 10)).toBe(true)
    subject.admit(request({ sessionId: 'incoming', viewId: 'b', intent: 'interactive', requestedAt: 11 })); subject.startNext(12)
    expect(subject.complete('incoming', 1, 10, 100, 13)).toBe(true)
    expect(subject.consume('old', 1)).toBeNull()
    expect(subject.consume('new', 1)).not.toBeNull()
  })

  it('expires queue, active lease and resident state at their boundaries', () => {
    const subject = policy(); subject.setRevision('view-a', 1)
    subject.admit(request({ sessionId: 'q', requestedAt: 0 })); expect(subject.expire(50)).toBe(1)
    subject.admit(request({ sessionId: 'a', requestedAt: 60 })); subject.startNext(61); expect(subject.expire(161)).toBe(1)
    subject.admit(request({ sessionId: 'r', requestedAt: 170 })); subject.startNext(171); subject.complete('r', 1, 10, 100, 172); expect(subject.expire(372)).toBe(1)
    expect(subject.snapshot().sessions).toBe(0)
  })

  it('does not allow stale completion after a lease expires', () => {
    const subject = policy(); subject.setRevision('view-a', 1); subject.admit(request({ requestedAt: 0 })); subject.startNext(1)
    expect(subject.complete('session-a', 1, 10, 100, 102)).toBe(false)
    expect(subject.snapshot().sessions).toBe(0)
  })

  it('applies per-view resident cardinality without evicting unrelated views unnecessarily', () => {
    const subject = policy({ maxResident: 3, maxResidentPerView: 1, maxActivePerView: 2 })
    subject.setRevision('a', 1); subject.setRevision('b', 1)
    subject.admit(request({ sessionId: 'a-old', viewId: 'a', intent: 'background' })); subject.startNext(11); subject.complete('a-old', 1, 10, 100, 12)
    subject.admit(request({ sessionId: 'b', viewId: 'b', intent: 'background', requestedAt: 13 })); subject.startNext(14); subject.complete('b', 1, 10, 100, 15)
    subject.admit(request({ sessionId: 'a-new', viewId: 'a', intent: 'interactive', requestedAt: 16 })); subject.startNext(17); expect(subject.complete('a-new', 1, 10, 100, 18)).toBe(true)
    expect(subject.consume('a-old', 1)).toBeNull()
    expect(subject.consume('b', 1)).not.toBeNull()
  })

  it('returns detached frozen scalar views instead of retaining caller payload graphs', () => {
    const subject = policy(); subject.setRevision('view-a', 1)
    const payload = request(); subject.admit(payload); payload.sessionId = 'mutated'; payload.vertexCount = 99
    const lease = subject.startNext(11)
    expect(lease).toMatchObject({ sessionId: 'session-a', vertexCount: 20 })
    expect(Object.isFrozen(lease)).toBe(true)
    expect(subject.fingerprint()).not.toContain('mutated')
  })

  it('fingerprints only deterministic scalar governance state', () => {
    const subject = policy(); subject.setRevision('view-a', 1); subject.admit(request())
    expect(subject.fingerprint()).toBe('view-a:session-a:1:interactive:polygon:queued:20:200')
  })

  it('releases all state for a view and frees view cardinality', () => {
    const subject = policy({ maxViews: 1 }); subject.setRevision('a', 1); subject.admit(request({ viewId: 'a' }))
    expect(subject.releaseView('a')).toBe(1)
    expect(subject.snapshot()).toMatchObject({ views: 0, sessions: 0 })
    expect(subject.setRevision('b', 1)).toBe(0)
  })

  it('prevents duplicate session ids across lifecycle phases', () => {
    const subject = policy(); subject.setRevision('view-a', 1)
    expect(subject.admit(request())).toBe(true)
    expect(subject.admit(request())).toBe(false)
    subject.startNext(11)
    expect(subject.admit(request())).toBe(false)
    subject.complete('session-a', 1, 10, 100, 12)
    expect(subject.admit(request())).toBe(false)
  })

  it('consume requires the authoritative revision', () => {
    const subject = policy(); subject.setRevision('view-a', 2); subject.admit(request({ revision: 2 })); subject.startNext(11); subject.complete('session-a', 2, 10, 100, 12)
    expect(subject.consume('session-a', 1)).toBeNull()
    expect(subject.consume('session-a', 2)).not.toBeNull()
  })

  it('dispose clears authority state and makes future use fail closed', () => {
    const subject = policy(); subject.setRevision('view-a', 1); subject.admit(request()); subject.dispose()
    expect(() => subject.snapshot()).toThrow(/disposed/)
    expect(() => subject.admit(request())).toThrow(/disposed/)
  })
})
