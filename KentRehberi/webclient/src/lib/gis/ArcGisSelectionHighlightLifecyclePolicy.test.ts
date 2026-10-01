import { describe, expect, it } from 'vitest'
import { ArcGisSelectionHighlightLifecyclePolicy, type ArcGisSelectionHighlightBudget, type ArcGisSelectionHighlightRequest } from './ArcGisSelectionHighlightLifecyclePolicy'

const budget: ArcGisSelectionHighlightBudget = {
  maxEntries: 6,
  maxEntriesPerView: 4,
  maxResolving: 2,
  maxActive: 3,
  maxObjectIdsPerEntry: 100,
  maxAggregateActiveObjectIds: 180,
  queueTtlMs: 100,
  resolveLeaseMs: 50,
  activeTtlMs: 200,
}

const request = (overrides: Partial<ArcGisSelectionHighlightRequest> = {}): ArcGisSelectionHighlightRequest => ({
  viewId: 'view-a',
  layerId: 'parcels',
  selectionId: 'selection-a',
  revision: 1,
  intent: 'visible',
  requestedAt: 10,
  objectIdCount: 20,
  ...overrides,
})

const policy = (overrides: Partial<ArcGisSelectionHighlightBudget> = {}) =>
  new ArcGisSelectionHighlightLifecyclePolicy({ ...budget, ...overrides })

describe('ArcGisSelectionHighlightLifecyclePolicy', () => {
  it('moves a bounded request through queued, resolving and active phases', () => {
    const sut = policy()
    expect(sut.enqueue(request())).toBe(true)
    expect(sut.snapshot()[0].phase).toBe('queued')
    expect(sut.takeNext(20)?.phase).toBe('resolving')
    expect(sut.complete('view-a', 'parcels', 'selection-a', 1, 18, 30)).toBe(true)
    expect(sut.snapshot()[0]).toMatchObject({ phase: 'active', resolvedObjectIdCount: 18 })
  })

  it('schedules primary before linked before hover regardless of insertion order', () => {
    const sut = policy()
    sut.enqueue(request({ selectionId: 'hover', intent: 'hover', requestedAt: 1 }))
    sut.enqueue(request({ selectionId: 'linked', intent: 'linked', requestedAt: 2 }))
    sut.enqueue(request({ selectionId: 'primary', intent: 'primary', requestedAt: 3 }))
    expect(sut.takeNext(10)?.selectionId).toBe('primary')
    expect(sut.takeNext(10)?.selectionId).toBe('linked')
  })

  it('uses requested time and insertion sequence as deterministic tie breakers', () => {
    const sut = policy({ maxResolving: 6 })
    sut.enqueue(request({ selectionId: 'late', requestedAt: 20 }))
    sut.enqueue(request({ selectionId: 'first', requestedAt: 10 }))
    sut.enqueue(request({ selectionId: 'second', requestedAt: 10 }))
    expect(sut.takeNext(21)?.selectionId).toBe('first')
    expect(sut.takeNext(21)?.selectionId).toBe('second')
    expect(sut.takeNext(21)?.selectionId).toBe('late')
  })

  it('enforces global entry cardinality', () => {
    const sut = policy({ maxEntries: 2, maxEntriesPerView: 2, maxResolving: 2, maxActive: 2 })
    expect(sut.enqueue(request({ selectionId: 'a' }))).toBe(true)
    expect(sut.enqueue(request({ selectionId: 'b' }))).toBe(true)
    expect(sut.enqueue(request({ selectionId: 'c' }))).toBe(false)
  })

  it('enforces per-view cardinality without blocking another view', () => {
    const sut = policy({ maxEntriesPerView: 1 })
    expect(sut.enqueue(request({ selectionId: 'a' }))).toBe(true)
    expect(sut.enqueue(request({ selectionId: 'b' }))).toBe(false)
    expect(sut.enqueue(request({ viewId: 'view-b', selectionId: 'b' }))).toBe(true)
  })

  it('rejects requests above the per-entry object-id budget', () => {
    const sut = policy()
    expect(sut.enqueue(request({ objectIdCount: 101 }))).toBe(false)
    expect(sut.snapshot()).toHaveLength(0)
  })

  it('limits concurrent resolving work', () => {
    const sut = policy({ maxResolving: 1 })
    sut.enqueue(request({ selectionId: 'a' }))
    sut.enqueue(request({ selectionId: 'b' }))
    expect(sut.takeNext(20)?.selectionId).toBe('a')
    expect(sut.takeNext(21)).toBeUndefined()
  })

  it('limits active highlight cardinality', () => {
    const sut = policy({ maxActive: 1 })
    sut.enqueue(request({ selectionId: 'a' }))
    sut.enqueue(request({ selectionId: 'b' }))
    sut.takeNext(20)
    expect(sut.complete('view-a', 'parcels', 'a', 1, 10, 30)).toBe(true)
    sut.takeNext(31)
    expect(sut.complete('view-a', 'parcels', 'b', 1, 10, 32)).toBe(false)
    expect(sut.snapshot().map((x) => x.selectionId)).toEqual(['a'])
  })

  it('limits aggregate active object-id residency', () => {
    const sut = policy({ maxAggregateActiveObjectIds: 100 })
    sut.enqueue(request({ selectionId: 'a', objectIdCount: 70 }))
    sut.enqueue(request({ selectionId: 'b', objectIdCount: 50 }))
    sut.takeNext(20)
    sut.takeNext(20)
    expect(sut.complete('view-a', 'parcels', 'a', 1, 70, 30)).toBe(true)
    expect(sut.complete('view-a', 'parcels', 'b', 1, 50, 30)).toBe(false)
  })

  it('rejects completion counts larger than the requested count', () => {
    const sut = policy()
    sut.enqueue(request({ objectIdCount: 10 }))
    sut.takeNext(20)
    expect(sut.complete('view-a', 'parcels', 'selection-a', 1, 11, 30)).toBe(false)
    expect(sut.snapshot()).toHaveLength(0)
  })

  it('rejects stale completion after a layer revision advances', () => {
    const sut = policy()
    sut.enqueue(request({ revision: 1 }))
    sut.takeNext(20)
    expect(sut.invalidateLayer('view-a', 'parcels', 2)).toBe(1)
    expect(sut.complete('view-a', 'parcels', 'selection-a', 1, 10, 30)).toBe(false)
  })

  it('rejects enqueue below the current layer revision watermark', () => {
    const sut = policy()
    expect(sut.invalidateLayer('view-a', 'parcels', 5)).toBe(0)
    expect(sut.enqueue(request({ revision: 4 }))).toBe(false)
    expect(sut.enqueue(request({ revision: 5 }))).toBe(true)
  })

  it('replaces the same logical selection only with a newer revision', () => {
    const sut = policy()
    expect(sut.enqueue(request({ revision: 2 }))).toBe(true)
    expect(sut.enqueue(request({ revision: 2, requestedAt: 20 }))).toBe(false)
    expect(sut.enqueue(request({ revision: 3, requestedAt: 20 }))).toBe(true)
    expect(sut.snapshot()).toHaveLength(1)
    expect(sut.snapshot()[0].revision).toBe(3)
  })

  it('expires queued work at its TTL boundary', () => {
    const sut = policy()
    sut.enqueue(request({ requestedAt: 10 }))
    expect(sut.expire(109)).toBe(0)
    expect(sut.expire(110)).toBe(1)
  })

  it('rejects resolving completion at lease expiry', () => {
    const sut = policy()
    sut.enqueue(request())
    sut.takeNext(20)
    expect(sut.complete('view-a', 'parcels', 'selection-a', 1, 10, 70)).toBe(false)
    expect(sut.snapshot()).toHaveLength(0)
  })

  it('touch extends a live active lease', () => {
    const sut = policy()
    sut.enqueue(request())
    sut.takeNext(20)
    sut.complete('view-a', 'parcels', 'selection-a', 1, 10, 30)
    expect(sut.touch('view-a', 'parcels', 'selection-a', 1, 100)).toBe(true)
    expect(sut.snapshot()[0].expiresAt).toBe(300)
  })

  it('touch fails closed after active expiry and frees capacity', () => {
    const sut = policy()
    sut.enqueue(request())
    sut.takeNext(20)
    sut.complete('view-a', 'parcels', 'selection-a', 1, 10, 30)
    expect(sut.touch('view-a', 'parcels', 'selection-a', 1, 230)).toBe(false)
    expect(sut.snapshot()).toHaveLength(0)
  })

  it('release requires the exact revision', () => {
    const sut = policy()
    sut.enqueue(request({ revision: 3 }))
    expect(sut.release('view-a', 'parcels', 'selection-a', 2)).toBe(false)
    expect(sut.release('view-a', 'parcels', 'selection-a', 3)).toBe(true)
  })

  it('releaseLayer removes only the requested layer and clears its watermark', () => {
    const sut = policy()
    sut.enqueue(request({ layerId: 'a', selectionId: 'a' }))
    sut.enqueue(request({ layerId: 'b', selectionId: 'b' }))
    expect(sut.releaseLayer('view-a', 'a')).toBe(1)
    expect(sut.snapshot().map((x) => x.layerId)).toEqual(['b'])
    expect(sut.enqueue(request({ layerId: 'a', selectionId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('releaseView removes all view entries while preserving other views', () => {
    const sut = policy()
    sut.enqueue(request({ selectionId: 'a' }))
    sut.enqueue(request({ layerId: 'roads', selectionId: 'b' }))
    sut.enqueue(request({ viewId: 'view-b', selectionId: 'c' }))
    expect(sut.releaseView('view-a')).toBe(2)
    expect(sut.snapshot().map((x) => x.viewId)).toEqual(['view-b'])
  })

  it('returns detached snapshots that cannot mutate authority state', () => {
    const sut = policy()
    sut.enqueue(request())
    const snapshot = sut.snapshot()[0]
    snapshot.phase = 'active'
    snapshot.resolvedObjectIdCount = 99
    expect(sut.snapshot()[0]).toMatchObject({ phase: 'queued', resolvedObjectIdCount: 0 })
  })

  it('produces a deterministic scalar-only fingerprint', () => {
    const sut = policy()
    sut.enqueue(request({ selectionId: 'a' }))
    sut.enqueue(request({ selectionId: 'b' }))
    expect(sut.fingerprint()).toBe('view-a:parcels:a:1:queued:0|view-a:parcels:b:1:queued:0')
    expect(sut.fingerprint()).not.toContain('[object Object]')
  })

  it('never exposes caller payload fields in snapshots', () => {
    const sut = policy()
    const input = { ...request(), geometry: { x: 1 }, graphic: { attributes: { secret: 'x' } } } as ArcGisSelectionHighlightRequest
    sut.enqueue(input)
    const snapshot = sut.snapshot()[0] as unknown as Record<string, unknown>
    expect(snapshot.geometry).toBeUndefined()
    expect(snapshot.graphic).toBeUndefined()
    expect(snapshot.attributes).toBeUndefined()
  })

  it('normalizes safe identifiers before storing them', () => {
    const sut = policy()
    sut.enqueue(request({ viewId: ' view-a ', layerId: ' parcels ', selectionId: ' selection-a ' }))
    expect(sut.snapshot()[0]).toMatchObject({ viewId: 'view-a', layerId: 'parcels', selectionId: 'selection-a' })
  })

  it.each([
    ['viewId', { viewId: '' }],
    ['layerId', { layerId: 'bad:id' }],
    ['selectionId', { selectionId: `bad\u0000id` }],
  ])('rejects unsafe %s identifiers', (_name, overrides) => {
    const sut = policy()
    expect(() => sut.enqueue(request(overrides))).toThrow(/safe characters|string/)
  })

  it('rejects unsafe numeric request fields', () => {
    const sut = policy()
    expect(() => sut.enqueue(request({ revision: 0 }))).toThrow(/revision/)
    expect(() => sut.enqueue(request({ objectIdCount: 0 }))).toThrow(/objectIdCount/)
    expect(() => sut.enqueue(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
  })

  it('rejects invalid intent values', () => {
    const sut = policy()
    expect(() => sut.enqueue(request({ intent: 'background' as never }))).toThrow(/intent/)
  })

  it('validates internally coherent budgets', () => {
    expect(() => policy({ maxEntriesPerView: 7 })).toThrow(/maxEntriesPerView/)
    expect(() => policy({ maxResolving: 7 })).toThrow(/maxResolving/)
    expect(() => policy({ maxActive: 7 })).toThrow(/maxActive/)
    expect(() => policy({ maxAggregateActiveObjectIds: 50 })).toThrow(/maxAggregateActiveObjectIds/)
  })

  it('rejects zero, negative and unsafe budget values', () => {
    expect(() => policy({ queueTtlMs: 0 })).toThrow(/queueTtlMs/)
    expect(() => policy({ activeTtlMs: -1 })).toThrow(/activeTtlMs/)
    expect(() => policy({ maxEntries: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/maxEntries/)
  })

  it('dispose is idempotent and future operations fail closed', () => {
    const sut = policy()
    sut.enqueue(request())
    sut.dispose()
    sut.dispose()
    expect(() => sut.snapshot()).toThrow(/disposed/)
    expect(() => sut.enqueue(request())).toThrow(/disposed/)
  })
})
