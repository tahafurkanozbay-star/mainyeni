export type ArcGisFeatureReductionMode = 'none' | 'cluster'
export type ArcGisFeatureReductionViewMode = '2d' | '3d'

export interface ArcGisFeatureReductionLayer {
  readonly id: string
  readonly revision: number
  readonly visible: boolean
  readonly clusterable: boolean
  readonly minScale: number
  readonly maxScale: number
  readonly estimatedFeatureCount: number
  readonly estimatedVertexCount: number
  readonly estimatedGpuBytes: number
}

export interface ArcGisFeatureReductionRequest {
  readonly expectedRevision: number
  readonly scale: number
  readonly viewMode: ArcGisFeatureReductionViewMode
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly pixelRatio: number
  readonly preferredRadius: number
  readonly layers: readonly ArcGisFeatureReductionLayer[]
}

export interface ArcGisFeatureReductionBudget {
  readonly maxLayers: number
  readonly maxFeatures: number
  readonly maxVertices: number
  readonly maxGpuBytes: number
  readonly maxViewportPixels: number
  readonly maxPixelRatio: number
  readonly minClusterRadius: number
  readonly maxClusterRadius: number
  readonly maxEstimatedClusters: number
}

export interface ArcGisFeatureReductionLayerPlan {
  readonly id: string
  readonly revision: number
  readonly mode: ArcGisFeatureReductionMode
  readonly clusterRadius: number
  readonly estimatedClusters: number
  readonly estimatedFeatureCount: number
  readonly estimatedVertexCount: number
  readonly estimatedGpuBytes: number
}

export interface ArcGisFeatureReductionPlan {
  readonly revision: number
  readonly scale: number
  readonly viewMode: ArcGisFeatureReductionViewMode
  readonly viewportPixels: number
  readonly layers: readonly ArcGisFeatureReductionLayerPlan[]
  readonly totals: Readonly<{
    features: number
    vertices: number
    gpuBytes: number
    estimatedClusters: number
  }>
  readonly fingerprint: string
}

const MAX_SCALE = 1_000_000_000
const MAX_DIMENSION = 32_768

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer in [${min}, ${max}]`)
  }
  return value
}

function finiteScale(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_SCALE) {
    throw new Error(`${name} must be finite in [0, ${MAX_SCALE}]`)
  }
  return value
}

function identifier(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('invalid feature-reduction layer id')
  }
  return normalized
}

function scaleVisible(layer: ArcGisFeatureReductionLayer, scale: number): boolean {
  const withinMin = layer.minScale === 0 || scale <= layer.minScale
  const withinMax = layer.maxScale === 0 || scale >= layer.maxScale
  return withinMin && withinMax
}

function stableHash(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function immutableLayer(plan: ArcGisFeatureReductionLayerPlan): ArcGisFeatureReductionLayerPlan {
  return Object.freeze({ ...plan })
}

/**
 * Pure admission authority for ArcGIS feature reduction. It deliberately owns no
 * SDK Layer/LayerView, request, timer or browser object, so plans can be tested,
 * cached and discarded without extending ArcGIS resource lifetimes.
 */
export class ArcGisFeatureReductionPolicy {
  private readonly budget: Readonly<ArcGisFeatureReductionBudget>

  constructor(input: ArcGisFeatureReductionBudget) {
    const minClusterRadius = boundedInteger(input.minClusterRadius, 'minClusterRadius', 1, 512)
    const maxClusterRadius = boundedInteger(input.maxClusterRadius, 'maxClusterRadius', minClusterRadius, 512)
    this.budget = Object.freeze({
      maxLayers: boundedInteger(input.maxLayers, 'maxLayers', 1, 256),
      maxFeatures: boundedInteger(input.maxFeatures, 'maxFeatures', 1, 10_000_000),
      maxVertices: boundedInteger(input.maxVertices, 'maxVertices', 1, 100_000_000),
      maxGpuBytes: boundedInteger(input.maxGpuBytes, 'maxGpuBytes', 1, 2_147_483_648),
      maxViewportPixels: boundedInteger(input.maxViewportPixels, 'maxViewportPixels', 1, 268_435_456),
      maxPixelRatio: boundedInteger(input.maxPixelRatio, 'maxPixelRatio', 1, 8),
      minClusterRadius,
      maxClusterRadius,
      maxEstimatedClusters: boundedInteger(input.maxEstimatedClusters, 'maxEstimatedClusters', 1, 1_000_000),
    })
  }

  plan(request: ArcGisFeatureReductionRequest): ArcGisFeatureReductionPlan {
    const expectedRevision = boundedInteger(request.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER)
    const scale = finiteScale(request.scale, 'scale')
    if (request.viewMode !== '2d' && request.viewMode !== '3d') throw new Error('invalid feature-reduction view mode')
    const width = boundedInteger(request.viewportWidth, 'viewportWidth', 1, MAX_DIMENSION)
    const height = boundedInteger(request.viewportHeight, 'viewportHeight', 1, MAX_DIMENSION)
    const pixelRatio = boundedInteger(request.pixelRatio, 'pixelRatio', 1, this.budget.maxPixelRatio)
    const viewportPixels = width * height * pixelRatio * pixelRatio
    if (!Number.isSafeInteger(viewportPixels) || viewportPixels > this.budget.maxViewportPixels) {
      throw new Error('feature-reduction viewport pixel budget exceeded')
    }
    if (request.layers.length > this.budget.maxLayers) throw new Error('feature-reduction layer budget exceeded')
    const preferredRadius = boundedInteger(
      request.preferredRadius,
      'preferredRadius',
      this.budget.minClusterRadius,
      this.budget.maxClusterRadius,
    )
    const seen = new Set<string>()
    const admitted: ArcGisFeatureReductionLayerPlan[] = []
    let features = 0
    let vertices = 0
    let gpuBytes = 0
    let estimatedClusters = 0

    const ordered = [...request.layers].map((layer) => {
      const id = identifier(layer.id)
      if (seen.has(id)) throw new Error(`duplicate feature-reduction layer:${id}`)
      seen.add(id)
      const revision = boundedInteger(layer.revision, `revision:${id}`, 0, Number.MAX_SAFE_INTEGER)
      if (revision !== expectedRevision) throw new Error(`stale feature-reduction layer:${id}`)
      const minScale = finiteScale(layer.minScale, `minScale:${id}`)
      const maxScale = finiteScale(layer.maxScale, `maxScale:${id}`)
      if (minScale > 0 && maxScale > 0 && minScale < maxScale) throw new Error(`invalid ArcGIS scale range:${id}`)
      return {
        id,
        revision,
        visible: layer.visible,
        clusterable: layer.clusterable,
        minScale,
        maxScale,
        estimatedFeatureCount: boundedInteger(layer.estimatedFeatureCount, `features:${id}`, 0, this.budget.maxFeatures),
        estimatedVertexCount: boundedInteger(layer.estimatedVertexCount, `vertices:${id}`, 0, this.budget.maxVertices),
        estimatedGpuBytes: boundedInteger(layer.estimatedGpuBytes, `gpuBytes:${id}`, 0, this.budget.maxGpuBytes),
      }
    }).sort((left, right) => left.id.localeCompare(right.id))

    for (const layer of ordered) {
      if (!layer.visible || !scaleVisible(layer, scale)) continue
      features += layer.estimatedFeatureCount
      vertices += layer.estimatedVertexCount
      gpuBytes += layer.estimatedGpuBytes
      if (features > this.budget.maxFeatures) throw new Error('feature-reduction feature budget exceeded')
      if (vertices > this.budget.maxVertices) throw new Error('feature-reduction vertex budget exceeded')
      if (gpuBytes > this.budget.maxGpuBytes) throw new Error('feature-reduction GPU budget exceeded')

      const density = layer.estimatedFeatureCount / Math.max(1, viewportPixels)
      const shouldCluster = layer.clusterable && layer.estimatedFeatureCount > 1 && density * preferredRadius * preferredRadius >= 0.25
      const layerClusters = shouldCluster
        ? Math.min(layer.estimatedFeatureCount, Math.ceil(viewportPixels / (preferredRadius * preferredRadius)))
        : layer.estimatedFeatureCount
      estimatedClusters += layerClusters
      if (estimatedClusters > this.budget.maxEstimatedClusters) throw new Error('feature-reduction cluster budget exceeded')
      admitted.push(immutableLayer({
        id: layer.id,
        revision: layer.revision,
        mode: shouldCluster ? 'cluster' : 'none',
        clusterRadius: shouldCluster ? preferredRadius : 0,
        estimatedClusters: layerClusters,
        estimatedFeatureCount: layer.estimatedFeatureCount,
        estimatedVertexCount: layer.estimatedVertexCount,
        estimatedGpuBytes: layer.estimatedGpuBytes,
      }))
    }

    const frozenLayers = Object.freeze(admitted)
    const totals = Object.freeze({ features, vertices, gpuBytes, estimatedClusters })
    const fingerprintPayload = [
      expectedRevision,
      scale,
      request.viewMode,
      viewportPixels,
      ...frozenLayers.map((layer) => [
        layer.id,
        layer.revision,
        layer.mode,
        layer.clusterRadius,
        layer.estimatedClusters,
        layer.estimatedFeatureCount,
        layer.estimatedVertexCount,
        layer.estimatedGpuBytes,
      ].join(':')),
    ].join('|')
    return Object.freeze({
      revision: expectedRevision,
      scale,
      viewMode: request.viewMode,
      viewportPixels,
      layers: frozenLayers,
      totals,
      fingerprint: stableHash(fingerprintPayload),
    })
  }

  snapshotBudget(): Readonly<ArcGisFeatureReductionBudget> {
    return this.budget
  }
}
