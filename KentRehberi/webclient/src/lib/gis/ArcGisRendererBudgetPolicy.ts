export type ArcGisViewMode = '2d' | '3d'
export type ArcGisGeometryKind = 'point' | 'polyline' | 'polygon' | 'mesh'
export type ArcGisRendererMode = 'simple' | 'unique-value' | 'class-breaks' | 'heatmap' | 'cluster'

export interface ArcGisRendererCandidate {
  readonly layerId: string
  readonly view: ArcGisViewMode
  readonly geometry: ArcGisGeometryKind
  readonly renderer: ArcGisRendererMode
  readonly featureCount: number
  readonly vertexCount: number
  readonly symbolCount: number
  readonly textureBytes: number
  readonly bufferBytes: number
  readonly labelCount: number
  readonly popupFieldCount: number
  readonly scale: number
  readonly minScale?: number
  readonly maxScale?: number
  readonly clusterRadius?: number
}

export interface ArcGisRendererBudget {
  readonly maxFeatures2d: number
  readonly maxFeatures3d: number
  readonly maxVertices2d: number
  readonly maxVertices3d: number
  readonly maxSymbols: number
  readonly maxTextureBytes: number
  readonly maxBufferBytes: number
  readonly maxLabels: number
  readonly maxPopupFields: number
  readonly maxClusterRadius: number
  readonly maxLayers: number
}

export interface ArcGisRendererDecision {
  readonly accepted: boolean
  readonly layerId: string
  readonly reason?: string
  readonly renderer: ArcGisRendererMode
  readonly effectiveFeatureCount: number
  readonly effectiveVertexCount: number
  readonly textureBytes: number
  readonly bufferBytes: number
  readonly labelsEnabled: boolean
  readonly popupFieldCount: number
}

export interface ArcGisRendererPlan {
  readonly accepted: boolean
  readonly decisions: readonly ArcGisRendererDecision[]
  readonly totalTextureBytes: number
  readonly totalBufferBytes: number
  readonly totalSymbols: number
  readonly totalLabels: number
  readonly reason?: string
}

const MAX_COUNT = 100_000_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_SCALE = 1_000_000_000_000

function integer(value: number, name: string, max = MAX_COUNT): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer in [0, ${max}]`)
  return value
}

function positiveInteger(value: number, name: string, max = MAX_COUNT): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer in [1, ${max}]`)
  return value
}

function id(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('layerId must contain 1..256 safe characters')
  return normalized
}

function scale(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0 || value > MAX_SCALE) throw new Error(`${name} must be finite and in [0, ${MAX_SCALE}]`)
  return value
}

function visibleAtScale(current: number, minScale?: number, maxScale?: number): boolean {
  if (minScale !== undefined && maxScale !== undefined && minScale !== 0 && maxScale !== 0 && minScale < maxScale) throw new Error('minScale must be >= maxScale')
  if (minScale !== undefined && minScale !== 0 && current > minScale) return false
  if (maxScale !== undefined && maxScale !== 0 && current < maxScale) return false
  return true
}

function validateCandidate(candidate: ArcGisRendererCandidate): ArcGisRendererCandidate {
  const layerId = id(candidate.layerId)
  const featureCount = integer(candidate.featureCount, 'featureCount')
  const vertexCount = integer(candidate.vertexCount, 'vertexCount')
  const symbolCount = integer(candidate.symbolCount, 'symbolCount')
  const textureBytes = integer(candidate.textureBytes, 'textureBytes', MAX_BYTES)
  const bufferBytes = integer(candidate.bufferBytes, 'bufferBytes', MAX_BYTES)
  const labelCount = integer(candidate.labelCount, 'labelCount')
  const popupFieldCount = integer(candidate.popupFieldCount, 'popupFieldCount', 10_000)
  const currentScale = scale(candidate.scale, 'scale') ?? 0
  const minScale = scale(candidate.minScale, 'minScale')
  const maxScale = scale(candidate.maxScale, 'maxScale')
  const clusterRadius = candidate.clusterRadius === undefined ? undefined : integer(candidate.clusterRadius, 'clusterRadius', 2048)
  if (candidate.renderer === 'cluster' && candidate.geometry !== 'point') throw new Error('cluster renderer requires point geometry')
  if (candidate.renderer === 'heatmap' && candidate.geometry !== 'point') throw new Error('heatmap renderer requires point geometry')
  if (candidate.view === '3d' && candidate.renderer === 'heatmap') throw new Error('heatmap renderer is not admitted in 3d')
  visibleAtScale(currentScale, minScale, maxScale)
  return Object.freeze({ ...candidate, layerId, featureCount, vertexCount, symbolCount, textureBytes, bufferBytes, labelCount, popupFieldCount, scale: currentScale, minScale, maxScale, clusterRadius })
}

export class ArcGisRendererBudgetPolicy {
  private readonly budget: ArcGisRendererBudget

  constructor(budget: ArcGisRendererBudget) {
    this.budget = Object.freeze({
      maxFeatures2d: positiveInteger(budget.maxFeatures2d, 'maxFeatures2d'),
      maxFeatures3d: positiveInteger(budget.maxFeatures3d, 'maxFeatures3d'),
      maxVertices2d: positiveInteger(budget.maxVertices2d, 'maxVertices2d'),
      maxVertices3d: positiveInteger(budget.maxVertices3d, 'maxVertices3d'),
      maxSymbols: positiveInteger(budget.maxSymbols, 'maxSymbols'),
      maxTextureBytes: positiveInteger(budget.maxTextureBytes, 'maxTextureBytes', MAX_BYTES),
      maxBufferBytes: positiveInteger(budget.maxBufferBytes, 'maxBufferBytes', MAX_BYTES),
      maxLabels: positiveInteger(budget.maxLabels, 'maxLabels'),
      maxPopupFields: positiveInteger(budget.maxPopupFields, 'maxPopupFields', 10_000),
      maxClusterRadius: positiveInteger(budget.maxClusterRadius, 'maxClusterRadius', 2048),
      maxLayers: positiveInteger(budget.maxLayers, 'maxLayers', 10_000),
    })
  }

  plan(input: readonly ArcGisRendererCandidate[]): ArcGisRendererPlan {
    if (input.length > this.budget.maxLayers) return this.reject([], 'layer-budget-exceeded')
    const seen = new Set<string>()
    const decisions: ArcGisRendererDecision[] = []
    let totalTextureBytes = 0
    let totalBufferBytes = 0
    let totalSymbols = 0
    let totalLabels = 0

    for (const raw of input) {
      let candidate: ArcGisRendererCandidate
      try { candidate = validateCandidate(raw) } catch (error) { return this.reject(decisions, error instanceof Error ? error.message : 'invalid-renderer-candidate') }
      if (seen.has(candidate.layerId)) return this.reject(decisions, `duplicate-layer:${candidate.layerId}`)
      seen.add(candidate.layerId)

      if (!visibleAtScale(candidate.scale, candidate.minScale, candidate.maxScale)) {
        decisions.push(this.decision(candidate, false, 'outside-scale-range', false))
        continue
      }

      const featureLimit = candidate.view === '2d' ? this.budget.maxFeatures2d : this.budget.maxFeatures3d
      const vertexLimit = candidate.view === '2d' ? this.budget.maxVertices2d : this.budget.maxVertices3d
      if (candidate.featureCount > featureLimit) {
        if (candidate.geometry === 'point' && candidate.renderer === 'cluster') {
          if ((candidate.clusterRadius ?? 0) < 1 || (candidate.clusterRadius ?? 0) > this.budget.maxClusterRadius) return this.reject(decisions, `cluster-radius-budget-exceeded:${candidate.layerId}`)
        } else return this.reject(decisions, `feature-budget-exceeded:${candidate.layerId}`)
      }
      if (candidate.vertexCount > vertexLimit) return this.reject(decisions, `vertex-budget-exceeded:${candidate.layerId}`)
      if (candidate.symbolCount > this.budget.maxSymbols) return this.reject(decisions, `symbol-budget-exceeded:${candidate.layerId}`)
      if (candidate.popupFieldCount > this.budget.maxPopupFields) return this.reject(decisions, `popup-field-budget-exceeded:${candidate.layerId}`)

      if (totalTextureBytes + candidate.textureBytes > this.budget.maxTextureBytes) return this.reject(decisions, `texture-budget-exceeded:${candidate.layerId}`)
      if (totalBufferBytes + candidate.bufferBytes > this.budget.maxBufferBytes) return this.reject(decisions, `buffer-budget-exceeded:${candidate.layerId}`)
      if (totalSymbols + candidate.symbolCount > this.budget.maxSymbols) return this.reject(decisions, `aggregate-symbol-budget-exceeded:${candidate.layerId}`)

      const labelsEnabled = candidate.labelCount > 0 && totalLabels + candidate.labelCount <= this.budget.maxLabels
      totalTextureBytes += candidate.textureBytes
      totalBufferBytes += candidate.bufferBytes
      totalSymbols += candidate.symbolCount
      if (labelsEnabled) totalLabels += candidate.labelCount
      decisions.push(this.decision(candidate, true, undefined, labelsEnabled))
    }

    return Object.freeze({ accepted: true, decisions: Object.freeze(decisions), totalTextureBytes, totalBufferBytes, totalSymbols, totalLabels })
  }

  private decision(candidate: ArcGisRendererCandidate, accepted: boolean, reason: string | undefined, labelsEnabled: boolean): ArcGisRendererDecision {
    return Object.freeze({ accepted, layerId: candidate.layerId, reason, renderer: candidate.renderer, effectiveFeatureCount: accepted ? candidate.featureCount : 0, effectiveVertexCount: accepted ? candidate.vertexCount : 0, textureBytes: accepted ? candidate.textureBytes : 0, bufferBytes: accepted ? candidate.bufferBytes : 0, labelsEnabled, popupFieldCount: accepted ? candidate.popupFieldCount : 0 })
  }

  private reject(decisions: readonly ArcGisRendererDecision[], reason: string): ArcGisRendererPlan {
    return Object.freeze({ accepted: false, decisions: Object.freeze([...decisions]), totalTextureBytes: 0, totalBufferBytes: 0, totalSymbols: 0, totalLabels: 0, reason })
  }
}
