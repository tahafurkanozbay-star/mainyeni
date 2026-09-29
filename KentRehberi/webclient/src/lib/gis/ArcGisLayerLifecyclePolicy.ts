export type ArcGisLayerKind = 'feature' | 'map-image' | 'scene' | 'graphics' | 'tile' | 'elevation'
export type ArcGisLayerPhase = 'registered' | 'loading' | 'ready' | 'suspended' | 'failed' | 'disposed'
export type ArcGisViewMode = '2d' | '3d'

export interface ArcGisLayerDescriptor {
  readonly id: string
  readonly kind: ArcGisLayerKind
  readonly revision: string
  readonly visible: boolean
  readonly minScale: number
  readonly maxScale: number
  readonly priority: number
  readonly estimatedCpuBytes: number
  readonly estimatedGpuBytes: number
  readonly estimatedFeatureCount: number
  readonly supports2d: boolean
  readonly supports3d: boolean
}

export interface ArcGisLayerLifecycleBudget {
  readonly maxLayers: number
  readonly maxActiveLayers: number
  readonly maxCpuBytes: number
  readonly maxGpuBytes: number
  readonly maxFeatureCount: number
  readonly maxIdLength: number
  readonly maxRevisionLength: number
  readonly maxFailuresPerLayer: number
}

export interface ArcGisLayerRecord extends ArcGisLayerDescriptor {
  readonly phase: ArcGisLayerPhase
  readonly generation: number
  readonly failures: number
  readonly lastTransitionAtMs: number
  readonly failureReason?: string
}

export interface ArcGisLayerAdmissionPlan {
  readonly revision: string
  readonly viewMode: ArcGisViewMode
  readonly scale: number
  readonly activeLayerIds: readonly string[]
  readonly suspendedLayerIds: readonly string[]
  readonly cpuBytes: number
  readonly gpuBytes: number
  readonly featureCount: number
  readonly fingerprint: string
}

export interface ArcGisLayerLifecycleSnapshot {
  readonly revision: string
  readonly layers: readonly ArcGisLayerRecord[]
  readonly registered: number
  readonly loading: number
  readonly ready: number
  readonly suspended: number
  readonly failed: number
  readonly disposed: number
}

const KINDS = new Set<ArcGisLayerKind>(['feature', 'map-image', 'scene', 'graphics', 'tile', 'elevation'])
const MAX_LAYERS = 10_000
const MAX_BYTES = 4 * 1024 * 1024 * 1024
const MAX_FEATURES = 100_000_000
const CONTROL = /[\u0000-\u001f\u007f]/

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be finite in [${min}, ${max}]`)
  }
  return value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || CONTROL.test(normalized)) {
    throw new Error(`invalid-${name}`)
  }
  return normalized
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function freezeRecord(record: ArcGisLayerRecord): ArcGisLayerRecord {
  return Object.freeze({ ...record })
}

function scaleVisible(layer: ArcGisLayerRecord, scale: number): boolean {
  if (!layer.visible) return false
  if (layer.minScale > 0 && scale > layer.minScale) return false
  if (layer.maxScale > 0 && scale < layer.maxScale) return false
  return true
}

function modeSupported(layer: ArcGisLayerRecord, mode: ArcGisViewMode): boolean {
  return mode === '2d' ? layer.supports2d : layer.supports3d
}

function canActivate(layer: ArcGisLayerRecord): boolean {
  return layer.phase === 'ready' || layer.phase === 'suspended'
}

function activationOrder(a: ArcGisLayerRecord, b: ArcGisLayerRecord): number {
  return b.priority - a.priority || a.id.localeCompare(b.id)
}

/**
 * Transport-independent lifecycle authority for ArcGIS operational layers.
 *
 * It deliberately retains descriptors and scalar accounting only. ArcGIS SDK layer/view
 * objects, network handles, AbortControllers, DOM nodes and renderer resources stay owned
 * by adapters. This keeps disposal explicit and prevents this policy from extending SDK
 * object lifetimes accidentally.
 */
export class ArcGisLayerLifecyclePolicy {
  private readonly budget: Readonly<ArcGisLayerLifecycleBudget>
  private readonly records = new Map<string, ArcGisLayerRecord>()
  private revision: string
  private disposed = false

  constructor(revision: string, budget: ArcGisLayerLifecycleBudget) {
    this.budget = Object.freeze({
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1, MAX_LAYERS),
      maxActiveLayers: integer(budget.maxActiveLayers, 'maxActiveLayers', 1, MAX_LAYERS),
      maxCpuBytes: integer(budget.maxCpuBytes, 'maxCpuBytes', 1, MAX_BYTES),
      maxGpuBytes: integer(budget.maxGpuBytes, 'maxGpuBytes', 1, MAX_BYTES),
      maxFeatureCount: integer(budget.maxFeatureCount, 'maxFeatureCount', 1, MAX_FEATURES),
      maxIdLength: integer(budget.maxIdLength, 'maxIdLength', 1, 256),
      maxRevisionLength: integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 256),
      maxFailuresPerLayer: integer(budget.maxFailuresPerLayer, 'maxFailuresPerLayer', 0, 100),
    })
    if (this.budget.maxActiveLayers > this.budget.maxLayers) {
      throw new Error('maxActiveLayers must be <= maxLayers')
    }
    this.revision = text(revision, 'revision', this.budget.maxRevisionLength)
  }

  register(descriptor: ArcGisLayerDescriptor, nowMs: number): ArcGisLayerRecord {
    this.assertLive()
    if (this.records.size >= this.budget.maxLayers) throw new Error('layer-count-budget-exceeded')
    const id = text(descriptor.id, 'layer-id', this.budget.maxIdLength)
    if (this.records.has(id)) throw new Error('duplicate-layer-id')
    if (!KINDS.has(descriptor.kind)) throw new Error('unsupported-layer-kind')
    const revision = text(descriptor.revision, 'layer-revision', this.budget.maxRevisionLength)
    if (revision !== this.revision) throw new Error('stale-layer-revision')
    const minScale = finite(descriptor.minScale, 'minScale', 0, Number.MAX_SAFE_INTEGER)
    const maxScale = finite(descriptor.maxScale, 'maxScale', 0, Number.MAX_SAFE_INTEGER)
    if (minScale > 0 && maxScale > 0 && maxScale > minScale) throw new Error('invalid-scale-range')
    const record = freezeRecord({
      id,
      kind: descriptor.kind,
      revision,
      visible: descriptor.visible,
      minScale,
      maxScale,
      priority: integer(descriptor.priority, 'priority', -1_000_000, 1_000_000),
      estimatedCpuBytes: integer(descriptor.estimatedCpuBytes, 'estimatedCpuBytes', 0, this.budget.maxCpuBytes),
      estimatedGpuBytes: integer(descriptor.estimatedGpuBytes, 'estimatedGpuBytes', 0, this.budget.maxGpuBytes),
      estimatedFeatureCount: integer(descriptor.estimatedFeatureCount, 'estimatedFeatureCount', 0, this.budget.maxFeatureCount),
      supports2d: descriptor.supports2d,
      supports3d: descriptor.supports3d,
      phase: 'registered',
      generation: 0,
      failures: 0,
      lastTransitionAtMs: integer(nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER),
    })
    if (!record.supports2d && !record.supports3d) throw new Error('layer-supports-no-view-mode')
    this.records.set(id, record)
    return record
  }

  beginLoad(idInput: string, expectedRevision: string, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase !== 'registered' && record.phase !== 'failed') throw new Error('invalid-begin-load-transition')
    if (record.failures > this.budget.maxFailuresPerLayer) throw new Error('layer-failure-budget-exceeded')
    return this.replace(record, {
      phase: 'loading',
      generation: record.generation + 1,
      lastTransitionAtMs: this.time(nowMs),
      failureReason: undefined,
    })
  }

  markReady(idInput: string, expectedRevision: string, generation: number, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase !== 'loading') throw new Error('invalid-ready-transition')
    this.assertGeneration(record, generation)
    return this.replace(record, {
      phase: 'ready',
      lastTransitionAtMs: this.time(nowMs),
      failureReason: undefined,
    })
  }

  markFailed(idInput: string, expectedRevision: string, generation: number, reasonInput: string, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase !== 'loading') throw new Error('invalid-failed-transition')
    this.assertGeneration(record, generation)
    const failures = record.failures + 1
    if (failures > this.budget.maxFailuresPerLayer + 1) throw new Error('layer-failure-accounting-invalid')
    return this.replace(record, {
      phase: 'failed',
      failures,
      lastTransitionAtMs: this.time(nowMs),
      failureReason: text(reasonInput, 'failure-reason', 512),
    })
  }

  suspend(idInput: string, expectedRevision: string, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase !== 'ready') throw new Error('invalid-suspend-transition')
    return this.replace(record, {
      phase: 'suspended',
      lastTransitionAtMs: this.time(nowMs),
    })
  }

  resume(idInput: string, expectedRevision: string, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase !== 'suspended') throw new Error('invalid-resume-transition')
    return this.replace(record, {
      phase: 'ready',
      lastTransitionAtMs: this.time(nowMs),
    })
  }

  disposeLayer(idInput: string, expectedRevision: string, nowMs: number): ArcGisLayerRecord {
    const record = this.requireCurrent(idInput, expectedRevision)
    if (record.phase === 'disposed') return record
    return this.replace(record, {
      phase: 'disposed',
      lastTransitionAtMs: this.time(nowMs),
      failureReason: undefined,
    })
  }

  removeDisposed(idInput: string): boolean {
    this.assertLive()
    const id = text(idInput, 'layer-id', this.budget.maxIdLength)
    const record = this.records.get(id)
    if (!record) return false
    if (record.phase !== 'disposed') throw new Error('cannot-remove-live-layer')
    return this.records.delete(id)
  }

  rebaseRevision(nextRevisionInput: string): void {
    this.assertLive()
    if ([...this.records.values()].some((record) => record.phase === 'loading')) {
      throw new Error('cannot-rebase-while-loading')
    }
    const nextRevision = text(nextRevisionInput, 'revision', this.budget.maxRevisionLength)
    if (nextRevision === this.revision) return
    this.revision = nextRevision
    for (const record of this.records.values()) {
      if (record.phase === 'disposed') continue
      this.records.set(record.id, freezeRecord({
        ...record,
        revision: nextRevision,
        generation: record.generation + 1,
        phase: 'registered',
        failureReason: undefined,
      }))
    }
  }

  plan(input: { readonly expectedRevision: string; readonly viewMode: ArcGisViewMode; readonly scale: number }): ArcGisLayerAdmissionPlan {
    this.assertLive()
    const expectedRevision = text(input.expectedRevision, 'expected-revision', this.budget.maxRevisionLength)
    if (expectedRevision !== this.revision) throw new Error('stale-plan-revision')
    if (input.viewMode !== '2d' && input.viewMode !== '3d') throw new Error('invalid-view-mode')
    const scale = finite(input.scale, 'scale', 1, Number.MAX_SAFE_INTEGER)
    const candidates = [...this.records.values()]
      .filter((record) => canActivate(record) && modeSupported(record, input.viewMode) && scaleVisible(record, scale))
      .sort(activationOrder)
    const active: string[] = []
    const suspended: string[] = []
    let cpuBytes = 0
    let gpuBytes = 0
    let featureCount = 0
    for (const record of candidates) {
      const nextCpu = cpuBytes + record.estimatedCpuBytes
      const nextGpu = gpuBytes + record.estimatedGpuBytes
      const nextFeatures = featureCount + record.estimatedFeatureCount
      const admitted = active.length < this.budget.maxActiveLayers
        && nextCpu <= this.budget.maxCpuBytes
        && nextGpu <= this.budget.maxGpuBytes
        && nextFeatures <= this.budget.maxFeatureCount
      if (!admitted) {
        suspended.push(record.id)
        continue
      }
      active.push(record.id)
      cpuBytes = nextCpu
      gpuBytes = nextGpu
      featureCount = nextFeatures
    }
    const activeLayerIds = Object.freeze(active)
    const suspendedLayerIds = Object.freeze(suspended)
    const fingerprintSource = [
      this.revision,
      input.viewMode,
      String(scale),
      ...active.map((id) => `a:${id}`),
      ...suspended.map((id) => `s:${id}`),
      String(cpuBytes),
      String(gpuBytes),
      String(featureCount),
    ].join('|')
    return Object.freeze({
      revision: this.revision,
      viewMode: input.viewMode,
      scale,
      activeLayerIds,
      suspendedLayerIds,
      cpuBytes,
      gpuBytes,
      featureCount,
      fingerprint: stableHash(fingerprintSource),
    })
  }

  snapshot(): ArcGisLayerLifecycleSnapshot {
    this.assertLive()
    const layers = Object.freeze([...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)))
    const count = (phase: ArcGisLayerPhase): number => layers.filter((layer) => layer.phase === phase).length
    return Object.freeze({
      revision: this.revision,
      layers,
      registered: count('registered'),
      loading: count('loading'),
      ready: count('ready'),
      suspended: count('suspended'),
      failed: count('failed'),
      disposed: count('disposed'),
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
  }

  private requireCurrent(idInput: string, expectedRevisionInput: string): ArcGisLayerRecord {
    this.assertLive()
    const id = text(idInput, 'layer-id', this.budget.maxIdLength)
    const expectedRevision = text(expectedRevisionInput, 'expected-revision', this.budget.maxRevisionLength)
    if (expectedRevision !== this.revision) throw new Error('stale-lifecycle-revision')
    const record = this.records.get(id)
    if (!record) throw new Error('unknown-layer-id')
    if (record.revision !== this.revision) throw new Error('layer-revision-integrity-failure')
    return record
  }

  private assertGeneration(record: ArcGisLayerRecord, generation: number): void {
    const expected = integer(generation, 'generation', 0, Number.MAX_SAFE_INTEGER)
    if (record.generation !== expected) throw new Error('stale-layer-generation')
  }

  private time(nowMs: number): number {
    return integer(nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
  }

  private replace(record: ArcGisLayerRecord, patch: Partial<ArcGisLayerRecord>): ArcGisLayerRecord {
    const next = freezeRecord({ ...record, ...patch })
    this.records.set(record.id, next)
    return next
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-layer-lifecycle-disposed')
  }
}
