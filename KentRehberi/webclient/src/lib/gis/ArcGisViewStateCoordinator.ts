export type ArcGisViewDimension = '2d' | '3d'
export type ArcGisViewPhase = 'idle' | 'transitioning' | 'ready' | 'suspended' | 'failed' | 'disposed'

export interface ArcGisViewpoint2d {
  readonly dimension: '2d'
  readonly centerX: number
  readonly centerY: number
  readonly scale: number
  readonly rotation: number
  readonly wkid: number
}

export interface ArcGisViewpoint3d {
  readonly dimension: '3d'
  readonly longitude: number
  readonly latitude: number
  readonly altitude: number
  readonly heading: number
  readonly tilt: number
  readonly fov: number
  readonly wkid: number
}

export type ArcGisViewpoint = ArcGisViewpoint2d | ArcGisViewpoint3d

export interface ArcGisViewStateBudget {
  readonly maxBookmarks: number
  readonly maxBookmarkNameLength: number
  readonly maxObservers: number
  readonly maxFailureMessageLength: number
  readonly minScale: number
  readonly maxScale: number
  readonly minAltitude: number
  readonly maxAltitude: number
}

export interface ArcGisViewTransitionToken {
  readonly generation: number
  readonly dimension: ArcGisViewDimension
}

export interface ArcGisViewBookmark {
  readonly id: string
  readonly name: string
  readonly viewpoint: ArcGisViewpoint
}

export interface ArcGisViewStateSnapshot {
  readonly phase: ArcGisViewPhase
  readonly dimension: ArcGisViewDimension
  readonly generation: number
  readonly viewpoint?: ArcGisViewpoint
  readonly bookmarks: readonly ArcGisViewBookmark[]
  readonly failure?: string
}

const MAX_COORDINATE = 1_000_000_000
const MAX_SCALE = 1_000_000_000_000
const MAX_ALTITUDE = 100_000_000
const CONTROL = /[\u0000-\u001f\u007f]/g

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be finite and in [${min}, ${max}]`)
  return value
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function safeText(value: string, name: string, maxLength: number): string {
  const normalized = value.replace(CONTROL, ' ').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength) throw new Error(`${name} must contain 1..${maxLength} safe characters`)
  return normalized
}

function normalizeWkid(value: number): number {
  const wkid = integer(value, 'wkid', 1, 999999)
  return wkid === 102100 || wkid === 102113 ? 3857 : wkid
}

function normalizeViewpoint(viewpoint: ArcGisViewpoint, budget: ArcGisViewStateBudget): ArcGisViewpoint {
  if (viewpoint.dimension === '2d') {
    return Object.freeze({
      dimension: '2d' as const,
      centerX: finite(viewpoint.centerX, 'centerX', -MAX_COORDINATE, MAX_COORDINATE),
      centerY: finite(viewpoint.centerY, 'centerY', -MAX_COORDINATE, MAX_COORDINATE),
      scale: finite(viewpoint.scale, 'scale', budget.minScale, budget.maxScale),
      rotation: finite(viewpoint.rotation, 'rotation', -360, 360),
      wkid: normalizeWkid(viewpoint.wkid),
    })
  }
  if (viewpoint.wkid !== 4326) throw new Error('3d geographic viewpoint requires wkid 4326')
  return Object.freeze({
    dimension: '3d' as const,
    longitude: finite(viewpoint.longitude, 'longitude', -180, 180),
    latitude: finite(viewpoint.latitude, 'latitude', -90, 90),
    altitude: finite(viewpoint.altitude, 'altitude', budget.minAltitude, budget.maxAltitude),
    heading: finite(viewpoint.heading, 'heading', 0, 360),
    tilt: finite(viewpoint.tilt, 'tilt', 0, 180),
    fov: finite(viewpoint.fov, 'fov', 1, 179),
    wkid: 4326,
  })
}

function freezeBookmark(bookmark: ArcGisViewBookmark): ArcGisViewBookmark {
  return Object.freeze({ ...bookmark, viewpoint: Object.freeze({ ...bookmark.viewpoint }) })
}

export class ArcGisViewStateCoordinator {
  private readonly budget: ArcGisViewStateBudget
  private phase: ArcGisViewPhase = 'idle'
  private dimension: ArcGisViewDimension = '2d'
  private generation = 0
  private viewpoint?: ArcGisViewpoint
  private failure?: string
  private readonly bookmarks = new Map<string, ArcGisViewBookmark>()
  private readonly observers = new Set<() => void>()
  private disposed = false

  constructor(budget: ArcGisViewStateBudget) {
    const minScale = finite(budget.minScale, 'minScale', 1, MAX_SCALE)
    const maxScale = finite(budget.maxScale, 'maxScale', minScale, MAX_SCALE)
    const minAltitude = finite(budget.minAltitude, 'minAltitude', 0, MAX_ALTITUDE)
    const maxAltitude = finite(budget.maxAltitude, 'maxAltitude', minAltitude, MAX_ALTITUDE)
    this.budget = Object.freeze({
      maxBookmarks: integer(budget.maxBookmarks, 'maxBookmarks', 1, 10_000),
      maxBookmarkNameLength: integer(budget.maxBookmarkNameLength, 'maxBookmarkNameLength', 1, 512),
      maxObservers: integer(budget.maxObservers, 'maxObservers', 1, 10_000),
      maxFailureMessageLength: integer(budget.maxFailureMessageLength, 'maxFailureMessageLength', 1, 4096),
      minScale,
      maxScale,
      minAltitude,
      maxAltitude,
    })
  }

  snapshot(): ArcGisViewStateSnapshot {
    const bookmarks = [...this.bookmarks.values()].sort((a, b) => a.id.localeCompare(b.id)).map(freezeBookmark)
    return Object.freeze({
      phase: this.phase,
      dimension: this.dimension,
      generation: this.generation,
      viewpoint: this.viewpoint ? Object.freeze({ ...this.viewpoint }) : undefined,
      bookmarks: Object.freeze(bookmarks),
      failure: this.failure,
    })
  }

  subscribe(observer: () => void): () => void {
    this.ensureLive()
    if (this.observers.size >= this.budget.maxObservers) throw new Error('view observer budget exceeded')
    this.observers.add(observer)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.observers.delete(observer)
    }
  }

  beginTransition(dimension: ArcGisViewDimension): ArcGisViewTransitionToken {
    this.ensureLive()
    if (this.phase === 'transitioning') throw new Error('view transition already in progress')
    this.generation += 1
    this.dimension = dimension
    this.phase = 'transitioning'
    this.failure = undefined
    this.emit()
    return Object.freeze({ generation: this.generation, dimension })
  }

  resolveTransition(token: ArcGisViewTransitionToken, viewpoint: ArcGisViewpoint): boolean {
    this.ensureLive()
    this.assertCurrent(token)
    if (viewpoint.dimension !== token.dimension) throw new Error('viewpoint dimension does not match transition')
    this.viewpoint = normalizeViewpoint(viewpoint, this.budget)
    this.phase = 'ready'
    this.failure = undefined
    this.emit()
    return true
  }

  failTransition(token: ArcGisViewTransitionToken, message: string): void {
    this.ensureLive()
    this.assertCurrent(token)
    const sanitized = message.replace(CONTROL, ' ').trim().replace(/\s+/g, ' ')
    this.failure = (sanitized || 'view transition failed').slice(0, this.budget.maxFailureMessageLength)
    this.phase = 'failed'
    this.emit()
  }

  suspend(): void {
    this.ensureLive()
    if (this.phase === 'transitioning') this.generation += 1
    this.phase = 'suspended'
    this.emit()
  }

  resume(): ArcGisViewTransitionToken {
    this.ensureLive()
    if (this.phase !== 'suspended' && this.phase !== 'failed') throw new Error('view is not resumable')
    return this.beginTransition(this.dimension)
  }

  updateReadyViewpoint(viewpoint: ArcGisViewpoint): void {
    this.ensureLive()
    if (this.phase !== 'ready') throw new Error('viewpoint can only be updated while ready')
    if (viewpoint.dimension !== this.dimension) throw new Error('viewpoint dimension mismatch')
    this.viewpoint = normalizeViewpoint(viewpoint, this.budget)
    this.emit()
  }

  addBookmark(idValue: string, nameValue: string, viewpoint: ArcGisViewpoint): ArcGisViewBookmark {
    this.ensureLive()
    const id = safeText(idValue, 'bookmark id', 128)
    const name = safeText(nameValue, 'bookmark name', this.budget.maxBookmarkNameLength)
    if (this.bookmarks.has(id)) throw new Error(`duplicate bookmark:${id}`)
    if (this.bookmarks.size >= this.budget.maxBookmarks) throw new Error('bookmark budget exceeded')
    const bookmark = freezeBookmark({ id, name, viewpoint: normalizeViewpoint(viewpoint, this.budget) })
    this.bookmarks.set(id, bookmark)
    this.emit()
    return bookmark
  }

  removeBookmark(idValue: string): boolean {
    this.ensureLive()
    const id = safeText(idValue, 'bookmark id', 128)
    const removed = this.bookmarks.delete(id)
    if (removed) this.emit()
    return removed
  }

  restoreBookmark(idValue: string): ArcGisViewTransitionToken {
    this.ensureLive()
    const id = safeText(idValue, 'bookmark id', 128)
    const bookmark = this.bookmarks.get(id)
    if (!bookmark) throw new Error(`unknown bookmark:${id}`)
    const token = this.beginTransition(bookmark.viewpoint.dimension)
    this.resolveTransition(token, bookmark.viewpoint)
    return token
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.phase = 'disposed'
    this.viewpoint = undefined
    this.failure = undefined
    this.bookmarks.clear()
    this.observers.clear()
  }

  private assertCurrent(token: ArcGisViewTransitionToken): void {
    if (token.generation !== this.generation || token.dimension !== this.dimension || this.phase !== 'transitioning') throw new Error('stale view transition token')
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('view state coordinator disposed')
  }

  private emit(): void {
    for (const observer of [...this.observers]) {
      try { observer() } catch { /* observer isolation is intentional */ }
    }
  }
}
