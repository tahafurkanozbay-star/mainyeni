export type ArcGisServiceHealthState = 'healthy' | 'degraded' | 'unavailable'
export type ArcGisHealthOutcome = 'success' | 'failure' | 'timeout' | 'cancelled'

export interface ArcGisServiceHealthRegistryOptions {
  readonly maxServices: number
  readonly idleTtlMs: number
  readonly sampleWindow: number
  readonly degradedFailureRatio: number
  readonly unavailableFailureRatio: number
  readonly minimumSamples: number
  readonly recoverySuccesses: number
  readonly slowLatencyMs: number
  readonly latencyAlpha: number
}

export interface ArcGisHealthObservation {
  readonly serviceKey: string
  readonly outcome: ArcGisHealthOutcome
  readonly latencyMs: number
  readonly at?: number
}

export interface ArcGisServiceHealthSnapshot {
  readonly serviceKey: string
  readonly state: ArcGisServiceHealthState
  readonly samples: number
  readonly successes: number
  readonly failures: number
  readonly timeouts: number
  readonly cancellations: number
  readonly consecutiveSuccesses: number
  readonly consecutiveFailures: number
  readonly failureRatio: number
  readonly smoothedLatencyMs?: number
  readonly lastObservedAt: number
  readonly revision: number
}

interface Sample {
  readonly failed: boolean
  readonly timeout: boolean
}

interface HealthRecord {
  readonly serviceKey: string
  readonly samples: Sample[]
  state: ArcGisServiceHealthState
  successes: number
  failures: number
  timeouts: number
  cancellations: number
  consecutiveSuccesses: number
  consecutiveFailures: number
  smoothedLatencyMs?: number
  lastObservedAt: number
  revision: number
}

const DEFAULTS: ArcGisServiceHealthRegistryOptions = Object.freeze({
  maxServices: 128,
  idleTtlMs: 15 * 60_000,
  sampleWindow: 20,
  degradedFailureRatio: 0.25,
  unavailableFailureRatio: 0.6,
  minimumSamples: 4,
  recoverySuccesses: 3,
  slowLatencyMs: 2_500,
  latencyAlpha: 0.2,
})

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS health ${name} must be a positive integer`)
}

function ratio(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`ArcGIS health ${name} must be between zero and one`)
}

function normalizeServiceKey(value: string): string {
  const key = value.trim()
  if (key.length === 0 || key.length > 512) throw new Error('ArcGIS health service key must contain 1..512 characters')
  return key
}

function finiteLatency(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('ArcGIS health latency must be finite and non-negative')
}

export class ArcGisQueryHealthRegistry {
  private readonly options: ArcGisServiceHealthRegistryOptions
  private readonly records = new Map<string, HealthRecord>()
  private disposed = false

  constructor(options: Partial<ArcGisServiceHealthRegistryOptions> = {}, private readonly now: () => number = Date.now) {
    this.options = Object.freeze({ ...DEFAULTS, ...options })
    positiveInteger(this.options.maxServices, 'maxServices')
    positiveInteger(this.options.idleTtlMs, 'idleTtlMs')
    positiveInteger(this.options.sampleWindow, 'sampleWindow')
    positiveInteger(this.options.minimumSamples, 'minimumSamples')
    positiveInteger(this.options.recoverySuccesses, 'recoverySuccesses')
    positiveInteger(this.options.slowLatencyMs, 'slowLatencyMs')
    ratio(this.options.degradedFailureRatio, 'degradedFailureRatio')
    ratio(this.options.unavailableFailureRatio, 'unavailableFailureRatio')
    ratio(this.options.latencyAlpha, 'latencyAlpha')
    if (this.options.degradedFailureRatio >= this.options.unavailableFailureRatio) {
      throw new Error('ArcGIS health degradedFailureRatio must be lower than unavailableFailureRatio')
    }
    if (this.options.minimumSamples > this.options.sampleWindow) {
      throw new Error('ArcGIS health minimumSamples cannot exceed sampleWindow')
    }
  }

  get size(): number { return this.records.size }

  observe(input: ArcGisHealthObservation): ArcGisServiceHealthSnapshot {
    this.assertActive()
    const key = normalizeServiceKey(input.serviceKey)
    finiteLatency(input.latencyMs)
    const at = input.at ?? this.now()
    if (!Number.isFinite(at) || at < 0) throw new Error('ArcGIS health observation time must be finite and non-negative')
    this.prune(at)
    const record = this.getOrCreate(key, at)
    if (at < record.lastObservedAt) throw new Error('ArcGIS health observations must be monotonic per service')
    record.lastObservedAt = at
    record.revision += 1

    if (input.outcome === 'cancelled') {
      record.cancellations += 1
      return this.toSnapshot(record)
    }

    const failed = input.outcome === 'failure' || input.outcome === 'timeout'
    record.samples.push({ failed, timeout: input.outcome === 'timeout' })
    if (record.samples.length > this.options.sampleWindow) record.samples.shift()

    if (failed) {
      record.failures += 1
      if (input.outcome === 'timeout') record.timeouts += 1
      record.consecutiveFailures += 1
      record.consecutiveSuccesses = 0
    } else {
      record.successes += 1
      record.consecutiveSuccesses += 1
      record.consecutiveFailures = 0
      record.smoothedLatencyMs = record.smoothedLatencyMs === undefined
        ? input.latencyMs
        : this.options.latencyAlpha * input.latencyMs + (1 - this.options.latencyAlpha) * record.smoothedLatencyMs
    }

    record.state = this.evaluate(record)
    return this.toSnapshot(record)
  }

  snapshot(serviceKey: string): ArcGisServiceHealthSnapshot | undefined {
    this.assertActive()
    const key = normalizeServiceKey(serviceKey)
    this.prune(this.now())
    const record = this.records.get(key)
    return record ? this.toSnapshot(record) : undefined
  }

  snapshots(): readonly ArcGisServiceHealthSnapshot[] {
    this.assertActive()
    this.prune(this.now())
    return Object.freeze([...this.records.values()]
      .sort((a, b) => a.serviceKey.localeCompare(b.serviceKey))
      .map(record => this.toSnapshot(record)))
  }

  state(serviceKey: string): ArcGisServiceHealthState {
    return this.snapshot(serviceKey)?.state ?? 'healthy'
  }

  canIssueRequest(serviceKey: string): boolean {
    return this.state(serviceKey) !== 'unavailable'
  }

  reset(serviceKey: string): boolean {
    this.assertActive()
    return this.records.delete(normalizeServiceKey(serviceKey))
  }

  clear(): void {
    this.assertActive()
    this.records.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
  }

  private evaluate(record: HealthRecord): ArcGisServiceHealthState {
    const count = record.samples.length
    if (count < this.options.minimumSamples) return 'healthy'
    const failures = record.samples.reduce((sum, sample) => sum + (sample.failed ? 1 : 0), 0)
    const failureRatio = failures / count
    if (record.state === 'unavailable' && record.consecutiveSuccesses < this.options.recoverySuccesses) return 'unavailable'
    if (failureRatio >= this.options.unavailableFailureRatio) return 'unavailable'
    const slow = record.smoothedLatencyMs !== undefined && record.smoothedLatencyMs >= this.options.slowLatencyMs
    if (failureRatio >= this.options.degradedFailureRatio || slow) return 'degraded'
    if (record.state === 'degraded' && record.consecutiveSuccesses < this.options.recoverySuccesses && failures > 0) return 'degraded'
    return 'healthy'
  }

  private getOrCreate(key: string, at: number): HealthRecord {
    const existing = this.records.get(key)
    if (existing) return existing
    while (this.records.size >= this.options.maxServices) this.evictOldest()
    const record: HealthRecord = {
      serviceKey: key, samples: [], state: 'healthy', successes: 0, failures: 0, timeouts: 0, cancellations: 0,
      consecutiveSuccesses: 0, consecutiveFailures: 0, lastObservedAt: at, revision: 0,
    }
    this.records.set(key, record)
    return record
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (now - record.lastObservedAt >= this.options.idleTtlMs) this.records.delete(key)
    }
  }

  private evictOldest(): void {
    let candidate: HealthRecord | undefined
    for (const record of this.records.values()) {
      if (!candidate || record.lastObservedAt < candidate.lastObservedAt ||
        (record.lastObservedAt === candidate.lastObservedAt && record.serviceKey < candidate.serviceKey)) candidate = record
    }
    if (candidate) this.records.delete(candidate.serviceKey)
  }

  private toSnapshot(record: HealthRecord): ArcGisServiceHealthSnapshot {
    const failures = record.samples.reduce((sum, sample) => sum + (sample.failed ? 1 : 0), 0)
    const result: ArcGisServiceHealthSnapshot = {
      serviceKey: record.serviceKey, state: record.state, samples: record.samples.length,
      successes: record.successes, failures: record.failures, timeouts: record.timeouts, cancellations: record.cancellations,
      consecutiveSuccesses: record.consecutiveSuccesses, consecutiveFailures: record.consecutiveFailures,
      failureRatio: record.samples.length === 0 ? 0 : failures / record.samples.length,
      lastObservedAt: record.lastObservedAt, revision: record.revision,
      ...(record.smoothedLatencyMs === undefined ? {} : { smoothedLatencyMs: record.smoothedLatencyMs }),
    }
    return Object.freeze(result)
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('ArcGIS health registry is disposed')
  }
}
