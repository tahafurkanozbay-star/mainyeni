export type ArcGisNavigationDimension = '2d' | '3d'
export type ArcGisNavigationReason = 'user' | 'bookmark' | 'selection' | 'search' | 'restore'

export interface ArcGisNavigationPose {
  readonly centerX: number
  readonly centerY: number
  readonly centerZ?: number
  readonly scale: number
  readonly heading: number
  readonly tilt: number
}

export interface ArcGisNavigationRequest {
  readonly dimension: ArcGisNavigationDimension
  readonly spatialReferenceWkid: number
  readonly pose: ArcGisNavigationPose
  readonly reason: ArcGisNavigationReason
  readonly revision: string
  readonly durationMs?: number
}

export interface ArcGisNavigationBudget {
  readonly allowedWkids: readonly number[]
  readonly minScale: number
  readonly maxScale: number
  readonly maxCoordinateMagnitude: number
  readonly maxAltitude: number
  readonly maxTilt: number
  readonly maxDurationMs: number
  readonly maxRevisionLength: number
}

export interface ArcGisNavigationPlan {
  readonly dimension: ArcGisNavigationDimension
  readonly spatialReferenceWkid: number
  readonly pose: Readonly<ArcGisNavigationPose>
  readonly reason: ArcGisNavigationReason
  readonly revision: string
  readonly durationMs: number
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
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('invalid-navigation-revision')
  return normalized
}

function wkid(value: number): number {
  const admitted = integer(value, 'wkid', 1, 999_999)
  return WEB_MERCATOR.has(admitted) ? 3857 : admitted
}

function normalizeHeading(value: number): number {
  const admitted = finite(value, 'heading', -360_000, 360_000)
  const normalized = ((admitted % 360) + 360) % 360
  return Object.is(normalized, -0) ? 0 : normalized
}

/** Transport-independent admission boundary for deterministic 2D/3D navigation. */
export class ArcGisNavigationPolicy {
  private readonly budget: Readonly<ArcGisNavigationBudget>
  private readonly allowedWkids: ReadonlySet<number>

  constructor(input: ArcGisNavigationBudget) {
    const allowedWkids = [...new Set(input.allowedWkids.map(wkid))].sort((a, b) => a - b)
    if (!allowedWkids.length || allowedWkids.length > 64) throw new Error('allowedWkids-out-of-range')
    const minScale = finite(input.minScale, 'minScale', 1, Number.MAX_SAFE_INTEGER)
    const maxScale = finite(input.maxScale, 'maxScale', minScale, Number.MAX_SAFE_INTEGER)
    this.budget = Object.freeze({
      allowedWkids: Object.freeze(allowedWkids),
      minScale,
      maxScale,
      maxCoordinateMagnitude: finite(input.maxCoordinateMagnitude, 'maxCoordinateMagnitude', 1, 1_000_000_000),
      maxAltitude: finite(input.maxAltitude, 'maxAltitude', 0, 100_000_000),
      maxTilt: finite(input.maxTilt, 'maxTilt', 0, 90),
      maxDurationMs: integer(input.maxDurationMs, 'maxDurationMs', 0, 120_000),
      maxRevisionLength: integer(input.maxRevisionLength, 'maxRevisionLength', 1, 256),
    })
    this.allowedWkids = new Set(allowedWkids)
  }

  plan(request: ArcGisNavigationRequest): ArcGisNavigationPlan {
    if (request.dimension !== '2d' && request.dimension !== '3d') throw new Error('invalid-navigation-dimension')
    if (!['user', 'bookmark', 'selection', 'search', 'restore'].includes(request.reason)) throw new Error('invalid-navigation-reason')
    const spatialReferenceWkid = wkid(request.spatialReferenceWkid)
    if (!this.allowedWkids.has(spatialReferenceWkid)) throw new Error('navigation-wkid-not-allowed')
    const revision = text(request.revision, this.budget.maxRevisionLength)
    const centerX = finite(request.pose.centerX, 'centerX', -this.budget.maxCoordinateMagnitude, this.budget.maxCoordinateMagnitude)
    const centerY = finite(request.pose.centerY, 'centerY', -this.budget.maxCoordinateMagnitude, this.budget.maxCoordinateMagnitude)
    const scale = finite(request.pose.scale, 'scale', this.budget.minScale, this.budget.maxScale)
    const heading = normalizeHeading(request.pose.heading)
    const tilt = finite(request.pose.tilt, 'tilt', 0, this.budget.maxTilt)
    if (request.dimension === '2d' && request.pose.centerZ !== undefined) throw new Error('2d-navigation-cannot-retain-altitude')
    if (request.dimension === '2d' && tilt !== 0) throw new Error('2d-navigation-requires-zero-tilt')
    const centerZ = request.pose.centerZ === undefined ? undefined : finite(request.pose.centerZ, 'centerZ', -this.budget.maxAltitude, this.budget.maxAltitude)
    const durationMs = request.durationMs === undefined ? 0 : integer(request.durationMs, 'durationMs', 0, this.budget.maxDurationMs)
    const pose = Object.freeze(centerZ === undefined ? { centerX, centerY, scale, heading, tilt } : { centerX, centerY, centerZ, scale, heading, tilt })
    const fingerprint = ['navigation-v1', request.dimension, spatialReferenceWkid, request.reason, revision, centerX, centerY, centerZ ?? '', scale, heading, tilt, durationMs].join('|')
    return Object.freeze({ dimension: request.dimension, spatialReferenceWkid, pose, reason: request.reason, revision, durationMs, fingerprint })
  }
}
