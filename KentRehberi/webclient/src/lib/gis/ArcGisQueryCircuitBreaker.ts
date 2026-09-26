export type ArcGisQueryCircuitState = 'closed' | 'open' | 'half-open'

export interface ArcGisQueryCircuitBreakerOptions {
  readonly failureThreshold: number
  readonly successThreshold: number
  readonly openDurationMs: number
  readonly halfOpenMaxConcurrent: number
  readonly maxTrackedServices: number
  readonly idleTtlMs: number
}

export interface ArcGisQueryCircuitPermit {
  readonly serviceKey: string
  readonly generation: number
  readonly state: ArcGisQueryCircuitState
  complete(outcome: 'success' | 'failure' | 'cancelled'): void
}

export interface ArcGisQueryCircuitSnapshot {
  readonly serviceKey: string
  readonly state: ArcGisQueryCircuitState
  readonly consecutiveFailures: number
  readonly consecutiveSuccesses: number
  readonly halfOpenInFlight: number
  readonly openedAt?: number
  readonly lastTouchedAt: number
}

export type ArcGisQueryCircuitAcquireResult =
  | { readonly kind: 'admitted'; readonly permit: ArcGisQueryCircuitPermit }
  | { readonly kind: 'rejected'; readonly code: 'open' | 'half-open-capacity' | 'disposed' }

interface CircuitRecord {
  readonly serviceKey: string
  state: ArcGisQueryCircuitState
  generation: number
  consecutiveFailures: number
  consecutiveSuccesses: number
  halfOpenInFlight: number
  openedAt?: number
  lastTouchedAt: number
}

const DEFAULT_OPTIONS: ArcGisQueryCircuitBreakerOptions = Object.freeze({
  failureThreshold: 4,
  successThreshold: 2,
  openDurationMs: 15_000,
  halfOpenMaxConcurrent: 1,
  maxTrackedServices: 128,
  idleTtlMs: 10 * 60_000,
})

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS circuit ${name} must be a positive integer`)
  return value
}

function normalizeServiceKey(value: string): string {
  const key = value.trim()
  if (key.length === 0 || key.length > 512) throw new Error('ArcGIS circuit service key must be non-empty and bounded')
  return key
}

function normalizeOptions(input: Partial<ArcGisQueryCircuitBreakerOptions>): ArcGisQueryCircuitBreakerOptions {
  const options = { ...DEFAULT_OPTIONS, ...input }
  positiveInteger(options.failureThreshold, 'failureThreshold')
  positiveInteger(options.successThreshold, 'successThreshold')
  positiveInteger(options.openDurationMs, 'openDurationMs')
  positiveInteger(options.halfOpenMaxConcurrent, 'halfOpenMaxConcurrent')
  positiveInteger(options.maxTrackedServices, 'maxTrackedServices')
  positiveInteger(options.idleTtlMs, 'idleTtlMs')
  return Object.freeze(options)
}

/**
 * Bounded per-service circuit breaker for injected ArcGIS query transports.
 * It deliberately knows nothing about URLs or fetch: callers provide a stable,
 * verified service identity and report only transport/server outcomes.
 */
export class ArcGisQueryCircuitBreaker {
  readonly #options: ArcGisQueryCircuitBreakerOptions
  readonly #records = new Map<string, CircuitRecord>()
  readonly #now: () => number
  #disposed = false

  constructor(options: Partial<ArcGisQueryCircuitBreakerOptions> = {}, now: () => number = Date.now) {
    this.#options = normalizeOptions(options)
    this.#now = now
  }

  get size(): number {
    return this.#records.size
  }

  acquire(serviceKeyInput: string): ArcGisQueryCircuitAcquireResult {
    if (this.#disposed) return { kind: 'rejected', code: 'disposed' }
    const serviceKey = normalizeServiceKey(serviceKeyInput)
    const now = this.#now()
    this.#evictIdle(now)
    let record = this.#records.get(serviceKey)
    if (record === undefined) {
      this.#ensureCapacity(now)
      record = {
        serviceKey,
        state: 'closed',
        generation: 1,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        halfOpenInFlight: 0,
        lastTouchedAt: now,
      }
      this.#records.set(serviceKey, record)
    }

    record.lastTouchedAt = now
    if (record.state === 'open') {
      if (record.openedAt === undefined || now - record.openedAt < this.#options.openDurationMs) {
        return { kind: 'rejected', code: 'open' }
      }
      record.state = 'half-open'
      record.generation += 1
      record.consecutiveFailures = 0
      record.consecutiveSuccesses = 0
      record.halfOpenInFlight = 0
      delete record.openedAt
    }

    if (record.state === 'half-open' && record.halfOpenInFlight >= this.#options.halfOpenMaxConcurrent) {
      return { kind: 'rejected', code: 'half-open-capacity' }
    }
    if (record.state === 'half-open') record.halfOpenInFlight += 1

    const generation = record.generation
    const admittedState = record.state
    let completed = false
    const permit: ArcGisQueryCircuitPermit = Object.freeze({
      serviceKey,
      generation,
      state: admittedState,
      complete: (outcome): void => {
        if (completed) return
        completed = true
        this.#complete(serviceKey, generation, admittedState, outcome)
      },
    })
    return { kind: 'admitted', permit }
  }

  snapshot(serviceKeyInput: string): ArcGisQueryCircuitSnapshot | undefined {
    const serviceKey = normalizeServiceKey(serviceKeyInput)
    const record = this.#records.get(serviceKey)
    if (record === undefined) return undefined
    return Object.freeze({
      serviceKey: record.serviceKey,
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      consecutiveSuccesses: record.consecutiveSuccesses,
      halfOpenInFlight: record.halfOpenInFlight,
      ...(record.openedAt === undefined ? {} : { openedAt: record.openedAt }),
      lastTouchedAt: record.lastTouchedAt,
    })
  }

  reset(serviceKeyInput: string): boolean {
    return this.#records.delete(normalizeServiceKey(serviceKeyInput))
  }

  clear(): void {
    this.#records.clear()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#records.clear()
  }

  #complete(
    serviceKey: string,
    generation: number,
    admittedState: ArcGisQueryCircuitState,
    outcome: 'success' | 'failure' | 'cancelled',
  ): void {
    if (this.#disposed) return
    const record = this.#records.get(serviceKey)
    if (record === undefined || record.generation !== generation) return
    record.lastTouchedAt = this.#now()
    if (admittedState === 'half-open') record.halfOpenInFlight = Math.max(0, record.halfOpenInFlight - 1)
    if (outcome === 'cancelled') return

    if (record.state === 'closed') {
      if (outcome === 'success') {
        record.consecutiveFailures = 0
        return
      }
      record.consecutiveFailures += 1
      if (record.consecutiveFailures >= this.#options.failureThreshold) this.#open(record)
      return
    }

    if (record.state !== 'half-open') return
    if (outcome === 'failure') {
      this.#open(record)
      return
    }
    record.consecutiveSuccesses += 1
    if (record.consecutiveSuccesses >= this.#options.successThreshold) {
      record.state = 'closed'
      record.generation += 1
      record.consecutiveFailures = 0
      record.consecutiveSuccesses = 0
      record.halfOpenInFlight = 0
      delete record.openedAt
    }
  }

  #open(record: CircuitRecord): void {
    record.state = 'open'
    record.generation += 1
    record.openedAt = this.#now()
    record.consecutiveSuccesses = 0
    record.halfOpenInFlight = 0
  }

  #evictIdle(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.state !== 'closed') continue
      if (now - record.lastTouchedAt >= this.#options.idleTtlMs) this.#records.delete(key)
    }
  }

  #ensureCapacity(now: number): void {
    if (this.#records.size < this.#options.maxTrackedServices) return
    let candidate: CircuitRecord | undefined
    for (const record of this.#records.values()) {
      if (record.state !== 'closed') continue
      if (candidate === undefined || record.lastTouchedAt < candidate.lastTouchedAt) candidate = record
    }
    if (candidate !== undefined) {
      this.#records.delete(candidate.serviceKey)
      return
    }
    // Open/half-open circuits carry active protection and are never evicted to
    // admit a new identity. Fail closed rather than silently dropping state.
    throw new Error(`ArcGIS circuit registry capacity exhausted at ${now}`)
  }
}
