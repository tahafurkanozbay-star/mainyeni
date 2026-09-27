export type ArcGisDrawingViewMode = '2d' | '3d';
export type ArcGisDrawingGeometryKind = 'point' | 'polyline' | 'polygon';
export type ArcGisDrawingStatus = 'draft' | 'completed';

export interface ArcGisDrawingVertex { readonly x: number; readonly y: number; readonly z: number; }
export interface ArcGisDrawingState {
  readonly id: string; readonly mode: ArcGisDrawingViewMode; readonly kind: ArcGisDrawingGeometryKind;
  readonly status: ArcGisDrawingStatus; readonly wkid: number; readonly vertices: readonly ArcGisDrawingVertex[];
  readonly createdAtMs: number; readonly updatedAtMs: number; readonly revision: number;
}
export interface ArcGisDrawingStatePolicy {
  readonly maxDrawings: number; readonly maxVerticesPerDrawing: number; readonly maxIdLength: number;
  readonly maxAbsCoordinate: number; readonly maxAbsElevation: number; readonly maxClockSkewMs: number; readonly retentionMs: number;
}
export interface ArcGisDrawingStateSnapshot { readonly generation: number; readonly activeId: string | null; readonly drawings: readonly ArcGisDrawingState[]; }

function safePositive(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`); return value; }
function finitePositive(value: number, name: string): number { if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and > 0`); return value; }
function time(value: number, name: string): number { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`); return value; }
function id(value: string, max: number): string { if (typeof value !== 'string') throw new Error('id must be a string'); const normalized = value.trim(); if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error('drawing id outside configured bounds'); return normalized; }
function mode(value: ArcGisDrawingViewMode): ArcGisDrawingViewMode { if (value !== '2d' && value !== '3d') throw new Error('invalid drawing view mode'); return value; }
function kind(value: ArcGisDrawingGeometryKind): ArcGisDrawingGeometryKind { if (value !== 'point' && value !== 'polyline' && value !== 'polygon') throw new Error('invalid drawing geometry kind'); return value; }
function status(value: ArcGisDrawingStatus): ArcGisDrawingStatus { if (value !== 'draft' && value !== 'completed') throw new Error('invalid drawing status'); return value; }
function freezeVertex(value: ArcGisDrawingVertex): ArcGisDrawingVertex { return Object.freeze({ ...value }); }
function freezeState(value: ArcGisDrawingState): ArcGisDrawingState { return Object.freeze({ ...value, vertices: Object.freeze(value.vertices.map(freezeVertex)) }); }

/** Primitive-only bounded authority for user drawing/editing state. It never retains ArcGIS Graphic/Geometry/Sketch handles. */
export class ArcGisDrawingStateCoordinator {
  private readonly policy: ArcGisDrawingStatePolicy;
  private readonly drawings = new Map<string, ArcGisDrawingState>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisDrawingStatePolicy) {
    this.policy = Object.freeze({
      maxDrawings: safePositive(policy.maxDrawings, 'maxDrawings'), maxVerticesPerDrawing: safePositive(policy.maxVerticesPerDrawing, 'maxVerticesPerDrawing'),
      maxIdLength: safePositive(policy.maxIdLength, 'maxIdLength'), maxAbsCoordinate: finitePositive(policy.maxAbsCoordinate, 'maxAbsCoordinate'),
      maxAbsElevation: finitePositive(policy.maxAbsElevation, 'maxAbsElevation'), maxClockSkewMs: finitePositive(policy.maxClockSkewMs, 'maxClockSkewMs'),
      retentionMs: finitePositive(policy.retentionMs, 'retentionMs'),
    });
  }

  upsert(input: Omit<ArcGisDrawingState, 'createdAtMs' | 'updatedAtMs' | 'revision'>, timestampMs: number): ArcGisDrawingState {
    this.assertUsable(); const now = time(timestampMs, 'timestampMs'); this.prune(now);
    const drawingId = id(input.id, this.policy.maxIdLength); const existing = this.drawings.get(drawingId);
    if (existing && now + this.policy.maxClockSkewMs < existing.updatedAtMs) throw new Error('stale drawing update rejected');
    const normalizedKind = kind(input.kind); const normalizedStatus = status(input.status); const normalizedMode = mode(input.mode);
    const next = freezeState({ id: drawingId, mode: normalizedMode, kind: normalizedKind, status: normalizedStatus,
      wkid: this.wkid(input.wkid), vertices: this.vertices(input.vertices, normalizedMode, normalizedKind, normalizedStatus),
      createdAtMs: existing?.createdAtMs ?? now, updatedAtMs: now, revision: (existing?.revision ?? 0) + 1 });
    this.drawings.set(drawingId, next); this.enforceCapacity(drawingId); this.generation += 1; return next;
  }

  activate(value: string, timestampMs: number): ArcGisDrawingState {
    this.assertUsable(); this.prune(time(timestampMs, 'timestampMs')); const drawingId = id(value, this.policy.maxIdLength);
    const drawing = this.drawings.get(drawingId); if (!drawing) throw new Error('drawing does not exist');
    if (this.activeId !== drawingId) { this.activeId = drawingId; this.generation += 1; } return drawing;
  }
  remove(value: string): boolean { this.assertUsable(); const drawingId = id(value, this.policy.maxIdLength); if (!this.drawings.delete(drawingId)) return false; if (this.activeId === drawingId) this.activeId = null; this.generation += 1; return true; }
  clearActive(): void { this.assertUsable(); if (this.activeId === null) return; this.activeId = null; this.generation += 1; }
  clear(): void { this.assertUsable(); if (this.drawings.size === 0 && this.activeId === null) return; this.drawings.clear(); this.activeId = null; this.generation += 1; }

  snapshot(timestampMs: number): ArcGisDrawingStateSnapshot {
    this.assertUsable(); this.prune(time(timestampMs, 'timestampMs'));
    const drawings = [...this.drawings.values()].sort((a,b) => a.updatedAtMs-b.updatedAtMs || a.id.localeCompare(b.id)).map(freezeState);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, drawings: Object.freeze(drawings) });
  }

  restore(snapshot: Pick<ArcGisDrawingStateSnapshot, 'activeId' | 'drawings'>, timestampMs: number): void {
    this.assertUsable(); const now = time(timestampMs, 'timestampMs'); if (!Array.isArray(snapshot.drawings) || snapshot.drawings.length > this.policy.maxDrawings) throw new Error('drawing snapshot exceeds capacity');
    const staged = new Map<string, ArcGisDrawingState>();
    for (const source of snapshot.drawings) {
      const drawingId = id(source.id, this.policy.maxIdLength); if (staged.has(drawingId)) throw new Error('duplicate drawing id');
      const createdAtMs = time(source.createdAtMs, 'createdAtMs'); const updatedAtMs = time(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('drawing update precedes creation'); if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future drawing snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue; const revision = safePositive(source.revision, 'revision'); const normalizedMode = mode(source.mode); const normalizedKind = kind(source.kind); const normalizedStatus = status(source.status);
      staged.set(drawingId, freezeState({ id: drawingId, mode: normalizedMode, kind: normalizedKind, status: normalizedStatus, wkid: this.wkid(source.wkid), vertices: this.vertices(source.vertices, normalizedMode, normalizedKind, normalizedStatus), createdAtMs, updatedAtMs, revision }));
    }
    let active: string | null = null; if (snapshot.activeId !== null) { active = id(snapshot.activeId, this.policy.maxIdLength); if (!staged.has(active)) throw new Error('active drawing is missing'); }
    this.drawings.clear(); for (const [key,value] of staged) this.drawings.set(key,value); this.activeId = active; this.generation += 1;
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.drawings.clear(); this.activeId = null; }
  private wkid(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error('wkid must be a positive safe integer'); return value; }
  private vertices(values: readonly ArcGisDrawingVertex[], drawingMode: ArcGisDrawingViewMode, drawingKind: ArcGisDrawingGeometryKind, drawingStatus: ArcGisDrawingStatus): readonly ArcGisDrawingVertex[] {
    if (!Array.isArray(values) || values.length === 0 || values.length > this.policy.maxVerticesPerDrawing) throw new Error('drawing vertices outside configured bounds');
    if (drawingStatus === 'completed' && drawingKind === 'point' && values.length !== 1) throw new Error('completed point requires exactly one vertex');
    if (drawingStatus === 'completed' && drawingKind === 'polyline' && values.length < 2) throw new Error('completed polyline requires at least two vertices');
    if (drawingStatus === 'completed' && drawingKind === 'polygon' && values.length < 3) throw new Error('completed polygon requires at least three vertices');
    return Object.freeze(values.map(vertex => { if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !Number.isFinite(vertex.z)) throw new Error('drawing coordinates must be finite'); if (Math.abs(vertex.x) > this.policy.maxAbsCoordinate || Math.abs(vertex.y) > this.policy.maxAbsCoordinate) throw new Error('drawing coordinate exceeds configured maximum'); if (Math.abs(vertex.z) > this.policy.maxAbsElevation) throw new Error('drawing elevation exceeds configured maximum'); if (drawingMode === '2d' && vertex.z !== 0) throw new Error('2d drawing cannot carry elevation'); return freezeVertex(vertex); }));
  }
  private prune(now: number): void { let changed = false; for (const [key,value] of this.drawings) { if (now-value.updatedAtMs <= this.policy.retentionMs) continue; this.drawings.delete(key); if (this.activeId === key) this.activeId = null; changed = true; } if (changed) this.generation += 1; }
  private enforceCapacity(protectedId: string): void { while (this.drawings.size > this.policy.maxDrawings) { const victim = [...this.drawings.values()].filter(value => value.id !== protectedId).sort((a,b) => a.updatedAtMs-b.updatedAtMs || a.id.localeCompare(b.id))[0]; if (!victim) throw new Error('drawing capacity cannot be satisfied'); this.drawings.delete(victim.id); if (this.activeId === victim.id) this.activeId = null; } }
  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisDrawingStateCoordinator is disposed'); }
}
