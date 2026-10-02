export type ArcGisSpatialExecutionIntent = 'background' | 'visible' | 'interactive'
export type ArcGisSpatialExecutionKind = 'query' | 'identify' | 'buffer' | 'nearest' | 'projection' | 'measurement'
export type ArcGisSpatialExecutionPhase = 'queued' | 'running' | 'ready'

export interface ArcGisSpatialExecutionBudget {
  maxExecutions: number
  maxExecutionsPerView: number
  maxExecutionsPerLayer: number
  maxRunning: number
  maxRunningPerView: number
  maxReady: number
  maxEstimatedVerticesPerExecution: number
  maxActualVerticesPerExecution: number
  maxReadyVertices: number
  maxEstimatedBytesPerExecution: number
  maxActualBytesPerExecution: number
  maxReadyBytes: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisSpatialExecutionRequest {
  executionId: string
  viewId: string
  layerId: string
  revision: number
  kind: ArcGisSpatialExecutionKind
  intent: ArcGisSpatialExecutionIntent
  requestedAt: number
  estimatedVertices: number
  estimatedBytes: number
}

export interface ArcGisSpatialExecutionCompletion {
  executionId: string
  viewId: string
  layerId: string
  revision: number
  actualVertices: number
  actualBytes: number
  completedAt: number
}

export interface ArcGisSpatialExecutionView {
  readonly executionId: string
  readonly viewId: string
  readonly layerId: string
  readonly revision: number
  readonly kind: ArcGisSpatialExecutionKind
  readonly intent: ArcGisSpatialExecutionIntent
  readonly phase: ArcGisSpatialExecutionPhase
  readonly estimatedVertices: number
  readonly estimatedBytes: number
  readonly actualVertices: number
  readonly actualBytes: number
  readonly sequence: number
  readonly expiresAt: number
}

interface Entry extends ArcGisSpatialExecutionRequest {
  phase: ArcGisSpatialExecutionPhase
  actualVertices: number
  actualBytes: number
  sequence: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisSpatialExecutionIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })
const identifierPattern = /^[A-Za-z0-9._:-]{1,160}$/

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!identifierPattern.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function integer(name: string, value: number, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free authority for expensive ArcGIS geometry/query execution.
 * Geometry, Graphic, FeatureSet, workers, credentials and AbortControllers
 * deliberately remain caller-owned. Only bounded scalar accounting metadata is
 * retained so view/layer teardown can deterministically release authority.
 */
export class ArcGisSpatialExecutionLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSpatialExecutionBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #layerRevisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisSpatialExecutionBudget) {
    for (const [name, value] of Object.entries(budget)) {
      if (name.endsWith('Ms')) finite(name, value)
      else integer(name, value, 1)
    }
    if (budget.maxExecutionsPerView > budget.maxExecutions || budget.maxExecutionsPerLayer > budget.maxExecutions) throw new Error('execution cardinality budget is impossible')
    if (budget.maxRunning > budget.maxExecutions || budget.maxRunningPerView > budget.maxRunning || budget.maxReady > budget.maxExecutions) throw new Error('phase budget is impossible')
    if (budget.maxEstimatedVerticesPerExecution > budget.maxActualVerticesPerExecution || budget.maxActualVerticesPerExecution > budget.maxReadyVertices) throw new Error('vertex budget is impossible')
    if (budget.maxEstimatedBytesPerExecution > budget.maxActualBytesPerExecution || budget.maxActualBytesPerExecution > budget.maxReadyBytes) throw new Error('byte budget is impossible')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisSpatialExecutionRequest): Readonly<ArcGisSpatialExecutionView> {
    this.#active()
    const executionId = identifier('executionId', request.executionId)
    const viewId = identifier('viewId', request.viewId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision)
    finite('requestedAt', request.requestedAt)
    integer('estimatedVertices', request.estimatedVertices)
    integer('estimatedBytes', request.estimatedBytes)
    if (request.estimatedVertices > this.#budget.maxEstimatedVerticesPerExecution) throw new Error('estimated vertex budget exceeded')
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerExecution) throw new Error('estimated byte budget exceeded')
    if (this.#entries.has(executionId)) throw new Error('duplicate execution authority')
    if (this.#entries.size >= this.#budget.maxExecutions) throw new Error('execution capacity exceeded')
    if (this.#count(entry => entry.viewId === viewId) >= this.#budget.maxExecutionsPerView) throw new Error('view execution capacity exceeded')
    if (this.#count(entry => entry.layerId === layerId) >= this.#budget.maxExecutionsPerLayer) throw new Error('layer execution capacity exceeded')

    const watermark = this.#layerRevisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) throw new Error('stale layer revision')
    if (watermark === undefined || request.revision > watermark) this.advanceLayerRevision(layerId, request.revision)

    const entry: Entry = Object.freeze({ ...request, executionId, viewId, layerId, phase: 'queued', actualVertices: 0, actualBytes: 0, sequence: this.#sequence++, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(executionId, entry)
    return this.#view(entry)
  }

  takeNext(now: number): Readonly<ArcGisSpatialExecutionView> | undefined {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#count(entry => entry.phase === 'running') >= this.#budget.maxRunning) return undefined
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || a.requestedAt - b.requestedAt || a.executionId.localeCompare(b.executionId))
    const selected = candidates.find(candidate => this.#count(entry => entry.phase === 'running' && entry.viewId === candidate.viewId) < this.#budget.maxRunningPerView)
    if (!selected) return undefined
    const running: Entry = Object.freeze({ ...selected, phase: 'running', expiresAt: now + this.#budget.runTtlMs })
    this.#entries.set(selected.executionId, running)
    return this.#view(running)
  }

  complete(completion: ArcGisSpatialExecutionCompletion): Readonly<ArcGisSpatialExecutionView> {
    this.#active()
    const executionId = identifier('executionId', completion.executionId)
    const viewId = identifier('viewId', completion.viewId)
    const layerId = identifier('layerId', completion.layerId)
    integer('revision', completion.revision); integer('actualVertices', completion.actualVertices); integer('actualBytes', completion.actualBytes); finite('completedAt', completion.completedAt)
    const entry = this.#entries.get(executionId)
    if (!entry || entry.phase !== 'running') throw new Error('execution is not running')
    if (entry.viewId !== viewId || entry.layerId !== layerId || entry.revision !== completion.revision) throw new Error('completion identity mismatch')
    if (completion.completedAt > entry.expiresAt) { this.#entries.delete(executionId); throw new Error('execution lease expired') }
    if (this.#layerRevisions.get(layerId) !== completion.revision) { this.#entries.delete(executionId); throw new Error('stale completion revision') }
    if (completion.actualVertices > this.#budget.maxActualVerticesPerExecution) { this.#entries.delete(executionId); throw new Error('actual vertex budget exceeded') }
    if (completion.actualBytes > this.#budget.maxActualBytesPerExecution) { this.#entries.delete(executionId); throw new Error('actual byte budget exceeded') }
    if (this.#count(candidate => candidate.phase === 'ready') >= this.#budget.maxReady) { this.#entries.delete(executionId); throw new Error('ready capacity exceeded') }
    if (this.#sumReady('vertices') + completion.actualVertices > this.#budget.maxReadyVertices) { this.#entries.delete(executionId); throw new Error('ready vertex residency exceeded') }
    if (this.#sumReady('bytes') + completion.actualBytes > this.#budget.maxReadyBytes) { this.#entries.delete(executionId); throw new Error('ready byte residency exceeded') }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualVertices: completion.actualVertices, actualBytes: completion.actualBytes, expiresAt: completion.completedAt + this.#budget.readyTtlMs })
    this.#entries.set(executionId, ready)
    return this.#view(ready)
  }

  touch(executionId: string, now: number): boolean {
    this.#active(); const id = identifier('executionId', executionId); finite('now', now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(id, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs })); return true
  }

  consume(executionId: string): Readonly<ArcGisSpatialExecutionView> | undefined {
    this.#active(); const id = identifier('executionId', executionId); const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#entries.delete(id); return this.#view(entry)
  }

  cancel(executionId: string): boolean {
    this.#active(); const id = identifier('executionId', executionId); const entry = this.#entries.get(id)
    if (!entry || entry.phase === 'ready') return false
    return this.#entries.delete(id)
  }

  advanceLayerRevision(layerId: string, revision: number): number {
    this.#active(); const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#layerRevisions.get(layer)
    if (current !== undefined && revision < current) throw new Error('layer revision cannot move backwards')
    if (current === revision) return 0
    let removed = 0
    for (const [id, entry] of this.#entries) if (entry.layerId === layer && entry.revision < revision) { this.#entries.delete(id); removed += 1 }
    this.#layerRevisions.set(layer, revision); return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [id, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(id); removed += 1 }
    return removed
  }

  releaseView(viewId: string): number { return this.#release(entry => entry.viewId === identifier('viewId', viewId)) }
  releaseLayer(layerId: string): number {
    const layer = identifier('layerId', layerId); const removed = this.#release(entry => entry.layerId === layer); this.#layerRevisions.delete(layer); return removed
  }

  snapshot(): readonly Readonly<ArcGisSpatialExecutionView>[] {
    this.#active(); return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }

  fingerprint(): string {
    this.#active(); return [...this.#entries.values()].sort((a, b) => a.executionId.localeCompare(b.executionId)).map(entry => [entry.executionId, entry.viewId, entry.layerId, entry.revision, entry.kind, entry.intent, entry.phase, entry.actualVertices, entry.actualBytes].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#layerRevisions.clear(); this.#disposed = true }

  #release(predicate: (entry: Entry) => boolean): number {
    this.#active(); let removed = 0
    for (const [id, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(id); removed += 1 }
    return removed
  }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total += 1; return total }
  #sumReady(metric: 'vertices' | 'bytes'): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += metric === 'vertices' ? entry.actualVertices : entry.actualBytes; return total }
  #view(entry: Entry): Readonly<ArcGisSpatialExecutionView> { return Object.freeze({ executionId: entry.executionId, viewId: entry.viewId, layerId: entry.layerId, revision: entry.revision, kind: entry.kind, intent: entry.intent, phase: entry.phase, estimatedVertices: entry.estimatedVertices, estimatedBytes: entry.estimatedBytes, actualVertices: entry.actualVertices, actualBytes: entry.actualBytes, sequence: entry.sequence, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisSpatialExecutionLifecyclePolicy is disposed') }
}
