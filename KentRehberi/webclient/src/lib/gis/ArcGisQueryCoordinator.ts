export interface ArcGisQueryKey {
  readonly serviceId: string
  readonly layerId: number
  readonly where: string
  readonly geometryFingerprint?: string
  readonly outFields: readonly string[]
  readonly returnGeometry: boolean
  readonly resultOffset?: number
  readonly resultRecordCount?: number
}

export interface ArcGisQueryBudget {
  readonly maxEntries: number
  readonly maxInflight: number
  readonly maxWaitersPerQuery: number
  readonly maxCacheAgeMs: number
  readonly maxCachedBytes: number
  readonly maxResponseBytes: number
  readonly maxWhereLength: number
  readonly maxOutFields: number
}

export interface ArcGisQueryResponse<T> {
  readonly value: T
  readonly estimatedBytes: number
  readonly datasetRevision?: string
}

export interface ArcGisQueryContext {
  readonly signal: AbortSignal
  readonly key: ArcGisQueryKey
}

export type ArcGisQueryExecutor<T> = (context: ArcGisQueryContext) => Promise<ArcGisQueryResponse<T>>

interface CacheEntry<T> {
  readonly response: ArcGisQueryResponse<T>
  readonly storedAt: number
  lastAccess: number
}

interface Flight<T> {
  readonly controller: AbortController
  readonly promise: Promise<ArcGisQueryResponse<T>>
  waiters: number
  settled: boolean
}

export interface ArcGisQueryDiagnostics {
  readonly cacheEntries: number
  readonly cachedBytes: number
  readonly inflight: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly dedupedWaiters: number
  readonly evictions: number
}

const MAX_SAFE_BYTES = 256 * 1024 * 1024
const MAX_SAFE_ENTRIES = 10_000

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function normalizedText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid ${name}`)
  return normalized
}

function normalizeKey(key: ArcGisQueryKey, budget: ArcGisQueryBudget): ArcGisQueryKey {
  const serviceId = normalizedText(key.serviceId, 'serviceId', 256)
  const where = normalizedText(key.where, 'where', budget.maxWhereLength)
  integer(key.layerId, 'layerId', 0, 100_000)
  if (key.outFields.length > budget.maxOutFields) throw new Error('outFields budget exceeded')
  const outFields = [...new Set(key.outFields.map(field => normalizedText(field, 'outField', 128)))].sort()
  const geometryFingerprint = key.geometryFingerprint === undefined ? undefined : normalizedText(key.geometryFingerprint, 'geometryFingerprint', 512)
  const resultOffset = key.resultOffset === undefined ? undefined : integer(key.resultOffset, 'resultOffset', 0, Number.MAX_SAFE_INTEGER)
  const resultRecordCount = key.resultRecordCount === undefined ? undefined : integer(key.resultRecordCount, 'resultRecordCount', 1, 100_000)
  return Object.freeze({ serviceId, layerId: key.layerId, where, geometryFingerprint, outFields: Object.freeze(outFields), returnGeometry: key.returnGeometry, resultOffset, resultRecordCount })
}

function fingerprint(key: ArcGisQueryKey): string {
  return JSON.stringify([key.serviceId, key.layerId, key.where, key.geometryFingerprint ?? '', key.outFields, key.returnGeometry, key.resultOffset ?? 0, key.resultRecordCount ?? 0])
}

function abortError(): Error {
  const error = new Error('ArcGIS query aborted')
  error.name = 'AbortError'
  return error
}

export class ArcGisQueryCoordinator<T> {
  private readonly budget: ArcGisQueryBudget
  private readonly executor: ArcGisQueryExecutor<T>
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry<T>>()
  private readonly flights = new Map<string, Flight<T>>()
  private cachedBytes = 0
  private hits = 0
  private misses = 0
  private deduped = 0
  private evictions = 0

  constructor(executor: ArcGisQueryExecutor<T>, budget: ArcGisQueryBudget, now: () => number = Date.now) {
    this.executor = executor
    this.now = now
    this.budget = Object.freeze({
      maxEntries: integer(budget.maxEntries, 'maxEntries', 1, MAX_SAFE_ENTRIES),
      maxInflight: integer(budget.maxInflight, 'maxInflight', 1, 1_000),
      maxWaitersPerQuery: integer(budget.maxWaitersPerQuery, 'maxWaitersPerQuery', 1, 10_000),
      maxCacheAgeMs: integer(budget.maxCacheAgeMs, 'maxCacheAgeMs', 0, 86_400_000),
      maxCachedBytes: integer(budget.maxCachedBytes, 'maxCachedBytes', 1, MAX_SAFE_BYTES),
      maxResponseBytes: integer(budget.maxResponseBytes, 'maxResponseBytes', 1, MAX_SAFE_BYTES),
      maxWhereLength: integer(budget.maxWhereLength, 'maxWhereLength', 1, 32_768),
      maxOutFields: integer(budget.maxOutFields, 'maxOutFields', 1, 1_000),
    })
  }

  diagnostics(): ArcGisQueryDiagnostics {
    return Object.freeze({ cacheEntries: this.cache.size, cachedBytes: this.cachedBytes, inflight: this.flights.size, cacheHits: this.hits, cacheMisses: this.misses, dedupedWaiters: this.deduped, evictions: this.evictions })
  }

  invalidateAll(): void {
    this.cache.clear()
    this.cachedBytes = 0
  }

  invalidateService(serviceId: string): number {
    const normalized = normalizedText(serviceId, 'serviceId', 256)
    let removed = 0
    for (const [key, entry] of this.cache) {
      if (JSON.parse(key)[0] !== normalized) continue
      this.cache.delete(key); this.cachedBytes -= entry.response.estimatedBytes; removed++
    }
    return removed
  }

  async query(key: ArcGisQueryKey, signal?: AbortSignal): Promise<ArcGisQueryResponse<T>> {
    if (signal?.aborted) throw abortError()
    const normalized = normalizeKey(key, this.budget)
    const id = fingerprint(normalized)
    const cached = this.readCache(id)
    if (cached) { this.hits++; return cached }
    this.misses++
    let flight = this.flights.get(id)
    if (flight) {
      if (flight.waiters >= this.budget.maxWaitersPerQuery) throw new Error('ArcGIS query waiter budget exceeded')
      flight.waiters++; this.deduped++
    } else {
      if (this.flights.size >= this.budget.maxInflight) throw new Error('ArcGIS query inflight budget exceeded')
      flight = this.startFlight(id, normalized)
      this.flights.set(id, flight)
    }
    return this.waitForFlight(id, flight, signal)
  }

  private startFlight(id: string, key: ArcGisQueryKey): Flight<T> {
    const controller = new AbortController()
    const flight: Flight<T> = { controller, waiters: 1, settled: false, promise: Promise.resolve(undefined as never) }
    const promise = this.executor({ signal: controller.signal, key }).then(response => {
      integer(response.estimatedBytes, 'estimatedBytes', 0, this.budget.maxResponseBytes)
      this.storeCache(id, response)
      return response
    }).finally(() => { flight.settled = true; if (flight.waiters === 0) this.flights.delete(id) })
    ;(flight as { promise: Promise<ArcGisQueryResponse<T>> }).promise = promise
    return flight
  }

  private waitForFlight(id: string, flight: Flight<T>, signal?: AbortSignal): Promise<ArcGisQueryResponse<T>> {
    return new Promise((resolve, reject) => {
      let done = false
      const release = () => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); flight.waiters--; if (flight.waiters === 0) { if (!flight.settled) flight.controller.abort(); else this.flights.delete(id) } }
      const onAbort = () => { release(); reject(abortError()) }
      signal?.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(value => { if (!done) { release(); resolve(value) } }, error => { if (!done) { release(); reject(error) } })
    })
  }

  private readCache(id: string): ArcGisQueryResponse<T> | undefined {
    const entry = this.cache.get(id)
    if (!entry) return undefined
    const now = this.now()
    if (now < entry.storedAt || now - entry.storedAt > this.budget.maxCacheAgeMs) { this.cache.delete(id); this.cachedBytes -= entry.response.estimatedBytes; return undefined }
    entry.lastAccess = now
    return entry.response
  }

  private storeCache(id: string, response: ArcGisQueryResponse<T>): void {
    if (response.estimatedBytes > this.budget.maxCachedBytes) return
    const previous = this.cache.get(id)
    if (previous) this.cachedBytes -= previous.response.estimatedBytes
    const now = this.now(); this.cache.set(id, { response, storedAt: now, lastAccess: now }); this.cachedBytes += response.estimatedBytes
    while (this.cache.size > this.budget.maxEntries || this.cachedBytes > this.budget.maxCachedBytes) this.evictOldest()
  }

  private evictOldest(): void {
    let oldestKey: string | undefined; let oldestAccess = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.cache) if (entry.lastAccess < oldestAccess) { oldestKey = key; oldestAccess = entry.lastAccess }
    if (!oldestKey) return
    const entry = this.cache.get(oldestKey); if (!entry) return
    this.cache.delete(oldestKey); this.cachedBytes -= entry.response.estimatedBytes; this.evictions++
  }
}
