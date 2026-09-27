export type ArcGisTimePlaybackDirection = 'forward' | 'reverse';

export interface ArcGisTimeExtent {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ArcGisTimeState {
  readonly id: string;
  readonly extent: ArcGisTimeExtent;
  readonly cursorMs: number;
  readonly stepMs: number;
  readonly direction: ArcGisTimePlaybackDirection;
  readonly playing: boolean;
  readonly updatedAtMs: number;
  readonly revision: number;
}

export interface ArcGisTimeStatePolicy {
  readonly maxStates: number;
  readonly maxIdLength: number;
  readonly maxExtentMs: number;
  readonly maxStepMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisTimeStateSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly states: readonly ArcGisTimeState[];
}

function positiveSafe(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function finiteTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}
function boundedId(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('id must be a string');
  const id = value.trim();
  if (id.length === 0 || id.length > maxLength || id.includes('\0')) throw new Error('id is outside configured bounds');
  return id;
}
function direction(value: ArcGisTimePlaybackDirection): ArcGisTimePlaybackDirection {
  if (value !== 'forward' && value !== 'reverse') throw new Error('invalid playback direction');
  return value;
}
function freezeExtent(value: ArcGisTimeExtent): ArcGisTimeExtent { return Object.freeze({ ...value }); }
function freezeState(value: ArcGisTimeState): ArcGisTimeState { return Object.freeze({ ...value, extent: freezeExtent(value.extent) }); }

/** Primitive-only temporal authority for ArcGIS time-aware layers and views. */
export class ArcGisTimeStateCoordinator {
  private readonly policy: ArcGisTimeStatePolicy;
  private readonly states = new Map<string, ArcGisTimeState>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisTimeStatePolicy) {
    this.policy = Object.freeze({
      maxStates: positiveSafe(policy.maxStates, 'maxStates'),
      maxIdLength: positiveSafe(policy.maxIdLength, 'maxIdLength'),
      maxExtentMs: positiveSafe(policy.maxExtentMs, 'maxExtentMs'),
      maxStepMs: positiveSafe(policy.maxStepMs, 'maxStepMs'),
      maxClockSkewMs: positiveSafe(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  upsert(input: Omit<ArcGisTimeState, 'updatedAtMs' | 'revision'>, timestampMs: number): ArcGisTimeState {
    this.assertUsable();
    const now = finiteTime(timestampMs, 'timestampMs');
    const id = boundedId(input.id, this.policy.maxIdLength);
    const existing = this.states.get(id);
    if (existing && now + this.policy.maxClockSkewMs < existing.updatedAtMs) throw new Error('stale time-state update rejected');
    const extent = this.normalizeExtent(input.extent);
    const cursorMs = finiteTime(input.cursorMs, 'cursorMs');
    if (cursorMs < extent.startMs || cursorMs > extent.endMs) throw new Error('cursor must be inside extent');
    const stepMs = positiveSafe(input.stepMs, 'stepMs');
    if (stepMs > this.policy.maxStepMs) throw new Error('step exceeds configured maximum');
    const next = freezeState({ id, extent, cursorMs, stepMs, direction: direction(input.direction), playing: Boolean(input.playing), updatedAtMs: now, revision: (existing?.revision ?? 0) + 1 });
    this.states.set(id, next);
    this.enforceCapacity(id);
    this.generation += 1;
    return next;
  }

  advance(idValue: string, timestampMs: number): ArcGisTimeState {
    this.assertUsable();
    const id = boundedId(idValue, this.policy.maxIdLength);
    const current = this.states.get(id);
    if (!current) throw new Error('time state does not exist');
    const delta = current.direction === 'forward' ? current.stepMs : -current.stepMs;
    const unclamped = current.cursorMs + delta;
    const cursorMs = Math.min(current.extent.endMs, Math.max(current.extent.startMs, unclamped));
    return this.upsert({ ...current, cursorMs, playing: current.playing }, timestampMs);
  }

  activate(idValue: string): ArcGisTimeState {
    this.assertUsable();
    const id = boundedId(idValue, this.policy.maxIdLength);
    const state = this.states.get(id);
    if (!state) throw new Error('time state does not exist');
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

  snapshot(): ArcGisTimeStateSnapshot {
    this.assertUsable();
    const states = [...this.states.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id)).map(freezeState);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, states: Object.freeze(states) });
  }

  restore(snapshot: Pick<ArcGisTimeStateSnapshot, 'activeId' | 'states'>, timestampMs: number): void {
    this.assertUsable();
    const now = finiteTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.states) || snapshot.states.length > this.policy.maxStates) throw new Error('time-state snapshot exceeds capacity');
    const staged = new Map<string, ArcGisTimeState>();
    for (const source of snapshot.states) {
      const id = boundedId(source.id, this.policy.maxIdLength);
      if (staged.has(id)) throw new Error('duplicate time-state id');
      if (!Number.isSafeInteger(source.revision) || source.revision <= 0) throw new Error('revision must be positive');
      const updatedAtMs = finiteTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future time-state snapshot rejected');
      const extent = this.normalizeExtent(source.extent);
      const cursorMs = finiteTime(source.cursorMs, 'cursorMs');
      if (cursorMs < extent.startMs || cursorMs > extent.endMs) throw new Error('cursor must be inside extent');
      const stepMs = positiveSafe(source.stepMs, 'stepMs');
      if (stepMs > this.policy.maxStepMs) throw new Error('step exceeds configured maximum');
      staged.set(id, freezeState({ id, extent, cursorMs, stepMs, direction: direction(source.direction), playing: Boolean(source.playing), updatedAtMs, revision: source.revision }));
    }
    let active: string | null = null;
    if (snapshot.activeId !== null) {
      active = boundedId(snapshot.activeId, this.policy.maxIdLength);
      if (!staged.has(active)) throw new Error('active time state is missing');
    }
    this.states.clear();
    for (const [id, state] of staged) this.states.set(id, state);
    this.activeId = active;
    this.generation += 1;
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.states.clear(); this.activeId = null; } }

  private normalizeExtent(value: ArcGisTimeExtent): ArcGisTimeExtent {
    const startMs = finiteTime(value.startMs, 'startMs');
    const endMs = finiteTime(value.endMs, 'endMs');
    if (endMs < startMs) throw new Error('time extent is reversed');
    if (endMs - startMs > this.policy.maxExtentMs) throw new Error('time extent exceeds configured maximum');
    return freezeExtent({ startMs, endMs });
  }

  private enforceCapacity(protectedId: string): void {
    while (this.states.size > this.policy.maxStates) {
      const victim = [...this.states.values()].filter(item => item.id !== protectedId).sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))[0];
      if (!victim) throw new Error('time-state capacity cannot be satisfied');
      this.states.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisTimeStateCoordinator is disposed'); }
}
