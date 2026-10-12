import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPlan, ArcGisQueryPage } from './ArcGisQueryPagePlanner'

function accepted(page: ArcGisQueryPage) {
  const id = page.kind === 'objectIds' ? page.objectIds[0]! : page.page + 1
  return {
    kind: 'accepted' as const,
    features: [{ attributes: { OBJECTID: id } }],
    objectIds: [id],
    exceededTransferLimit: false,
  }
}

describe('ArcGIS execution immutable plan and inspector contract', () => {
  it('captures caller-owned pages, identity, and IDs before async transport dispatch', async () => {
    const first = { kind: 'objectIds' as const, page: 0, objectIds: [1] }
    const second = { kind: 'objectIds' as const, page: 1, objectIds: [2] }
    const plan = {
      kind: 'planned' as const, key: 'original', pageSize: 1, pages: [first, second],
    }
    const dispatched: ArcGisQueryPage[] = []
    const coordinator = new ArcGisQueryExecutionCoordinator({
      execute: async page => {
        dispatched.push(page)
        expect(Object.isFrozen(page)).toBe(true)
        if (page.kind === 'objectIds') expect(Object.isFrozen(page.objectIds)).toBe(true)
        return {}
      },
    }, { inspect: (_response, page) => accepted(page) }, { maxConcurrentPages: 1 })

    const pending = coordinator.execute(plan)
    first.objectIds[0] = 99
    second.objectIds[0] = 88
    first.page = 9
    second.page = 8
    const result = await pending
    expect(result).toMatchObject({
      kind: 'completed', key: 'original', objectIds: [1, 2], pagesCompleted: 2,
    })
    expect(dispatched.map(page => page.page)).toEqual([0, 1])
  })

  it('isolates offset ordering and offsets from mutation while a page is pending', async () => {
    const orderByFields = ['OBJECTID asc']
    const pages = [
      { kind: 'offset' as const, page: 0, resultOffset: 0, resultRecordCount: 1, orderByFields },
      { kind: 'offset' as const, page: 1, resultOffset: 1, resultRecordCount: 1, orderByFields },
    ]
    const coordinator = new ArcGisQueryExecutionCoordinator({
      execute: async page => {
        if (page.kind === 'offset') {
          expect(page.orderByFields).toEqual(['OBJECTID asc'])
          expect(page.resultOffset).toBe(page.page)
          expect(Object.isFrozen(page.orderByFields)).toBe(true)
        }
        return {}
      },
    }, { inspect: (_response, page) => accepted(page) }, { maxConcurrentPages: 1 })
    const pending = coordinator.execute({ kind: 'planned', key: 'offset', pageSize: 1, pages })
    orderByFields[0] = 'OBJECTID desc'
    pages[1]!.resultOffset = 900
    expect(await pending).toMatchObject({ kind: 'completed', objectIds: [1, 2] })
  })

  it('rejects malformed null page entries without dispatching network work', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, { inspect: () => accepted({
      kind: 'objectIds', page: 0, objectIds: [1],
    }) })
    const malformed = {
      kind: 'planned', key: 'malformed', pageSize: 1, pages: [null],
    } as unknown as ArcGisQueryPlan
    await expect(coordinator.execute(malformed)).resolves.toEqual({ kind: 'failed', code: 'invalid-plan' })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    { objectIds: [Number.NaN], exceededTransferLimit: false },
    { objectIds: [0], exceededTransferLimit: false },
    { objectIds: ['1'], exceededTransferLimit: false },
    { objectIds: [1], exceededTransferLimit: 'false' },
    { objectIds: null, exceededTransferLimit: false },
  ])('rejects invalid injected inspector payload %# before aggregation', async malformed => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async () => ({}) },
      { inspect: () => ({
        kind: 'accepted',
        features: [{ attributes: { OBJECTID: 1 } }],
        objectIds: malformed.objectIds,
        exceededTransferLimit: malformed.exceededTransferLimit,
      }) as never },
    )
    const plan: ArcGisQueryPlan = {
      kind: 'planned', key: 'inspection', pageSize: 1,
      pages: [{ kind: 'objectIds', page: 0, objectIds: [1] }],
    }
    await expect(coordinator.execute(plan)).resolves.toEqual({
      kind: 'failed', code: 'integrity-error', page: 0,
    })
  })

  it('retains valid injected inspector results without changing transport semantics', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute }, { inspect: (_response, page) => accepted(page) },
    )
    await expect(coordinator.execute({
      kind: 'planned', key: 'valid', pageSize: 1,
      pages: [{ kind: 'objectIds', page: 0, objectIds: [1] }],
    })).resolves.toMatchObject({
      kind: 'completed', key: 'valid', objectIds: [1], pagesCompleted: 1,
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
