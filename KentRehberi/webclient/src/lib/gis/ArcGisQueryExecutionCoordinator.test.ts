import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPage, ArcGisQueryPlan } from './ArcGisQueryPagePlanner'
import type { ArcGisQueryIntegrityResult } from './ArcGisQueryResponseIntegrity'

function page(page: number): ArcGisQueryPage {
  return { kind: 'objectIds', page, objectIds: [page + 1] }
}

function plan(count = 3): ArcGisQueryPlan {
  return {
    kind: 'planned',
    key: 'layer-query',
    pageSize: 1,
    pages: Array.from({ length: count }, (_, index) => page(index)),
  }
}

function accepted(id: number, exceededTransferLimit = false): ArcGisQueryIntegrityResult {
  return {
    kind: 'accepted',
    features: [{ attributes: { OBJECTID: id } }],
    objectIds: [id],
    exceededTransferLimit,
  }
}

describe('ArcGisQueryExecutionCoordinator', () => {
  it('rejects a rejected plan without transport work', async () => {
    const execute = vi.fn()
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, { inspect: vi.fn() })
    await expect(coordinator.execute({ kind: 'rejected', reason: 'page-budget' })).resolves.toEqual({ kind: 'failed', code: 'invalid-plan' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes pages and restores deterministic page order', async () => {
    const execute = vi.fn(async (request: ArcGisQueryPage) => {
      await new Promise(resolve => setTimeout(resolve, (3 - request.page) * 2))
      return request.page
    })
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute },
      { inspect: (_response, request) => accepted(request.page + 1) },
      { maxConcurrentPages: 3 },
    )
    const result = await coordinator.execute(plan())
    expect(result).toEqual({
      kind: 'completed',
      key: 'layer-query',
      features: [
        { attributes: { OBJECTID: 1 } },
        { attributes: { OBJECTID: 2 } },
        { attributes: { OBJECTID: 3 } },
      ],
      objectIds: [1, 2, 3],
      pagesCompleted: 3,
    })
  })

  it('bounds concurrent page execution', async () => {
    let active = 0
    let peak = 0
    const execute = vi.fn(async (request: ArcGisQueryPage) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 4))
      active -= 1
      return request.page
    })
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute },
      { inspect: (_response, request) => accepted(request.page + 1) },
      { maxConcurrentPages: 2 },
    )
    expect((await coordinator.execute(plan(8))).kind).toBe('completed')
    expect(peak).toBe(2)
  })

  it('fails closed on inspector rejection', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async request => request.page },
      { inspect: (_response, request) => request.page === 1
        ? { kind: 'rejected', issue: { code: 'duplicate-object-id' } }
        : accepted(request.page + 1) },
      { maxConcurrentPages: 1 },
    )
    await expect(coordinator.execute(plan())).resolves.toEqual({
      kind: 'failed',
      code: 'integrity-error',
      page: 1,
      integrity: { kind: 'rejected', issue: { code: 'duplicate-object-id' } },
    })
  })

  it('rejects duplicate object ids across otherwise valid pages', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async request => request.page },
      { inspect: () => accepted(7) },
      { maxConcurrentPages: 1 },
    )
    await expect(coordinator.execute(plan(2))).resolves.toEqual({ kind: 'failed', code: 'integrity-error', page: 1 })
  })

  it('enforces the aggregate feature budget', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async request => request.page },
      { inspect: (_response, request) => accepted(request.page + 1) },
      { maxFeatures: 2 },
    )
    await expect(coordinator.execute(plan(3))).resolves.toEqual({ kind: 'failed', code: 'feature-budget', page: 2 })
  })

  it('rejects transfer truncation for object-id pages', async () => {
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async request => request.page },
      { inspect: (_response, request) => accepted(request.page + 1, true) },
    )
    await expect(coordinator.execute(plan(1))).resolves.toEqual({ kind: 'failed', code: 'incomplete-transfer', page: 0 })
  })

  it('retries transient transport failures up to the configured bound', async () => {
    let calls = 0
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute: async request => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return request.page
      } },
      { inspect: (_response, request) => accepted(request.page + 1) },
      { maxAttemptsPerPage: 2 },
    )
    expect((await coordinator.execute(plan(1))).kind).toBe('completed')
    expect(calls).toBe(2)
  })

  it('fails after the retry budget is exhausted', async () => {
    const execute = vi.fn(async () => { throw new Error('offline') })
    const coordinator = new ArcGisQueryExecutionCoordinator(
      { execute },
      { inspect: vi.fn() },
      { maxAttemptsPerPage: 2 },
    )
    await expect(coordinator.execute(plan(1))).resolves.toEqual({ kind: 'failed', code: 'transport-error', page: 0 })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('honors a caller abort before execution', async () => {
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn()
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, { inspect: vi.fn() })
    await expect(coordinator.execute(plan(1), controller.signal)).resolves.toEqual({ kind: 'failed', code: 'aborted' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('propagates caller abort to active page work', async () => {
    const controller = new AbortController()
    const execute = vi.fn((_page: ArcGisQueryPage, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, { inspect: vi.fn() })
    const pending = coordinator.execute(plan(1), controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'aborted' })
  })

  it('validates execution options', () => {
    const transport = { execute: vi.fn() }
    const inspector = { inspect: vi.fn() }
    expect(() => new ArcGisQueryExecutionCoordinator(transport, inspector, { maxConcurrentPages: 0 })).toThrow()
    expect(() => new ArcGisQueryExecutionCoordinator(transport, inspector, { maxFeatures: -1 })).toThrow()
    expect(() => new ArcGisQueryExecutionCoordinator(transport, inspector, { maxAttemptsPerPage: 1.5 })).toThrow()
    expect(() => new ArcGisQueryExecutionCoordinator(transport, inspector, { pageTimeoutMs: 0 })).toThrow()
  })
})
