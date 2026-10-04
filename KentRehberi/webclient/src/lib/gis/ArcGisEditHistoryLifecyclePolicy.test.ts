import { describe, expect, it } from 'vitest'
import { ArcGisEditHistoryLifecyclePolicy, type EditHistoryBudget, type EditHistoryIntent } from './ArcGisEditHistoryLifecyclePolicy'

const budget: EditHistoryBudget = {
  maxLayers: 3,
  maxEntries: 8,
  maxEntriesPerLayer: 4,
  maxOperationsPerEntry: 8,
  maxBytesPerEntry: 800,
  maxResidentOperations: 12,
  maxResidentBytes: 1200,
  stagedTtlMs: 50,
  historyTtlMs: 100,
}

function policy(overrides: Partial<EditHistoryBudget> = {}) { return new ArcGisEditHistoryLifecyclePolicy({ ...budget, ...overrides }) }
function request(entryId: string, layerId = 'roads', revision = 1, intent: EditHistoryIntent = 'interactive', requestedAt = 0) {
  return { entryId, layerId, revision, intent, operationCount: 2, estimatedBytes: 100, requestedAt }
}
function committed(p: ArcGisEditHistoryLifecyclePolicy, id: string, layer = 'roads', intent: EditHistoryIntent = 'interactive', at = 0) {
  expect(p.stage(request(id, layer, 1, intent, at))).toBe(true)
  expect(p.commit(id, 1, 2, 100, at + 1)).toBe(true)
}

describe('ArcGisEditHistoryLifecyclePolicy', () => {
  it('validates budgets fail closed', () => {
    expect(() => policy({ maxLayers: 0 })).toThrow()
    expect(() => policy({ maxEntriesPerLayer: 9 })).toThrow()
    expect(() => policy({ maxOperationsPerEntry: 13 })).toThrow()
    expect(() => policy({ maxBytesPerEntry: 1201 })).toThrow()
    expect(() => policy({ stagedTtlMs: Number.NaN })).toThrow()
  })

  it('requires a current layer revision before staging', () => {
    const p = policy()
    expect(p.stage(request('a'))).toBe(false)
    expect(p.setRevision('roads', 1)).toBe(0)
    expect(p.stage(request('a'))).toBe(true)
  })

  it('normalizes identifiers and rejects unsafe identifiers', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(p.stage(request(' a ', ' roads '))).toBe(true)
    expect(p.fingerprint()).toContain('roads:a:')
    expect(() => p.stage(request('\u0000x'))).toThrow()
    expect(() => p.setRevision('x'.repeat(193), 1)).toThrow()
  })

  it('rejects invalid numeric and intent input', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(() => p.stage({ ...request('a'), operationCount: 0 })).toThrow()
    expect(() => p.stage({ ...request('a'), estimatedBytes: -1 })).toThrow()
    expect(() => p.stage({ ...request('a'), requestedAt: Infinity })).toThrow()
    expect(() => p.stage({ ...request('a'), intent: 'urgent' as EditHistoryIntent })).toThrow()
  })

  it('enforces entry operation and byte admission limits', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(p.stage({ ...request('a'), operationCount: 9 })).toBe(false)
    expect(p.stage({ ...request('b'), estimatedBytes: 801 })).toBe(false)
    expect(p.snapshot().entries).toBe(0)
  })

  it('enforces global and per-layer cardinality', () => {
    const p = policy({ maxEntries: 3, maxEntriesPerLayer: 2 }); p.setRevision('roads', 1); p.setRevision('parks', 1)
    expect(p.stage(request('a'))).toBe(true)
    expect(p.stage(request('b'))).toBe(true)
    expect(p.stage(request('c'))).toBe(false)
    expect(p.stage(request('d', 'parks'))).toBe(true)
    expect(p.stage(request('e', 'parks'))).toBe(false)
  })

  it('bounds revision registry cardinality', () => {
    const p = policy({ maxLayers: 2 }); expect(p.setRevision('a', 1)).toBe(0); expect(p.setRevision('b', 1)).toBe(0)
    expect(p.setRevision('c', 1)).toBe(-1); expect(p.snapshot().layers).toBe(2)
  })

  it('rejects revision rollback without invalidating current history', () => {
    const p = policy(); p.setRevision('roads', 2); expect(p.stage(request('a', 'roads', 2))).toBe(true)
    expect(p.setRevision('roads', 1)).toBe(-1); expect(p.snapshot().entries).toBe(1)
  })

  it('invalidates stale entries when revision advances', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); expect(p.stage(request('b'))).toBe(true)
    expect(p.setRevision('roads', 2)).toBe(2); expect(p.snapshot().entries).toBe(0)
  })

  it('keeps other layers intact during revision invalidation', () => {
    const p = policy(); p.setRevision('roads', 1); p.setRevision('parks', 1); committed(p, 'a'); committed(p, 'b', 'parks')
    expect(p.setRevision('roads', 2)).toBe(1); expect(p.fingerprint()).toContain('parks:b:')
  })

  it('reconciles estimates with actual operation and byte counts', () => {
    const p = policy(); p.setRevision('roads', 1); expect(p.stage(request('a'))).toBe(true)
    expect(p.commit('a', 1, 5, 700, 10)).toBe(true)
    expect(p.snapshot()).toMatchObject({ committed: 1, residentOperations: 5, residentBytes: 700 })
  })

  it('drops an entry when actual counts exceed per-entry budgets', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a'))
    expect(p.commit('a', 1, 9, 100, 1)).toBe(false); expect(p.snapshot().entries).toBe(0)
    p.stage(request('b')); expect(p.commit('b', 1, 2, 801, 2)).toBe(false); expect(p.snapshot().entries).toBe(0)
  })

  it('rejects commit for wrong revision or non-staged entry', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a'))
    expect(p.commit('a', 2, 2, 100, 1)).toBe(false)
    expect(p.commit('missing', 1, 2, 100, 1)).toBe(false)
    expect(p.commit('a', 1, 2, 100, 1)).toBe(true)
    expect(p.commit('a', 1, 2, 100, 2)).toBe(false)
  })

  it('undoes newest committed edit first', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a', 'roads', 'interactive', 0); committed(p, 'b', 'roads', 'interactive', 2)
    expect(p.undo('roads', 1, 5)?.entryId).toBe('b')
    expect(p.undo('roads', 1, 6)?.entryId).toBe('a')
    expect(p.undo('roads', 1, 7)).toBeNull()
  })

  it('redoes oldest undone edit first to preserve stack order', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); committed(p, 'b', 'roads', 'interactive', 2)
    p.undo('roads', 1, 5); p.undo('roads', 1, 6)
    expect(p.redo('roads', 1, 7)?.entryId).toBe('a')
    expect(p.redo('roads', 1, 8)?.entryId).toBe('b')
  })

  it('rejects undo and redo against stale revisions', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a')
    expect(p.undo('roads', 2, 2)).toBeNull(); expect(p.redo('roads', 2, 2)).toBeNull()
  })

  it('drops redo tail when a new edit is committed after undo', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); committed(p, 'b', 'roads', 'interactive', 2)
    expect(p.undo('roads', 1, 5)?.entryId).toBe('b')
    committed(p, 'c', 'roads', 'interactive', 6)
    expect(p.redo('roads', 1, 8)).toBeNull(); expect(p.fingerprint()).not.toContain(':b:')
  })

  it('does not drop redo history on another layer', () => {
    const p = policy(); p.setRevision('roads', 1); p.setRevision('parks', 1); committed(p, 'a'); committed(p, 'b', 'parks')
    p.undo('parks', 1, 3); committed(p, 'c', 'roads', 'interactive', 4)
    expect(p.redo('parks', 1, 6)?.entryId).toBe('b')
  })

  it('expires staged entries by staged TTL', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a'))
    expect(p.expire(49)).toBe(0); expect(p.expire(50)).toBe(1)
  })

  it('expires committed and undone history by history TTL', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a')
    expect(p.expire(100)).toBe(0); expect(p.expire(101)).toBe(1)
    committed(p, 'b', 'roads', 'interactive', 200); p.undo('roads', 1, 202)
    expect(p.expire(301)).toBe(0); expect(p.expire(302)).toBe(1)
  })

  it('touch extends history residency but not staged work', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a')); expect(p.touch('a', 20)).toBe(false)
    expect(p.commit('a', 1, 2, 100, 21)).toBe(true); expect(p.touch('a', 100)).toBe(true)
    expect(p.expire(199)).toBe(0); expect(p.expire(200)).toBe(1)
  })

  it('evicts lower-intent history under operation pressure', () => {
    const p = policy({ maxResidentOperations: 4 }); p.setRevision('roads', 1)
    committed(p, 'bg', 'roads', 'background'); expect(p.stage(request('ui'))).toBe(true)
    expect(p.commit('ui', 1, 4, 100, 5)).toBe(true)
    expect(p.fingerprint()).not.toContain(':bg:'); expect(p.fingerprint()).toContain(':ui:')
  })

  it('evicts lower-intent history under byte pressure', () => {
    const p = policy({ maxResidentBytes: 800 }); p.setRevision('roads', 1)
    p.stage(request('bg', 'roads', 1, 'background')); p.commit('bg', 1, 2, 700, 1)
    p.stage(request('ui')); expect(p.commit('ui', 1, 2, 700, 2)).toBe(true)
    expect(p.snapshot().residentBytes).toBe(700); expect(p.fingerprint()).not.toContain(':bg:')
  })

  it('refuses to evict higher-intent history for background work', () => {
    const p = policy({ maxResidentOperations: 4 }); p.setRevision('roads', 1)
    committed(p, 'ui'); p.stage(request('bg', 'roads', 1, 'background'))
    expect(p.commit('bg', 1, 4, 100, 3)).toBe(false); expect(p.fingerprint()).toContain(':ui:')
  })

  it('uses recency then sequence as deterministic eviction tie breaks', () => {
    const p = policy({ maxResidentOperations: 4 }); p.setRevision('roads', 1)
    committed(p, 'a', 'roads', 'visible', 0); committed(p, 'b', 'roads', 'visible', 0)
    expect(p.touch('b', 10)).toBe(true); p.stage(request('c', 'roads', 1, 'visible', 11)); expect(p.commit('c', 1, 2, 100, 12)).toBe(true)
    expect(p.fingerprint()).not.toContain(':a:'); expect(p.fingerprint()).toContain(':b:')
  })

  it('counts undone entries against resident budgets', () => {
    const p = policy({ maxResidentOperations: 4 }); p.setRevision('roads', 1); committed(p, 'a'); p.undo('roads', 1, 2)
    p.stage(request('b', 'roads', 1, 'background', 3)); expect(p.commit('b', 1, 4, 100, 4)).toBe(false)
    expect(p.fingerprint()).toContain(':a:')
  })

  it('cancel removes any phase deterministically', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a')); expect(p.cancel('a')).toBe(true); expect(p.cancel('a')).toBe(false)
    committed(p, 'b'); expect(p.cancel('b')).toBe(true); expect(p.snapshot().entries).toBe(0)
  })

  it('releaseLayer removes history and revision authority only for that layer', () => {
    const p = policy(); p.setRevision('roads', 1); p.setRevision('parks', 1); committed(p, 'a'); committed(p, 'b', 'parks')
    expect(p.releaseLayer('roads')).toBe(1); expect(p.snapshot()).toMatchObject({ layers: 1, entries: 1 })
    expect(p.stage(request('c'))).toBe(false); expect(p.fingerprint()).toContain('parks:b:')
  })

  it('returns detached frozen views', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); const view = p.undo('roads', 1, 2)
    expect(Object.isFrozen(view)).toBe(true); expect(view).toMatchObject({ entryId: 'a', phase: 'undone' })
  })

  it('returns a scalar snapshot without caller payload graphs', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); const snap = p.snapshot()
    expect(Object.isFrozen(snap)).toBe(true); expect(snap).toEqual({ layers: 1, entries: 1, staged: 0, committed: 1, undone: 0, residentOperations: 2, residentBytes: 100 })
    expect(JSON.stringify(snap)).not.toMatch(/geometry|graphic|attributes|credential|token/i)
  })

  it('produces deterministic payload-free fingerprints', () => {
    const a = policy(); const b = policy(); for (const p of [a,b]) { p.setRevision('roads', 1); committed(p, 'x'); committed(p, 'y', 'roads', 'visible', 2); p.undo('roads', 1, 4) }
    expect(a.fingerprint()).toBe(b.fingerprint()); expect(a.fingerprint()).toBe('roads:x:1:interactive:committed:2:100|roads:y:1:visible:undone:2:100')
  })

  it('does not retain extra request properties in views or fingerprints', () => {
    const p = policy(); p.setRevision('roads', 1)
    const geometry = { secret: 'caller-owned' }
    expect(p.stage({ ...request('a'), geometry } as ReturnType<typeof request> & { geometry: object })).toBe(true)
    p.commit('a', 1, 2, 100, 1); const view = p.undo('roads', 1, 2) as unknown as Record<string, unknown>
    expect(view.geometry).toBeUndefined(); expect(p.fingerprint()).not.toContain('caller-owned')
  })

  it('expire validates time and is idempotent', () => {
    const p = policy(); p.setRevision('roads', 1); p.stage(request('a'))
    expect(() => p.expire(-1)).toThrow(); expect(p.expire(50)).toBe(1); expect(p.expire(50)).toBe(0)
  })

  it('dispose clears authority and rejects subsequent operations', () => {
    const p = policy(); p.setRevision('roads', 1); committed(p, 'a'); p.dispose(); p.dispose()
    expect(() => p.snapshot()).toThrow('disposed'); expect(() => p.setRevision('roads', 2)).toThrow('disposed'); expect(() => p.stage(request('b'))).toThrow('disposed')
  })
})
