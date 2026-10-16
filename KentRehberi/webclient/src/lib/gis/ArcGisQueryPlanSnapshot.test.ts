import { describe, expect, it, vi } from 'vitest'
import { captureArcGisQueryPlan } from './ArcGisQueryPlanSnapshot'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPage, ArcGisQueryPlan } from './ArcGisQueryPagePlanner'

function objectIdPlan(ids: readonly number[] = [1]): ArcGisQueryPlan {
  return {
    kind: 'planned', key: 'parcels', pageSize: 2,
    pages: [{ kind: 'objectIds', page: 0, objectIds: ids }],
  }
}

function offsetPlan(): ArcGisQueryPlan {
  return {
    kind: 'planned', key: 'ordered-parcels', pageSize: 2,
    pages: [
      { kind: 'offset', page: 1, resultOffset: 2, resultRecordCount: 2, orderByFields: ['OBJECTID asc'] },
      { kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 2, orderByFields: ['OBJECTID asc'] },
    ],
  }
}

function coordinator(transport = vi.fn(async (_page: ArcGisQueryPage, _signal: AbortSignal) => ({ features: [] }))) {
  const inspect = vi.fn(() => ({
    kind: 'accepted' as const, features: [], objectIds: [], exceededTransferLimit: false,
  }))
  return { transport, inspect, executor: new ArcGisQueryExecutionCoordinator({ execute: transport }, { inspect }) }
}

describe('ArcGIS query plan snapshot and execution admission', () => {
  it('captures independently frozen page and object-ID arrays', () => {
    const ids = [1, 2]
    const input = objectIdPlan(ids)
    const captured = captureArcGisQueryPlan(input)
    expect(captured?.kind).toBe('planned')
    if (captured === null) return
    ids[0] = 999
    expect(captured.pages[0]).toMatchObject({ objectIds: [1, 2] })
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.pages)).toBe(true)
    expect(Object.isFrozen(captured.pages[0])).toBe(true)
    if (captured.pages[0]?.kind === 'objectIds') {
      expect(Object.isFrozen(captured.pages[0].objectIds)).toBe(true)
    }
  })

  it('preserves valid unordered pages and stable deterministic ordering', () => {
    const captured = captureArcGisQueryPlan(offsetPlan())
    expect(captured?.kind).toBe('planned')
    expect(captured?.pages.map(page => page.page)).toEqual([1, 0])
    expect(captured?.pages[0]).toMatchObject({ resultOffset: 2, orderByFields: ['OBJECTID asc'] })
  })

  it('does not evaluate accessor-backed plan fields or page values', async () => {
    let executed = 0
    const page = { kind: 'objectIds', page: 0 } as Record<string, unknown>
    Object.defineProperty(page, 'objectIds', {
      enumerable: true,
      get() { executed += 1; throw new Error('should not execute') },
    })
    const plan = { kind: 'planned', key: 'a', pageSize: 2, pages: [page] } as unknown as ArcGisQueryPlan
    expect(captureArcGisQueryPlan(plan)).toBeNull()
    const { executor, transport } = coordinator()
    await expect(executor.execute(plan)).resolves.toMatchObject({ kind: 'failed', code: 'invalid-plan' })
    expect(executed).toBe(0)
    expect(transport).not.toHaveBeenCalled()
  })

  it('converts throwing proxy traps into invalid plans without starting transport', async () => {
    const pages = new Proxy([objectIdPlan()], {
      getOwnPropertyDescriptor() { throw new Error('proxy trap') },
    })
    const plan = { kind: 'planned', key: 'a', pageSize: 2, pages } as unknown as ArcGisQueryPlan
    expect(captureArcGisQueryPlan(plan)).toBeNull()
    const { executor, transport } = coordinator()
    await expect(executor.execute(plan)).resolves.toMatchObject({ code: 'invalid-plan' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('rejects sparse pages, sparse IDs and accessor-backed array elements', () => {
    const sparsePages: unknown[] = []
    sparsePages.length = 1
    expect(captureArcGisQueryPlan({
      kind: 'planned', key: 'a', pageSize: 2, pages: sparsePages,
    })).toBeNull()
    const sparseIds: number[] = []
    sparseIds.length = 1
    expect(captureArcGisQueryPlan(objectIdPlan(sparseIds))).toBeNull()
    const ids = [1]
    Object.defineProperty(ids, '0', { get() { throw new Error('not-called') } })
    expect(captureArcGisQueryPlan(objectIdPlan(ids))).toBeNull()
  })

  it('rejects duplicate page indexes, cross-page object IDs and mixed page modes', () => {
    expect(captureArcGisQueryPlan({
      kind: 'planned', key: 'x', pageSize: 2,
      pages: [
        { kind: 'objectIds', page: 0, objectIds: [1] },
        { kind: 'objectIds', page: 0, objectIds: [2] },
      ],
    })).toBeNull()
    expect(captureArcGisQueryPlan({
      kind: 'planned', key: 'x', pageSize: 2,
      pages: [
        { kind: 'objectIds', page: 0, objectIds: [1] },
        { kind: 'objectIds', page: 1, objectIds: [1] },
      ],
    })).toBeNull()
    expect(captureArcGisQueryPlan({
      kind: 'planned', key: 'x', pageSize: 2,
      pages: [
        { kind: 'objectIds', page: 0, objectIds: [1] },
        { kind: 'offset', page: 1, resultOffset: 2, resultRecordCount: 2, orderByFields: ['OBJECTID asc'] },
      ],
    })).toBeNull()
  })

  it('rejects offset overflow, inconsistent order, missing sort and unsafe fields', () => {
    const wrong = [
      [{ kind: 'offset', page: 0, resultOffset: 1, resultRecordCount: 2, orderByFields: ['OBJECTID asc'] }],
      [
        { kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 2, orderByFields: ['OBJECTID asc'] },
        { kind: 'offset', page: 1, resultOffset: 2, resultRecordCount: 2, orderByFields: ['NAME desc'] },
      ],
      [
        { kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 2, orderByFields: [] },
        { kind: 'offset', page: 1, resultOffset: 2, resultRecordCount: 2, orderByFields: [] },
      ],
      [{ kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 2, orderByFields: ['OBJECTID; DROP TABLE parcels'] }],
    ]
    for (const pages of wrong) {
      expect(captureArcGisQueryPlan({ kind: 'planned', key: 'x', pageSize: 2, pages })).toBeNull()
    }
  })

  it('rejects oversized cardinalities before allocating worker state', async () => {
    const { executor, transport } = coordinator()
    const invalid = [
      { kind: 'planned', key: 'x', pageSize: Number.MAX_SAFE_INTEGER, pages: [{ kind: 'objectIds', page: 0, objectIds: [1] }] },
      { kind: 'planned', key: 'x', pageSize: 2, pages: [{ kind: 'objectIds', page: 0, objectIds: [0] }] },
      { kind: 'planned', key: 'x', pageSize: 2, pages: [{ kind: 'objectIds', page: 0, objectIds: [1, 1] }] },
      { kind: 'planned', key: 'x\n', pageSize: 2, pages: [{ kind: 'objectIds', page: 0, objectIds: [1] }] },
    ]
    for (const plan of invalid) {
      await expect(executor.execute(plan as ArcGisQueryPlan)).resolves.toMatchObject({ code: 'invalid-plan' })
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('executes a valid captured plan without exposing mutable source pages', async () => {
    const transport = vi.fn(async (_page: ArcGisQueryPage, _signal: AbortSignal) => ({ features: [] }))
    const { executor } = coordinator(transport)
    const result = await executor.execute(objectIdPlan([1]))
    expect(result).toMatchObject({ kind: 'completed', pagesCompleted: 1, objectIds: [] })
    expect(transport).toHaveBeenCalledTimes(1)
    const [page] = transport.mock.calls[0] ?? []
    expect(page).toMatchObject({ kind: 'objectIds', objectIds: [1] })
    expect(Object.isFrozen(page)).toBe(true)
  })
})
