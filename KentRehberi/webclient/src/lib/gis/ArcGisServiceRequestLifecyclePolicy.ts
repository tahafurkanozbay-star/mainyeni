export type ArcGisServiceRequestIntent = 'background' | 'visible' | 'interactive'
export type ArcGisServiceRequestPhase = 'queued' | 'running' | 'ready'
export type ArcGisServiceOperation = 'query' | 'identify' | 'legend' | 'metadata'

export interface ArcGisServiceRequestBudget {
  maxRequests: number
  maxRequestsPerService: number
  maxRunning: number
  maxRunningPerService: number
  maxReady: number
  maxReadyBytes: number
  maxResponseBytes: number
  maxRetries: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisServiceRequest {
  requestId: string
  serviceId: string
  operation: ArcGisServiceOperation
  intent: ArcGisServiceRequestIntent
  revision: number
  requestedAt: number
  estimatedResponseBytes: number
  signature: string
}

export interface ArcGisServiceCompletion {
  requestId: string
  serviceId: string
  revision: number
  responseBytes: number
  completedAt: number
}

export interface ArcGisServiceRequestView {
  readonly requestId: string
  readonly serviceId: string
  readonly operation: ArcGisServiceOperation
  readonly intent: ArcGisServiceRequestIntent
  readonly revision: number
  readonly requestedAt: number
  readonly estimatedResponseBytes: number
  readonly signature: string
  readonly phase: ArcGisServiceRequestPhase
  readonly attempts: number
  readonly expiresAt: number
  readonly actualResponseBytes: number
}

interface Entry extends ArcGisServiceRequest {
  phase: ArcGisServiceRequestPhase
  attempts: number
  expiresAt: number
  actualResponseBytes: number
  sequence: number
}

const priority: Readonly<Record<ArcGisServiceRequestIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function finiteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!idPattern.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function signature(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f]/.test(normalized)) throw new Error('signature is invalid')
  return normalized
}

/**
 * Payload-free authority for ArcGIS REST request scheduling and response
 * residency. URLs, credentials, request bodies, response JSON, AbortSignals
 * and SDK objects remain caller-owned. The policy stores only scalar metadata,
 * so it can coordinate dedupe/cancellation without becoming a transport layer.
 */
export class ArcGisServiceRequestLifecyclePolicy {
  readonly #budget: Readonly<ArcGisServiceRequestBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #signatureIndex = new Map<string, string>()
  readonly #serviceRevisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisServiceRequestBudget) {
    positiveInteger('maxRequests', budget.maxRequests)
    positiveInteger('maxRequestsPerService', budget.maxRequestsPerService)
    positiveInteger('maxRunning', budget.maxRunning)
    positiveInteger('maxRunningPerService', budget.maxRunningPerService)
    positiveInteger('maxReady', budget.maxReady)
    positiveInteger('maxReadyBytes', budget.maxReadyBytes)
    positiveInteger('maxResponseBytes', budget.maxResponseBytes)
    nonNegativeInteger('maxRetries', budget.maxRetries)
    finiteNonNegative('queueTtlMs', budget.queueTtlMs)
    finiteNonNegative('runTtlMs', budget.runTtlMs)
    finiteNonNegative('readyTtlMs', budget.readyTtlMs)
    if (budget.maxRequestsPerService > budget.maxRequests) throw new Error('per-service request budget is impossible')
    if (budget.maxRunning > budget.maxRequests || budget.maxReady > budget.maxRequests) throw new Error('phase budget is impossible')
    if (budget.maxRunningPerService > budget.maxRunning || budget.maxRunningPerService > budget.maxRequestsPerService) throw new Error('per-service running budget is impossible')
    if (budget.maxResponseBytes > budget.maxReadyBytes) throw new Error('response byte budget is impossible')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisServiceRequest): Readonly<ArcGisServiceRequestView> {
    this.#active()
    const requestId = identifier('requestId', request.requestId)
    const serviceId = identifier('serviceId', request.serviceId)
    const requestSignature = signature(request.signature)
    nonNegativeInteger('revision', request.revision)
    finiteNonNegative('requestedAt', request.requestedAt)
    nonNegativeInteger('estimatedResponseBytes', request.estimatedResponseBytes)
    if (request.estimatedResponseBytes > this.#budget.maxResponseBytes) throw new Error('estimated response exceeds response budget')
    const watermark = this.#serviceRevisions.get(serviceId)
    if (watermark !== undefined && request.revision < watermark) throw new Error('request revision is stale')
    if (watermark !== undefined && request.revision > watermark) this.advanceServiceRevision(serviceId, request.revision)
    if (this.#entries.has(requestId)) throw new Error('duplicate request authority')
    const signatureKey = this.#signatureKey(serviceId, request.operation, requestSignature, request.revision)
    const duplicateId = this.#signatureIndex.get(signatureKey)
    if (duplicateId && this.#entries.has(duplicateId)) throw new Error('duplicate request signature')
    if (this.#entries.size >= this.#budget.maxRequests) throw new Error('request capacity exceeded')
    if (this.#countService(serviceId) >= this.#budget.maxRequestsPerService) throw new Error('service request capacity exceeded')
    const entry: Entry = Object.freeze({
      ...request,
      requestId,
      serviceId,
      signature: requestSignature,
      phase: 'queued',
      attempts: 0,
      actualResponseBytes: 0,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
      sequence: this.#sequence++,
    })
    this.#entries.set(requestId, entry)
    this.#signatureIndex.set(signatureKey, requestId)
    this.#serviceRevisions.set(serviceId, request.revision)
    return this.#view(entry)
  }

  takeNext(now: number): Readonly<ArcGisServiceRequestView> | undefined {
    this.#active()
    finiteNonNegative('now', now)
    this.expire(now)
    if (this.#countPhase('running') >= this.#budget.maxRunning) return undefined
    const candidates = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued' && this.#countRunningService(entry.serviceId) < this.#budget.maxRunningPerService)
      .sort((a, b) => priority[b.intent] - priority[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.requestId.localeCompare(b.requestId))
    const entry = candidates[0]
    if (!entry) return undefined
    const running: Entry = Object.freeze({ ...entry, phase: 'running', attempts: entry.attempts + 1, expiresAt: now + this.#budget.runTtlMs })
    this.#entries.set(entry.requestId, running)
    return this.#view(running)
  }

  complete(completion: ArcGisServiceCompletion): Readonly<ArcGisServiceRequestView> {
    this.#active()
    const requestId = identifier('requestId', completion.requestId)
    const serviceId = identifier('serviceId', completion.serviceId)
    nonNegativeInteger('revision', completion.revision)
    nonNegativeInteger('responseBytes', completion.responseBytes)
    finiteNonNegative('completedAt', completion.completedAt)
    const entry = this.#entries.get(requestId)
    if (!entry || entry.phase !== 'running') throw new Error('request is not running')
    if (entry.serviceId !== serviceId || entry.revision !== completion.revision) throw new Error('completion identity mismatch')
    if (completion.completedAt > entry.expiresAt) { this.#remove(entry); throw new Error('request lease expired') }
    if (this.#serviceRevisions.get(serviceId) !== completion.revision) { this.#remove(entry); throw new Error('completion revision is stale') }
    if (completion.responseBytes > this.#budget.maxResponseBytes) { this.#remove(entry); throw new Error('response exceeds response budget') }
    if (this.#countPhase('ready') >= this.#budget.maxReady) { this.#remove(entry); throw new Error('ready capacity exceeded') }
    if (this.#readyBytes() + completion.responseBytes > this.#budget.maxReadyBytes) { this.#remove(entry); throw new Error('ready byte budget exceeded') }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualResponseBytes: completion.responseBytes, expiresAt: completion.completedAt + this.#budget.readyTtlMs })
    this.#entries.set(requestId, ready)
    return this.#view(ready)
  }

  retry(requestId: string, now: number): boolean {
    this.#active()
    const id = identifier('requestId', requestId)
    finiteNonNegative('now', now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'running' || now > entry.expiresAt) return false
    if (entry.attempts > this.#budget.maxRetries) { this.#remove(entry); return false }
    const queued: Entry = Object.freeze({ ...entry, phase: 'queued', expiresAt: now + this.#budget.queueTtlMs })
    this.#entries.set(id, queued)
    return true
  }

  consume(requestId: string): Readonly<ArcGisServiceRequestView> | undefined {
    this.#active()
    const id = identifier('requestId', requestId)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#remove(entry)
    return this.#view(entry)
  }

  cancel(requestId: string): boolean {
    this.#active()
    const id = identifier('requestId', requestId)
    const entry = this.#entries.get(id)
    if (!entry) return false
    this.#remove(entry)
    return true
  }

  touch(requestId: string, now: number): boolean {
    this.#active()
    const id = identifier('requestId', requestId)
    finiteNonNegative('now', now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(id, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  advanceServiceRevision(serviceId: string, revision: number): number {
    this.#active()
    const service = identifier('serviceId', serviceId)
    nonNegativeInteger('revision', revision)
    const current = this.#serviceRevisions.get(service)
    if (current !== undefined && revision < current) throw new Error('service revision cannot move backwards')
    if (current === revision) return 0
    let removed = 0
    for (const entry of [...this.#entries.values()]) {
      if (entry.serviceId === service && entry.revision < revision) { this.#remove(entry); removed += 1 }
    }
    this.#serviceRevisions.set(service, revision)
    return removed
  }

  releaseService(serviceId: string): number {
    this.#active()
    const service = identifier('serviceId', serviceId)
    let removed = 0
    for (const entry of [...this.#entries.values()]) if (entry.serviceId === service) { this.#remove(entry); removed += 1 }
    this.#serviceRevisions.delete(service)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finiteNonNegative('now', now)
    let removed = 0
    for (const entry of [...this.#entries.values()]) if (now > entry.expiresAt) { this.#remove(entry); removed += 1 }
    return removed
  }

  snapshot(): readonly Readonly<ArcGisServiceRequestView>[] {
    this.#active()
    return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()]
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.requestId.localeCompare(b.requestId))
      .map(entry => [entry.serviceId, entry.requestId, entry.operation, entry.intent, entry.revision, entry.phase, entry.attempts, entry.actualResponseBytes].join(':'))
      .join('|')
  }

  dispose(): void {
    this.#entries.clear(); this.#signatureIndex.clear(); this.#serviceRevisions.clear(); this.#disposed = true
  }

  #signatureKey(serviceId: string, operation: ArcGisServiceOperation, requestSignature: string, revision: number): string {
    return `${serviceId}\u001f${operation}\u001f${revision}\u001f${requestSignature}`
  }

  #remove(entry: Entry): void {
    this.#entries.delete(entry.requestId)
    this.#signatureIndex.delete(this.#signatureKey(entry.serviceId, entry.operation, entry.signature, entry.revision))
  }

  #countService(serviceId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.serviceId === serviceId) count += 1; return count }
  #countPhase(phase: ArcGisServiceRequestPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #countRunningService(serviceId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.serviceId === serviceId && entry.phase === 'running') count += 1; return count }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualResponseBytes; return total }

  #view(entry: Entry): Readonly<ArcGisServiceRequestView> {
    return Object.freeze({ requestId: entry.requestId, serviceId: entry.serviceId, operation: entry.operation, intent: entry.intent, revision: entry.revision, requestedAt: entry.requestedAt, estimatedResponseBytes: entry.estimatedResponseBytes, signature: entry.signature, phase: entry.phase, attempts: entry.attempts, expiresAt: entry.expiresAt, actualResponseBytes: entry.actualResponseBytes })
  }

  #active(): void { if (this.#disposed) throw new Error('ArcGisServiceRequestLifecyclePolicy is disposed') }
}
