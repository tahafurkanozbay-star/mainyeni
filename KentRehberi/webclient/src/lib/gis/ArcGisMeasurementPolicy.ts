export type ArcGisMeasurementDimension = '2d' | '3d'
export type ArcGisMeasurementMode = 'distance' | 'area' | 'height'

export interface ArcGisMeasurementPoint {
  readonly x: number
  readonly y: number
  readonly z?: number
}

export interface ArcGisMeasurementRequest {
  readonly dimension: ArcGisMeasurementDimension
  readonly mode: ArcGisMeasurementMode
  readonly spatialReferenceWkid: number
  readonly points: readonly ArcGisMeasurementPoint[]
  readonly revision: string
}

export interface ArcGisMeasurementBudget {
  readonly allowedWkids: readonly number[]
  readonly maxPoints: number
  readonly maxRevisionLength: number
  readonly maxCoordinateMagnitude: number
  readonly maxSegmentLength: number
  readonly maxTotalDistance: number
  readonly maxArea: number
  readonly maxHeight: number
}

export interface ArcGisMeasurementPlan {
  readonly dimension: ArcGisMeasurementDimension
  readonly mode: ArcGisMeasurementMode
  readonly spatialReferenceWkid: number
  readonly points: readonly Readonly<ArcGisMeasurementPoint>[]
  readonly revision: string
  readonly segmentLengths: readonly number[]
  readonly totalDistance: number
  readonly area: number
  readonly height: number
  readonly fingerprint: string
}

const WEB_MERCATOR = new Set([102100, 102113, 900913, 3857])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return Object.is(value, -0) ? 0 : value
}

function text(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('invalid-measurement-revision')
  return normalized
}

function wkid(value: number): number {
  const admitted = integer(value, 'wkid', 1, 999_999)
  return WEB_MERCATOR.has(admitted) ? 3857 : admitted
}

function hypot(a: ArcGisMeasurementPoint, b: ArcGisMeasurementPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = (b.z ?? 0) - (a.z ?? 0)
  return Math.hypot(dx, dy, dz)
}

function polygonArea(points: readonly ArcGisMeasurementPoint[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    twiceArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(twiceArea) / 2
}

/**
 * Transport-independent admission boundary for interactive measurement.
 * Coordinates are assumed to already be in a projected metric-compatible
 * spatial reference chosen by the caller; this policy deliberately does not
 * invent projection/network behavior.
 */
export class ArcGisMeasurementPolicy {
  private readonly budget: Readonly<ArcGisMeasurementBudget>
  private readonly allowedWkids: ReadonlySet<number>

  constructor(input: ArcGisMeasurementBudget) {
    const allowedWkids = [...new Set(input.allowedWkids.map(wkid))].sort((a, b) => a - b)
    if (!allowedWkids.length || allowedWkids.length > 64) throw new Error('allowedWkids-out-of-range')
    this.budget = Object.freeze({
      allowedWkids: Object.freeze(allowedWkids),
      maxPoints: integer(input.maxPoints, 'maxPoints', 2, 100_000),
      maxRevisionLength: integer(input.maxRevisionLength, 'maxRevisionLength', 1, 256),
      maxCoordinateMagnitude: finite(input.maxCoordinateMagnitude, 'maxCoordinateMagnitude', 1, 1_000_000_000),
      maxSegmentLength: finite(input.maxSegmentLength, 'maxSegmentLength', 0, Number.MAX_SAFE_INTEGER),
      maxTotalDistance: finite(input.maxTotalDistance, 'maxTotalDistance', 0, Number.MAX_SAFE_INTEGER),
      maxArea: finite(input.maxArea, 'maxArea', 0, Number.MAX_SAFE_INTEGER),
      maxHeight: finite(input.maxHeight, 'maxHeight', 0, Number.MAX_SAFE_INTEGER),
    })
    this.allowedWkids = new Set(allowedWkids)
  }

  plan(request: ArcGisMeasurementRequest): ArcGisMeasurementPlan {
    if (request.dimension !== '2d' && request.dimension !== '3d') throw new Error('invalid-measurement-dimension')
    if (request.mode !== 'distance' && request.mode !== 'area' && request.mode !== 'height') throw new Error('invalid-measurement-mode')
    if (!Array.isArray(request.points)) throw new Error('measurement-points-must-be-array')
    const minimum = request.mode === 'area' ? 3 : 2
    if (request.points.length < minimum || request.points.length > this.budget.maxPoints) throw new Error('measurement-point-budget-exceeded')
    if (request.mode === 'height' && request.dimension !== '3d') throw new Error('height-measurement-requires-3d')
    if (request.mode === 'height' && request.points.length !== 2) throw new Error('height-measurement-requires-two-points')
    const spatialReferenceWkid = wkid(request.spatialReferenceWkid)
    if (!this.allowedWkids.has(spatialReferenceWkid)) throw new Error('measurement-wkid-not-allowed')
    const revision = text(request.revision, this.budget.maxRevisionLength)
    const points = Object.freeze(request.points.map((point, index) => {
      const x = finite(point.x, `point-${index}-x`, -this.budget.maxCoordinateMagnitude, this.budget.maxCoordinateMagnitude)
      const y = finite(point.y, `point-${index}-y`, -this.budget.maxCoordinateMagnitude, this.budget.maxCoordinateMagnitude)
      if (request.dimension === '2d' && point.z !== undefined) throw new Error('2d-measurement-cannot-retain-z')
      const z = point.z === undefined ? undefined : finite(point.z, `point-${index}-z`, -this.budget.maxCoordinateMagnitude, this.budget.maxCoordinateMagnitude)
      if (request.mode === 'height' && z === undefined) throw new Error('height-measurement-requires-z')
      return Object.freeze(z === undefined ? { x, y } : { x, y, z })
    }))
    const segmentLengths: number[] = []
    let totalDistance = 0
    for (let index = 1; index < points.length; index += 1) {
      const segment = hypot(points[index - 1]!, points[index]!)
      if (!Number.isFinite(segment) || segment > this.budget.maxSegmentLength) throw new Error('measurement-segment-budget-exceeded')
      if (segment > this.budget.maxTotalDistance - totalDistance) throw new Error('measurement-distance-budget-exceeded')
      totalDistance += segment
      segmentLengths.push(segment)
    }
    const area = request.mode === 'area' ? polygonArea(points) : 0
    if (!Number.isFinite(area) || area > this.budget.maxArea) throw new Error('measurement-area-budget-exceeded')
    const height = request.mode === 'height' ? Math.abs((points[1]!.z ?? 0) - (points[0]!.z ?? 0)) : 0
    if (height > this.budget.maxHeight) throw new Error('measurement-height-budget-exceeded')
    const frozenSegments = Object.freeze(segmentLengths)
    const fingerprint = ['measurement-v1', request.dimension, request.mode, spatialReferenceWkid, revision,
      ...points.map(point => `${point.x},${point.y},${point.z ?? ''}`)].join('|')
    return Object.freeze({ dimension: request.dimension, mode: request.mode, spatialReferenceWkid, points, revision,
      segmentLengths: frozenSegments, totalDistance, area, height, fingerprint })
  }
}
