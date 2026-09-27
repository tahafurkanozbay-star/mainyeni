export type ArcGisBookmarkViewMode = '2d' | '3d';

export interface ArcGisBookmarkCameraState {
  readonly centerX: number;
  readonly centerY: number;
  readonly wkid: number;
  readonly scale: number;
  readonly rotation: number;
  readonly tilt: number;
  readonly altitude: number;
}

export interface ArcGisBookmarkRecord {
  readonly id: string;
  readonly title: string;
  readonly mode: ArcGisBookmarkViewMode;
  readonly camera: ArcGisBookmarkCameraState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
}

export interface ArcGisBookmarkStatePolicy {
  readonly maxBookmarks: number;
  readonly maxTitleLength: number;
  readonly maxIdLength: number;
  readonly maxScale: number;
  readonly maxAltitude: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisBookmarkSnapshot {
  readonly generation: number;
  readonly activeBookmarkId: string | null;
  readonly bookmarks: readonly ArcGisBookmarkRecord[];
}

function positiveSafe(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and > 0`);
  return value;
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
function nonNegativeTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}
function boundedText(value: string, maxLength: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${name} is outside configured bounds`);
  }
  return normalized;
}
function normalizeMode(value: ArcGisBookmarkViewMode): ArcGisBookmarkViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid bookmark view mode');
  return value;
}
function freezeCamera(camera: ArcGisBookmarkCameraState): ArcGisBookmarkCameraState {
  return Object.freeze({ ...camera });
}
function freezeRecord(record: ArcGisBookmarkRecord): ArcGisBookmarkRecord {
  return Object.freeze({ ...record, camera: freezeCamera(record.camera) });
}

/**
 * Primitive-only bookmark authority for ArcGIS 2D/3D views. The coordinator
 * deliberately never retains View, Map, Scene, Geometry or Graphic instances.
 * Capacity, strings, camera values and timestamps are bounded so persisted or
 * user-created bookmark state cannot become an unbounded memory/data channel.
 */
export class ArcGisBookmarkStateCoordinator {
  private readonly policy: ArcGisBookmarkStatePolicy;
  private readonly records = new Map<string, ArcGisBookmarkRecord>();
  private activeBookmarkId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisBookmarkStatePolicy) {
    this.policy = Object.freeze({
      maxBookmarks: positiveSafe(policy.maxBookmarks, 'maxBookmarks'),
      maxTitleLength: positiveSafe(policy.maxTitleLength, 'maxTitleLength'),
      maxIdLength: positiveSafe(policy.maxIdLength, 'maxIdLength'),
      maxScale: positiveFinite(policy.maxScale, 'maxScale'),
      maxAltitude: positiveFinite(policy.maxAltitude, 'maxAltitude'),
      maxClockSkewMs: positiveFinite(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  upsert(input: Omit<ArcGisBookmarkRecord, 'createdAtMs' | 'updatedAtMs' | 'revision'>, timestampMs: number): ArcGisBookmarkRecord {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    const id = boundedText(input.id, this.policy.maxIdLength, 'id');
    const title = boundedText(input.title, this.policy.maxTitleLength, 'title');
    const mode = normalizeMode(input.mode);
    const camera = this.normalizeCamera(input.camera, mode);
    const existing = this.records.get(id);
    if (existing && now + this.policy.maxClockSkewMs < existing.updatedAtMs) throw new Error('stale bookmark update rejected');

    this.generation += 1;
    const next = freezeRecord({
      id,
      title,
      mode,
      camera,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      revision: (existing?.revision ?? 0) + 1,
    });
    this.records.set(id, next);
    this.enforceCapacity(id);
    return next;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'id');
    const removed = this.records.delete(id);
    if (!removed) return false;
    if (this.activeBookmarkId === id) this.activeBookmarkId = null;
    this.generation += 1;
    return true;
  }

  activate(idValue: string): ArcGisBookmarkRecord {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'id');
    const record = this.records.get(id);
    if (!record) throw new Error('bookmark does not exist');
    if (this.activeBookmarkId !== id) {
      this.activeBookmarkId = id;
      this.generation += 1;
    }
    return record;
  }

  clearActive(): void {
    this.assertUsable();
    if (this.activeBookmarkId === null) return;
    this.activeBookmarkId = null;
    this.generation += 1;
  }

  get(idValue: string): ArcGisBookmarkRecord | null {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'id');
    return this.records.get(id) ?? null;
  }

  snapshot(): ArcGisBookmarkSnapshot {
    this.assertUsable();
    const bookmarks = [...this.records.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
      .map(freezeRecord);
    return Object.freeze({
      generation: this.generation,
      activeBookmarkId: this.activeBookmarkId,
      bookmarks: Object.freeze(bookmarks),
    });
  }

  restore(snapshot: Pick<ArcGisBookmarkSnapshot, 'activeBookmarkId' | 'bookmarks'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.bookmarks) || snapshot.bookmarks.length > this.policy.maxBookmarks) {
      throw new Error('bookmark snapshot exceeds configured capacity');
    }
    const staged = new Map<string, ArcGisBookmarkRecord>();
    for (const source of snapshot.bookmarks) {
      const id = boundedText(source.id, this.policy.maxIdLength, 'id');
      if (staged.has(id)) throw new Error('duplicate bookmark id in snapshot');
      const title = boundedText(source.title, this.policy.maxTitleLength, 'title');
      const mode = normalizeMode(source.mode);
      const camera = this.normalizeCamera(source.camera, mode);
      const createdAtMs = nonNegativeTime(source.createdAtMs, 'createdAtMs');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('bookmark update precedes creation');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future bookmark snapshot rejected');
      const revision = positiveSafe(source.revision, 'revision');
      staged.set(id, freezeRecord({ id, title, mode, camera, createdAtMs, updatedAtMs, revision }));
    }
    let active: string | null = null;
    if (snapshot.activeBookmarkId !== null) {
      active = boundedText(snapshot.activeBookmarkId, this.policy.maxIdLength, 'activeBookmarkId');
      if (!staged.has(active)) throw new Error('active bookmark is missing from snapshot');
    }
    this.records.clear();
    for (const [id, record] of staged) this.records.set(id, record);
    this.activeBookmarkId = active;
    this.generation += 1;
  }

  clear(): void {
    this.assertUsable();
    if (this.records.size === 0 && this.activeBookmarkId === null) return;
    this.records.clear();
    this.activeBookmarkId = null;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
    this.activeBookmarkId = null;
  }

  private normalizeCamera(camera: ArcGisBookmarkCameraState, mode: ArcGisBookmarkViewMode): ArcGisBookmarkCameraState {
    const centerX = finite(camera.centerX, 'centerX');
    const centerY = finite(camera.centerY, 'centerY');
    if (centerY < -90 || centerY > 90) throw new Error('centerY must be within [-90, 90]');
    if (!Number.isSafeInteger(camera.wkid) || camera.wkid <= 0) throw new Error('wkid must be a positive safe integer');
    const scale = positiveFinite(camera.scale, 'scale');
    if (scale > this.policy.maxScale) throw new Error('scale exceeds configured maximum');
    const rotation = finite(camera.rotation, 'rotation');
    if (rotation < -360 || rotation > 360) throw new Error('rotation outside [-360, 360]');
    const tilt = finite(camera.tilt, 'tilt');
    const altitude = finite(camera.altitude, 'altitude');
    if (mode === '2d' && (tilt !== 0 || altitude !== 0)) throw new Error('2d bookmark cannot carry tilt or altitude');
    if (mode === '3d' && (tilt < 0 || tilt > 90 || altitude < 0 || altitude > this.policy.maxAltitude)) {
      throw new Error('3d bookmark camera outside configured bounds');
    }
    return freezeCamera({ centerX, centerY, wkid: camera.wkid, scale, rotation, tilt, altitude });
  }

  private enforceCapacity(protectedId: string): void {
    while (this.records.size > this.policy.maxBookmarks) {
      const candidates = [...this.records.values()]
        .filter(record => record.id !== protectedId)
        .sort((left, right) => left.updatedAtMs - right.updatedAtMs || left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
      const victim = candidates[0];
      if (!victim) throw new Error('bookmark capacity cannot be satisfied');
      this.records.delete(victim.id);
      if (this.activeBookmarkId === victim.id) this.activeBookmarkId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisBookmarkStateCoordinator is disposed');
  }
}
