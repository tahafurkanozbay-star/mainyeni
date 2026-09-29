export interface ArcGisRequestDescriptor {
  readonly key: string
  readonly priority: number
  readonly estimatedResponseBytes: number
  readonly timeoutMs: number
  readonly cacheable: boolean
}

export interface ArcGisRequestSchedulerBudget {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly maxEstimatedInflightBytes: number
  readonly maxTimeoutMs: number
  readonly maxKeyLength: number
}

export interface ArcGisRequestTicket {
  readonly key: string
  readonly generation: number
}

export interface ArcGisScheduledRequest extends ArcGisRequestDescriptor {
  readonly generation: number
  readonly state: 'queued' | 'active'
}

export interface ArcGisRequestSchedulerSnapshot {
  readonly active: readonly ArcGisScheduledRequest[]
  readonly queued: readonly ArcGisScheduledRequest[]
  readonly estimatedInflightBytes: number
}

const MAX_REQUESTS = 10_000
const MAX_BYTES = 512 * 1024 * 1024
const MAX_TIMEOUT = 300_000

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function keyOf(value: string, maxLength: number): string {
  const key = value.trim()
  if (!key || key.length > maxLength || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('invalid-request-key')
  return key
}

/** Transport-independent admission, dedupe and cancellation authority for ArcGIS requests. */
export class ArcGisRequestScheduler {
  private readonly budget: Readonly<ArcGisRequestSchedulerBudget>
  private readonly active = new Map<string, ArcGisScheduledRequest>()
  private readonly queued = new Map<string, ArcGisScheduledRequest>()
  private readonly generations = new Map<string, number>()
  private inflightBytes = 0
  private disposed = false

  constructor(budget: ArcGisRequestSchedulerBudget) {
    this.budget = Object.freeze({
      maxConcurrent: integer(budget.maxConcurrent, 'maxConcurrent', 1, MAX_REQUESTS),
      maxQueued: integer(budget.maxQueued, 'maxQueued', 0, MAX_REQUESTS),
      maxEstimatedInflightBytes: integer(budget.maxEstimatedInflightBytes, 'maxEstimatedInflightBytes', 1, MAX_BYTES),
      maxTimeoutMs: integer(budget.maxTimeoutMs, 'maxTimeoutMs', 1, MAX_TIMEOUT),
      maxKeyLength: integer(budget.maxKeyLength, 'maxKeyLength', 1, 512),
    })
  }

  schedule(input: ArcGisRequestDescriptor): ArcGisRequestTicket {
    this.assertLive()
    const key = keyOf(input.key, this.budget.maxKeyLength)
    if (this.active.has(key) || this.queued.has(key)) throw new Error(`duplicate-request:${key}`)
    const priority = integer(input.priority, 'priority', -1_000_000, 1_000_000)
    const estimatedResponseBytes = integer(input.estimatedResponseBytes, 'estimatedResponseBytes', 0, MAX_BYTES)
    const timeoutMs = integer(input.timeoutMs, 'timeoutMs', 1, this.budget.maxTimeoutMs)
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    const base = Object.freeze({ ...input, key, priority, estimatedResponseBytes, timeoutMs, generation, state: 'queued' as const })
    if (this.canActivate(estimatedResponseBytes)) this.activate(base)
    else {
      if (this.queued.size >= this.budget.maxQueued) throw new Error('request-queue-budget-exceeded')
      this.queued.set(key, base)
    }
    return Object.freeze({ key, generation })
  }

  complete(ticket: ArcGisRequestTicket): boolean {
    this.assertLive()
    const request = this.active.get(ticket.key)
    if (!request || request.generation !== ticket.generation) return false
    this.active.delete(ticket.key)
    this.inflightBytes -= request.estimatedResponseBytes
    this.drain()
    return true
  }

  cancel(ticket: ArcGisRequestTicket): boolean {
    this.assertLive()
    const active = this.active.get(ticket.key)
    if (active?.generation === ticket.generation) {
      this.active.delete(ticket.key)
      this.inflightBytes -= active.estimatedResponseBytes
      this.drain()
      return true
    }
    const queued = this.queued.get(ticket.key)
    if (queued?.generation === ticket.generation) {
      this.queued.delete(ticket.key)
      return true
    }
    return false
  }

  snapshot(): ArcGisRequestSchedulerSnapshot {
    const active = [...this.active.values()].sort((a, b) => a.key.localeCompare(b.key))
    const queued = this.orderedQueue()
    return Object.freeze({ active: Object.freeze(active), queued: Object.freeze(queued), estimatedInflightBytes: this.inflightBytes })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active.clear()
    this.queued.clear()
    this.generations.clear()
    this.inflightBytes = 0
  }

  private canActivate(bytes: number): boolean {
    return this.active.size < this.budget.maxConcurrent && this.inflightBytes + bytes <= this.budget.maxEstimatedInflightBytes
  }

  private activate(request: ArcGisScheduledRequest): void {
    const active = Object.freeze({ ...request, state: 'active' as const })
    this.active.set(active.key, active)
    this.inflightBytes += active.estimatedResponseBytes
  }

  private orderedQueue(): ArcGisScheduledRequest[] {
    return [...this.queued.values()].sort((a, b) => b.priority - a.priority || a.generation - b.generation || a.key.localeCompare(b.key))
  }

  private drain(): void {
    for (const request of this.orderedQueue()) {
      if (!this.canActivate(request.estimatedResponseBytes)) continue
      this.queued.delete(request.key)
      this.activate(request)
      if (this.active.size >= this.budget.maxConcurrent) break
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('request-scheduler-disposed')
  }
}
