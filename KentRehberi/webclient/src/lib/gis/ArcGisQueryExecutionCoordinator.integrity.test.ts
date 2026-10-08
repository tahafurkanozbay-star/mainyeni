import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPlan } from './ArcGisQueryPagePlanner'

const ids = (values: number[]): ArcGisQueryPlan => ({
  kind: 'planned', key: 'identity', pageSize: values.length,
  pages: [{ kind: 'objectIds', page: 0, objectIds: values }],
})

describe('ArcGIS execution integrity at aggregation boundary', () => {
  it('rejects an inspector that loses the object ID to feature alignment', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async () => ({}) },
      { inspect: () => ({
        kind: 'accepted', features: [{ attributes: { OBJECTID: 1 } }],
        objectIds: [1, 2], exceededTransferLimit: false,
      }) },
    )
    await expect(coordinator.execute(ids([1, 2]))).resolves.toEqual({
      kind: 'failed', code: 'integrity-error', page: 0,
    })
  })

  it('rejects an inspector that returns an unrequested object ID', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async () => ({}) },
      { inspect: () => ({
        kind: 'accepted', features: [{ attributes: { OBJECTID: 3 } }],
        objectIds: [3], exceededTransferLimit: false,
      }) },
    )
    await expect(coordinator.execute(ids([1]))).resolves.toEqual({
      kind: 'failed', code: 'integrity-error', page: 0,
    })
  })

  it('does not accept a truncated final offset page', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async () => ({}) },
      { inspect: () => ({
        kind: 'accepted', features: [{ attributes: { OBJECTID: 1 } }],
        objectIds: [1], exceededTransferLimit: true,
      }) },
    )
    await expect(coordinator.execute({
      kind: 'planned', key: 'offset', pageSize: 1,
      pages: [{ kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 1, orderByFields: [] }],
    })).resolves.toEqual({ kind: 'failed', code: 'incomplete-transfer', page: 0 })
  })

  it('rejects a duplicated object ID across pages before network work', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, {
      inspect: () => ({ kind: 'accepted', features: [], objectIds: [], exceededTransferLimit: false }),
    })
    await expect(coordinator.execute({
      kind: 'planned', key: 'collision', pageSize: 1,
      pages: [
        { kind: 'objectIds', page: 0, objectIds: [7] },
        { kind: 'objectIds', page: 1, objectIds: [7] },
      ],
    })).resolves.toEqual({ kind: 'failed', code: 'invalid-plan' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a noncontiguous offset plan before network work', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, {
      inspect: () => ({ kind: 'accepted', features: [], objectIds: [], exceededTransferLimit: false }),
    })
    await expect(coordinator.execute({
      kind: 'planned', key: 'offset-gap', pageSize: 5,
      pages: [
        { kind: 'offset', page: 0, resultOffset: 0, resultRecordCount: 5, orderByFields: ['OBJECTID asc'] },
        { kind: 'offset', page: 1, resultOffset: 20, resultRecordCount: 5, orderByFields: ['OBJECTID asc'] },
      ],
    })).resolves.toEqual({ kind: 'failed', code: 'invalid-plan' })
    expect(execute).not.toHaveBeenCalled()
  })
})
