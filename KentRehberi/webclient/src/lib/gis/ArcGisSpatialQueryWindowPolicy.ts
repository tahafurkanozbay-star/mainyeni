export type ArcGisSpatialRelationship = 'intersects' | 'contains' | 'within' | 'touches' | 'crosses' | 'overlaps' | 'envelope-intersects'
export type ArcGisQueryGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent'

export interface ArcGisQueryExtent {
  readonly xmin: number
  readonly ymin: number
  readonly xmax: number
  readonly ymax: number
  readonly wkid: number
}

export interface ArcGisSpatialQueryWindowInput {
  readonly geometryType: ArcGisQueryGeometryType
  readonly relationship: ArcGisSpatialRelationship
  readonly extent: ArcGisQueryExtent
  readonly tolerance?: number
  readonly maxAllowableOffset?: number
  readonly resultRecordCount: number
  readonly resultOffset: number
  readonly returnGeometry: boolean
  readonly returnCentroid: boolean
  readonly outWkid?: number
}

export interface ArcGisSpatialQueryWindowBudget {
  readonly allowedWkids: readonly number[]
  readonly maxResultRecordCount: number
  readonly maxResultOffset: number
  readonly maxArea: number
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxTolerance: number
  readonly maxAllowableOffset: number
  readonly allowGeometry: boolean
  readonly allowCentroid: boolean
  readonly allowedRelationships: readonly ArcGisSpatialRelationship[]
}

export interface ArcGisSpatialQueryWindow {
  readonly geometryType: ArcGisQueryGeometryType
  readonly relationship: ArcGisSpatialRelationship
  readonly extent: Readonly<ArcGisQueryExtent>
  readonly tolerance?: number
  readonly maxAllowableOffset?: number
  readonly resultRecordCount: number
  readonly resultOffset: number
  readonly returnGeometry: boolean
  readonly returnCentroid: boolean
  readonly outWkid?: number
  readonly estimatedArea: number
  readonly fingerprint: string
}

const RELATIONSHIPS = new Set<ArcGisSpatialRelationship>(['intersects', 'contains', 'within', 'touches', 'crosses', 'overlaps', 'envelope-intersects'])
const GEOMETRIES = new Set<ArcGisQueryGeometryType>(['point', 'multipoint', 'polyline', 'polygon', 'extent'])
const MAX_COORDINATE = 1_000_000_000

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be finite in [${min}, ${max}]`)
  return value
}

function optionalFinite(value: number | undefined, name: string, max: number): number | undefined {
  return value === undefined ? undefined : finite(value, name, 0, max)
}

function normalizeWkid(value: number): number {
  const wkid = integer(value, 'wkid', 1, 999_999)
  if (wkid === 102100 || wkid === 102113 || wkid === 900913) return 3857
  return wkid
}

function multiplyBounded(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  const result = a * b
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new Error('query-window-area-overflow')
  return result
}

/**
 * Canonical admission boundary for spatial query windows. It prevents an
 * interaction gesture or stale view state from silently becoming an unbounded
 * ArcGIS query while preserving deterministic cache/dedupe identity.
 */
export class ArcGisSpatialQueryWindowPolicy {
  private readonly budget: Readonly<ArcGisSpatialQueryWindowBudget>
  private readonly allowedWkids: ReadonlySet<number>
  private readonly allowedRelationships: ReadonlySet<ArcGisSpatialRelationship>

  constructor(input: ArcGisSpatialQueryWindowBudget) {
    const wkids = [...new Set(input.allowedWkids.map(normalizeWkid))].sort((a, b) => a - b)
    if (!wkids.length || wkids.length > 64) throw new Error('allowedWkids must contain 1..64 entries')
    const relationships = [...new Set(input.allowedRelationships)]
    if (!relationships.length || relationships.some(value => !RELATIONSHIPS.has(value))) throw new Error('invalid-allowed-relationships')
    this.budget = Object.freeze({
      allowedWkids: Object.freeze(wkids),
      maxResultRecordCount: integer(input.maxResultRecordCount, 'maxResultRecordCount', 1, 100_000),
      maxResultOffset: integer(input.maxResultOffset, 'maxResultOffset', 0, 10_000_000),
      maxArea: finite(input.maxArea, 'maxArea', 0, Number.MAX_SAFE_INTEGER),
      maxWidth: finite(input.maxWidth, 'maxWidth', 0, MAX_COORDINATE * 2),
      maxHeight: finite(input.maxHeight, 'maxHeight', 0, MAX_COORDINATE * 2),
      maxTolerance: finite(input.maxTolerance, 'maxTolerance', 0, 1_000_000),
      maxAllowableOffset: finite(input.maxAllowableOffset, 'maxAllowableOffset', 0, 1_000_000),
      allowGeometry: Boolean(input.allowGeometry),
      allowCentroid: Boolean(input.allowCentroid),
      allowedRelationships: Object.freeze(relationships.sort()),
    })
    this.allowedWkids = new Set(wkids)
    this.allowedRelationships = new Set(relationships)
  }

  admit(input: ArcGisSpatialQueryWindowInput): ArcGisSpatialQueryWindow {
    if (!GEOMETRIES.has(input.geometryType)) throw new Error('invalid-query-geometry-type')
    if (!RELATIONSHIPS.has(input.relationship) || !this.allowedRelationships.has(input.relationship)) throw new Error('spatial-relationship-not-allowed')
    const extent = this.normalizeExtent(input.extent)
    const width = extent.xmax - extent.xmin
    const height = extent.ymax - extent.ymin
    if (width > this.budget.maxWidth) throw new Error('query-window-width-budget-exceeded')
    if (height > this.budget.maxHeight) throw new Error('query-window-height-budget-exceeded')
    const estimatedArea = multiplyBounded(width, height)
    if (estimatedArea > this.budget.maxArea) throw new Error('query-window-area-budget-exceeded')
    const tolerance = optionalFinite(input.tolerance, 'tolerance', this.budget.maxTolerance)
    const maxAllowableOffset = optionalFinite(input.maxAllowableOffset, 'maxAllowableOffset', this.budget.maxAllowableOffset)
    const resultRecordCount = integer(input.resultRecordCount, 'resultRecordCount', 1, this.budget.maxResultRecordCount)
    const resultOffset = integer(input.resultOffset, 'resultOffset', 0, this.budget.maxResultOffset)
    if (input.returnGeometry && !this.budget.allowGeometry) throw new Error('return-geometry-not-allowed')
    if (input.returnCentroid && !this.budget.allowCentroid) throw new Error('return-centroid-not-allowed')
    if (input.returnCentroid && input.geometryType === 'point') throw new Error('point-centroid-redundant')
    const outWkid = input.outWkid === undefined ? undefined : this.admitWkid(input.outWkid, 'outWkid')
    const fingerprint = [input.geometryType, input.relationship, extent.wkid, extent.xmin, extent.ymin, extent.xmax, extent.ymax, tolerance ?? '', maxAllowableOffset ?? '', resultRecordCount, resultOffset, input.returnGeometry ? 1 : 0, input.returnCentroid ? 1 : 0, outWkid ?? ''].join(':')
    return Object.freeze({ geometryType: input.geometryType, relationship: input.relationship, extent, tolerance, maxAllowableOffset, resultRecordCount, resultOffset, returnGeometry: input.returnGeometry, returnCentroid: input.returnCentroid, outWkid, estimatedArea, fingerprint })
  }

  private normalizeExtent(input: ArcGisQueryExtent): Readonly<ArcGisQueryExtent> {
    const xmin = finite(input.xmin, 'xmin', -MAX_COORDINATE, MAX_COORDINATE)
    const ymin = finite(input.ymin, 'ymin', -MAX_COORDINATE, MAX_COORDINATE)
    const xmax = finite(input.xmax, 'xmax', -MAX_COORDINATE, MAX_COORDINATE)
    const ymax = finite(input.ymax, 'ymax', -MAX_COORDINATE, MAX_COORDINATE)
    if (xmin > xmax || ymin > ymax) throw new Error('query-window-extent-order-invalid')
    return Object.freeze({ xmin, ymin, xmax, ymax, wkid: this.admitWkid(input.wkid, 'extent.wkid') })
  }

  private admitWkid(value: number, name: string): number {
    const wkid = normalizeWkid(value)
    if (!this.allowedWkids.has(wkid)) throw new Error(`${name}-not-allowed`)
    return wkid
  }
}
