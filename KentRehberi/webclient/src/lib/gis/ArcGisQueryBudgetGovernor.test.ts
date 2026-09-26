import { afterEach, describe, expect, test, vi } from 'vitest'
import { ArcGisQueryBudgetGovernor, type ArcGisQueryBudgetResult } from './ArcGisQueryBudgetGovernor'

const request = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  workload: 'interactive' as const,
  estimatedFeatures: 10,
  estimatedBytes: 1_000,
  ...overrides,
})

function admitted(result: ArcGisQueryBudgetResult) {
  expect(result.kind).toBe('admitted')
  if (result.kind !== 'admitted') throw new Error('expected admitted result')
  return result.lease
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ArcGisQueryBudgetGovernor', () => {
  test('admits work immediately while concurrency and resource budgets permit', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 2 })
    const first = admitted(await governor.acquire(request('a')))
    const second = admitted(await governor.acquire(request('b')))
    expect(governor.snapshot()).toMatchObject({ active: 2, queued: 0, featuresInFlight: 20, estimatedBytesInFlight: 2_000 })
    first.release()
    second.release()
    expect(governor.snapshot()).toMatchObject({ active: 0, featuresInFlight: 0, estimatedBytesInFlight: 0 })
  })

  test('queues work when concurrency is exhausted and admits it after release', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const first = admitted(await governor.acquire(request('a')))
    const pending = governor.acquire(request('b'))
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 1 })
    first.release()
    const second = admitted(await pending)
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0 })
    second.release()
  })

  test('prioritizes interactive work ahead of background and prefetch queues', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const order: string[] = []
    const prefetch = governor.acquire(request('prefetch', { workload: 'prefetch' })).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    })
    const background = governor.acquire(request('background', { workload: 'background' })).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    })
    const interactive = governor.acquire(request('interactive')).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    })
    blocker.release()
    await Promise.all([prefetch, background, interactive])
    expect(order).toEqual(['interactive', 'background', 'prefetch'])
  })

  test('uses explicit priority inside the same workload class', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const order: string[] = []
    const low = governor.acquire(request('low', { priority: -5 })).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    })
    const high = governor.acquire(request('high', { priority: 9 })).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    })
    blocker.release()
    await Promise.all([low, high])
    expect(order).toEqual(['high', 'low'])
  })

  test('preserves FIFO order when workload and priority are equal', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const order: string[] = []
    const promises = ['one', 'two', 'three'].map((key) => governor.acquire(request(key)).then((result) => {
      const lease = admitted(result); order.push(lease.key); lease.release()
    }))
    blocker.release()
    await Promise.all(promises)
    expect(order).toEqual(['one', 'two', 'three'])
  })

  test('rejects a request that can never fit the feature budget', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxFeaturesInFlight: 50 })
    await expect(governor.acquire(request('huge', { estimatedFeatures: 51 }))).resolves.toEqual({
      kind: 'rejected', code: 'request-feature-budget',
    })
  })

  test('rejects a request that can never fit the byte budget', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxEstimatedBytesInFlight: 5_000 })
    await expect(governor.acquire(request('huge', { estimatedBytes: 5_001 }))).resolves.toEqual({
      kind: 'rejected', code: 'request-byte-budget',
    })
  })

  test('uses aggregate feature budget to delay otherwise concurrent work', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 4, maxFeaturesInFlight: 15 })
    const first = admitted(await governor.acquire(request('a', { estimatedFeatures: 10 })))
    const pending = governor.acquire(request('b', { estimatedFeatures: 10 }))
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 1, featuresInFlight: 10 })
    first.release()
    const second = admitted(await pending)
    expect(governor.snapshot().featuresInFlight).toBe(10)
    second.release()
  })

  test('uses aggregate byte budget to delay otherwise concurrent work', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 4, maxEstimatedBytesInFlight: 1_500 })
    const first = admitted(await governor.acquire(request('a', { estimatedBytes: 1_000 })))
    const pending = governor.acquire(request('b', { estimatedBytes: 1_000 }))
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 1, estimatedBytesInFlight: 1_000 })
    first.release()
    const second = admitted(await pending)
    second.release()
  })

  test('rejects when queue capacity is exhausted', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1, maxQueued: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const pending = governor.acquire(request('queued'))
    await expect(governor.acquire(request('overflow'))).resolves.toEqual({ kind: 'rejected', code: 'queue-capacity' })
    blocker.release()
    admitted(await pending).release()
  })

  test('cancels a queued subscriber without affecting active work', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const controller = new AbortController()
    const pending = governor.acquire(request('queued'), controller.signal)
    controller.abort('navigation')
    await expect(pending).resolves.toEqual({ kind: 'rejected', code: 'aborted' })
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0 })
    blocker.release()
  })

  test('rejects an already aborted request without queueing', async () => {
    const governor = new ArcGisQueryBudgetGovernor()
    const controller = new AbortController()
    controller.abort()
    await expect(governor.acquire(request('a'), controller.signal)).resolves.toEqual({ kind: 'rejected', code: 'aborted' })
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  test('times queued work out and removes it from accounting', async () => {
    vi.useFakeTimers()
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1, queueTimeoutMs: 100 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const pending = governor.acquire(request('queued'))
    await vi.advanceTimersByTimeAsync(101)
    await expect(pending).resolves.toEqual({ kind: 'rejected', code: 'queue-timeout' })
    expect(governor.snapshot().queued).toBe(0)
    blocker.release()
  })

  test('dispose rejects queued work and prevents future admission', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 1 })
    const blocker = admitted(await governor.acquire(request('blocker')))
    const pending = governor.acquire(request('queued'))
    governor.dispose()
    await expect(pending).resolves.toEqual({ kind: 'rejected', code: 'disposed' })
    await expect(governor.acquire(request('later'))).resolves.toEqual({ kind: 'rejected', code: 'disposed' })
    expect(governor.snapshot().disposed).toBe(true)
    blocker.release()
  })

  test('release is idempotent and cannot underflow resource accounting', async () => {
    const governor = new ArcGisQueryBudgetGovernor()
    const lease = admitted(await governor.acquire(request('a')))
    lease.release(); lease.release(); lease.release()
    expect(governor.snapshot()).toMatchObject({ active: 0, featuresInFlight: 0, estimatedBytesInFlight: 0 })
  })

  test('reports immutable workload snapshots', async () => {
    const governor = new ArcGisQueryBudgetGovernor({ maxConcurrent: 2 })
    const a = admitted(await governor.acquire(request('a')))
    const b = admitted(await governor.acquire(request('b', { workload: 'background' })))
    const snapshot = governor.snapshot()
    expect(snapshot.activeByWorkload).toEqual({ interactive: 1, background: 1, prefetch: 0 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.activeByWorkload)).toBe(true)
    a.release(); b.release()
  })

  test.each([
    [{ maxConcurrent: 0 }, 'maxConcurrent'],
    [{ maxQueued: -1 }, 'maxQueued'],
    [{ maxFeaturesInFlight: Number.NaN }, 'maxFeaturesInFlight'],
    [{ queueTimeoutMs: 1.5 }, 'queueTimeoutMs'],
  ])('fails closed for invalid limits %j', (limits, name) => {
    expect(() => new ArcGisQueryBudgetGovernor(limits)).toThrow(name)
  })

  test.each([
    [request('   '), 'key'],
    [request('x', { estimatedFeatures: 0 }), 'feature'],
    [request('x', { estimatedBytes: -1 }), 'byte'],
    [request('x', { priority: 101 }), 'priority'],
  ])('fails closed for invalid request %#', async (input, message) => {
    const governor = new ArcGisQueryBudgetGovernor()
    await expect(governor.acquire(input as never)).rejects.toThrow(message)
  })
})
