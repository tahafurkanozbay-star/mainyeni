export interface ArcGisPaginationBudget {
  readonly maxLayers: number
  readonly maxPagesPerLayer: number
  readonly maxFeaturesPerPage: number
  readonly maxFeaturesPerLayer: number
  readonly maxBytesPerPage: number
  readonly maxBytesPerLayer: number
  readonly maxCursorLength: number
  readonly maxLayerIdLength: number
}

export interface ArcGisPageRequest {
  readonly requestId: string
  readonly layerId: string
  readonly revision: number
  readonly pageIndex: number
  readonly resultOffset: number
  readonly resultRecordCount: number
  readonly cursor?: string
}

export interface ArcGisPageResult {
  readonly requestId: string
  readonly layerId: string
  readonly revision: number
  readonly pageIndex: number
  readonly featureCount: number
  readonly byteLength: number
  readonly exceededTransferLimit: boolean
  readonly nextCursor?: string
}

export interface ArcGisPaginationSnapshot {
  readonly layerId: string
  readonly revision: number
  readonly pagesCompleted: number
  readonly featuresReceived: number
  readonly bytesReceived: number
  readonly nextPageIndex: number
  readonly complete: boolean
  readonly fingerprint: string
}

interface LayerState {
  revision: number
  pagesCompleted: number
  featuresReceived: number
  bytesReceived: number
  nextPageIndex: number
  complete: boolean
  activeRequestId?: string
  activeRecordCount?: number
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}-out-of-range`)
  }
  return value
}

function boundedText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`invalid-${name}`)
  }
  return normalized
}

function fingerprint(parts: readonly string[]): string {
  let hash = 2166136261
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 31
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Transport-independent authority for ArcGIS REST result pagination. It tracks
 * only bounded accounting facts and never retains response payloads, geometry,
 * SDK objects, AbortControllers or service URLs. Existing service adapters stay
 * responsible for transport and translate admitted plans to ArcGIS requests.
 */
export class ArcGisPaginationPolicy {
  private readonly budget: Readonly<ArcGisPaginationBudget>
  private readonly layers = new Map<string, LayerState>()
  private disposed = false

  constructor(budget: ArcGisPaginationBudget) {
    this.budget = Object.freeze({
      maxLayers: boundedInteger(budget.maxLayers, 'maxLayers', 1, 100_000),
      maxPagesPerLayer: boundedInteger(budget.maxPagesPerLayer, 'maxPagesPerLayer', 1, 1_000_000),
      maxFeaturesPerPage: boundedInteger(budget.maxFeaturesPerPage, 'maxFeaturesPerPage', 1, 1_000_000),
      maxFeaturesPerLayer: boundedInteger(budget.maxFeaturesPerLayer, 'maxFeaturesPerLayer', 1, 100_000_000),
      maxBytesPerPage: boundedInteger(budget.maxBytesPerPage, 'maxBytesPerPage', 1, 2 * 1024 * 1024 * 1024),
      maxBytesPerLayer: boundedInteger(budget.maxBytesPerLayer, 'maxBytesPerLayer', 1, Number.MAX_SAFE_INTEGER),
      maxCursorLength: boundedInteger(budget.maxCursorLength, 'maxCursorLength', 1, 4096),
      maxLayerIdLength: boundedInteger(budget.maxLayerIdLength, 'maxLayerIdLength', 1, 512),
    })
    if (this.budget.maxFeaturesPerPage > this.budget.maxFeaturesPerLayer) throw new Error('page-feature-budget-exceeds-layer-budget')
    if (this.budget.maxBytesPerPage > this.budget.maxBytesPerLayer) throw new Error('page-byte-budget-exceeds-layer-budget')
  }

  begin(request: ArcGisPageRequest): Readonly<ArcGisPageRequest> {
    this.assertLive()
    const normalized = this.normalizeRequest(request)
    let state = this.layers.get(normalized.layerId)
    if (!state) {
      if (this.layers.size >= this.budget.maxLayers) throw new Error('pagination-layer-budget-exceeded')
      if (normalized.pageIndex !== 0 || normalized.resultOffset !== 0) throw new Error('pagination-must-start-at-zero')
      state = this.createState(normalized.revision)
      this.layers.set(normalized.layerId, state)
    }
    if (normalized.revision < state.revision) throw new Error('stale-pagination-revision')
    if (normalized.revision > state.revision) {
      if (normalized.pageIndex !== 0 || normalized.resultOffset !== 0) throw new Error('new-pagination-revision-must-start-at-zero')
      state = this.createState(normalized.revision)
      this.layers.set(normalized.layerId, state)
    }
    if (state.complete) throw new Error('pagination-already-complete')
    if (state.activeRequestId) throw new Error('pagination-request-already-active')
    if (state.pagesCompleted >= this.budget.maxPagesPerLayer) throw new Error('pagination-page-budget-exceeded')
    if (normalized.pageIndex !== state.nextPageIndex) throw new Error('unexpected-pagination-page')
    if (normalized.resultOffset !== state.featuresReceived) throw new Error('unexpected-pagination-offset')
    const remaining = this.budget.maxFeaturesPerLayer - state.featuresReceived
    if (normalized.resultRecordCount > remaining) throw new Error('pagination-feature-budget-exceeded')
    state.activeRequestId = normalized.requestId
    state.activeRecordCount = normalized.resultRecordCount
    return Object.freeze(normalized)
  }

  complete(result: ArcGisPageResult): ArcGisPaginationSnapshot {
    this.assertLive()
    const layerId = boundedText(result.layerId, 'layer-id', this.budget.maxLayerIdLength)
    const state = this.layers.get(layerId)
    if (!state) throw new Error('unknown-pagination-layer')
    const requestId = boundedText(result.requestId, 'request-id', this.budget.maxCursorLength)
    const revision = boundedInteger(result.revision, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const pageIndex = boundedInteger(result.pageIndex, 'pageIndex', 0, this.budget.maxPagesPerLayer - 1)
    const featureCount = boundedInteger(result.featureCount, 'featureCount', 0, this.budget.maxFeaturesPerPage)
    const byteLength = boundedInteger(result.byteLength, 'byteLength', 0, this.budget.maxBytesPerPage)
    if (revision !== state.revision) throw new Error('pagination-result-revision-mismatch')
    if (requestId !== state.activeRequestId) throw new Error('pagination-result-request-mismatch')
    if (pageIndex !== state.nextPageIndex) throw new Error('pagination-result-page-mismatch')
    if (featureCount > (state.activeRecordCount ?? 0)) throw new Error('pagination-result-exceeds-requested-count')
    if (state.featuresReceived + featureCount > this.budget.maxFeaturesPerLayer) throw new Error('pagination-feature-budget-exceeded')
    if (state.bytesReceived + byteLength > this.budget.maxBytesPerLayer) throw new Error('pagination-byte-budget-exceeded')
    const exceeded = result.exceededTransferLimit === true
    const nextCursor = result.nextCursor === undefined ? undefined : boundedText(result.nextCursor, 'next-cursor', this.budget.maxCursorLength)
    if (exceeded && featureCount === 0) throw new Error('pagination-transfer-limit-without-progress')
    if (!exceeded && nextCursor !== undefined) throw new Error('pagination-terminal-page-cannot-have-cursor')
    state.pagesCompleted += 1
    state.featuresReceived += featureCount
    state.bytesReceived += byteLength
    state.nextPageIndex += 1
    state.complete = !exceeded
    state.activeRequestId = undefined
    state.activeRecordCount = undefined
    return this.snapshot(layerId, state)
  }

  fail(layerIdInput: string, requestIdInput: string): ArcGisPaginationSnapshot {
    this.assertLive()
    const layerId = boundedText(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const requestId = boundedText(requestIdInput, 'request-id', this.budget.maxCursorLength)
    const state = this.layers.get(layerId)
    if (!state) throw new Error('unknown-pagination-layer')
    if (state.activeRequestId !== requestId) throw new Error('pagination-result-request-mismatch')
    state.activeRequestId = undefined
    state.activeRecordCount = undefined
    return this.snapshot(layerId, state)
  }

  invalidate(layerIdInput: string, minimumRevisionInput: number): void {
    this.assertLive()
    const layerId = boundedText(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const minimumRevision = boundedInteger(minimumRevisionInput, 'minimumRevision', 0, Number.MAX_SAFE_INTEGER)
    const state = this.layers.get(layerId)
    if (state && minimumRevision > state.revision) this.layers.delete(layerId)
  }

  getSnapshot(layerIdInput: string): ArcGisPaginationSnapshot | undefined {
    this.assertLive()
    const layerId = boundedText(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const state = this.layers.get(layerId)
    return state ? this.snapshot(layerId, state) : undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.layers.clear()
  }

  private normalizeRequest(request: ArcGisPageRequest): ArcGisPageRequest {
    return {
      requestId: boundedText(request.requestId, 'request-id', this.budget.maxCursorLength),
      layerId: boundedText(request.layerId, 'layer-id', this.budget.maxLayerIdLength),
      revision: boundedInteger(request.revision, 'revision', 0, Number.MAX_SAFE_INTEGER),
      pageIndex: boundedInteger(request.pageIndex, 'pageIndex', 0, this.budget.maxPagesPerLayer - 1),
      resultOffset: boundedInteger(request.resultOffset, 'resultOffset', 0, this.budget.maxFeaturesPerLayer),
      resultRecordCount: boundedInteger(request.resultRecordCount, 'resultRecordCount', 1, this.budget.maxFeaturesPerPage),
      cursor: request.cursor === undefined ? undefined : boundedText(request.cursor, 'cursor', this.budget.maxCursorLength),
    }
  }

  private createState(revision: number): LayerState {
    return { revision, pagesCompleted: 0, featuresReceived: 0, bytesReceived: 0, nextPageIndex: 0, complete: false }
  }

  private snapshot(layerId: string, state: LayerState): ArcGisPaginationSnapshot {
    return Object.freeze({
      layerId,
      revision: state.revision,
      pagesCompleted: state.pagesCompleted,
      featuresReceived: state.featuresReceived,
      bytesReceived: state.bytesReceived,
      nextPageIndex: state.nextPageIndex,
      complete: state.complete,
      fingerprint: fingerprint([layerId, String(state.revision), String(state.pagesCompleted), String(state.featuresReceived), String(state.bytesReceived), String(state.nextPageIndex), state.complete ? '1' : '0']),
    })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-pagination-policy-disposed')
  }
}
