export type ArcGisRequestClass = 'identify' | 'query' | 'export' | 'proximity' | 'geometry'

export interface ArcGisRequestBudget {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly maxEstimatedBytes: number
  readonly maxDeadlineMs: number
  readonly maxLayerCount: number
  readonly maxRevisionLength: number
}

export interface ArcGisRequestDescriptor {
  readonly id: string
  readonly requestClass: ArcGisRequestClass
  readonly revision: string
  readonly priority: number
  readonly estimatedBytes: number
  readonly deadlineMs: number
  readonly layerIds: readonly string[]
}

export interface ArcGisRequestPlan {
  readonly id: string
  readonly requestClass: ArcGisRequestClass
  readonly revision: string
  readonly priority: number
  readonly estimatedBytes: number
  readonly deadlineMs: number
  readonly layerIds: readonly string[]
  readonly dedupeKey: string
}

export interface ArcGisRequestQueuePlan {
  readonly running: readonly ArcGisRequestPlan[]
  readonly queued: readonly ArcGisRequestPlan[]
  readonly rejectedIds: readonly string[]
  readonly totalEstimatedBytes: number
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CLASSES: ReadonlySet<ArcGisRequestClass> = new Set(['identify', 'query', 'export', 'proximity', 'geometry'])

function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}-out-of-range`)
  return value
}

function text(value: string, label: string, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !TOKEN.test(value)) throw new Error(`${label}-invalid`)
  return value
}

/** Pure admission/scheduling authority. It owns no fetch, AbortController, timer or ArcGIS SDK object. */
export class ArcGisRequestBudgetPolicy {
  readonly #budget: Readonly<ArcGisRequestBudget>

  constructor(budget: ArcGisRequestBudget) {
    this.#budget = Object.freeze({
      maxConcurrent: integer(budget.maxConcurrent, 'maxConcurrent', 1, 64),
      maxQueued: integer(budget.maxQueued, 'maxQueued', 0, 10_000),
      maxEstimatedBytes: integer(budget.maxEstimatedBytes, 'maxEstimatedBytes', 1, 1024 * 1024 * 1024),
      maxDeadlineMs: integer(budget.maxDeadlineMs, 'maxDeadlineMs', 1, 300_000),
      maxLayerCount: integer(budget.maxLayerCount, 'maxLayerCount', 1, 10_000),
      maxRevisionLength: integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 256),
    })
  }

  plan(input: ArcGisRequestDescriptor): ArcGisRequestPlan {
    const id = text(input.id, 'request-id')
    if (!CLASSES.has(input.requestClass)) throw new Error('request-class-invalid')
    const revision = text(input.revision, 'revision', this.#budget.maxRevisionLength)
    const priority = integer(input.priority, 'priority', 0, 100)
    const estimatedBytes = integer(input.estimatedBytes, 'estimatedBytes', 1, this.#budget.maxEstimatedBytes)
    const deadlineMs = integer(input.deadlineMs, 'deadlineMs', 1, this.#budget.maxDeadlineMs)
    if (!Array.isArray(input.layerIds) || input.layerIds.length > this.#budget.maxLayerCount) throw new Error('layer-count-budget-exceeded')
    const seen = new Set<string>()
    const layerIds = input.layerIds.map(raw => {
      const layerId = text(raw, 'layer-id')
      if (seen.has(layerId)) throw new Error('duplicate-layer-id')
      seen.add(layerId)
      return layerId
    }).sort()
    const frozenLayers = Object.freeze(layerIds)
    const dedupeKey = ['arcgis-request-v1', input.requestClass, revision, estimatedBytes, deadlineMs, ...frozenLayers].join('|')
    return Object.freeze({ id, requestClass: input.requestClass, revision, priority, estimatedBytes, deadlineMs, layerIds: frozenLayers, dedupeKey })
  }

  schedule(inputs: readonly ArcGisRequestDescriptor[]): ArcGisRequestQueuePlan {
    if (!Array.isArray(inputs)) throw new Error('request-list-invalid')
    const ids = new Set<string>()
    const dedupe = new Set<string>()
    const admitted: ArcGisRequestPlan[] = []
    const rejectedIds: string[] = []
    let totalEstimatedBytes = 0
    for (const input of inputs) {
      const plan = this.plan(input)
      if (ids.has(plan.id)) throw new Error('duplicate-request-id')
      ids.add(plan.id)
      if (dedupe.has(plan.dedupeKey)) { rejectedIds.push(plan.id); continue }
      if (totalEstimatedBytes + plan.estimatedBytes > this.#budget.maxEstimatedBytes) { rejectedIds.push(plan.id); continue }
      dedupe.add(plan.dedupeKey)
      totalEstimatedBytes += plan.estimatedBytes
      admitted.push(plan)
    }
    admitted.sort((a, b) => b.priority - a.priority || a.deadlineMs - b.deadlineMs || a.id.localeCompare(b.id))
    const running = admitted.slice(0, this.#budget.maxConcurrent)
    const queued = admitted.slice(this.#budget.maxConcurrent, this.#budget.maxConcurrent + this.#budget.maxQueued)
    for (const overflow of admitted.slice(this.#budget.maxConcurrent + this.#budget.maxQueued)) rejectedIds.push(overflow.id)
    const retainedBytes = [...running, ...queued].reduce((sum, plan) => sum + plan.estimatedBytes, 0)
    rejectedIds.sort()
    return Object.freeze({ running: Object.freeze(running), queued: Object.freeze(queued), rejectedIds: Object.freeze(rejectedIds), totalEstimatedBytes: retainedBytes })
  }
}