export type ArcGisViewMode = '2d' | '3d'

export interface ArcGisViewLayerDemand {
  readonly layerId: string
  readonly revision: number
  readonly priority: number
  readonly minScale?: number
  readonly maxScale?: number
  readonly estimatedFeatures: number
  readonly estimatedVertices: number
  readonly estimatedCpuBytes: number
  readonly estimatedGpuBytes: number
  readonly interactive: boolean
}

export interface ArcGisViewBudget {
  readonly maxLayers: number
  readonly maxInteractiveLayers: number
  readonly maxFeatures: number
  readonly maxVertices: number
  readonly maxCpuBytes: number
  readonly maxGpuBytes: number
  readonly maxViewportPixels: number
  readonly maxPixelRatio: number
}

export interface ArcGisViewRequest {
  readonly mode: ArcGisViewMode
  readonly scale: number
  readonly width: number
  readonly height: number
  readonly pixelRatio: number
  readonly layers: readonly ArcGisViewLayerDemand[]
}

export interface ArcGisAdmittedLayer {
  readonly layerId: string
  readonly revision: number
  readonly priority: number
  readonly interactive: boolean
}

export interface ArcGisViewPlan {
  readonly mode: ArcGisViewMode
  readonly scale: number
  readonly viewportPixels: number
  readonly layers: readonly ArcGisAdmittedLayer[]
  readonly totals: Readonly<{
    features: number
    vertices: number
    cpuBytes: number
    gpuBytes: number
    interactiveLayers: number
  }>
  readonly fingerprint: string
}

const MAX_LAYERS = 4096
const MAX_COUNT = 100_000_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_VIEWPORT_PIXELS = 67_108_864

function safeInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer in [${min}, ${max}]`)
  }
  return value
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid-${name}`)
  return value
}

function identifier(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('invalid-layer-id')
  }
  return normalized
}

function scaleVisible(layer: ArcGisViewLayerDemand, scale: number): boolean {
  if (layer.minScale !== undefined && scale > layer.minScale) return false
  if (layer.maxScale !== undefined && scale < layer.maxScale) return false
  return true
}

function hash(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * Transport-independent admission authority for expensive ArcGIS MapView/SceneView work.
 * It deliberately stores no SDK objects, DOM nodes, request handles or payloads.
 */
export class ArcGisViewBudgetPolicy {
  private readonly budget: Readonly<ArcGisViewBudget>

  constructor(input: ArcGisViewBudget) {
    const maxLayers = safeInteger(input.maxLayers, 'maxLayers', 1, MAX_LAYERS)
    const maxInteractiveLayers = safeInteger(input.maxInteractiveLayers, 'maxInteractiveLayers', 0, MAX_LAYERS)
    if (maxInteractiveLayers > maxLayers) throw new Error('maxInteractiveLayers must be <= maxLayers')
    this.budget = Object.freeze({
      maxLayers,
      maxInteractiveLayers,
      maxFeatures: safeInteger(input.maxFeatures, 'maxFeatures', 0, MAX_COUNT),
      maxVertices: safeInteger(input.maxVertices, 'maxVertices', 0, MAX_COUNT),
      maxCpuBytes: safeInteger(input.maxCpuBytes, 'maxCpuBytes', 0, MAX_BYTES),
      maxGpuBytes: safeInteger(input.maxGpuBytes, 'maxGpuBytes', 0, MAX_BYTES),
      maxViewportPixels: safeInteger(input.maxViewportPixels, 'maxViewportPixels', 1, MAX_VIEWPORT_PIXELS),
      maxPixelRatio: finitePositive(input.maxPixelRatio, 'maxPixelRatio'),
    })
  }

  plan(request: ArcGisViewRequest): ArcGisViewPlan {
    if (request.mode !== '2d' && request.mode !== '3d') throw new Error('invalid-view-mode')
    const scale = finitePositive(request.scale, 'scale')
    const width = safeInteger(request.width, 'width', 1, 32768)
    const height = safeInteger(request.height, 'height', 1, 32768)
    const pixelRatio = finitePositive(request.pixelRatio, 'pixelRatio')
    if (pixelRatio > this.budget.maxPixelRatio) throw new Error('pixel-ratio-budget-exceeded')

    const viewportPixels = Math.ceil(width * height * pixelRatio * pixelRatio)
    if (!Number.isSafeInteger(viewportPixels) || viewportPixels > this.budget.maxViewportPixels) {
      throw new Error('viewport-pixel-budget-exceeded')
    }
    if (request.layers.length > MAX_LAYERS) throw new Error('layer-input-budget-exceeded')

    const seen = new Set<string>()
    const normalized = request.layers.map((layer) => {
      const layerId = identifier(layer.layerId)
      if (seen.has(layerId)) throw new Error(`duplicate-layer:${layerId}`)
      seen.add(layerId)
      const revision = safeInteger(layer.revision, 'revision', 0, Number.MAX_SAFE_INTEGER)
      const priority = safeInteger(layer.priority, 'priority', -1_000_000, 1_000_000)
      const estimatedFeatures = safeInteger(layer.estimatedFeatures, 'estimatedFeatures', 0, MAX_COUNT)
      const estimatedVertices = safeInteger(layer.estimatedVertices, 'estimatedVertices', 0, MAX_COUNT)
      const estimatedCpuBytes = safeInteger(layer.estimatedCpuBytes, 'estimatedCpuBytes', 0, MAX_BYTES)
      const estimatedGpuBytes = safeInteger(layer.estimatedGpuBytes, 'estimatedGpuBytes', 0, MAX_BYTES)
      const minScale = layer.minScale === undefined ? undefined : finitePositive(layer.minScale, 'minScale')
      const maxScale = layer.maxScale === undefined ? undefined : finitePositive(layer.maxScale, 'maxScale')
      if (minScale !== undefined && maxScale !== undefined && minScale < maxScale) {
        throw new Error(`invalid-scale-range:${layerId}`)
      }
      return Object.freeze({
        layerId,
        revision,
        priority,
        minScale,
        maxScale,
        estimatedFeatures,
        estimatedVertices,
        estimatedCpuBytes,
        estimatedGpuBytes,
        interactive: layer.interactive === true,
      })
    })

    const visible = normalized
      .filter((layer) => scaleVisible(layer, scale))
      .sort((a, b) => b.priority - a.priority || a.layerId.localeCompare(b.layerId))

    if (visible.length > this.budget.maxLayers) throw new Error('visible-layer-budget-exceeded')

    let features = 0
    let vertices = 0
    let cpuBytes = 0
    let gpuBytes = 0
    let interactiveLayers = 0
    const admitted: ArcGisAdmittedLayer[] = []

    for (const layer of visible) {
      features += layer.estimatedFeatures
      vertices += layer.estimatedVertices
      cpuBytes += layer.estimatedCpuBytes
      gpuBytes += layer.estimatedGpuBytes
      interactiveLayers += layer.interactive ? 1 : 0
      if (features > this.budget.maxFeatures) throw new Error(`feature-budget-exceeded:${layer.layerId}`)
      if (vertices > this.budget.maxVertices) throw new Error(`vertex-budget-exceeded:${layer.layerId}`)
      if (cpuBytes > this.budget.maxCpuBytes) throw new Error(`cpu-byte-budget-exceeded:${layer.layerId}`)
      if (gpuBytes > this.budget.maxGpuBytes) throw new Error(`gpu-byte-budget-exceeded:${layer.layerId}`)
      if (interactiveLayers > this.budget.maxInteractiveLayers) throw new Error(`interactive-layer-budget-exceeded:${layer.layerId}`)
      admitted.push(Object.freeze({
        layerId: layer.layerId,
        revision: layer.revision,
        priority: layer.priority,
        interactive: layer.interactive,
      }))
    }

    const layers = Object.freeze(admitted)
    const totals = Object.freeze({ features, vertices, cpuBytes, gpuBytes, interactiveLayers })
    const fingerprintSource = [
      request.mode,
      scale,
      viewportPixels,
      features,
      vertices,
      cpuBytes,
      gpuBytes,
      interactiveLayers,
      ...layers.map((layer) => `${layer.layerId}@${layer.revision}:${layer.priority}:${layer.interactive ? 1 : 0}`),
    ].join('|')

    return Object.freeze({
      mode: request.mode,
      scale,
      viewportPixels,
      layers,
      totals,
      fingerprint: `view-${hash(fingerprintSource)}`,
    })
  }
}
