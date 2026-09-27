export type ArcGisMeasurementMode = '2d' | '3d';
export type ArcGisMeasurementKind = 'distance' | 'area' | 'height';
export type ArcGisMeasurementStatus = 'draft' | 'complete';

export interface ArcGisMeasurementPoint {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface ArcGisMeasurementRequest {
  readonly id: string;
  readonly kind: ArcGisMeasurementKind;
  readonly wkid: number;
  readonly points: readonly ArcGisMeasurementPoint[];
  readonly observedAtMs: number;
  readonly status?: ArcGisMeasurementStatus;
}

export interface ArcGisMeasurementPolicy {
  readonly maxEntries: number;
  readonly maxPointsPerEntry: number;
  readonly maxIdLength: number;
  readonly retentionMs: number;
  readonly maxCoordinateMagnitude: number;
  readonly maxAbsoluteZ: number;
}

export interface ArcGisMeasurementEntry {
  readonly id: string;
  readonly kind: ArcGisMeasurementKind;
  readonly wkid: number;
  readonly points: readonly ArcGisMeasurementPoint[];
  readonly observedAtMs: number;
  readonly status: ArcGisMeasurementStatus;
  readonly generation: number;
}

export interface ArcGisMeasurementSnapshot {
  readonly mode: ArcGisMeasurementMode;
  readonly activeId: string | null;
  readonly generation: number;
  readonly entries: readonly ArcGisMeasurementEntry[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

/**
 * Bounded primitive-only measurement authority for 2D/3D view transitions.
 * ArcGIS widgets, Graphics, geometries and handles remain caller-owned.
 */
export class ArcGisMeasurementStateCoordinator {
  private readonly policy: ArcGisMeasurementPolicy;
  private readonly entries = new Map<string, ArcGisMeasurementEntry>();
  private mode: ArcGisMeasurementMode = '2d';
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisMeasurementPolicy) {
    this.policy = Object.freeze({
      maxEntries: positiveInteger(policy.maxEntries, 'maxEntries'),
      maxPointsPerEntry: positiveInteger(policy.maxPointsPerEntry, 'maxPointsPerEntry'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxCoordinateMagnitude: finitePositive(policy.maxCoordinateMagnitude, 'maxCoordinateMagnitude'),
      maxAbsoluteZ: finitePositive(policy.maxAbsoluteZ, 'maxAbsoluteZ'),
    });
  }

  setMode(mode: ArcGisMeasurementMode): boolean {
    this.assertUsable();
    if (mode !== '2d' && mode !== '3d') throw new Error('invalid measurement mode');
    if (mode === this.mode) return false;
    this.mode = mode;
    this.generation += 1;
    return true;
  }

  upsert(request: ArcGisMeasurementRequest, nowMs: number): ArcGisMeasurementEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const normalized = this.normalizeRequest(request, now);
    this.pruneInternal(now);
    const existing = this.entries.get(normalized.id);
    if (existing && normalized.observedAtMs < existing.observedAtMs) throw new Error('stale measurement update');
    if (!existing && this.entries.size >= this.policy.maxEntries) this.evictOldest();
    this.generation += 1;
    const entry = Object.freeze({ ...normalized, generation: this.generation });
    this.entries.set(entry.id, entry);
    this.activeId = entry.id;
    return entry;
  }

  activate(id: string, nowMs: number): boolean {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    this.pruneInternal(now);
    const normalized = this.normalizeId(id);
    if (!this.entries.has(normalized)) return false;
    if (this.activeId === normalized) return false;
    this.activeId = normalized;
    this.generation += 1;
    return true;
  }

  complete(id: string, observedAtMs: number, nowMs: number): ArcGisMeasurementEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const observed = finiteNonNegative(observedAtMs, 'observedAtMs');
    if (observed > now) throw new Error('observedAtMs cannot be in the future');
    const normalized = this.normalizeId(id);
    const current = this.entries.get(normalized);
    if (!current) throw new Error('measurement does not exist');
    if (observed < current.observedAtMs) throw new Error('stale measurement completion');
    if (current.status === 'complete' && observed === current.observedAtMs) return current;
    this.generation += 1;
    const next = Object.freeze({ ...current, observedAtMs: observed, status: 'complete' as const, generation: this.generation });
    this.entries.set(normalized, next);
    return next;
  }

  remove(id: string): boolean {
    this.assertUsable();
    const normalized = this.normalizeId(id);
    if (!this.entries.delete(normalized)) return false;
    if (this.activeId === normalized) this.activeId = null;
    this.generation += 1;
    return true;
  }

  clearActive(): boolean {
    this.assertUsable();
    if (this.activeId === null) return false;
    this.activeId = null;
    this.generation += 1;
    return true;
  }

  prune(nowMs: number): number {
    this.assertUsable();
    return this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
  }

  snapshot(nowMs?: number): ArcGisMeasurementSnapshot {
    this.assertUsable();
    if (nowMs !== undefined) this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
    const entries = [...this.entries.values()].sort((a, b) =>
      b.observedAtMs - a.observedAtMs || a.id.localeCompare(b.id));
    return Object.freeze({
      mode: this.mode,
      activeId: this.activeId,
      generation: this.generation,
      entries: Object.freeze(entries),
    });
  }

  restore(snapshot: Pick<ArcGisMeasurementSnapshot, 'mode' | 'activeId' | 'entries'>, nowMs: number): void {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    if (snapshot.mode !== '2d' && snapshot.mode !== '3d') throw new Error('invalid measurement mode');
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid measurement snapshot');
    const next = new Map<string, ArcGisMeasurementEntry>();
    for (const raw of snapshot.entries) {
      const normalized = this.normalizeRequest(raw, now);
      if (now - normalized.observedAtMs > this.policy.retentionMs) continue;
      if (next.has(normalized.id)) throw new Error('duplicate measurement id');
      this.generation += 1;
      next.set(normalized.id, Object.freeze({ ...normalized, generation: this.generation }));
    }
    const activeId = snapshot.activeId === null ? null : this.normalizeId(snapshot.activeId);
    if (activeId !== null && !next.has(activeId)) throw new Error('active measurement is absent from snapshot');
    this.entries.clear();
    for (const [id, entry] of next) this.entries.set(id, entry);
    this.activeId = activeId;
    this.mode = snapshot.mode;
    this.generation += 1;
  }

  clear(): void {
    this.assertUsable();
    if (!this.entries.size && this.activeId === null) return;
    this.entries.clear();
    this.activeId = null;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.activeId = null;
  }

  private normalizeRequest(request: ArcGisMeasurementRequest, now: number): Omit<ArcGisMeasurementEntry, 'generation'> {
    const id = this.normalizeId(request.id);
    const kind = request.kind;
    if (kind !== 'distance' && kind !== 'area' && kind !== 'height') throw new Error('invalid measurement kind');
    if (!Number.isSafeInteger(request.wkid) || request.wkid <= 0) throw new Error('invalid measurement WKID');
    const observedAtMs = finiteNonNegative(request.observedAtMs, 'observedAtMs');
    if (observedAtMs > now) throw new Error('observedAtMs cannot be in the future');
    const status = request.status ?? 'draft';
    if (status !== 'draft' && status !== 'complete') throw new Error('invalid measurement status');
    if (!Array.isArray(request.points) || request.points.length < 1 || request.points.length > this.policy.maxPointsPerEntry) {
      throw new Error('invalid measurement point count');
    }
    if (kind === 'area' && status === 'complete' && request.points.length < 3) throw new Error('completed area requires at least three points');
    if ((kind === 'distance' || kind === 'height') && status === 'complete' && request.points.length < 2) {
      throw new Error('completed linear measurement requires at least two points');
    }
    const points = Object.freeze(request.points.map((point) => this.normalizePoint(point, kind)));
    return Object.freeze({ id, kind, wkid: request.wkid, points, observedAtMs, status });
  }

  private normalizePoint(point: ArcGisMeasurementPoint, kind: ArcGisMeasurementKind): ArcGisMeasurementPoint {
    if (!point || typeof point !== 'object') throw new Error('invalid measurement point');
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('measurement coordinates must be finite');
    if (Math.abs(point.x) > this.policy.maxCoordinateMagnitude || Math.abs(point.y) > this.policy.maxCoordinateMagnitude) {
      throw new Error('measurement coordinate exceeds configured magnitude');
    }
    if (point.z !== undefined) {
      if (!Number.isFinite(point.z) || Math.abs(point.z) > this.policy.maxAbsoluteZ) throw new Error('invalid measurement elevation');
    }
    if (kind === 'height' && point.z === undefined) throw new Error('height measurement requires elevation');
    return point.z === undefined ? Object.freeze({ x: point.x, y: point.y }) : Object.freeze({ x: point.x, y: point.y, z: point.z });
  }

  private normalizeId(value: string): string {
    if (typeof value !== 'string') throw new Error('invalid measurement id');
    if (!value || value.length > this.policy.maxIdLength || value.trim() !== value || value.includes('\u0000')) throw new Error('invalid measurement id');
    return value;
  }

  private pruneInternal(now: number): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now < entry.observedAtMs) throw new Error('clock moved before measurement observation');
      if (now - entry.observedAtMs <= this.policy.retentionMs) continue;
      this.entries.delete(id);
      if (this.activeId === id) this.activeId = null;
      removed += 1;
    }
    if (removed) this.generation += 1;
    return removed;
  }

  private evictOldest(): void {
    const victim = [...this.entries.values()].sort((a, b) => a.observedAtMs - b.observedAtMs || a.id.localeCompare(b.id))[0];
    if (!victim) throw new Error('measurement capacity exceeded');
    this.entries.delete(victim.id);
    if (this.activeId === victim.id) this.activeId = null;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisMeasurementStateCoordinator is disposed');
  }
}
