export type ArcGisViewDimension = '2d' | '3d'
export type ArcGisVisibilityReason = 'admitted' | 'hidden' | 'outside-scale' | 'outside-extent' | 'unsupported-dimension' | 'feature-budget' | 'gpu-budget' | 'cpu-budget'

export interface ArcGisVisibilityExtent { readonly xmin: number; readonly ymin: number; readonly xmax: number; readonly ymax: number }
export interface ArcGisLayerVisibilityDescriptor {
  readonly id: string
  readonly visible: boolean
  readonly minScale?: number
  readonly maxScale?: number
  readonly extent?: ArcGisVisibilityExtent
  readonly dimensions: readonly ArcGisViewDimension[]
  readonly estimatedFeatures: number
  readonly estimatedGpuBytes: number
  readonly estimatedCpuBytes: number
  readonly priority: number
}
export interface ArcGisLayerVisibilityContext {
  readonly dimension: ArcGisViewDimension
  readonly scale: number
  readonly extent?: ArcGisVisibilityExtent
}
export interface ArcGisLayerVisibilityBudget {
  readonly maxLayers: number
  readonly maxVisibleLayers: number
  readonly maxFeatures: number
  readonly maxGpuBytes: number
  readonly maxCpuBytes: number
}
export interface ArcGisLayerVisibilityDecision {
  readonly id: string
  readonly admitted: boolean
  readonly reason: ArcGisVisibilityReason
  readonly priority: number
}
export interface ArcGisLayerVisibilityPlan {
  readonly decisions: readonly ArcGisLayerVisibilityDecision[]
  readonly admittedIds: readonly string[]
  readonly visibleLayers: number
  readonly estimatedFeatures: number
  readonly estimatedGpuBytes: number
  readonly estimatedCpuBytes: number
  readonly fingerprint: string
}

const MAX_LAYERS = 10_000
const MAX_FEATURES = 10_000_000
const MAX_BYTES = 1024 * 1024 * 1024
const CONTROL = /[\u0000-\u001f\u007f]/

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}
function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be finite in [${min}, ${max}]`)
  return value
}
function layerId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || CONTROL.test(normalized)) throw new Error('invalid-layer-id')
  return normalized
}
function extent(value: ArcGisVisibilityExtent | undefined, name: string): Readonly<ArcGisVisibilityExtent> | undefined {
  if (!value) return undefined
  const xmin = finite(value.xmin, `${name}.xmin`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  const ymin = finite(value.ymin, `${name}.ymin`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  const xmax = finite(value.xmax, `${name}.xmax`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  const ymax = finite(value.ymax, `${name}.ymax`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  if (xmin > xmax || ymin > ymax) throw new Error(`${name}-order-invalid`)
  return Object.freeze({ xmin, ymin, xmax, ymax })
}
function intersects(a: ArcGisVisibilityExtent, b: ArcGisVisibilityExtent): boolean {
  return a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin
}
function scaleVisible(layer: ArcGisLayerVisibilityDescriptor, scale: number): boolean {
  if (layer.minScale !== undefined && layer.minScale > 0 && scale > layer.minScale) return false
  if (layer.maxScale !== undefined && layer.maxScale > 0 && scale < layer.maxScale) return false
  return true
}
function fingerprint(decisions: readonly ArcGisLayerVisibilityDecision[]): string {
  return decisions.map(item => `${item.id}:${item.admitted ? 1 : 0}:${item.reason}:${item.priority}`).join('|')
}

/**
 * Pure render-admission authority shared by 2D/3D layer hosts. It never creates
 * ArcGIS SDK objects or performs I/O; it deterministically decides which already
 * declared layers may consume feature/CPU/GPU budgets for the current view.
 */
export class ArcGisLayerVisibilityPolicy {
  private readonly budget: Readonly<ArcGisLayerVisibilityBudget>

  constructor(budget: ArcGisLayerVisibilityBudget) {
    this.budget = Object.freeze({
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1, MAX_LAYERS),
      maxVisibleLayers: integer(budget.maxVisibleLayers, 'maxVisibleLayers', 1, MAX_LAYERS),
      maxFeatures: integer(budget.maxFeatures, 'maxFeatures', 1, MAX_FEATURES),
      maxGpuBytes: integer(budget.maxGpuBytes, 'maxGpuBytes', 1, MAX_BYTES),
      maxCpuBytes: integer(budget.maxCpuBytes, 'maxCpuBytes', 1, MAX_BYTES),
    })
    if (this.budget.maxVisibleLayers > this.budget.maxLayers) throw new Error('maxVisibleLayers must be <= maxLayers')
  }

  plan(input: readonly ArcGisLayerVisibilityDescriptor[], contextInput: ArcGisLayerVisibilityContext): ArcGisLayerVisibilityPlan {
    if (input.length > this.budget.maxLayers) throw new Error('layer-visibility-input-budget-exceeded')
    const context = this.normalizeContext(contextInput)
    const normalized = input.map(layer => this.normalizeLayer(layer))
    const ids = new Set<string>()
    for (const layer of normalized) {
      if (ids.has(layer.id)) throw new Error(`duplicate-layer-id:${layer.id}`)
      ids.add(layer.id)
    }
    const ordered = [...normalized].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    const decisions: ArcGisLayerVisibilityDecision[] = []
    let visibleLayers = 0
    let estimatedFeatures = 0
    let estimatedGpuBytes = 0
    let estimatedCpuBytes = 0

    for (const layer of ordered) {
      const staticReason = this.staticReason(layer, context)
      if (staticReason) {
        decisions.push(Object.freeze({ id: layer.id, admitted: false, reason: staticReason, priority: layer.priority }))
        continue
      }
      if (visibleLayers + 1 > this.budget.maxVisibleLayers) {
        decisions.push(Object.freeze({ id: layer.id, admitted: false, reason: 'feature-budget', priority: layer.priority }))
        continue
      }
      if (estimatedFeatures + layer.estimatedFeatures > this.budget.maxFeatures) {
        decisions.push(Object.freeze({ id: layer.id, admitted: false, reason: 'feature-budget', priority: layer.priority }))
        continue
      }
      if (estimatedGpuBytes + layer.estimatedGpuBytes > this.budget.maxGpuBytes) {
        decisions.push(Object.freeze({ id: layer.id, admitted: false, reason: 'gpu-budget', priority: layer.priority }))
        continue
      }
      if (estimatedCpuBytes + layer.estimatedCpuBytes > this.budget.maxCpuBytes) {
        decisions.push(Object.freeze({ id: layer.id, admitted: false, reason: 'cpu-budget', priority: layer.priority }))
        continue
      }
      visibleLayers += 1
      estimatedFeatures += layer.estimatedFeatures
      estimatedGpuBytes += layer.estimatedGpuBytes
      estimatedCpuBytes += layer.estimatedCpuBytes
      decisions.push(Object.freeze({ id: layer.id, admitted: true, reason: 'admitted', priority: layer.priority }))
    }

    const stableDecisions = Object.freeze([...decisions].sort((a, b) => a.id.localeCompare(b.id)))
    const admittedIds = Object.freeze(stableDecisions.filter(item => item.admitted).map(item => item.id))
    return Object.freeze({ decisions: stableDecisions, admittedIds, visibleLayers, estimatedFeatures, estimatedGpuBytes, estimatedCpuBytes, fingerprint: fingerprint(stableDecisions) })
  }

  private normalizeContext(input: ArcGisLayerVisibilityContext): Readonly<ArcGisLayerVisibilityContext> {
    if (input.dimension !== '2d' && input.dimension !== '3d') throw new Error('invalid-view-dimension')
    return Object.freeze({ dimension: input.dimension, scale: finite(input.scale, 'scale', 0, Number.MAX_SAFE_INTEGER), extent: extent(input.extent, 'view-extent') })
  }

  private normalizeLayer(input: ArcGisLayerVisibilityDescriptor): Readonly<ArcGisLayerVisibilityDescriptor> {
    const dimensions = [...new Set(input.dimensions)]
    if (!dimensions.length || dimensions.some(value => value !== '2d' && value !== '3d')) throw new Error('invalid-layer-dimensions')
    const minScale = input.minScale === undefined ? undefined : finite(input.minScale, 'minScale', 0, Number.MAX_SAFE_INTEGER)
    const maxScale = input.maxScale === undefined ? undefined : finite(input.maxScale, 'maxScale', 0, Number.MAX_SAFE_INTEGER)
    if (minScale !== undefined && maxScale !== undefined && minScale > 0 && maxScale > 0 && minScale < maxScale) throw new Error('invalid-arcgis-scale-range')
    return Object.freeze({
      ...input,
      id: layerId(input.id),
      minScale,
      maxScale,
      extent: extent(input.extent, 'layer-extent'),
      dimensions: Object.freeze(dimensions.sort()),
      estimatedFeatures: integer(input.estimatedFeatures, 'estimatedFeatures', 0, MAX_FEATURES),
      estimatedGpuBytes: integer(input.estimatedGpuBytes, 'estimatedGpuBytes', 0, MAX_BYTES),
      estimatedCpuBytes: integer(input.estimatedCpuBytes, 'estimatedCpuBytes', 0, MAX_BYTES),
      priority: integer(input.priority, 'priority', -1_000_000, 1_000_000),
    })
  }

  private staticReason(layer: ArcGisLayerVisibilityDescriptor, context: ArcGisLayerVisibilityContext): ArcGisVisibilityReason | undefined {
    if (!layer.visible) return 'hidden'
    if (!layer.dimensions.includes(context.dimension)) return 'unsupported-dimension'
    if (!scaleVisible(layer, context.scale)) return 'outside-scale'
    if (layer.extent && context.extent && !intersects(layer.extent, context.extent)) return 'outside-extent'
    return undefined
  }
}
