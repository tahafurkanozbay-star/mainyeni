import type { ArcGisQueryExecutionResult } from './ArcGisQueryExecutionCoordinator'

export interface ArcGisQueryRequestRegistryOptions {
  readonly maxEntries: number
  readonly successTtlMs: number
}

export interface ArcGisQueryRequestContext {
  readonly key: string
  readonly signal: AbortSignal
}

export type ArcGisQueryRequestExecutor = (context: ArcGisQueryRequestContext) => Promise<ArcGisQueryExecutionResult>

interface Subscriber {
  readonly id: number
  readonly resolve: (result: ArcGisQueryExecutionResult) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

interface InFlightEntry {
  readonly key: string
  readonly controller: AbortController
  readonly subscribers: Map<number, Subscriber>
  startedAt: number
}

interface CachedEntry {
  readonly key: string
  readonly result: ArcGisQueryExecutionResult
  readonly expiresAt: number
  lastAccessedAt: number
}

const DEFAULTS: ArcGisQueryRequestRegistryOptions = {
  maxEntries: 128,
  successTtlMs: 15_000,
}

function normalizeOptions(input: Partial<ArcGisQueryRequestRegistryOptions>): ArcGisQueryRequestRegistryOptions {
  const options = { ...DEFAULTS, ...input }
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) throw new Error('Invalid ArcGIS request registry maxEntries')
  if (!Number.isSafeInteger(options.successTtlMs) || options.successTtlMs <= 0) throw new Error('Invalid ArcGIS request registry successTtlMs')
  return Object.freeze(options)
}

function abortedResult(): ArcGisQueryExecutionResult {
  return { kind: 'failed', code: 'aborted' }
}

/**
 * Bounded single-flight registry for ArcGIS query plans.
 *
 * The registry deliberately owns no network transport. Callers inject an executor,
 * keeping same-origin/service governance outside this cache. Concurrent callers for
 * the same stable plan key share one execution while retaining independent
 * cancellation. The underlying request is aborted only after its last subscriber
 * leaves. Only successful results are cached, so transient failures cannot poison a
 * later request. Cache capacity and TTL are hard bounded.
 */
export class ArcGisQueryRequestRegistry {
  readonly #options: ArcGisQueryRequestRegistryOptions
  readonly #executor: ArcGisQueryRequestExecutor
  readonly #inFlight = new Map<string, InFlightEntry>()
  readonly #cache = new Map<string, CachedEntry>()
  #subscriberId = 0

  constructor(executor: ArcGisQueryRequestExecutor, options: Partial<ArcGisQueryRequestRegistryOptions> = {}) {
    this.#executor = executor
    this.#options = normalizeOptions(options)
  }

  get inFlightCount(): number {
    return this.#inFlight.size
  }

  get cachedCount(): number {
    return this.#cache.size
  }

  request(key: string, signal?: AbortSignal): Promise<ArcGisQueryExecutionResult> {
    const normalizedKey = key.trim()
    if (normalizedKey.length === 0) return Promise.resolve({ kind: 'failed', code: 'invalid-plan' })
    if (signal?.aborted === true) return Promise.resolve(abortedResult())

    const now = Date.now()
    this.#pruneExpired(now)
    const cached = this.#cache.get(normalizedKey)
    if (cached !== undefined) {
      cached.lastAccessedAt = now
      return Promise.resolve(cached.result)
    }

    let entry = this.#inFlight.get(normalizedKey)
    if (entry === undefined) {
      entry = {
        key: normalizedKey,
        controller: new AbortController(),
        subscribers: new Map(),
        startedAt: now,
      }
      this.#inFlight.set(normalizedKey, entry)
      void this.#run(entry)
    }
    return this.#subscribe(entry, signal)
  }

  invalidate(key: string): boolean {
    return this.#cache.delete(key.trim())
  }

  clear(): void {
    this.#cache.clear()
  }

  dispose(): void {
    this.#cache.clear()
    for (const entry of this.#inFlight.values()) {
      entry.controller.abort(new Error('ArcGIS request registry disposed'))
      this.#settleSubscribers(entry, abortedResult())
    }
    this.#inFlight.clear()
  }

  #subscribe(entry: InFlightEntry, signal?: AbortSignal): Promise<ArcGisQueryExecutionResult> {
    return new Promise((resolve) => {
      const id = ++this.#subscriberId
      const onAbort = signal === undefined ? undefined : (): void => {
        const current = entry.subscribers.get(id)
        if (current === undefined) return
        entry.subscribers.delete(id)
        signal.removeEventListener('abort', onAbort)
        resolve(abortedResult())
        if (entry.subscribers.size === 0) entry.controller.abort(signal.reason)
      }
      const subscriber: Subscriber = { id, resolve, ...(signal === undefined ? {} : { signal, onAbort }) }
      entry.subscribers.set(id, subscriber)
      signal?.addEventListener('abort', onAbort as () => void, { once: true })
    })
  }

  async #run(entry: InFlightEntry): Promise<void> {
    let result: ArcGisQueryExecutionResult
    try {
      result = await this.#executor({ key: entry.key, signal: entry.controller.signal })
    } catch {
      result = entry.controller.signal.aborted ? abortedResult() : { kind: 'failed', code: 'transport-error' }
    }

    if (this.#inFlight.get(entry.key) !== entry) return
    this.#inFlight.delete(entry.key)
    if (result.kind === 'completed' && !entry.controller.signal.aborted) this.#store(entry.key, result)
    this.#settleSubscribers(entry, result)
  }

  #settleSubscribers(entry: InFlightEntry, result: ArcGisQueryExecutionResult): void {
    for (const subscriber of entry.subscribers.values()) {
      if (subscriber.signal !== undefined && subscriber.onAbort !== undefined) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort)
      }
      subscriber.resolve(result)
    }
    entry.subscribers.clear()
  }

  #store(key: string, result: ArcGisQueryExecutionResult): void {
    const now = Date.now()
    this.#cache.set(key, { key, result, expiresAt: now + this.#options.successTtlMs, lastAccessedAt: now })
    while (this.#cache.size > this.#options.maxEntries) {
      let oldest: CachedEntry | undefined
      for (const candidate of this.#cache.values()) {
        if (oldest === undefined || candidate.lastAccessedAt < oldest.lastAccessedAt) oldest = candidate
      }
      if (oldest === undefined) break
      this.#cache.delete(oldest.key)
    }
  }

  #pruneExpired(now: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#cache.delete(key)
    }
  }
}
