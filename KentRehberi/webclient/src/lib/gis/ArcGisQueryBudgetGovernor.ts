export type ArcGisQueryWorkloadClass = 'interactive' | 'background' | 'prefetch'

export interface ArcGisQueryBudgetLimits {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly maxFeaturesInFlight: number
  readonly maxEstimatedBytesInFlight: number
  readonly queueTimeoutMs: number
}

export interface ArcGisQueryBudgetRequest {
  readonly key: string
  readonly workload: ArcGisQueryWorkloadClass
  readonly estimatedFeatures: number
  readonly estimatedBytes: number
  readonly priority?: number
}

export interface ArcGisQueryBudgetLease {
  readonly id: number
  readonly key: string
  readonly workload: ArcGisQueryWorkloadClass
  readonly admittedAt: number
  release(): void
}

export type ArcGisQueryBudgetRejectionCode =
  | 'disposed'
  | 'aborted'
  | 'queue-capacity'
  | 'request-feature-budget'
  | 'request-byte-budget'
  | 'queue-timeout'

export interface ArcGisQueryBudgetRejection {
  readonly kind: 'rejected'
  readonly code: ArcGisQueryBudgetRejectionCode
}

export interface ArcGisQueryBudgetAdmission {
  readonly kind: 'admitted'
  readonly lease: ArcGisQueryBudgetLease
}

export type ArcGisQueryBudgetResult = ArcGisQueryBudgetAdmission | ArcGisQueryBudgetRejection

export interface ArcGisQueryBudgetSnapshot {
  readonly active: number
  readonly queued: number
  readonly featuresInFlight: number
  readonly estimatedBytesInFlight: number
  readonly disposed: boolean
  readonly activeByWorkload: Readonly<Record<ArcGisQueryWorkloadClass, number>>
  readonly queuedByWorkload: Readonly<Record<ArcGisQueryWorkloadClass, number>>
}

interface QueueRecord {
  readonly sequence: number
  readonly request: Required<ArcGisQueryBudgetRequest>
  readonly resolve: (result: ArcGisQueryBudgetResult) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
}

interface ActiveRecord {
  readonly id: number
  readonly request: Required<ArcGisQueryBudgetRequest>
  readonly admittedAt: number
  released: boolean
}

const WORKLOAD_WEIGHT: Readonly<Record<ArcGisQueryWorkloadClass, number>> = Object.freeze({
  interactive: 3,
  background: 2,
  prefetch: 1,
})

const DEFAULT_LIMITS: ArcGisQueryBudgetLimits = Object.freeze({
  maxConcurrent: 6,
  maxQueued: 48,
  maxFeaturesInFlight: 120_000,
  maxEstimatedBytesInFlight: 48 * 1024 * 1024,
  queueTimeoutMs: 15_000,
})

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function normalizeLimits(input: Partial<ArcGisQueryBudgetLimits>): ArcGisQueryBudgetLimits {
  const limits = { ...DEFAULT_LIMITS, ...input }
  for (const [name, value] of Object.entries(limits)) {
    if (!positiveInteger(value)) throw new Error(`Invalid ArcGIS query budget limit: ${name}`)
  }
  return Object.freeze(limits)
}

function normalizeRequest(request: ArcGisQueryBudgetRequest): Required<ArcGisQueryBudgetRequest> {
  const key = request.key.trim()
  if (key.length === 0 || key.length > 512) throw new Error('ArcGIS query budget key must be non-empty and bounded')
  if (!positiveInteger(request.estimatedFeatures)) throw new Error('ArcGIS estimated feature count must be a positive integer')
  if (!positiveInteger(request.estimatedBytes)) throw new Error('ArcGIS estimated byte count must be a positive integer')
  const priority = request.priority ?? 0
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
    throw new Error('ArcGIS query priority must be an integer between -100 and 100')
  }
  if (!(request.workload in WORKLOAD_WEIGHT)) throw new Error('Unsupported ArcGIS query workload class')
  return Object.freeze({ ...request, key, priority })
}

function emptyWorkloadCounter(): Record<ArcGisQueryWorkloadClass, number> {
  return { interactive: 0, background: 0, prefetch: 0 }
}

export class ArcGisQueryBudgetGovernor {
  readonly #limits: ArcGisQueryBudgetLimits
  readonly #queue: QueueRecord[] = []
  readonly #active = new Map<number, ActiveRecord>()
  #featuresInFlight = 0
  #bytesInFlight = 0
  #nextSequence = 1
  #nextLeaseId = 1
  #disposed = false

  constructor(limits: Partial<ArcGisQueryBudgetLimits> = {}) {
    this.#limits = normalizeLimits(limits)
  }

  get limits(): ArcGisQueryBudgetLimits {
    return this.#limits
  }

  snapshot(): ArcGisQueryBudgetSnapshot {
    const activeByWorkload = emptyWorkloadCounter()
    const queuedByWorkload = emptyWorkloadCounter()
    for (const active of this.#active.values()) activeByWorkload[active.request.workload] += 1
    for (const queued of this.#queue) {
      if (!queued.settled) queuedByWorkload[queued.request.workload] += 1
    }
    return Object.freeze({
      active: this.#active.size,
      queued: this.#queue.filter((record) => !record.settled).length,
      featuresInFlight: this.#featuresInFlight,
      estimatedBytesInFlight: this.#bytesInFlight,
      disposed: this.#disposed,
      activeByWorkload: Object.freeze(activeByWorkload),
      queuedByWorkload: Object.freeze(queuedByWorkload),
    })
  }

  async acquire(requestInput: ArcGisQueryBudgetRequest, signal?: AbortSignal): Promise<ArcGisQueryBudgetResult> {
    if (this.#disposed) return { kind: 'rejected', code: 'disposed' }
    if (signal?.aborted === true) return { kind: 'rejected', code: 'aborted' }
    const request = normalizeRequest(requestInput)
    if (request.estimatedFeatures > this.#limits.maxFeaturesInFlight) {
      return { kind: 'rejected', code: 'request-feature-budget' }
    }
    if (request.estimatedBytes > this.#limits.maxEstimatedBytesInFlight) {
      return { kind: 'rejected', code: 'request-byte-budget' }
    }
    if (this.#canAdmit(request)) return this.#admit(request)
    if (this.#queue.length >= this.#limits.maxQueued) return { kind: 'rejected', code: 'queue-capacity' }

    return await new Promise<ArcGisQueryBudgetResult>((resolve) => {
      const record: QueueRecord = {
        sequence: this.#nextSequence++,
        request,
        resolve,
        signal,
        settled: false,
      }
      const settle = (result: ArcGisQueryBudgetResult): void => {
        if (record.settled) return
        record.settled = true
        if (record.timer !== undefined) clearTimeout(record.timer)
        if (record.onAbort !== undefined) signal?.removeEventListener('abort', record.onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        settle({ kind: 'rejected', code: 'aborted' })
        this.#compactQueue()
        this.#drain()
      }
      record.onAbort = onAbort
      signal?.addEventListener('abort', onAbort, { once: true })
      record.timer = setTimeout(() => {
        settle({ kind: 'rejected', code: 'queue-timeout' })
        this.#compactQueue()
        this.#drain()
      }, this.#limits.queueTimeoutMs)
      this.#queue.push(record)
      this.#sortQueue()
      this.#drain()
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const record of this.#queue) {
      if (record.settled) continue
      record.settled = true
      if (record.timer !== undefined) clearTimeout(record.timer)
      if (record.onAbort !== undefined) record.signal?.removeEventListener('abort', record.onAbort)
      record.resolve({ kind: 'rejected', code: 'disposed' })
    }
    this.#queue.length = 0
  }

  #sortQueue(): void {
    this.#queue.sort((left, right) => {
      const workloadDelta = WORKLOAD_WEIGHT[right.request.workload] - WORKLOAD_WEIGHT[left.request.workload]
      if (workloadDelta !== 0) return workloadDelta
      const priorityDelta = right.request.priority - left.request.priority
      if (priorityDelta !== 0) return priorityDelta
      return left.sequence - right.sequence
    })
  }

  #canAdmit(request: Required<ArcGisQueryBudgetRequest>): boolean {
    return this.#active.size < this.#limits.maxConcurrent
      && this.#featuresInFlight + request.estimatedFeatures <= this.#limits.maxFeaturesInFlight
      && this.#bytesInFlight + request.estimatedBytes <= this.#limits.maxEstimatedBytesInFlight
  }

  #admit(request: Required<ArcGisQueryBudgetRequest>): ArcGisQueryBudgetAdmission {
    const id = this.#nextLeaseId++
    const admittedAt = Date.now()
    const record: ActiveRecord = { id, request, admittedAt, released: false }
    this.#active.set(id, record)
    this.#featuresInFlight += request.estimatedFeatures
    this.#bytesInFlight += request.estimatedBytes

    const lease: ArcGisQueryBudgetLease = Object.freeze({
      id,
      key: request.key,
      workload: request.workload,
      admittedAt,
      release: (): void => this.#release(id),
    })
    return { kind: 'admitted', lease }
  }

  #release(id: number): void {
    const record = this.#active.get(id)
    if (record === undefined || record.released) return
    record.released = true
    this.#active.delete(id)
    this.#featuresInFlight = Math.max(0, this.#featuresInFlight - record.request.estimatedFeatures)
    this.#bytesInFlight = Math.max(0, this.#bytesInFlight - record.request.estimatedBytes)
    this.#drain()
  }

  #drain(): void {
    if (this.#disposed) return
    this.#compactQueue()
    let progressed = true
    while (progressed && this.#active.size < this.#limits.maxConcurrent) {
      progressed = false
      for (let index = 0; index < this.#queue.length; index += 1) {
        const record = this.#queue[index]
        if (record === undefined || record.settled) continue
        if (!this.#canAdmit(record.request)) continue
        this.#queue.splice(index, 1)
        record.settled = true
        if (record.timer !== undefined) clearTimeout(record.timer)
        if (record.onAbort !== undefined) record.signal?.removeEventListener('abort', record.onAbort)
        record.resolve(this.#admit(record.request))
        progressed = true
        break
      }
    }
  }

  #compactQueue(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      if (this.#queue[index]?.settled === true) this.#queue.splice(index, 1)
    }
  }
}
