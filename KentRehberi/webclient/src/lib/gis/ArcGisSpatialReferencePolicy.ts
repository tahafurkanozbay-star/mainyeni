export type ArcGisSpatialReferenceKind = 'geographic' | 'projected' | 'web-mercator'

export interface ArcGisSpatialReferenceInput {
  readonly wkid: number
  readonly latestWkid?: number
  readonly kind: ArcGisSpatialReferenceKind
  readonly metersPerUnit: number
  readonly wrapAround: boolean
}

export interface ArcGisSpatialReferenceBudget {
  readonly maxKnownReferences: number
  readonly maxCoordinateMagnitude: number
  readonly maxProjectedMetersPerUnit: number
}

export interface ArcGisCoordinateInput {
  readonly x: number
  readonly y: number
  readonly z?: number
  readonly wkid: number
}

export interface ArcGisCoordinatePlan {
  readonly x: number
  readonly y: number
  readonly z?: number
  readonly wkid: number
  readonly canonicalWkid: number
  readonly kind: ArcGisSpatialReferenceKind
  readonly wrapAround: boolean
  readonly fingerprint: string
}

const MAX_WKID = 999_999_999
const WEB_MERCATOR_WKIDS = new Set([3857, 102100, 102113])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function finite(value: number, name: string, magnitude: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > magnitude) throw new Error(`${name} exceeds spatial-reference coordinate budget`)
  return Object.is(value, -0) ? 0 : value
}

function stableHash(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function kind(value: ArcGisSpatialReferenceKind): ArcGisSpatialReferenceKind {
  if (value !== 'geographic' && value !== 'projected' && value !== 'web-mercator') throw new Error('invalid-spatial-reference-kind')
  return value
}

/** Pure admission authority for ArcGIS spatial-reference metadata and coordinates. */
export class ArcGisSpatialReferencePolicy {
  private readonly budget: Readonly<ArcGisSpatialReferenceBudget>
  private readonly references = new Map<number, Readonly<ArcGisSpatialReferenceInput>>()

  constructor(budget: ArcGisSpatialReferenceBudget) {
    this.budget = Object.freeze({
      maxKnownReferences: integer(budget.maxKnownReferences, 'maxKnownReferences', 1, 10_000),
      maxCoordinateMagnitude: finite(budget.maxCoordinateMagnitude, 'maxCoordinateMagnitude', Number.MAX_SAFE_INTEGER),
      maxProjectedMetersPerUnit: finite(budget.maxProjectedMetersPerUnit, 'maxProjectedMetersPerUnit', 1_000_000),
    })
    if (this.budget.maxCoordinateMagnitude <= 0 || this.budget.maxProjectedMetersPerUnit <= 0) throw new Error('spatial-reference budgets must be positive')
  }

  register(input: ArcGisSpatialReferenceInput): Readonly<ArcGisSpatialReferenceInput> {
    if (this.references.size >= this.budget.maxKnownReferences && !this.references.has(input.wkid)) throw new Error('spatial-reference-cardinality-budget-exceeded')
    const wkid = integer(input.wkid, 'wkid', 1, MAX_WKID)
    const latestWkid = input.latestWkid === undefined ? undefined : integer(input.latestWkid, 'latestWkid', 1, MAX_WKID)
    const resolvedKind = kind(input.kind)
    const metersPerUnit = finite(input.metersPerUnit, 'metersPerUnit', this.budget.maxProjectedMetersPerUnit)
    if (metersPerUnit <= 0) throw new Error('metersPerUnit must be positive')
    if (resolvedKind === 'web-mercator' && !WEB_MERCATOR_WKIDS.has(wkid) && !WEB_MERCATOR_WKIDS.has(latestWkid ?? -1)) throw new Error('invalid-web-mercator-wkid')
    if (resolvedKind === 'geographic' && input.wrapAround !== true) throw new Error('geographic-spatial-reference-must-wrap')
    const entry = Object.freeze({ wkid, ...(latestWkid === undefined ? {} : { latestWkid }), kind: resolvedKind, metersPerUnit, wrapAround: input.wrapAround })
    const existing = this.references.get(wkid)
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error('conflicting-spatial-reference-registration')
    this.references.set(wkid, entry)
    return entry
  }

  planCoordinate(input: ArcGisCoordinateInput): ArcGisCoordinatePlan {
    const wkid = integer(input.wkid, 'wkid', 1, MAX_WKID)
    const reference = this.references.get(wkid) ?? [...this.references.values()].find((item) => item.latestWkid === wkid)
    if (!reference) throw new Error('unknown-spatial-reference')
    let x = finite(input.x, 'x', this.budget.maxCoordinateMagnitude)
    const y = finite(input.y, 'y', this.budget.maxCoordinateMagnitude)
    const z = input.z === undefined ? undefined : finite(input.z, 'z', this.budget.maxCoordinateMagnitude)
    if (reference.kind === 'geographic') {
      if (y < -90 || y > 90) throw new Error('geographic-latitude-out-of-range')
      if (reference.wrapAround) x = ((x + 180) % 360 + 360) % 360 - 180
      else if (x < -180 || x > 180) throw new Error('geographic-longitude-out-of-range')
    }
    const canonicalWkid = reference.latestWkid ?? reference.wkid
    const fingerprint = stableHash([canonicalWkid, reference.kind, x, y, z ?? '', reference.wrapAround ? 1 : 0].join('|'))
    return Object.freeze({ x, y, ...(z === undefined ? {} : { z }), wkid, canonicalWkid, kind: reference.kind, wrapAround: reference.wrapAround, fingerprint })
  }

  snapshot(): readonly Readonly<ArcGisSpatialReferenceInput>[] {
    return Object.freeze([...this.references.values()].sort((a, b) => a.wkid - b.wkid))
  }
}
