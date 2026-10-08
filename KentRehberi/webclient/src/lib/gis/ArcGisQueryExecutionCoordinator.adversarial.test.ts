import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPage, ArcGisQueryPlan } from './ArcGisQueryPagePlanner'

function page(index: number): ArcGisQueryPage {
  return { kind: 'objectIds', page: index, objectIds: [index + 1] }
}

function plan(count: number): ArcGisQueryPlan {
  return { kind: 'planned', key: 'test-query', pageSize: 1,
    pages: Array.from({ length: count }, (_, index) => page(index)) }
}

const inspector = {
  inspect: (_response: unknown, entry: ArcGisQueryPage) => ({
    kind: 'accepted' as const,
    features: [{ attributes: { OBJECTID: entry.page + 1 } }],
    objectIds: [entry.page + 1],
    exceededTransferLimit: false,
  }),
}

describe('ArcGisQueryExecutionCoordinator adversarial deadlines', () => {
  it('returns a timeout even if transport never honors cancellation', async () => {
    const execute = vi.fn(() => new Promise<unknown>(() => {}))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector, {
      maxAttemptsPerPage: 2, pageTimeoutMs: 10,
    })
    await expect(coordinator.execute(plan(1))).resolves.toEqual({
      kind: 'failed', code: 'timeout', page: 0,
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('returns promptly on caller cancellation when transport never settles', async () => {
    const controller = new AbortController()
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: () => new Promise<unknown>(() => {}) }, inspector,
      { pageTimeoutMs: 1000 },
    )
    const result = coordinator.execute(plan(1), controller.signal)
    controller.abort()
    await expect(result).resolves.toEqual({ kind: 'failed', code: 'aborted' })
  })

  it('preserves the first transport failure when another worker is aborted', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: request => request.page === 0
        ? Promise.reject(new Error('offline'))
        : new Promise<unknown>(() => {}) },
      inspector, { maxConcurrentPages: 2, maxAttemptsPerPage: 1, pageTimeoutMs: 1000 },
    )
    await expect(coordinator.execute(plan(2))).resolves.toEqual({
      kind: 'failed', code: 'transport-error', page: 0,
    })
  })

  it('classifies a throwing inspector as an integrity failure without retry', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute }, { inspect: () => { throw new Error('invalid response shape') } },
      { maxAttemptsPerPage: 3 },
    )
    await expect(coordinator.execute(plan(1))).resolves.toEqual({
      kind: 'failed', code: 'integrity-error', page: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate or oversized plans without transport work', async () => {
    const execute = vi.fn(async () => ({}))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector)
    const duplicate: ArcGisQueryPlan = {
      kind: 'planned', key: 'duplicate', pageSize: 1, pages: [page(0), page(0)],
    }
    await expect(coordinator.execute(duplicate)).resolves.toEqual({
      kind: 'failed', code: 'invalid-plan',
    })
    await expect(coordinator.execute(plan(4097))).resolves.toEqual({
      kind: 'failed', code: 'invalid-plan',
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
