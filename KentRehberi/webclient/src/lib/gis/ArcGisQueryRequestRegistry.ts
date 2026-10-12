import type { ArcGisQueryExecutionResult } from './ArcGisQueryExecutionCoordinator'
import { hasAsciiControl } from './ArcGisScalarValidation'

export interface ArcGisQueryRequestRegistryOptions {
  readonly maxEntries: number
  readonly successTtlMs: number
  /** Physical promises still occupy capacity after logical cancellation. */
  readonly maxPhysicalInFlight?: number
  readonly maxSubscribersPerQuery?: number
  readonly maxKeyLength?: number
  readonly maxCachedFeatures?: number
  readonly maxFeaturesPerEntry?: number
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
}

interface CachedEntry {
  readonly key: string
  readonly result: Extract<ArcGisQueryExecutionResult, { kind: 'completed' }>
  readonly features: number
  readonly expiresAt: number
  lastAccessSequence: number
}

type RegistryBudget = Required<ArcGisQueryRequestRegistryOptions>

const DEFAULTS: RegistryBudget = {
  maxEntries: 128,
  successTtlMs: 15_000,
  maxPhysicalInFlight: 8,
  maxSubscribersPerQuery: 64,
  maxKeyLength: 8_192,
  maxCachedFeatures: 100_000,
  maxFeaturesPerEntry: 25_000,
}

function boundedInteger(name: keyof RegistryBudget, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ArcGIS request registry ${name}`)
  }
  return value
}

function normalizeOptions(input: Partial<ArcGisQueryRequestRegistryOptions>): RegistryBudget {
  const options = { ...DEFAULTS, ...input }
  const normalized: RegistryBudget = {
    maxEntries: boundedInteger('maxEntries', options.maxEntries, 100_000),
    successTtlMs: boundedInteger('successTtlMs', options.successTtlMs, 86_400_000),
    maxPhysicalInFlight: boundedInteger('maxPhysicalInFlight', options.maxPhysicalInFlight, 10_000),
    maxSubscribersPerQuery: boundedInteger('maxSubscribersPerQuery', options.maxSubscribersPerQuery, 100_000),
    maxKeyLength: boundedInteger('maxKeyLength', options.maxKeyLength, 65_536),
    maxCachedFeatures: boundedInteger('maxCachedFeatures', options.maxCachedFeatures, 1_000_000),
    maxFeaturesPerEntry: boundedInteger('maxFeaturesPerEntry', options.maxFeaturesPerEntry, 1_000_000),
  }
  if (normalized.maxFeaturesPerEntry > normalized.maxCachedFeatures) {
    throw new Error('Invalid ArcGIS request registry maxFeaturesPerEntry')
  }
  return Object.freeze(normalized)
}

function abortedResult(): ArcGisQueryExecutionResult {
  return Object.freeze({ kind: 'failed', code: 'aborted' })
}

function capacityResult(): ArcGisQueryExecutionResult {
  return Object.freeze({ kind: 'failed', code: 'transport-capacity' })
}

/**
 * Single-flight request registry for the existing ArcGIS query executor.
 *
 * A physical transport is not freed by abandoning its logical wait. Aborted
 * transports which ignore their AbortSignal occupy physical capacity until
 * their actual promises settle. New callers never attach to cancelled work.
 * The registry stores only bounded metadata and successful bounded results;
 * it does not own or introduce a network endpoint, fetch carrier or SDK.
 */
export class ArcGisQueryRequestRegistry {
  readonly #options: RegistryBudget
  readonly #executor: ArcGisQueryRequestExecutor
  readonly #inFlight = new Map<string, InFlightEntry>()
  readonly #physical = new Set<InFlightEntry>()
  readonly #cache = new Map<string, CachedEntry>()
  #cachedFeatures = 0
  #subscriberId = 0
  #accessSequence = 0
  #observedNow = 0
  #disposed = false

  constructor(executor: ArcGisQueryRequestExecutor, options: Partial<ArcGisQueryRequestRegistryOptions> = {}) {
    this.#executor = executor
    this.#options = normalizeOptions(options)
  }

  get inFlightCount(): number {
    return this.#inFlight.size
  }

  /** Physical network reservations include cancelled but unsettled adapters. */
  get physicalInFlightCount(): number {
    return this.#physical.size
  }

  get cachedCount(): number {
    return this.#cache.size
  }

  get cachedFeatureCount(): number {
    return this.#cachedFeatures
  }

  snapshot(): Readonly<{ inFlight: number; physical: number; subscribers: number; cached: number; cachedFeatures: number; disposed: boolean }> {
    let subscribers = 0
    for (const entry of this.#inFlight.values()) subscribers += entry.subscribers.size
    return Object.freeze({
      inFlight: this.#inFlight.size,
      physical: this.#physical.size,
      subscribers,
      cached: this.#cache.size,
      cachedFeatures: this.#cachedFeatures,
      disposed: this.#disposed,
    })
  }

  request(key: string, signal?: AbortSignal): Promise<ArcGisQueryExecutionResult> {
    if (this.#disposed || signal?.aborted === true) return Promise.resolve(abortedResult())
    const normalizedKey = this.#key(key)
    if (normalizedKey === null) return Promise.resolve({ kind: 'failed', code: 'invalid-plan' })

    const now = this.#clock()
    this.#pruneExpired(now)
    const cached = this.#cache.get(normalizedKey)
    if (cached !== undefined) {
      cached.lastAccessSequence = ++this.#accessSequence
      return Promise.resolve(cached.result)
    }

    let entry = this.#inFlight.get(normalizedKey)
    if (entry !== undefined && entry.controller.signal.aborted) {
      // Never deliver a late response from an abandoned request to a new caller.
      this.#inFlight.delete(normalizedKey)
      entry = undefined
    }
    if (entry === undefined) {
      if (this.#physical.size >= this.#options.maxPhysicalInFlight) {
        return Promise.resolve(capacityResult())
      }
      entry = { key: normalizedKey, controller: new AbortController(), subscribers: new Map() }
      this.#inFlight.set(normalizedKey, entry)
      this.#physical.add(entry)
      // Register the initial subscriber before an executor can settle.
      const pending = this.#subscribe(entry, signal)
      void this.#run(entry)
      return pending
    }
    if (entry.subscribers.size >= this.#options.maxSubscribersPerQuery) {
      return Promise.resolve(capacityResult())
    }
    return this.#subscribe(entry, signal)
  }

  /** Invalidate both resident and active data of a changed ArcGIS query key. */
  invalidate(key: string): boolean {
    const normalizedKey = this.#key(key)
    if (normalizedKey === null || this.#disposed) return false
    const removed = this.#deleteCache(normalizedKey)
    const entry = this.#inFlight.get(normalizedKey)
    if (entry === undefined) return removed
    this.#abandon(entry)
    return true
  }

  /** Legacy cache-only clearing; active queries may still populate the cache. */
  clear(): void {
    this.#cache.clear()
    this.#cachedFeatures = 0
  }

  /** Revision or service invalidation: prevent all active results being cached. */
  invalidateAll(): void {
    this.clear()
    for (const entry of this.#inFlight.values()) this.#abandon(entry)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.invalidateAll()
  }

  #key(key: string): string | null {
    if (typeof key !== 'string' || hasAsciiControl(key) || key.length > this.#options.maxKeyLength) return null
    const normalized = key.trim()
    return normalized.length > 0 && normalized.length <= this.#options.maxKeyLength ? normalized : null
  }

  #clock(): number {
    // Clock rollback cannot resurrect an already-expired cached feature page.
    const now = Date.now()
    this.#observedNow = Math.max(this.#observedNow, now)
    return this.#observedNow
  }

  #subscribe(entry: InFlightEntry, signal?: AbortSignal): Promise<ArcGisQueryExecutionResult> {
    return new Promise((resolve) => {
      const id = ++this.#subscriberId
      const onAbort = signal === undefined ? undefined : (): void => {
        if (!entry.subscribers.delete(id)) return
        signal?.removeEventListener('abort', onAbort as () => void)
        resolve(abortedResult())
        if (entry.subscribers.size === 0) this.#abandon(entry)
      }
      const subscriber: Subscriber = { id, resolve, ...(signal === undefined ? {} : { signal, onAbort }) }
      entry.subscribers.set(id, subscriber)
      signal?.addEventListener('abort', onAbort as () => void, { once: true })
      // Handle cancellation between request()'s first check and subscription.
      if (signal?.aborted) onAbort?.()
    })
  }

  #abandon(entry: InFlightEntry): void {
    if (this.#inFlight.get(entry.key) === entry) this.#inFlight.delete(entry.key)
    entry.controller.abort()
    this.#settleSubscribers(entry, abortedResult())
    // #physical deliberately holds this lease until #run has really settled.
  }

  async #run(entry: InFlightEntry): Promise<void> {
    let result: ArcGisQueryExecutionResult
    try {
      result = await this.#executor({ key: entry.key, signal: entry.controller.signal })
    } catch {
      result = entry.controller.signal.aborted ? abortedResult() : { kind: 'failed', code: 'transport-error' }
    } finally {
      this.#physical.delete(entry)
    }
    if (this.#inFlight.get(entry.key) !== entry) return
    this.#inFlight.delete(entry.key)
    if (!this.#disposed && !entry.controller.signal.aborted) {
      try {
        const snapshot = this.#snapshotCompleted(result, entry.key)
        if (snapshot !== undefined) this.#store(entry.key, snapshot)
      } catch {
        // A malformed executor result must not reject #run and strand subscribers.
        // Do not reflect SDK exception text or attacker-controlled payloads.
        result = { kind: 'failed', code: 'integrity-error' }
      }
    }
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

  /**
   * Verify an injectable executor's success shape using own data descriptors.
   * Do not execute accessor properties while choosing objects for retention.
   * The canonical ArcGIS response inspector remains responsible for the
   * nested attribute and geometry validation of individual features.
   */
  #snapshotCompleted(
    raw: unknown,
    requestedKey: string,
  ): Extract<ArcGisQueryExecutionResult, { kind: 'completed' }> | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const own = (key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(raw, key)
      return property !== undefined && 'value' in property ? property.value : undefined
    }
    if (own('kind') !== 'completed' || own('key') !== requestedKey) return undefined
    const features = own('features')
    const ids = own('objectIds')
    const pagesCompleted = own('pagesCompleted')
    if (!Array.isArray(features) || !Array.isArray(ids) ||
        features.length !== ids.length ||
        features.length > this.#options.maxFeaturesPerEntry ||
        features.length > this.#options.maxCachedFeatures ||
        !Number.isSafeInteger(pagesCompleted) || (pagesCompleted as number) < 0) return undefined

    const featureCopy: unknown[] = []
    const idCopy: number[] = []
    const seen = new Set<number>()
    for (let index = 0; index < ids.length; index += 1) {
      const feature = Object.getOwnPropertyDescriptor(features, String(index))
      const identity = Object.getOwnPropertyDescriptor(ids, String(index))
      if (feature === undefined || !('value' in feature) ||
          identity === undefined || !('value' in identity) ||
          !Number.isSafeInteger(identity.value) || identity.value <= 0 ||
          seen.has(identity.value as number)) return undefined
      const id = identity.value as number
      seen.add(id)
      idCopy.push(id)
      featureCopy.push(feature.value)
    }
    return Object.freeze({
      kind: 'completed',
      key: requestedKey,
      pagesCompleted: pagesCompleted as number,
      objectIds: Object.freeze(idCopy),
      features: Object.freeze(featureCopy),
    })
  }

  #store(key: string, result: Extract<ArcGisQueryExecutionResult, { kind: 'completed' }>): void {
    const features = result.features.length
    const now = this.#clock()
    if (now > Number.MAX_SAFE_INTEGER - this.#options.successTtlMs) return
    this.#deleteCache(key)
    this.#cache.set(key, {
      key,
      result,
      features,
      expiresAt: now + this.#options.successTtlMs,
      lastAccessSequence: ++this.#accessSequence,
    })
    this.#cachedFeatures += features
    while (this.#cache.size > this.#options.maxEntries ||
           this.#cachedFeatures > this.#options.maxCachedFeatures) {
      let oldest: CachedEntry | undefined
      for (const candidate of this.#cache.values()) {
        if (oldest === undefined || candidate.lastAccessSequence < oldest.lastAccessSequence) oldest = candidate
      }
      if (oldest === undefined) break
      this.#deleteCache(oldest.key)
    }
  }

  #deleteCache(key: string): boolean {
    const entry = this.#cache.get(key)
    if (entry === undefined) return false
    this.#cache.delete(key)
    this.#cachedFeatures -= entry.features
    return true
  }

  #pruneExpired(now: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#deleteCache(key)
    }
  }
}
