import { describe, expect, it } from 'vitest'
import { ArcGisIdentifyWorkPolicy, type ArcGisIdentifyWorkBudget, type ArcGisIdentifyWorkInput } from './ArcGisIdentifyWorkPolicy'

const budget = (overrides: Partial<ArcGisIdentifyWorkBudget> = {}): ArcGisIdentifyWorkBudget => ({
  maxQueued: 4,
  maxQueuedPerView: 3,
  maxRunning: 2,
  maxRunningPerView: 1,
  maxLayersPerRequest: 12,
  maxTolerancePixels: 24,
  maxResponseBytes: 1_000,
  maxAggregateResponseBytes: 2_000,
  queueTtlMs: 100,
  runTtlMs: 200,
  maxViews: 3,
  ...overrides,
})

const input = (requestId: string, overrides: Partial<ArcGisIdentifyWorkInput> = {}): ArcGisIdentifyWorkInput => ({
  requestId,
  viewId: 'map-2d',
  revision: 1,
  intent: 'foreground',
  layerCount: 2,
  tolerancePixels: 8,
  queuedAt: 10,
  ...overrides,
})

describe('ArcGisIdentifyWorkPolicy', () => {
  it('admits scalar identify metadata and exposes detached snapshots', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(policy.admit(input('a'))).toBe(true)
    const snapshot = policy.snapshot()
    expect(snapshot).toEqual([{ ...input('a'), state: 'queued', sequence: 0 }])
    snapshot[0].requestId = 'mutated'
    expect(policy.snapshot()[0].requestId).toBe('a')
  })

  it('prioritizes interactive then foreground then background work deterministically', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxRunning: 3, maxRunningPerView: 3 }))
    policy.admit(input('background', { intent: 'background', queuedAt: 1 }))
    policy.admit(input('foreground', { intent: 'foreground', queuedAt: 2 }))
    policy.admit(input('interactive', { intent: 'interactive', queuedAt: 3 }))
    expect(policy.startNext(4)?.requestId).toBe('interactive')
    expect(policy.startNext(5)?.requestId).toBe('foreground')
    expect(policy.startNext(6)?.requestId).toBe('background')
  })

  it('uses queue age and insertion sequence as stable tie breakers', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxRunning: 3, maxRunningPerView: 3 }))
    policy.admit(input('later', { queuedAt: 20 }))
    policy.admit(input('first', { queuedAt: 10 }))
    policy.admit(input('second', { queuedAt: 10 }))
    expect(policy.startNext(21)?.requestId).toBe('first')
    expect(policy.startNext(22)?.requestId).toBe('second')
    expect(policy.startNext(23)?.requestId).toBe('later')
  })

  it('enforces global queue cardinality', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxQueued: 2, maxQueuedPerView: 2 }))
    expect(policy.admit(input('a'))).toBe(true)
    expect(policy.admit(input('b'))).toBe(true)
    expect(policy.admit(input('c'))).toBe(false)
    expect(policy.diagnostics().rejected).toBe(1)
  })

  it('enforces per-view queue cardinality without blocking another view', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxQueuedPerView: 1 }))
    expect(policy.admit(input('a'))).toBe(true)
    expect(policy.admit(input('b'))).toBe(false)
    expect(policy.admit(input('c', { viewId: 'scene-3d' }))).toBe(true)
  })

  it('enforces global running concurrency', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxRunning: 1 }))
    policy.admit(input('a', { viewId: 'a-view' }))
    policy.admit(input('b', { viewId: 'b-view' }))
    expect(policy.startNext(20)?.requestId).toBe('a')
    expect(policy.startNext(21)).toBeUndefined()
  })

  it('enforces per-view running concurrency while allowing another view', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxRunning: 2, maxRunningPerView: 1 }))
    policy.admit(input('a'))
    policy.admit(input('b'))
    policy.admit(input('c', { viewId: 'scene-3d' }))
    expect(policy.startNext(20)?.requestId).toBe('a')
    expect(policy.startNext(21)?.requestId).toBe('c')
  })

  it('rejects requests above layer-count budget', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxLayersPerRequest: 2 }))
    expect(policy.admit(input('a', { layerCount: 3 }))).toBe(false)
  })

  it('rejects requests above tolerance budget', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxTolerancePixels: 4 }))
    expect(policy.admit(input('a', { tolerancePixels: 5 }))).toBe(false)
  })

  it('accepts zero-pixel tolerance', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(policy.admit(input('a', { tolerancePixels: 0 }))).toBe(true)
  })

  it('rejects duplicate request identities within a view', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(policy.admit(input('a'))).toBe(true)
    expect(policy.admit(input('a'))).toBe(false)
  })

  it('allows the same request identity in independent views', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(policy.admit(input('a'))).toBe(true)
    expect(policy.admit(input('a', { viewId: 'scene-3d' }))).toBe(true)
  })

  it('advances revision and cancels stale queued work', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('old'))
    expect(policy.admit(input('new', { revision: 2 }))).toBe(true)
    expect(policy.snapshot().map((item) => item.requestId)).toEqual(['new'])
    expect(policy.diagnostics().cancelled).toBe(1)
  })

  it('advances revision and cancels stale running work', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('old'))
    policy.startNext(20)
    expect(policy.advanceRevision('map-2d', 2)).toBe(1)
    expect(policy.diagnostics().running).toBe(0)
  })

  it('rejects admission behind the view revision watermark', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.advanceRevision('map-2d', 3)
    expect(policy.admit(input('old', { revision: 2 }))).toBe(false)
  })

  it('treats equal revision advance as a no-op', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.advanceRevision('map-2d', 2)
    expect(policy.advanceRevision('map-2d', 2)).toBe(0)
  })

  it('expires queued work at the queue deadline', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ queueTtlMs: 10 }))
    policy.admit(input('a', { queuedAt: 5 }))
    expect(policy.expire(14)).toBe(0)
    expect(policy.expire(15)).toBe(1)
    expect(policy.diagnostics().expired).toBe(1)
  })

  it('expires running work from authority-owned start time', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ runTtlMs: 10 }))
    policy.admit(input('a'))
    policy.startNext(20)
    expect(policy.expire(29)).toBe(0)
    expect(policy.expire(30)).toBe(1)
  })

  it('accepts a bounded completion and tracks only byte residency', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a'))
    policy.startNext(20)
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 400, completedAt: 30 })).toBe(true)
    expect(policy.diagnostics()).toMatchObject({ queued: 0, running: 0, residentResponseBytes: 400 })
  })

  it('rejects completion above per-response byte budget', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxResponseBytes: 100 }))
    policy.admit(input('a'))
    policy.startNext(20)
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 101, completedAt: 30 })).toBe(false)
    expect(policy.diagnostics().residentResponseBytes).toBe(0)
  })

  it('rejects completion above aggregate response byte budget', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxResponseBytes: 100, maxAggregateResponseBytes: 150, maxRunningPerView: 2 }))
    policy.admit(input('a'))
    policy.admit(input('b'))
    policy.startNext(20)
    policy.startNext(20)
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 100, completedAt: 30 })).toBe(true)
    expect(policy.complete({ requestId: 'b', viewId: 'map-2d', revision: 1, responseBytes: 60, completedAt: 30 })).toBe(false)
  })

  it('releases response byte residency explicitly', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a')); policy.startNext(20)
    policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 400, completedAt: 30 })
    expect(policy.releaseResponse('map-2d', 'a')).toBe(true)
    expect(policy.diagnostics().residentResponseBytes).toBe(0)
  })

  it('rejects stale completion after revision advance', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a')); policy.startNext(20); policy.advanceRevision('map-2d', 2)
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 10, completedAt: 30 })).toBe(false)
    expect(policy.diagnostics().staleCompletions).toBe(1)
  })

  it('rejects completion for unknown work', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(policy.complete({ requestId: 'missing', viewId: 'map-2d', revision: 1, responseBytes: 10, completedAt: 30 })).toBe(false)
  })

  it('rejects completion that never started', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a'))
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 10, completedAt: 30 })).toBe(false)
  })

  it('rejects completion after runtime deadline', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ runTtlMs: 10 }))
    policy.admit(input('a')); policy.startNext(20)
    expect(policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: 10, completedAt: 31 })).toBe(false)
    expect(policy.diagnostics().expired).toBe(1)
  })

  it('cancels a request and its response residency', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a'))
    expect(policy.cancelRequest('map-2d', 'a')).toBe(true)
    expect(policy.cancelRequest('map-2d', 'a')).toBe(false)
    expect(policy.diagnostics().cancelled).toBe(1)
  })

  it('cancels all work for a view without disturbing another view', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a')); policy.admit(input('b', { viewId: 'scene-3d' }))
    expect(policy.cancelView('map-2d')).toBe(1)
    expect(policy.snapshot().map((item) => item.viewId)).toEqual(['scene-3d'])
  })

  it('enforces bounded view cardinality', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxViews: 1 }))
    expect(policy.admit(input('a'))).toBe(true)
    expect(policy.admit(input('b', { viewId: 'scene-3d' }))).toBe(false)
  })

  it('allows a cancelled view slot to be reused', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget({ maxViews: 1 }))
    policy.admit(input('a')); policy.cancelView('map-2d')
    expect(policy.admit(input('b', { viewId: 'scene-3d' }))).toBe(true)
  })

  it('produces a payload-free deterministic fingerprint', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a', { intent: 'interactive', layerCount: 3, tolerancePixels: 5 }))
    expect(policy.fingerprint()).toBe('map-2d:a:1:interactive:queued:3:5')
  })

  it.each(['', '   ', 'bad:id', `bad\u0000id`])('rejects unsafe request ids: %j', (requestId) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input(requestId))).toThrow()
  })

  it.each(['', '   ', 'bad:id', `bad\u0000id`])('rejects unsafe view ids: %j', (viewId) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('a', { viewId }))).toThrow()
  })

  it('rejects oversized identifiers', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('x'.repeat(161)))).toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid revisions: %j', (revision) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('a', { revision }))).toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid layer counts: %j', (layerCount) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('a', { layerCount }))).toThrow()
  })

  it.each([-1, 1.5, Number.NaN])('rejects invalid tolerance: %j', (tolerancePixels) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('a', { tolerancePixels }))).toThrow()
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid queue timestamps: %j', (queuedAt) => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    expect(() => policy.admit(input('a', { queuedAt }))).toThrow()
  })

  it('rejects invalid completion byte sizes', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a')); policy.startNext(20)
    expect(() => policy.complete({ requestId: 'a', viewId: 'map-2d', revision: 1, responseBytes: -1, completedAt: 30 })).toThrow()
  })

  it('validates budget relationships', () => {
    expect(() => new ArcGisIdentifyWorkPolicy(budget({ maxQueued: 1, maxQueuedPerView: 2 }))).toThrow()
    expect(() => new ArcGisIdentifyWorkPolicy(budget({ maxRunning: 1, maxRunningPerView: 2 }))).toThrow()
    expect(() => new ArcGisIdentifyWorkPolicy(budget({ maxResponseBytes: 2_001 }))).toThrow()
  })

  it('validates positive budget fields', () => {
    expect(() => new ArcGisIdentifyWorkPolicy(budget({ maxQueued: 0 }))).toThrow()
    expect(() => new ArcGisIdentifyWorkPolicy(budget({ queueTtlMs: -1 }))).toThrow()
  })

  it('clears authority state on dispose and rejects later operations', () => {
    const policy = new ArcGisIdentifyWorkPolicy(budget())
    policy.admit(input('a'))
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(input('b'))).toThrow('disposed')
  })
})
