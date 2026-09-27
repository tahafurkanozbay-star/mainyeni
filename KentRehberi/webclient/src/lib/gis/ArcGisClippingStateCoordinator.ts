export type ArcGisClippingViewMode = '2d' | '3d';
export type ArcGisClippingOperation = 'include' | 'exclude';

export interface ArcGisClippingPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ArcGisClippingState {
  readonly id: string;
  readonly mode: ArcGisClippingViewMode;
  readonly operation: ArcGisClippingOperation;
  readonly wkid: number;
  readonly points: readonly ArcGisClippingPoint[];
  readonly enabled: boolean;
  readonly updatedAtMs: number;
  readonly revision: number;
}

export interface ArcGisClippingStatePolicy {
  readonly maxStates: number;
  readonly maxPointsPerState: number;
  readonly maxIdLength: number;
  readonly maxAbsCoordinate: number;
  readonly maxAbsElevation: number;
  readonly maxClockSkewMs: number;
  readonly retentionMs: number;
}

export interface ArcGisClippingStateSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly states: readonly ArcGisClippingState[];
}

function positiveSafe(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and > 0`);
  return value;
}
function nonNegativeTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}
function boundedId(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('id must be a string');
  const id = value.trim();
  if (id.length === 0 || id.length > maxLength || id.includes('\0')) throw new Error('id is outside configured bounds');
  return id;
}
function normalizeMode(value: ArcGisClippingViewMode): ArcGisClippingViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid clipping view mode');
  return value;
}
function normalizeOperation(value: ArcGisClippingOperation): ArcGisClippingOperation {
  if (value !== 'include' && value !== 'exclude') throw new Error('invalid clipping operation');
  return value;
}
function freezePoint(point: ArcGisClippingPoint): ArcGisClippingPoint { return Object.freeze({ ...point }); }
function freezeState(state: ArcGisClippingState): ArcGisClippingState {
  return Object.freeze({ ...state, points: Object.freeze(state.points.map(freezePoint)) });
}

/** Primitive-only bounded authority for ArcGIS clipping/section definitions. */
export class ArcGisClippingStateCoordinator {
  private readonly policy: ArcGisClippingStatePolicy;
  private readonly states = new Map<string, ArcGisClippingState>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisClippingStatePolicy) {
    this.policy = Object.freeze({
      maxStates: positiveSafe(policy.maxStates, 'maxStates'),
      maxPointsPerState: positiveSafe(policy.maxPointsPerState, 'maxPointsPerState'),
      maxIdLength: positiveSafe(policy.maxIdLength, 'maxIdLength'),
      maxAbsCoordinate: positiveFinite(policy.maxAbsCoordinate, 'maxAbsCoordinate'),
      maxAbsElevation: positiveFinite(policy.maxAbsElevation, 'maxAbsElevation'),
      maxClockSkewMs: positiveFinite(policy.maxClockSkewMs, 'maxClockSkewMs'),
      retentionMs: positiveFinite(policy.retentionMs, 'retentionMs'),
    });
  }

  upsert(input: Omit<ArcGisClippingState, 'updatedAtMs' | 'revision'>, timestampMs: number): ArcGisClippingState {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedId(input.id, this.policy.maxIdLength);
    const existing = this.states.get(id);
    if (existing && now + this.policy.maxClockSkewMs < existing.updatedAtMs) throw new Error('stale clipping update rejected');
    const next = freezeState({
      id,
      mode: normalizeMode(input.mode),
      operation: normalizeOperation(input.operation),
      wkid: this.normalizeWkid(input.wkid),
      points: this.normalizePoints(input.points, input.mode),
      enabled: Boolean(input.enabled),
      updatedAtMs: now,
      revision: (existing?.revision ?? 0) + 1,
    });
    this.states.set(id, next);
    this.enforceCapacity(id);
    this.generation += 1;
    return next;
  }

  activate(idValue: string, timestampMs: number): ArcGisClippingState {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const id = boundedId(idValue, this.policy.maxIdLength);
    const state = this.states.get(id);
    if (!state) throw new Error('clipping state does not exist');
    if (this.activeId !== id) { this.activeId = id; this.generation += 1; }
    return state;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = boundedId(idValue, this.policy.maxIdLength);
    if (!this.states.delete(id)) return false;
    if (this.activeId === id) this.activeId = null;
    this.generation += 1;
    return true;
  }

  clearActive(): void {
    this.assertUsable();
    if (this.activeId === null) return;
    this.activeId = null;
    this.generation += 1;
  }

  snapshot(timestampMs: number): ArcGisClippingStateSnapshot {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const states = [...this.states.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
      .map(freezeState);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, states: Object.freeze(states) });
  }

  restore(snapshot: Pick<ArcGisClippingStateSnapshot, 'activeId' | 'states'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.states) || snapshot.states.length > this.policy.maxStates) throw new Error('clipping snapshot exceeds capacity');
    const staged = new Map<string, ArcGisClippingState>();
    for (const source of snapshot.states) {
      const id = boundedId(source.id, this.policy.maxIdLength);
      if (staged.has(id)) throw new Error('duplicate clipping state id');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future clipping snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue;
      const revision = positiveSafe(source.revision, 'revision');
      staged.set(id, freezeState({
        id,
        mode: normalizeMode(source.mode),
        operation: normalizeOperation(source.operation),
        wkid: this.normalizeWkid(source.wkid),
        points: this.normalizePoints(source.points, source.mode),
        enabled: Boolean(source.enabled),
        updatedAtMs,
        revision,
      }));
    }
    let active: string | null = null;
    if (snapshot.activeId !== null) {
      active = boundedId(snapshot.activeId, this.policy.maxIdLength);
      if (!staged.has(active)) throw new Error('active clipping state is missing');
    }
    this.states.clear();
    for (const [id, state] of staged) this.states.set(id, state);
    this.activeId = active;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.states.clear();
    this.activeId = null;
  }

  private normalizeWkid(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('wkid must be a positive safe integer');
    return value;
  }

  private normalizePoints(value: readonly ArcGisClippingPoint[], modeValue: ArcGisClippingViewMode): readonly ArcGisClippingPoint[] {
    if (!Array.isArray(value) || value.length < 2 || value.length > this.policy.maxPointsPerState) throw new Error('clipping points outside configured bounds');
    const mode = normalizeMode(modeValue);
    const points = value.map(point => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) throw new Error('clipping coordinates must be finite');
      if (Math.abs(point.x) > this.policy.maxAbsCoordinate || Math.abs(point.y) > this.policy.maxAbsCoordinate) throw new Error('clipping coordinate exceeds configured maximum');
      if (Math.abs(point.z) > this.policy.maxAbsElevation) throw new Error('clipping elevation exceeds configured maximum');
      if (mode === '2d' && point.z !== 0) throw new Error('2d clipping state cannot carry elevation');
      return freezePoint({ x: point.x, y: point.y, z: point.z });
    });
    return Object.freeze(points);
  }

  private prune(now: number): void {
    let changed = false;
    for (const [id, state] of this.states) {
      if (now - state.updatedAtMs <= this.policy.retentionMs) continue;
      this.states.delete(id);
      if (this.activeId === id) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedId: string): void {
    while (this.states.size > this.policy.maxStates) {
      const victim = [...this.states.values()]
        .filter(state => state.id !== protectedId)
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))[0];
      if (!victim) throw new Error('clipping-state capacity cannot be satisfied');
      this.states.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisClippingStateCoordinator is disposed');
  }
}
