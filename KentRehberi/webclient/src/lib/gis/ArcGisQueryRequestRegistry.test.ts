import { describe, expect, it, vi } from 'vitest'
import type { ArcGisQueryExecutionResult } from './ArcGisQueryExecutionCoordinator'
import { ArcGisQueryRequestRegistry } from './ArcGisQueryRequestRegistry'

function success(key: string, objectId = 1): ArcGisQueryExecutionResult {
  return Object.freeze({
    kind: 'completed',
    key,
    features: Object.freeze([{ attributes: { OBJECTID: objectId } }]),
    objectIds: Object.freeze([objectId]),
    pagesCompleted: 1,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ArcGisQueryRequestRegistry', () => {
  it('rejects invalid capacity and TTL options', () => {
    const executor = vi.fn(async () => success('x'))
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxEntries: 0 })).toThrow(/maxEntries/)
    expect(() => new ArcGisQueryRequestRegistry(executor, { successTtlMs: 0 })).toThrow(/successTtlMs/)
  })

  it('fails closed for blank keys without invoking transport', async () => {
    const executor = vi.fn(async () => success('x'))
    const registry = new ArcGisQueryRequestRegistry(executor)
    await expect(registry.request('   ')).resolves.toEqual({ kind: 'failed', code: 'invalid-plan' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent requests by stable key', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => gate.promise)
    const registry = new ArcGisQueryRequestRegistry(executor)
    const first = registry.request('plan:a')
    const second = registry.request('plan:a')
    expect(registry.inFlightCount).toBe(1)
    expect(executor).toHaveBeenCalledTimes(1)
    gate.resolve(success('plan:a'))
    await expect(first).resolves.toEqual(success('plan:a'))
    await expect(second).resolves.toEqual(success('plan:a'))
    expect(registry.inFlightCount).toBe(0)
  })

  it('serves successful results from the bounded cache', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => success(key))
    const registry = new ArcGisQueryRequestRegistry(executor)
    await registry.request('plan:a')
    await registry.request('plan:a')
    expect(executor).toHaveBeenCalledTimes(1)
    expect(registry.cachedCount).toBe(1)
  })

  it('does not cache failed executions', async () => {
    const executor = vi.fn(async (): Promise<ArcGisQueryExecutionResult> => ({ kind: 'failed', code: 'transport-error' }))
    const registry = new ArcGisQueryRequestRegistry(executor)
    await registry.request('plan:a')
    await registry.request('plan:a')
    expect(executor).toHaveBeenCalledTimes(2)
    expect(registry.cachedCount).toBe(0)
  })

  it('allows one subscriber to cancel without aborting shared work', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    let executionSignal: AbortSignal | undefined
    const executor = vi.fn(({ signal }: { signal: AbortSignal }) => {
      executionSignal = signal
      return gate.promise
    })
    const registry = new ArcGisQueryRequestRegistry(executor)
    const caller = new AbortController()
    const first = registry.request('plan:a', caller.signal)
    const second = registry.request('plan:a')
    caller.abort()
    await expect(first).resolves.toEqual({ kind: 'failed', code: 'aborted' })
    expect(executionSignal?.aborted).toBe(false)
    gate.resolve(success('plan:a'))
    await expect(second).resolves.toEqual(success('plan:a'))
  })

  it('aborts shared work when its final subscriber cancels', async () => {
    const executor = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<ArcGisQueryExecutionResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ kind: 'failed', code: 'aborted' }), { once: true })
    }))
    const registry = new ArcGisQueryRequestRegistry(executor)
    const caller = new AbortController()
    const result = registry.request('plan:a', caller.signal)
    caller.abort()
    await expect(result).resolves.toEqual({ kind: 'failed', code: 'aborted' })
  })

  it('returns aborted immediately for an already cancelled caller', async () => {
    const executor = vi.fn(async () => success('x'))
    const registry = new ArcGisQueryRequestRegistry(executor)
    const caller = new AbortController()
    caller.abort()
    await expect(registry.request('plan:a', caller.signal)).resolves.toEqual({ kind: 'failed', code: 'aborted' })
    expect(executor).not.toHaveBeenCalled()
  })

  it('evicts least recently used cache entries at capacity', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => success(key))
    const registry = new ArcGisQueryRequestRegistry(executor, { maxEntries: 2 })
    await registry.request('a')
    await registry.request('b')
    await registry.request('a')
    await registry.request('c')
    expect(registry.cachedCount).toBe(2)
    await registry.request('b')
    expect(executor).toHaveBeenCalledTimes(4)
  })

  it('supports explicit invalidation without affecting unrelated entries', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => success(key))
    const registry = new ArcGisQueryRequestRegistry(executor)
    await registry.request('a')
    await registry.request('b')
    expect(registry.invalidate('a')).toBe(true)
    expect(registry.invalidate('missing')).toBe(false)
    await registry.request('a')
    await registry.request('b')
    expect(executor).toHaveBeenCalledTimes(3)
  })

  it('clears cached values without cancelling active work', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => gate.promise)
    const registry = new ArcGisQueryRequestRegistry(executor)
    const pending = registry.request('a')
    registry.clear()
    expect(registry.inFlightCount).toBe(1)
    gate.resolve(success('a'))
    await pending
    expect(registry.cachedCount).toBe(1)
  })

  it('disposes active work and settles subscribers as aborted', async () => {
    const executor = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<ArcGisQueryExecutionResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ kind: 'failed', code: 'aborted' }), { once: true })
    }))
    const registry = new ArcGisQueryRequestRegistry(executor)
    const pending = registry.request('a')
    registry.dispose()
    await expect(pending).resolves.toEqual({ kind: 'failed', code: 'aborted' })
    expect(registry.inFlightCount).toBe(0)
    expect(registry.cachedCount).toBe(0)
  })

  it('converts executor rejection to a transport failure', async () => {
    const executor = vi.fn(async () => { throw new Error('network') })
    const registry = new ArcGisQueryRequestRegistry(executor)
    await expect(registry.request('a')).resolves.toEqual({ kind: 'failed', code: 'transport-error' })
    expect(registry.cachedCount).toBe(0)
  })
})
