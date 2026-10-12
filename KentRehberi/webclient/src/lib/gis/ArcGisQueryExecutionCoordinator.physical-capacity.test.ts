import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryExecutionCoordinator } from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryPlan } from './ArcGisQueryPagePlanner'

const plan: ArcGisQueryPlan = {
  kind: 'planned', key: 'physical-lease', pageSize: 1,
  pages: [{ kind: 'objectIds', page: 0, objectIds: [1] }],
}
const inspector = {
  inspect: () => ({
    kind: 'accepted' as const,
    features: [{ attributes: { OBJECTID: 1 } }],
    objectIds: [1],
    exceededTransferLimit: false,
  }),
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}

describe('ArcGIS physical transport admission', () => {
  it('keeps a timeout orphan leased until the underlying transport actually settles', async () => {
    const transport = deferred()
    let started!: () => void
    const entered = new Promise<void>(done => { started = done })
    const execute = vi.fn(() => { started(); return transport.promise })
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector, {
      maxConcurrentPages: 1, maxAttemptsPerPage: 2, pageTimeoutMs: 30,
    })

    const first = coordinator.execute(plan)
    await entered
    await expect(first).resolves.toEqual({ kind: 'failed', code: 'timeout', page: 0 })
    await expect(coordinator.execute(plan)).resolves.toEqual({
      kind: 'failed', code: 'transport-capacity', page: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)

    transport.resolve({})
    await Promise.resolve()
    await Promise.resolve()
    await expect(coordinator.execute(plan)).resolves.toMatchObject({
      kind: 'completed', pagesCompleted: 1,
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('shares physical capacity across simultaneous logical execute calls', async () => {
    const transport = deferred()
    let started!: () => void
    const entered = new Promise<void>(done => { started = done })
    const execute = vi.fn(() => { started(); return transport.promise })
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector, {
      maxConcurrentPages: 1, maxAttemptsPerPage: 1, pageTimeoutMs: 1_000,
    })
    const first = coordinator.execute(plan)
    await entered
    await expect(coordinator.execute(plan)).resolves.toEqual({
      kind: 'failed', code: 'transport-capacity', page: 0,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    transport.resolve({})
    await expect(first).resolves.toMatchObject({ kind: 'completed' })
    await expect(coordinator.execute(plan)).resolves.toMatchObject({ kind: 'completed' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not release a physical lease merely because its caller aborted', async () => {
    const transport = deferred()
    let started!: () => void
    const entered = new Promise<void>(done => { started = done })
    const execute = vi.fn(() => { started(); return transport.promise })
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector, {
      maxConcurrentPages: 1, maxAttemptsPerPage: 1, pageTimeoutMs: 1_000,
    })
    const controller = new AbortController()
    const first = coordinator.execute(plan, controller.signal)
    await entered
    controller.abort()
    await expect(first).resolves.toEqual({ kind: 'failed', code: 'aborted' })
    await expect(coordinator.execute(plan)).resolves.toEqual({
      kind: 'failed', code: 'transport-capacity', page: 0,
    })
    transport.resolve({})
    await Promise.resolve()
    await Promise.resolve()
    await expect(coordinator.execute(plan)).resolves.toMatchObject({ kind: 'completed' })
  })

  it('releases capacity after settled synchronous transport errors', async () => {
    const execute = vi.fn()
      .mockImplementationOnce(() => { throw new Error('connection failed') })
      .mockResolvedValueOnce({})
    const coordinator = new ArcGisQueryExecutionCoordinator({ execute }, inspector, {
      maxConcurrentPages: 1, maxAttemptsPerPage: 1, pageTimeoutMs: 1_000,
    })
    await expect(coordinator.execute(plan)).resolves.toEqual({
      kind: 'failed', code: 'transport-error', page: 0,
    })
    await expect(coordinator.execute(plan)).resolves.toMatchObject({ kind: 'completed' })
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
