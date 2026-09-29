export type ArcGisClipMode = 'inside' | 'outside'

export interface ArcGisClipPoint {
  readonly x: number
  readonly y: number
  readonly z?: number
}

export interface ArcGisClipInput {
  readonly id: string
  readonly wkid: number
  readonly mode: ArcGisClipMode
  readonly ring: readonly ArcGisClipPoint[]
  readonly layerIds: readonly string[]
  readonly revision: number
}

export interface ArcGisClippingBudgets {
  readonly maxVertices: number
  readonly maxLayers: number
  readonly maxAbsoluteCoordinate: number
  readonly maxAbsoluteElevation: number
  readonly maxEnvelopeArea: number
}

export interface ArcGisClipEnvelope {
  readonly xmin: number
  readonly ymin: number
  readonly xmax: number
  readonly ymax: number
}

export interface ArcGisClipPlan {
  readonly id: string
  readonly wkid: number
  readonly mode: ArcGisClipMode
  readonly ring: readonly Readonly<ArcGisClipPoint>[]
  readonly layerIds: readonly string[]
  readonly revision: number
  readonly envelope: Readonly<ArcGisClipEnvelope>
  readonly fingerprint: string
}

const WEB_MERCATOR_ALIASES = new Set([3857, 102100, 102113, 900913])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

function positiveInteger(value: number, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result < 1) throw new Error(`${label} must be positive`)
  return result
}

function normalizeWkid(value: number): number {
  const wkid = positiveInteger(value, 'wkid')
  return WEB_MERCATOR_ALIASES.has(wkid) ? 3857 : wkid
}

function hash(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

function samePoint(a: Readonly<ArcGisClipPoint>, b: Readonly<ArcGisClipPoint>): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function signedArea(ring: readonly Readonly<ArcGisClipPoint>[]): number {
  let area = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]
    const next = ring[index + 1]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

export class ArcGisClippingPolicy {
  readonly #budgets: Readonly<ArcGisClippingBudgets>

  constructor(budgets: ArcGisClippingBudgets) {
    const normalized = {
      maxVertices: positiveInteger(budgets.maxVertices, 'maxVertices'),
      maxLayers: positiveInteger(budgets.maxLayers, 'maxLayers'),
      maxAbsoluteCoordinate: finite(budgets.maxAbsoluteCoordinate, 'maxAbsoluteCoordinate'),
      maxAbsoluteElevation: finite(budgets.maxAbsoluteElevation, 'maxAbsoluteElevation'),
      maxEnvelopeArea: finite(budgets.maxEnvelopeArea, 'maxEnvelopeArea'),
    }
    if (normalized.maxAbsoluteCoordinate <= 0 || normalized.maxAbsoluteElevation < 0 || normalized.maxEnvelopeArea <= 0) {
      throw new Error('invalid clipping budgets')
    }
    this.#budgets = Object.freeze(normalized)
  }

  plan(input: ArcGisClipInput): ArcGisClipPlan {
    const id = input.id.trim()
    if (!ID_PATTERN.test(id) || id !== input.id) throw new Error('invalid clip id')
    if (input.mode !== 'inside' && input.mode !== 'outside') throw new Error('invalid clip mode')
    const revision = nonNegativeInteger(input.revision, 'revision')
    const wkid = normalizeWkid(input.wkid)
    if (input.ring.length < 4) throw new Error('clip ring requires at least four coordinates')
    if (input.ring.length > this.#budgets.maxVertices + 1) throw new Error('clip vertex budget exceeded')

    const ring = input.ring.map((raw, index) => {
      const x = finite(raw.x, `ring[${index}].x`)
      const y = finite(raw.y, `ring[${index}].y`)
      if (Math.abs(x) > this.#budgets.maxAbsoluteCoordinate || Math.abs(y) > this.#budgets.maxAbsoluteCoordinate) {
        throw new Error('clip coordinate budget exceeded')
      }
      let z: number | undefined
      if (raw.z !== undefined) {
        z = finite(raw.z, `ring[${index}].z`)
        if (Math.abs(z) > this.#budgets.maxAbsoluteElevation) throw new Error('clip elevation budget exceeded')
      }
      return Object.freeze(z === undefined ? { x, y } : { x, y, z })
    })

    if (!samePoint(ring[0], ring[ring.length - 1])) throw new Error('clip ring must be closed')
    const unique = new Set(ring.slice(0, -1).map((point) => `${point.x}:${point.y}`))
    if (unique.size < 3) throw new Error('clip ring requires three unique planar vertices')
    if (Math.abs(signedArea(ring)) === 0) throw new Error('clip ring must have non-zero area')

    let xmin = Number.POSITIVE_INFINITY
    let ymin = Number.POSITIVE_INFINITY
    let xmax = Number.NEGATIVE_INFINITY
    let ymax = Number.NEGATIVE_INFINITY
    for (const point of ring) {
      xmin = Math.min(xmin, point.x)
      ymin = Math.min(ymin, point.y)
      xmax = Math.max(xmax, point.x)
      ymax = Math.max(ymax, point.y)
    }
    const envelopeArea = (xmax - xmin) * (ymax - ymin)
    if (!Number.isFinite(envelopeArea) || envelopeArea > this.#budgets.maxEnvelopeArea) throw new Error('clip envelope area budget exceeded')
    const envelope = Object.freeze({ xmin, ymin, xmax, ymax })

    if (input.layerIds.length < 1) throw new Error('clip requires at least one layer')
    if (input.layerIds.length > this.#budgets.maxLayers) throw new Error('clip layer budget exceeded')
    const seen = new Set<string>()
    const layerIds = input.layerIds.map((rawId) => {
      const layerId = rawId.trim()
      if (!ID_PATTERN.test(layerId) || layerId !== rawId) throw new Error('invalid clip layer id')
      if (seen.has(layerId)) throw new Error('duplicate clip layer id')
      seen.add(layerId)
      return layerId
    }).sort()

    const immutableRing = Object.freeze([...ring])
    const immutableLayers = Object.freeze([...layerIds])
    const canonical = JSON.stringify([id, wkid, input.mode, immutableRing, immutableLayers, revision])
    return Object.freeze({
      id,
      wkid,
      mode: input.mode,
      ring: immutableRing,
      layerIds: immutableLayers,
      revision,
      envelope,
      fingerprint: hash(canonical),
    })
  }

  assertCurrent(plan: ArcGisClipPlan, currentRevision: number): void {
    const revision = nonNegativeInteger(currentRevision, 'currentRevision')
    if (plan.revision !== revision) throw new Error('stale clipping plan revision')
  }
}
