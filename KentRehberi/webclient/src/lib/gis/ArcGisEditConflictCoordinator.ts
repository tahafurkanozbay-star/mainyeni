export type ArcGisConflictObjectId = string | number;
export type ArcGisConflictKind = 'revision' | 'deleted' | 'attribute' | 'geometry';
export type ArcGisConflictResolution = 'local' | 'remote' | 'manual';

export interface ArcGisConflictTarget {
  readonly layerKey: string;
  readonly objectId: ArcGisConflictObjectId;
}
export interface ArcGisEditConflict {
  readonly id: string;
  readonly target: ArcGisConflictTarget;
  readonly kind: ArcGisConflictKind;
  readonly localRevision: number;
  readonly remoteRevision: number;
  readonly detectedAtMs: number;
  readonly updatedAtMs: number;
  readonly resolution: ArcGisConflictResolution | null;
  readonly revision: number;
}
export interface ArcGisEditConflictPolicy {
  readonly maxConflicts: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}
export interface ArcGisEditConflictSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly conflicts: readonly ArcGisEditConflict[];
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function time(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}
function text(value: string, max: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
}
function revision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
function objectId(value: ArcGisConflictObjectId): ArcGisConflictObjectId {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('numeric objectId must be a safe integer');
    return value;
  }
  if (typeof value !== 'string') throw new Error('objectId must be a string or safe integer');
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) throw new Error('string objectId outside configured bounds');
  return normalized;
}
function kind(value: ArcGisConflictKind): ArcGisConflictKind {
  if (value !== 'revision' && value !== 'deleted' && value !== 'attribute' && value !== 'geometry') throw new Error('invalid conflict kind');
  return value;
}
function resolution(value: ArcGisConflictResolution): ArcGisConflictResolution {
  if (value !== 'local' && value !== 'remote' && value !== 'manual') throw new Error('invalid conflict resolution');
  return value;
}
function freezeTarget(value: ArcGisConflictTarget): ArcGisConflictTarget { return Object.freeze({ ...value }); }
function freezeConflict(value: ArcGisEditConflict): ArcGisEditConflict {
  return Object.freeze({ ...value, target: freezeTarget(value.target) });
}

/**
 * Bounded primitive-only optimistic-edit conflict authority. It deliberately
 * retains no ArcGIS Graphic, Geometry, FeatureLayer, LayerView or applyEdits
 * response. Callers keep payload ownership and use stable identities here.
 */
export class ArcGisEditConflictCoordinator {
  private readonly policy: ArcGisEditConflictPolicy;
  private readonly conflicts = new Map<string, ArcGisEditConflict>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisEditConflictPolicy) {
    this.policy = Object.freeze({
      maxConflicts: positive(policy.maxConflicts, 'maxConflicts'),
      maxIdLength: positive(policy.maxIdLength, 'maxIdLength'),
      maxLayerKeyLength: positive(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      retentionMs: positive(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positive(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  detect(input: {
    readonly id: string;
    readonly target: ArcGisConflictTarget;
    readonly kind: ArcGisConflictKind;
    readonly localRevision: number;
    readonly remoteRevision: number;
  }, timestampMs: number): ArcGisEditConflict {
    this.assertUsable();
    const now = time(timestampMs, 'timestampMs');
    this.prune(now);
    const id = text(input.id, this.policy.maxIdLength, 'conflict id');
    const existing = this.conflicts.get(id);
    if (existing && now + this.policy.maxClockSkewMs < existing.updatedAtMs) throw new Error('stale conflict observation rejected');
    const target = this.normalizeTarget(input.target);
    const localRevision = revision(input.localRevision, 'localRevision');
    const remoteRevision = revision(input.remoteRevision, 'remoteRevision');
    if (input.kind === 'revision' && localRevision === remoteRevision) throw new Error('revision conflict requires divergent revisions');
    if (existing && !this.sameTarget(existing.target, target)) throw new Error('conflict id cannot change target');
    const next = freezeConflict({
      id,
      target,
      kind: kind(input.kind),
      localRevision,
      remoteRevision,
      detectedAtMs: existing?.detectedAtMs ?? now,
      updatedAtMs: now,
      resolution: null,
      revision: (existing?.revision ?? 0) + 1,
    });
    this.conflicts.set(id, next);
    this.enforceCapacity(id);
    this.activeId = id;
    this.generation += 1;
    return next;
  }

  resolve(idValue: string, choice: ArcGisConflictResolution, timestampMs: number): ArcGisEditConflict {
    this.assertUsable();
    const now = time(timestampMs, 'timestampMs');
    this.prune(now);
    const id = text(idValue, this.policy.maxIdLength, 'conflict id');
    const current = this.conflicts.get(id);
    if (!current) throw new Error('conflict does not exist');
    if (now + this.policy.maxClockSkewMs < current.updatedAtMs) throw new Error('stale conflict resolution rejected');
    if (current.resolution !== null) throw new Error('conflict is already resolved');
    const next = freezeConflict({ ...current, resolution: resolution(choice), updatedAtMs: now, revision: current.revision + 1 });
    this.conflicts.set(id, next);
    this.generation += 1;
    return next;
  }

  activate(idValue: string, timestampMs: number): ArcGisEditConflict {
    this.assertUsable();
    this.prune(time(timestampMs, 'timestampMs'));
    const id = text(idValue, this.policy.maxIdLength, 'conflict id');
    const current = this.conflicts.get(id);
    if (!current) throw new Error('conflict does not exist');
    if (this.activeId !== id) { this.activeId = id; this.generation += 1; }
    return current;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = text(idValue, this.policy.maxIdLength, 'conflict id');
    if (!this.conflicts.delete(id)) return false;
    if (this.activeId === id) this.activeId = null;
    this.generation += 1;
    return true;
  }

  snapshot(timestampMs: number): ArcGisEditConflictSnapshot {
    this.assertUsable();
    this.prune(time(timestampMs, 'timestampMs'));
    const conflicts = [...this.conflicts.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
      .map(freezeConflict);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, conflicts: Object.freeze(conflicts) });
  }

  restore(snapshot: Pick<ArcGisEditConflictSnapshot, 'activeId' | 'conflicts'>, timestampMs: number): void {
    this.assertUsable();
    const now = time(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.conflicts) || snapshot.conflicts.length > this.policy.maxConflicts) throw new Error('conflict snapshot exceeds capacity');
    const staged = new Map<string, ArcGisEditConflict>();
    for (const source of snapshot.conflicts) {
      const id = text(source.id, this.policy.maxIdLength, 'conflict id');
      if (staged.has(id)) throw new Error('duplicate conflict id');
      const detectedAtMs = time(source.detectedAtMs, 'detectedAtMs');
      const updatedAtMs = time(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < detectedAtMs) throw new Error('conflict update precedes detection');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future conflict snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue;
      const localRevision = revision(source.localRevision, 'localRevision');
      const remoteRevision = revision(source.remoteRevision, 'remoteRevision');
      const normalizedKind = kind(source.kind);
      if (normalizedKind === 'revision' && localRevision === remoteRevision) throw new Error('restored revision conflict requires divergent revisions');
      const normalizedResolution = source.resolution === null ? null : resolution(source.resolution);
      staged.set(id, freezeConflict({
        id,
        target: this.normalizeTarget(source.target),
        kind: normalizedKind,
        localRevision,
        remoteRevision,
        detectedAtMs,
        updatedAtMs,
        resolution: normalizedResolution,
        revision: positive(source.revision, 'revision'),
      }));
    }
    let activeId: string | null = null;
    if (snapshot.activeId !== null) {
      activeId = text(snapshot.activeId, this.policy.maxIdLength, 'active conflict id');
      if (!staged.has(activeId)) throw new Error('active conflict is missing');
    }
    this.conflicts.clear();
    for (const [key, value] of staged) this.conflicts.set(key, value);
    this.activeId = activeId;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.conflicts.clear();
    this.activeId = null;
  }

  private normalizeTarget(target: ArcGisConflictTarget): ArcGisConflictTarget {
    if (!target || typeof target !== 'object') throw new Error('conflict target is required');
    return freezeTarget({
      layerKey: text(target.layerKey, this.policy.maxLayerKeyLength, 'layerKey'),
      objectId: objectId(target.objectId),
    });
  }
  private sameTarget(a: ArcGisConflictTarget, b: ArcGisConflictTarget): boolean {
    return a.layerKey === b.layerKey && typeof a.objectId === typeof b.objectId && a.objectId === b.objectId;
  }
  private prune(now: number): void {
    let changed = false;
    for (const [id, conflict] of this.conflicts) {
      if (now - conflict.updatedAtMs <= this.policy.retentionMs) continue;
      this.conflicts.delete(id);
      if (this.activeId === id) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }
  private enforceCapacity(protectedId: string): void {
    while (this.conflicts.size > this.policy.maxConflicts) {
      const victim = [...this.conflicts.values()]
        .filter(item => item.id !== protectedId)
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))[0];
      if (!victim) throw new Error('conflict capacity cannot be satisfied');
      this.conflicts.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }
  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisEditConflictCoordinator is disposed');
  }
}
