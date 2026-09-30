import { describe, expect, it } from 'vitest'
import { ArcGisPaginationPolicy, type ArcGisPaginationBudget } from './ArcGisPaginationPolicy'

const budget: ArcGisPaginationBudget = {
  maxLayers: 2,
  maxPagesPerLayer: 3,
  maxFeaturesPerPage: 100,
  maxFeaturesPerLayer: 250,
  maxBytesPerPage: 1_000,
  maxBytesPerLayer: 2_500,
  maxCursorLength: 64,
  maxLayerIdLength: 32,
}

const first = { requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, resultOffset: 0, resultRecordCount: 100 }

describe('ArcGisPaginationPolicy', () => {
  it('admits a deterministic first page and freezes the request', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    const plan = policy.begin(first)
    expect(plan).toEqual(first)
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it('requires a new layer to start from page and offset zero', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    expect(() => policy.begin({ ...first, pageIndex: 1 })).toThrow('pagination-must-start-at-zero')
    expect(() => policy.begin({ ...first, resultOffset: 10 })).toThrow('pagination-must-start-at-zero')
  })

  it('prevents concurrent requests for the same layer', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    expect(() => policy.begin({ ...first, requestId: 'r2' })).toThrow('pagination-request-already-active')
  })

  it('accounts completed pages and requires exact next offset', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    const snapshot = policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 80, byteLength: 900, exceededTransferLimit: true, nextCursor: 'next' })
    expect(snapshot).toMatchObject({ pagesCompleted: 1, featuresReceived: 80, bytesReceived: 900, nextPageIndex: 1, complete: false })
    expect(() => policy.begin({ requestId: 'r2', layerId: 'roads', revision: 1, pageIndex: 1, resultOffset: 79, resultRecordCount: 100 })).toThrow('unexpected-pagination-offset')
    expect(policy.begin({ requestId: 'r2', layerId: 'roads', revision: 1, pageIndex: 1, resultOffset: 80, resultRecordCount: 100 }).pageIndex).toBe(1)
  })

  it('rejects stale revisions and requires newer revisions to restart', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    policy.fail('roads', 'r1')
    expect(() => policy.begin({ ...first, revision: 0 })).toThrow('stale-pagination-revision')
    expect(() => policy.begin({ ...first, revision: 2, pageIndex: 1 })).toThrow('new-pagination-revision-must-start-at-zero')
    expect(policy.begin({ ...first, revision: 2 }).revision).toBe(2)
  })

  it('rejects a result that exceeds requested count', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin({ ...first, resultRecordCount: 10 })
    expect(() => policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 11, byteLength: 100, exceededTransferLimit: false })).toThrow('pagination-result-exceeds-requested-count')
  })

  it('rejects byte budget overflow across pages', () => {
    const policy = new ArcGisPaginationPolicy({ ...budget, maxBytesPerLayer: 1_500 })
    policy.begin(first)
    policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 100, byteLength: 900, exceededTransferLimit: true })
    policy.begin({ requestId: 'r2', layerId: 'roads', revision: 1, pageIndex: 1, resultOffset: 100, resultRecordCount: 100 })
    expect(() => policy.complete({ requestId: 'r2', layerId: 'roads', revision: 1, pageIndex: 1, featureCount: 100, byteLength: 700, exceededTransferLimit: false })).toThrow('pagination-byte-budget-exceeded')
  })

  it('rejects transfer-limit pages that make no progress', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    expect(() => policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 0, byteLength: 10, exceededTransferLimit: true })).toThrow('pagination-transfer-limit-without-progress')
  })

  it('rejects cursors on terminal pages', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    expect(() => policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 10, byteLength: 100, exceededTransferLimit: false, nextCursor: 'unused' })).toThrow('pagination-terminal-page-cannot-have-cursor')
  })

  it('marks a terminal page complete and rejects further requests', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    const snapshot = policy.complete({ requestId: 'r1', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 10, byteLength: 100, exceededTransferLimit: false })
    expect(snapshot.complete).toBe(true)
    expect(() => policy.begin({ requestId: 'r2', layerId: 'roads', revision: 1, pageIndex: 1, resultOffset: 10, resultRecordCount: 10 })).toThrow('pagination-already-complete')
  })

  it('bounds tracked layers', () => {
    const policy = new ArcGisPaginationPolicy({ ...budget, maxLayers: 1 })
    policy.begin(first)
    policy.fail('roads', 'r1')
    expect(() => policy.begin({ ...first, requestId: 'r2', layerId: 'buildings' })).toThrow('pagination-layer-budget-exceeded')
  })

  it('failure releases the active request without advancing accounting', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    const snapshot = policy.fail('roads', 'r1')
    expect(snapshot).toMatchObject({ pagesCompleted: 0, featuresReceived: 0, nextPageIndex: 0, complete: false })
    expect(policy.begin({ ...first, requestId: 'retry' }).requestId).toBe('retry')
  })

  it('invalidates state only for a newer minimum revision', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    policy.fail('roads', 'r1')
    policy.invalidate('roads', 1)
    expect(policy.getSnapshot('roads')?.revision).toBe(1)
    policy.invalidate('roads', 2)
    expect(policy.getSnapshot('roads')).toBeUndefined()
  })

  it('produces stable immutable snapshots for equal state', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    policy.fail('roads', 'r1')
    const left = policy.getSnapshot('roads')
    const right = policy.getSnapshot('roads')
    expect(left?.fingerprint).toBe(right?.fingerprint)
    expect(Object.isFrozen(left)).toBe(true)
  })

  it('rejects mismatched result identities', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.begin(first)
    expect(() => policy.complete({ requestId: 'other', layerId: 'roads', revision: 1, pageIndex: 0, featureCount: 1, byteLength: 1, exceededTransferLimit: false })).toThrow('pagination-result-request-mismatch')
    expect(() => policy.complete({ requestId: 'r1', layerId: 'roads', revision: 2, pageIndex: 0, featureCount: 1, byteLength: 1, exceededTransferLimit: false })).toThrow('pagination-result-revision-mismatch')
  })

  it('validates constructor budget relationships', () => {
    expect(() => new ArcGisPaginationPolicy({ ...budget, maxFeaturesPerPage: 300 })).toThrow('page-feature-budget-exceeds-layer-budget')
    expect(() => new ArcGisPaginationPolicy({ ...budget, maxBytesPerPage: 3_000 })).toThrow('page-byte-budget-exceeds-layer-budget')
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisPaginationPolicy(budget)
    policy.dispose()
    expect(() => policy.begin(first)).toThrow('arcgis-pagination-policy-disposed')
    expect(() => policy.getSnapshot('roads')).toThrow('arcgis-pagination-policy-disposed')
  })
})
