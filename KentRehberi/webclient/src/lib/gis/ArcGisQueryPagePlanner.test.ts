import { describe, expect, it } from 'vitest'
import { ArcGisQueryPagePlanner } from './ArcGisQueryPagePlanner'

const capabilities = {
  maxRecordCount: 2000,
  supportsPagination: true,
  supportsOrderBy: true,
  objectIdField: 'OBJECTID',
} as const

describe('ArcGisQueryPagePlanner', () => {
  it('plans deterministic offset pages bounded by the service record limit', () => {
    const planner = new ArcGisQueryPagePlanner()
    const result = planner.plan({
      layerId: 'roads',
      where: '1=1',
      outFields: ['OBJECTID', 'NAME'],
      estimatedFeatures: 4500,
      pageSize: 5000,
    }, capabilities)
    expect(result.kind).toBe('planned')
    if (result.kind !== 'planned') return
    expect(result.pageSize).toBe(2000)
    expect(result.pages).toHaveLength(3)
    expect(result.pages[0]).toMatchObject({ kind: 'offset', resultOffset: 0, resultRecordCount: 2000 })
    expect(result.pages[2]).toMatchObject({ kind: 'offset', resultOffset: 4000, resultRecordCount: 2000 })
  })

  it('uses stable object-id ordering and deduplicates ids', () => {
    const planner = new ArcGisQueryPagePlanner({ defaultPageSize: 2 })
    const result = planner.plan({
      layerId: 'parcels',
      where: 'STATUS = 1',
      outFields: ['OBJECTID'],
      objectIds: [9, 2, 9, 4, 1],
    }, { ...capabilities, supportsPagination: false })
    expect(result.kind).toBe('planned')
    if (result.kind !== 'planned') return
    expect(result.pages).toEqual([
      { kind: 'objectIds', page: 0, objectIds: [1, 2] },
      { kind: 'objectIds', page: 1, objectIds: [4, 9] },
    ])
  })

  it('rejects unbounded estimated feature counts', () => {
    const planner = new ArcGisQueryPagePlanner({ maxEstimatedFeatures: 100 })
    expect(planner.plan({
      layerId: 'buildings', where: '1=1', outFields: ['OBJECTID'], estimatedFeatures: 101,
    }, capabilities)).toEqual({ kind: 'rejected', reason: 'feature-budget' })
  })

  it('rejects pagination when service cannot page and ids are unavailable', () => {
    const planner = new ArcGisQueryPagePlanner()
    expect(planner.plan({
      layerId: 'buildings', where: '1=1', outFields: ['OBJECTID'], estimatedFeatures: 10,
    }, { ...capabilities, supportsPagination: false })).toEqual({
      kind: 'rejected', reason: 'pagination-unsupported-without-object-ids',
    })
  })

  it('rejects invalid field identifiers and unsafe control characters', () => {
    const planner = new ArcGisQueryPagePlanner()
    expect(planner.plan({ layerId: 'x', where: '1=1', outFields: ['NAME;DROP'] }, capabilities)).toEqual({
      kind: 'rejected', reason: 'invalid-out-fields',
    })
    expect(planner.plan({ layerId: 'x\n', where: '1=1', outFields: ['OBJECTID'] }, capabilities)).toEqual({
      kind: 'rejected', reason: 'invalid-layer',
    })
  })

  it('caps total pages before allocating page descriptors', () => {
    const planner = new ArcGisQueryPagePlanner({ defaultPageSize: 10, maxPageSize: 10, maxPages: 2 })
    expect(planner.plan({
      layerId: 'x', where: '1=1', outFields: ['OBJECTID'], estimatedFeatures: 21,
    }, capabilities)).toEqual({ kind: 'rejected', reason: 'page-budget' })
  })

  it('rejects invalid object ids and object-id budgets', () => {
    const planner = new ArcGisQueryPagePlanner({ maxObjectIds: 3 })
    expect(planner.plan({
      layerId: 'x', where: '1=1', outFields: ['OBJECTID'], objectIds: [1, 2, 3, 4],
    }, capabilities)).toEqual({ kind: 'rejected', reason: 'object-id-budget' })
    expect(planner.plan({
      layerId: 'x', where: '1=1', outFields: ['OBJECTID'], objectIds: [1, -2],
    }, capabilities)).toEqual({ kind: 'rejected', reason: 'object-id-budget' })
  })

  it('produces deterministic keys for equivalent repeated plans', () => {
    const planner = new ArcGisQueryPagePlanner()
    const request = { layerId: 'roads', where: 'TYPE = 2', outFields: ['OBJECTID', 'NAME'], estimatedFeatures: 2 } as const
    const first = planner.plan(request, capabilities)
    const second = planner.plan(request, capabilities)
    expect(first.kind).toBe('planned')
    expect(second.kind).toBe('planned')
    if (first.kind === 'planned' && second.kind === 'planned') expect(first.key).toBe(second.key)
  })
})