export type ArcGisBufferUnit = 'meters' | 'kilometers'
export type ArcGisBufferGeometry =
  | Readonly<{ kind: 'point'; x: number; y: number }>
  | Readonly<{ kind: 'polyline'; paths: readonly (readonly Readonly<{ x: number; y: number }>[])[] }>
  | Readonly<{ kind: 'polygon'; rings: readonly (readonly Readonly<{ x: number; y: number }>[])[] }>

export interface ArcGisBufferInput {
  readonly id: string
  readonly wkid: number
  readonly geometry: ArcGisBufferGeometry
  readonly distance: number
  readonly unit: ArcGisBufferUnit
  readonly targetLayerIds: readonly string[]
  readonly revision: number
}

export interface ArcGisBufferBudgets {
  readonly maxDistanceMeters: number
  readonly maxVertices: number
  readonly maxParts: number
  readonly maxTargetLayers: number
  readonly maxAbsoluteCoordinate: number
}

export interface ArcGisBufferPlan {
  readonly id: string
  readonly wkid: number
  readonly geometry: ArcGisBufferGeometry
  readonly distanceMeters: number
  readonly targetLayerIds: readonly string[]
  readonly revision: number
  readonly vertexCount: number
  readonly fingerprint: string
}

const WEB_MERCATOR_ALIASES = new Set([3857, 102100, 102113, 900913])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function positive(value: number, label: string): number {
  const result = finite(value, label)
  if (result <= 0) throw new Error(`${label} must be positive`)
  return result
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
  return value
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('revision must be a non-negative safe integer')
  return value
}

function wkid(value: number): number {
  const normalized = positiveInteger(value, 'wkid')
  return WEB_MERCATOR_ALIASES.has(normalized) ? 3857 : normalized
}

function hash(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisBufferPolicy {
  readonly #budgets: Readonly<ArcGisBufferBudgets>

  constructor(budgets: ArcGisBufferBudgets) {
    const normalized = {
      maxDistanceMeters: positive(budgets.maxDistanceMeters, 'maxDistanceMeters'),
      maxVertices: positiveInteger(budgets.maxVertices, 'maxVertices'),
      maxParts: positiveInteger(budgets.maxParts, 'maxParts'),
      maxTargetLayers: positiveInteger(budgets.maxTargetLayers, 'maxTargetLayers'),
      maxAbsoluteCoordinate: positive(budgets.maxAbsoluteCoordinate, 'maxAbsoluteCoordinate'),
    }
    this.#budgets = Object.freeze(normalized)
  }

  plan(input: ArcGisBufferInput): ArcGisBufferPlan {
    const id = input.id.trim()
    if (id !== input.id || !ID_PATTERN.test(id)) throw new Error('invalid buffer id')
    const canonicalWkid = wkid(input.wkid)
    const currentRevision = revision(input.revision)
    const distance = positive(input.distance, 'distance')
    if (input.unit !== 'meters' && input.unit !== 'kilometers') throw new Error('unsupported buffer unit')
    const distanceMeters = input.unit === 'kilometers' ? distance * 1000 : distance
    if (!Number.isFinite(distanceMeters) || distanceMeters > this.#budgets.maxDistanceMeters) {
      throw new Error('buffer distance budget exceeded')
    }

    let vertexCount = 0
    const point = (raw: Readonly<{ x: number; y: number }>, label: string) => {
      const x = finite(raw.x, `${label}.x`)
      const y = finite(raw.y, `${label}.y`)
      if (Math.abs(x) > this.#budgets.maxAbsoluteCoordinate || Math.abs(y) > this.#budgets.maxAbsoluteCoordinate) {
        throw new Error('buffer coordinate budget exceeded')
      }
      vertexCount += 1
      if (vertexCount > this.#budgets.maxVertices) throw new Error('buffer vertex budget exceeded')
      return Object.freeze({ x, y })
    }

    let geometry: ArcGisBufferGeometry
    if (input.geometry.kind === 'point') {
      const p = point(input.geometry, 'point')
      geometry = Object.freeze({ kind: 'point' as const, ...p })
    } else if (input.geometry.kind === 'polyline') {
      if (input.geometry.paths.length < 1 || input.geometry.paths.length > this.#budgets.maxParts) throw new Error('buffer path budget exceeded')
      const paths = input.geometry.paths.map((path, pathIndex) => {
        if (path.length < 2) throw new Error('buffer polyline path requires at least two vertices')
        return Object.freeze(path.map((raw, pointIndex) => point(raw, `paths[${pathIndex}][${pointIndex}]`)))
      })
      geometry = Object.freeze({ kind: 'polyline' as const, paths: Object.freeze(paths) })
    } else if (input.geometry.kind === 'polygon') {
      if (input.geometry.rings.length < 1 || input.geometry.rings.length > this.#budgets.maxParts) throw new Error('buffer ring budget exceeded')
      const rings = input.geometry.rings.map((ring, ringIndex) => {
        if (ring.length < 4) throw new Error('buffer polygon ring requires at least four coordinates')
        const normalized = ring.map((raw, pointIndex) => point(raw, `rings[${ringIndex}][${pointIndex}]`))
        const first = normalized[0]
        const last = normalized[normalized.length - 1]
        if (first.x !== last.x || first.y !== last.y) throw new Error('buffer polygon ring must be closed')
        const unique = new Set(normalized.slice(0, -1).map((p) => `${p.x}:${p.y}`))
        if (unique.size < 3) throw new Error('buffer polygon ring requires three unique vertices')
        let twiceArea = 0
        for (let index = 0; index < normalized.length - 1; index += 1) {
          twiceArea += normalized[index].x * normalized[index + 1].y - normalized[index + 1].x * normalized[index].y
        }
        if (twiceArea === 0) throw new Error('buffer polygon ring must have non-zero area')
        return Object.freeze(normalized)
      })
      geometry = Object.freeze({ kind: 'polygon' as const, rings: Object.freeze(rings) })
    } else {
      throw new Error('unsupported buffer geometry')
    }

    if (input.targetLayerIds.length < 1) throw new Error('buffer requires at least one target layer')
    if (input.targetLayerIds.length > this.#budgets.maxTargetLayers) throw new Error('buffer target-layer budget exceeded')
    const seen = new Set<string>()
    const targetLayerIds = input.targetLayerIds.map((raw) => {
      const layerId = raw.trim()
      if (layerId !== raw || !ID_PATTERN.test(layerId)) throw new Error('invalid buffer target layer id')
      if (seen.has(layerId)) throw new Error('duplicate buffer target layer id')
      seen.add(layerId)
      return layerId
    }).sort()
    const immutableLayers = Object.freeze(targetLayerIds)
    const canonical = JSON.stringify([id, canonicalWkid, geometry, distanceMeters, immutableLayers, currentRevision])
    return Object.freeze({ id, wkid: canonicalWkid, geometry, distanceMeters, targetLayerIds: immutableLayers, revision: currentRevision, vertexCount, fingerprint: hash(canonical) })
  }

  assertCurrent(plan: ArcGisBufferPlan, currentRevision: number): void {
    if (plan.revision !== revision(currentRevision)) throw new Error('stale buffer plan revision')
  }
}
