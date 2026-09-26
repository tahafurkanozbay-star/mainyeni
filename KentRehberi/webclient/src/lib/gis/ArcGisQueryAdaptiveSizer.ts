export interface ArcGisQueryAdaptiveSizerOptions {
  readonly minPageSize: number
  readonly maxPageSize: number
  readonly targetLatencyMs: number
  readonly highLatencyMs: number
  readonly increaseStep: number
  readonly decreaseFactor: number
  readonly latencyAlpha: number
  readonly maxTrackedQueries: number
  readonly idleTtlMs: number
}

export interface ArcGisQueryPageObservation {
  readonly queryKey: string
  readonly requested: number
  readonly returned: number
  readonly latencyMs: number
  readonly exceededTransferLimit: boolean
  readonly outcome: 'success' | 'failure' | 'cancelled'
}

export interface ArcGisQueryAdaptiveSnapshot {
  readonly queryKey: string
  readonly pageSize: number
  readonly smoothedLatencyMs?: number
  readonly successfulPages: number
  readonly failedPages: number
  readonly lastTouchedAt: number
}

interface QueryRecord {
  readonly queryKey: string
  pageSize: number
  smoothedLatencyMs?: number
  successfulPages: number
  failedPages: number
  lastTouchedAt: number
}

const DEFAULT_OPTIONS: ArcGisQueryAdaptiveSizerOptions = Object.freeze({
  minPageSize: 100,
  maxPageSize: 2_000,
  targetLatencyMs: 600,
  highLatencyMs: 1_800,
  increaseStep: 100,
  decreaseFactor: 0.5,
  latencyAlpha: 0.25,
  maxTrackedQueries: 128,
  idleTtlMs: 10 * 60_000,
})

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS adaptive ${name} must be a positive integer`)
}

function normalizeKey(input: string): string {
  const key = input.trim()
  if (key.length === 0 || key.length > 512) throw new Error('ArcGIS adaptive query key must be non-empty and bounded')
  return key
}

function normalizeOptions(input: Partial<ArcGisQueryAdaptiveSizerOptions>): ArcGisQueryAdaptiveSizerOptions {
  const options = { ...DEFAULT_OPTIONS, ...input }
  positiveInteger(options.minPageSize, 'minPageSize')
  positiveInteger(options.maxPageSize, 'maxPageSize')
  positiveInteger(options.targetLatencyMs, 'targetLatencyMs')
  positiveInteger(options.highLatencyMs, 'highLatencyMs')
  positiveInteger(options.increaseStep, 'increaseStep')
  positiveInteger(options.maxTrackedQueries, 'maxTrackedQueries')
  positiveInteger(options.idleTtlMs, 'idleTtlMs')
  if (options.minPageSize > options.maxPageSize) throw new Error('ArcGIS adaptive minPageSize cannot exceed maxPageSize')
  if (options.targetLatencyMs >= options.highLatencyMs) throw new Error('ArcGIS adaptive targetLatencyMs must be below highLatencyMs')
  if (!Number.isFinite(options.decreaseFactor) || options.decreaseFactor <= 0 || options.decreaseFactor >= 1) {
    throw new Error('ArcGIS adaptive decreaseFactor must be between 0 and 1')
  }
  if (!Number.isFinite(options.latencyAlpha) || options.latencyAlpha <= 0 || options.latencyAlpha > 1) {
    throw new Error('ArcGIS adaptive latencyAlpha must be in (0, 1]')
  }
  return Object.freeze(options)
}

/**
 * Deterministic AIMD-like page sizing for ArcGIS REST queries. The caller owns
 * transport and service discovery; this class only learns from bounded local
 * observations and never exceeds verified planner/service limits.
 */
export class ArcGisQueryAdaptiveSizer {
  readonly #options: ArcGisQueryAdaptiveSizerOptions
  readonly #records = new Map<string, QueryRecord>()
  readonly #now: () => number

  constructor(options: Partial<ArcGisQueryAdaptiveSizerOptions> = {}, now: () => number = Date.now) {
    this.#options = normalizeOptions(options)
    this.#now = now
  }

  get size(): number {
    return this.#records.size
  }

  recommend(queryKeyInput: string, verifiedMaxRecordCount: number): number {
    const queryKey = normalizeKey(queryKeyInput)
    positiveInteger(verifiedMaxRecordCount, 'verifiedMaxRecordCount')
    const now = this.#now()
    this.#evictIdle(now)
    const ceiling = Math.min(this.#options.maxPageSize, verifiedMaxRecordCount)
    if (ceiling < this.#options.minPageSize) return ceiling
    let record = this.#records.get(queryKey)
    if (record === undefined) {
      this.#ensureCapacity()
      record = {
        queryKey,
        pageSize: Math.min(Math.max(this.#options.minPageSize, this.#options.increaseStep), ceiling),
        successfulPages: 0,
        failedPages: 0,
        lastTouchedAt: now,
      }
      this.#records.set(queryKey, record)
    }
    record.lastTouchedAt = now
    record.pageSize = Math.min(record.pageSize, ceiling)
    return record.pageSize
  }

  observe(input: ArcGisQueryPageObservation): void {
    const queryKey = normalizeKey(input.queryKey)
    positiveInteger(input.requested, 'requested')
    if (!Number.isSafeInteger(input.returned) || input.returned < 0 || input.returned > input.requested) {
      throw new Error('ArcGIS adaptive returned count must be between zero and requested')
    }
    if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) throw new Error('ArcGIS adaptive latency must be finite and non-negative')
    const record = this.#records.get(queryKey)
    if (record === undefined) return
    record.lastTouchedAt = this.#now()
    if (input.outcome === 'cancelled') return

    if (input.outcome === 'failure') {
      record.failedPages += 1
      this.#decrease(record)
      return
    }

    record.successfulPages += 1
    record.smoothedLatencyMs = record.smoothedLatencyMs === undefined
      ? input.latencyMs
      : this.#options.latencyAlpha * input.latencyMs + (1 - this.#options.latencyAlpha) * record.smoothedLatencyMs

    if (input.exceededTransferLimit || record.smoothedLatencyMs >= this.#options.highLatencyMs) {
      this.#decrease(record)
      return
    }

    const fullPage = input.returned >= Math.floor(input.requested * 0.9)
    if (fullPage && record.smoothedLatencyMs <= this.#options.targetLatencyMs) {
      record.pageSize = Math.min(this.#options.maxPageSize, record.pageSize + this.#options.increaseStep)
    }
  }

  snapshot(queryKeyInput: string): ArcGisQueryAdaptiveSnapshot | undefined {
    const queryKey = normalizeKey(queryKeyInput)
    const record = this.#records.get(queryKey)
    if (record === undefined) return undefined
    return Object.freeze({
      queryKey,
      pageSize: record.pageSize,
      ...(record.smoothedLatencyMs === undefined ? {} : { smoothedLatencyMs: record.smoothedLatencyMs }),
      successfulPages: record.successfulPages,
      failedPages: record.failedPages,
      lastTouchedAt: record.lastTouchedAt,
    })
  }

  reset(queryKeyInput: string): boolean {
    return this.#records.delete(normalizeKey(queryKeyInput))
  }

  clear(): void {
    this.#records.clear()
  }

  #decrease(record: QueryRecord): void {
    record.pageSize = Math.max(this.#options.minPageSize, Math.floor(record.pageSize * this.#options.decreaseFactor))
  }

  #evictIdle(now: number): void {
    for (const [key, record] of this.#records) {
      if (now - record.lastTouchedAt >= this.#options.idleTtlMs) this.#records.delete(key)
    }
  }

  #ensureCapacity(): void {
    if (this.#records.size < this.#options.maxTrackedQueries) return
    let oldest: QueryRecord | undefined
    for (const record of this.#records.values()) {
      if (oldest === undefined || record.lastTouchedAt < oldest.lastTouchedAt) oldest = record
    }
    if (oldest !== undefined) this.#records.delete(oldest.queryKey)
  }
}
