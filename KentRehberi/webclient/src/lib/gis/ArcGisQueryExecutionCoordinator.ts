import type { ArcGisQueryPage, ArcGisQueryPlan } from './ArcGisQueryPagePlanner'
import type { ArcGisQueryIntegrityResult } from './ArcGisQueryResponseIntegrity'

export interface ArcGisQueryExecutionOptions {
  readonly maxConcurrentPages: number
  readonly maxFeatures: number
  readonly maxAttemptsPerPage: number
  readonly pageTimeoutMs: number
}

export interface ArcGisQueryPageTransport {
  execute(page: ArcGisQueryPage, signal: AbortSignal): Promise<unknown>
}

export interface ArcGisQueryPageInspector {
  inspect(response: unknown, page: ArcGisQueryPage): ArcGisQueryIntegrityResult
}

export interface ArcGisExecutedFeature {
  readonly objectId: number
  readonly feature: unknown
  readonly page: number
}

export type ArcGisQueryExecutionFailureCode =
  | 'invalid-plan'
  | 'aborted'
  | 'timeout'
  | 'transport-error'
  | 'integrity-error'
  | 'feature-budget'
  | 'incomplete-transfer'

export interface ArcGisQueryExecutionFailure {
  readonly kind: 'failed'
  readonly code: ArcGisQueryExecutionFailureCode
  readonly page?: number
  readonly integrity?: ArcGisQueryIntegrityResult
}

export interface ArcGisQueryExecutionSuccess {
  readonly kind: 'completed'
  readonly key: string
  readonly features: readonly unknown[]
  readonly objectIds: readonly number[]
  readonly pagesCompleted: number
}

export type ArcGisQueryExecutionResult = ArcGisQueryExecutionSuccess | ArcGisQueryExecutionFailure

// Reject malformed caller-supplied plans before any network work or worker allocation.
const MAX_EXECUTION_PAGES = 4096

function validPlan(plan: ArcGisQueryPlan): plan is Extract<ArcGisQueryPlan, { kind: 'planned' }> {
  if (plan.kind !== 'planned' || typeof plan.key !== 'string' || !plan.key.trim() ||
      plan.key.length > 8192 || !positiveInteger(plan.pageSize) ||
      !Array.isArray(plan.pages) || plan.pages.length === 0 || plan.pages.length > MAX_EXECUTION_PAGES) return false
  const seenPages = new Set<number>()
  for (const entry of plan.pages) {
    if (!entry || !Number.isSafeInteger(entry.page) || entry.page < 0 ||
        entry.page >= plan.pages.length || seenPages.has(entry.page)) return false
    seenPages.add(entry.page)
    if (entry.kind === 'objectIds') {
      if (!Array.isArray(entry.objectIds) || entry.objectIds.length === 0 ||
          entry.objectIds.length > plan.pageSize ||
          entry.objectIds.some((id: number) => !positiveInteger(id)) ||
          new Set(entry.objectIds).size !== entry.objectIds.length) return false
    } else if (entry.kind === 'offset') {
      if (!Number.isSafeInteger(entry.resultOffset) || entry.resultOffset < 0 ||
          !positiveInteger(entry.resultRecordCount) || entry.resultRecordCount > plan.pageSize ||
          !Array.isArray(entry.orderByFields) ||
          entry.orderByFields.some((field: string) => typeof field !== 'string' || field.length > 256)) return false
    } else return false
  }
  return true
}

const DEFAULTS: ArcGisQueryExecutionOptions = {
  maxConcurrentPages: 4,
  maxFeatures: 100_000,
  maxAttemptsPerPage: 2,
  pageTimeoutMs: 20_000,
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function normalizeOptions(input: Partial<ArcGisQueryExecutionOptions>): ArcGisQueryExecutionOptions {
  const options = { ...DEFAULTS, ...input }
  for (const [name, value] of Object.entries(options)) {
    if (!positiveInteger(value)) throw new Error(`Invalid ArcGIS execution option: ${name}`)
  }
  return Object.freeze(options)
}

interface PageOutcome {
  readonly page: ArcGisQueryPage
  readonly result: ArcGisQueryIntegrityResult
}

export class ArcGisQueryExecutionCoordinator {
  readonly #options: ArcGisQueryExecutionOptions
  readonly #transport: ArcGisQueryPageTransport
  readonly #inspector: ArcGisQueryPageInspector

  constructor(
    transport: ArcGisQueryPageTransport,
    inspector: ArcGisQueryPageInspector,
    options: Partial<ArcGisQueryExecutionOptions> = {},
  ) {
    this.#transport = transport
    this.#inspector = inspector
    this.#options = normalizeOptions(options)
  }

  async execute(plan: ArcGisQueryPlan, signal?: AbortSignal): Promise<ArcGisQueryExecutionResult> {
    if (!validPlan(plan)) return { kind: 'failed', code: 'invalid-plan' }
    if (signal?.aborted === true) return { kind: 'failed', code: 'aborted' }

    const root = new AbortController()
    const onAbort = (): void => root.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) root.abort(signal.reason)

    try {
      const outcomes = await this.#executeBounded(plan.pages, root)
      if ('kind' in outcomes) return outcomes

      const features: unknown[] = []
      const objectIds: number[] = []
      const seen = new Set<number>()
      for (const outcome of outcomes.sort((left, right) => left.page.page - right.page.page)) {
        if (outcome.result.kind !== 'accepted') {
          return { kind: 'failed', code: 'integrity-error', page: outcome.page.page, integrity: outcome.result }
        }
        if (outcome.result.exceededTransferLimit && outcome.page.kind === 'objectIds') {
          return { kind: 'failed', code: 'incomplete-transfer', page: outcome.page.page }
        }
        if (features.length + outcome.result.features.length > this.#options.maxFeatures) {
          return { kind: 'failed', code: 'feature-budget', page: outcome.page.page }
        }
        for (let index = 0; index < outcome.result.features.length; index += 1) {
          const objectId = outcome.result.objectIds[index]
          if (objectId === undefined || seen.has(objectId)) {
            return { kind: 'failed', code: 'integrity-error', page: outcome.page.page }
          }
          seen.add(objectId)
          objectIds.push(objectId)
          features.push(outcome.result.features[index])
        }
      }

      return Object.freeze({
        kind: 'completed',
        key: plan.key,
        features: Object.freeze(features),
        objectIds: Object.freeze(objectIds),
        pagesCompleted: outcomes.length,
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      root.abort()
    }
  }

  async #executeBounded(
    pages: readonly ArcGisQueryPage[],
    root: AbortController,
  ): Promise<PageOutcome[] | ArcGisQueryExecutionFailure> {
    const outcomes: PageOutcome[] = []
    let cursor = 0
    let failure: ArcGisQueryExecutionFailure | undefined

    const worker = async (): Promise<void> => {
      while (!root.signal.aborted && failure === undefined) {
        const index = cursor
        if (index >= pages.length) return
        cursor += 1
        const page = pages[index]
        if (page === undefined) return
        const outcome = await this.#executePage(page, root.signal)
        if ('kind' in outcome) {
          // Preserve the first causal failure, never a sibling's cancellation.
          if (failure === undefined && !root.signal.aborted) failure = outcome
          root.abort()
          return
        }
        outcomes.push(outcome)
      }
    }

    const workerCount = Math.min(this.#options.maxConcurrentPages, pages.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    if (failure !== undefined) return failure
    if (root.signal.aborted) return { kind: 'failed', code: 'aborted' }
    return outcomes
  }

  async #executePage(page: ArcGisQueryPage, rootSignal: AbortSignal): Promise<PageOutcome | ArcGisQueryExecutionFailure> {
    for (let attempt = 1; attempt <= this.#options.maxAttemptsPerPage; attempt += 1) {
      if (rootSignal.aborted) return { kind: 'failed', code: 'aborted', page: page.page }
      const pageController = new AbortController()
      const forwardAbort = (): void => pageController.abort(rootSignal.reason)
      rootSignal.addEventListener('abort', forwardAbort, { once: true })
      if (rootSignal.aborted) forwardAbort()

      let timedOut = false
      let inspecting = false
      let rejectPending: ((error: Error) => void) | undefined
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectPending = reject
      })
      const stopWaiting = (): void => rejectPending?.(new Error('ArcGIS query aborted'))
      rootSignal.addEventListener('abort', stopWaiting, { once: true })
      if (rootSignal.aborted) stopWaiting()
      const timer = setTimeout(() => {
        timedOut = true
        pageController.abort(new Error('ArcGIS query page timeout'))
        rejectPending?.(new Error('ArcGIS query page timeout'))
      }, this.#options.pageTimeoutMs)

      try {
        // Bound wall-clock latency even if a transport ignores AbortSignal.
        // Promise.race observes late rejections without inspecting late results.
        const response = await Promise.race([
          Promise.resolve().then(() => this.#transport.execute(page, pageController.signal)),
          interruption,
        ])
        if (rootSignal.aborted) return { kind: 'failed', code: 'aborted', page: page.page }
        if (timedOut) return { kind: 'failed', code: 'timeout', page: page.page }
        inspecting = true
        const result = this.#inspector.inspect(response, page)
        if (result.kind === 'rejected') {
          return { kind: 'failed', code: 'integrity-error', page: page.page, integrity: result }
        }
        return { page, result }
      } catch {
        if (rootSignal.aborted) return { kind: 'failed', code: 'aborted', page: page.page }
        if (inspecting) return { kind: 'failed', code: 'integrity-error', page: page.page }
        if (attempt === this.#options.maxAttemptsPerPage) {
          return { kind: 'failed', code: timedOut ? 'timeout' : 'transport-error', page: page.page }
        }
      } finally {
        clearTimeout(timer)
        rootSignal.removeEventListener('abort', forwardAbort)
        rootSignal.removeEventListener('abort', stopWaiting)
        pageController.abort()
      }
    }
    return { kind: 'failed', code: 'transport-error', page: page.page }
  }
}
