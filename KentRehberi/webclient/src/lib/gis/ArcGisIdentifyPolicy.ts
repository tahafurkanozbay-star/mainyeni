export type ArcGisIdentifyDimension = '2d' | '3d'
export type ArcGisIdentifyGeometryType = 'point' | 'polyline' | 'polygon'

export interface ArcGisIdentifyLayerFacts {
  readonly layerId: number
  readonly title: string
  readonly visible: boolean
  readonly queryable: boolean
  readonly minScale?: number
  readonly maxScale?: number
  readonly supportedDimensions: readonly ArcGisIdentifyDimension[]
  readonly estimatedFeatureBytes: number
  readonly priority: number
}

export interface ArcGisIdentifyRequest {
  readonly dimension: ArcGisIdentifyDimension
  readonly scale: number
  readonly x: number
  readonly y: number
  readonly spatialReferenceWkid: number
  readonly tolerancePx: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly geometryType: ArcGisIdentifyGeometryType
  readonly layerIds?: readonly number[]
}

export interface ArcGisIdentifyBudget {
  readonly maxLayers: number
  readonly maxEstimatedResponseBytes: number
  readonly maxTolerancePx: number
  readonly maxViewportPixels: number
  readonly maxLayerTitleLength: number
  readonly maxPriority: number
}

export interface ArcGisIdentifyLayerPlan {
  readonly layerId: number
  readonly title: string
  readonly estimatedFeatureBytes: number
  readonly priority: number
}

export interface ArcGisIdentifyPlan {
  readonly dimension: ArcGisIdentifyDimension
  readonly scale: number
  readonly point: Readonly<{ x: number; y: number; spatialReferenceWkid: number }>
  readonly tolerancePx: number
  readonly geometryType: ArcGisIdentifyGeometryType
  readonly layers: readonly ArcGisIdentifyLayerPlan[]
  readonly estimatedResponseBytes: number
  readonly fingerprint: string
}

const MAX_LAYERS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_VIEWPORT_PIXELS = 100_000_000
const WEB_MERCATOR_WKIDS = new Set([102100, 102113, 3857])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
  return Object.is(value, -0) ? 0 : value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function canonicalWkid(value: number): number {
  const wkid = integer(value, 'spatialReferenceWkid', 1, 999_999)
  return WEB_MERCATOR_WKIDS.has(wkid) ? 3857 : wkid
}

function canonicalScale(value: number): number {
  const scale = finite(value, 'scale')
  if (scale <= 0 || scale > 1_000_000_000) throw new Error('scale-out-of-range')
  return scale
}

function canonicalScaleBound(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const result = finite(value, name)
  if (result < 0 || result > 1_000_000_000) throw new Error(`${name}-out-of-range`)
  return result === 0 ? undefined : result
}

function isVisibleAtScale(scale: number, minScale?: number, maxScale?: number): boolean {
  if (minScale !== undefined && scale > minScale) return false
  if (maxScale !== undefined && scale < maxScale) return false
  return true
}

function fingerprint(plan: Omit<ArcGisIdentifyPlan, 'fingerprint'>): string {
  const layerPart = plan.layers.map((layer) => `${layer.layerId}:${layer.priority}:${layer.estimatedFeatureBytes}`).join(',')
  return [
    'identify-v1', plan.dimension, plan.scale, plan.point.x, plan.point.y,
    plan.point.spatialReferenceWkid, plan.tolerancePx, plan.geometryType,
    plan.estimatedResponseBytes, layerPart,
  ].join('|')
}

/**
 * Transport-independent authority for ArcGIS identify admission.
 * It deliberately does not execute network requests or retain ArcGIS SDK objects.
 */
export class ArcGisIdentifyPolicy {
  private readonly budget: Readonly<ArcGisIdentifyBudget>

  constructor(budget: ArcGisIdentifyBudget) {
    this.budget = Object.freeze({
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1, MAX_LAYERS),
      maxEstimatedResponseBytes: integer(budget.maxEstimatedResponseBytes, 'maxEstimatedResponseBytes', 1, MAX_RESPONSE_BYTES),
      maxTolerancePx: integer(budget.maxTolerancePx, 'maxTolerancePx', 0, 256),
      maxViewportPixels: integer(budget.maxViewportPixels, 'maxViewportPixels', 1, MAX_VIEWPORT_PIXELS),
      maxLayerTitleLength: integer(budget.maxLayerTitleLength, 'maxLayerTitleLength', 1, 512),
      maxPriority: integer(budget.maxPriority, 'maxPriority', 0, 1_000_000),
    })
  }

  plan(request: ArcGisIdentifyRequest, layerFacts: readonly ArcGisIdentifyLayerFacts[]): ArcGisIdentifyPlan {
    if (!Array.isArray(layerFacts)) throw new Error('layerFacts must be an array')
    if (layerFacts.length > MAX_LAYERS) throw new Error('layer-facts-cardinality-exceeded')

    const scale = canonicalScale(request.scale)
    const x = finite(request.x, 'x')
    const y = finite(request.y, 'y')
    const spatialReferenceWkid = canonicalWkid(request.spatialReferenceWkid)
    const tolerancePx = integer(request.tolerancePx, 'tolerancePx', 0, this.budget.maxTolerancePx)
    const viewportWidth = integer(request.viewportWidth, 'viewportWidth', 1, 100_000)
    const viewportHeight = integer(request.viewportHeight, 'viewportHeight', 1, 100_000)
    if (viewportWidth > Math.floor(this.budget.maxViewportPixels / viewportHeight)) throw new Error('viewport-pixel-budget-exceeded')
    if (request.dimension !== '2d' && request.dimension !== '3d') throw new Error('invalid-identify-dimension')
    if (!['point', 'polyline', 'polygon'].includes(request.geometryType)) throw new Error('invalid-identify-geometry-type')

    const requestedIds = request.layerIds === undefined ? undefined : this.canonicalLayerIds(request.layerIds)
    const requestedSet = requestedIds ? new Set(requestedIds) : undefined
    const seen = new Set<number>()
    const candidates: ArcGisIdentifyLayerPlan[] = []

    for (const facts of layerFacts) {
      const layerId = integer(facts.layerId, 'layerId', 0, 1_000_000)
      if (seen.has(layerId)) throw new Error(`duplicate-layer-id:${layerId}`)
      seen.add(layerId)
      if (requestedSet && !requestedSet.has(layerId)) continue
      if (!facts.visible || !facts.queryable) continue
      if (!Array.isArray(facts.supportedDimensions) || !facts.supportedDimensions.includes(request.dimension)) continue

      const minScale = canonicalScaleBound(facts.minScale, 'minScale')
      const maxScale = canonicalScaleBound(facts.maxScale, 'maxScale')
      if (minScale !== undefined && maxScale !== undefined && maxScale > minScale) throw new Error(`invalid-scale-range:${layerId}`)
      if (!isVisibleAtScale(scale, minScale, maxScale)) continue

      candidates.push(Object.freeze({
        layerId,
        title: text(facts.title, 'layer-title', this.budget.maxLayerTitleLength),
        estimatedFeatureBytes: integer(facts.estimatedFeatureBytes, 'estimatedFeatureBytes', 0, this.budget.maxEstimatedResponseBytes),
        priority: integer(facts.priority, 'priority', 0, this.budget.maxPriority),
      }))
    }

    if (requestedIds) {
      for (const layerId of requestedIds) if (!seen.has(layerId)) throw new Error(`unknown-requested-layer:${layerId}`)
    }

    candidates.sort((a, b) => b.priority - a.priority || a.layerId - b.layerId)
    const admitted: ArcGisIdentifyLayerPlan[] = []
    let estimatedResponseBytes = 0
    for (const candidate of candidates) {
      if (admitted.length >= this.budget.maxLayers) break
      if (candidate.estimatedFeatureBytes > this.budget.maxEstimatedResponseBytes - estimatedResponseBytes) continue
      admitted.push(candidate)
      estimatedResponseBytes += candidate.estimatedFeatureBytes
    }

    const frozenLayers = Object.freeze([...admitted])
    const partial = Object.freeze({
      dimension: request.dimension,
      scale,
      point: Object.freeze({ x, y, spatialReferenceWkid }),
      tolerancePx,
      geometryType: request.geometryType,
      layers: frozenLayers,
      estimatedResponseBytes,
    })
    return Object.freeze({ ...partial, fingerprint: fingerprint(partial) })
  }

  private canonicalLayerIds(values: readonly number[]): readonly number[] {
    if (!Array.isArray(values)) throw new Error('layerIds must be an array')
    if (values.length > this.budget.maxLayers * 4) throw new Error('requested-layer-cardinality-exceeded')
    const ids = values.map((value) => integer(value, 'requestedLayerId', 0, 1_000_000))
    if (new Set(ids).size !== ids.length) throw new Error('duplicate-requested-layer-id')
    return Object.freeze([...ids].sort((a, b) => a - b))
  }
}
