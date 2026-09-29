export type ArcGisLayerViewStatus = 'idle' | 'updating' | 'ready' | 'error'

export interface ArcGisLayerViewSignal {
  readonly layerId: string
  readonly revision: string
  readonly generation: number
  readonly status: ArcGisLayerViewStatus
  readonly pendingRequests: number
  readonly visibleFeatures: number
  readonly timestampMs: number
}

export interface ArcGisLayerViewStateBudget {
  readonly maxLayers: number
  readonly maxPendingRequestsPerLayer: number
  readonly maxVisibleFeaturesPerLayer: number
}

export interface ArcGisLayerViewSnapshot {
  readonly revision: string
  readonly signals: readonly ArcGisLayerViewSignal[]
  readonly updating: number
  readonly pendingRequests: number
  readonly visibleFeatures: number
  readonly fingerprint: string
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}

function text(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

/** Bounded scalar state authority; never retains ArcGIS LayerView or request objects. */
export class ArcGisLayerViewStatePolicy {
  private readonly revision: string
  private readonly budget: Readonly<ArcGisLayerViewStateBudget>
  private readonly signals = new Map<string, ArcGisLayerViewSignal>()

  constructor(revisionInput: string, budget: ArcGisLayerViewStateBudget) {
    this.revision = text(revisionInput, 'revision')
    this.budget = Object.freeze({
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1, 10_000),
      maxPendingRequestsPerLayer: integer(budget.maxPendingRequestsPerLayer, 'maxPendingRequestsPerLayer', 0, 10_000),
      maxVisibleFeaturesPerLayer: integer(budget.maxVisibleFeaturesPerLayer, 'maxVisibleFeaturesPerLayer', 0, 10_000_000),
    })
  }

  update(input: ArcGisLayerViewSignal): ArcGisLayerViewSignal {
    const layerId = text(input.layerId, 'layer-id')
    const revision = text(input.revision, 'signal-revision')
    if (revision !== this.revision) throw new Error('stale-layer-view-revision')
    if (!['idle', 'updating', 'ready', 'error'].includes(input.status)) throw new Error('invalid-layer-view-status')
    const previous = this.signals.get(layerId)
    if (!previous && this.signals.size >= this.budget.maxLayers) throw new Error('layer-view-cardinality-exceeded')
    const generation = integer(input.generation, 'generation', 0, Number.MAX_SAFE_INTEGER)
    if (previous && generation < previous.generation) throw new Error('stale-layer-view-generation')
    const timestampMs = integer(input.timestampMs, 'timestampMs', 0, Number.MAX_SAFE_INTEGER)
    if (previous && generation === previous.generation && timestampMs < previous.timestampMs) throw new Error('stale-layer-view-signal')
    const signal = Object.freeze({
      layerId,
      revision,
      generation,
      status: input.status,
      pendingRequests: integer(input.pendingRequests, 'pendingRequests', 0, this.budget.maxPendingRequestsPerLayer),
      visibleFeatures: integer(input.visibleFeatures, 'visibleFeatures', 0, this.budget.maxVisibleFeaturesPerLayer),
      timestampMs,
    })
    if (signal.status === 'ready' && signal.pendingRequests !== 0) throw new Error('ready-layer-view-has-pending-requests')
    this.signals.set(layerId, signal)
    return signal
  }

  remove(layerIdInput: string, expectedGeneration: number): boolean {
    const layerId = text(layerIdInput, 'layer-id')
    const current = this.signals.get(layerId)
    if (!current) return false
    if (current.generation !== integer(expectedGeneration, 'expectedGeneration', 0, Number.MAX_SAFE_INTEGER)) throw new Error('stale-layer-view-removal')
    return this.signals.delete(layerId)
  }

  snapshot(): ArcGisLayerViewSnapshot {
    const signals = Object.freeze([...this.signals.values()].sort((a, b) => a.layerId.localeCompare(b.layerId)))
    const pendingRequests = signals.reduce((sum, signal) => sum + signal.pendingRequests, 0)
    const visibleFeatures = signals.reduce((sum, signal) => sum + signal.visibleFeatures, 0)
    const updating = signals.filter((signal) => signal.status === 'updating').length
    const fingerprint = hash([this.revision, ...signals.map((signal) => `${signal.layerId}:${signal.generation}:${signal.status}:${signal.pendingRequests}:${signal.visibleFeatures}`)].join('|'))
    return Object.freeze({ revision: this.revision, signals, updating, pendingRequests, visibleFeatures, fingerprint })
  }

  clear(): void {
    this.signals.clear()
  }
}
