export type ArcGisEditViewMode = '2d' | '3d';
export type ArcGisEditOperation = 'create' | 'update' | 'delete';
export type ArcGisEditStatus = 'draft' | 'validated' | 'committing' | 'committed' | 'failed';
export type ArcGisEditObjectId = string | number;

export interface ArcGisEditTarget {
  readonly layerKey: string;
  readonly objectId: ArcGisEditObjectId | null;
}

export interface ArcGisEditSession {
  readonly id: string;
  readonly mode: ArcGisEditViewMode;
  readonly operation: ArcGisEditOperation;
  readonly status: ArcGisEditStatus;
  readonly target: ArcGisEditTarget;
  readonly baseRevision: number | null;
  readonly attempt: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
  readonly failureCode: string | null;
}

export interface ArcGisEditSessionPolicy {
  readonly maxSessions: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly maxFailureCodeLength: number;
  readonly maxAttempts: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisEditSessionSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly sessions: readonly ArcGisEditSession[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function nonNegativeTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}
function boundedText(value: string, maxLength: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
}
function viewMode(value: ArcGisEditViewMode): ArcGisEditViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid edit view mode');
  return value;
}
function operation(value: ArcGisEditOperation): ArcGisEditOperation {
  if (value !== 'create' && value !== 'update' && value !== 'delete') throw new Error('invalid edit operation');
  return value;
}
function status(value: ArcGisEditStatus): ArcGisEditStatus {
  if (value !== 'draft' && value !== 'validated' && value !== 'committing' && value !== 'committed' && value !== 'failed') throw new Error('invalid edit status');
  return value;
}
function objectId(value: ArcGisEditObjectId | null): ArcGisEditObjectId | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('numeric objectId must be a safe integer');
    return value;
  }
  if (typeof value !== 'string') throw new Error('objectId must be a string, safe integer, or null');
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) throw new Error('string objectId must be non-empty and contain no null bytes');
  return normalized;
}
function freezeTarget(value: ArcGisEditTarget): ArcGisEditTarget { return Object.freeze({ ...value }); }
function freezeSession(value: ArcGisEditSession): ArcGisEditSession { return Object.freeze({ ...value, target: freezeTarget(value.target) }); }

/**
 * Primitive-only edit lifecycle authority. ArcGIS Graphic, Geometry, FeatureLayer,
 * LayerView and applyEdits handles deliberately stay outside this coordinator.
 */
export class ArcGisEditSessionCoordinator {
  private readonly policy: ArcGisEditSessionPolicy;
  private readonly sessions = new Map<string, ArcGisEditSession>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisEditSessionPolicy) {
    this.policy = Object.freeze({
      maxSessions: positiveInteger(policy.maxSessions, 'maxSessions'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxFailureCodeLength: positiveInteger(policy.maxFailureCodeLength, 'maxFailureCodeLength'),
      maxAttempts: positiveInteger(policy.maxAttempts, 'maxAttempts'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  begin(input: {
    readonly id: string;
    readonly mode: ArcGisEditViewMode;
    readonly operation: ArcGisEditOperation;
    readonly target: ArcGisEditTarget;
    readonly baseRevision?: number | null;
  }, timestampMs: number): ArcGisEditSession {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const sessionId = boundedText(input.id, this.policy.maxIdLength, 'edit session id');
    if (this.sessions.has(sessionId)) throw new Error('edit session already exists');
    const normalizedOperation = operation(input.operation);
    const target = this.normalizeTarget(input.target, normalizedOperation);
    const baseRevision = input.baseRevision ?? null;
    if (baseRevision !== null && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) throw new Error('baseRevision must be a non-negative safe integer or null');
    if (normalizedOperation !== 'create' && baseRevision === null) throw new Error('update/delete edits require a baseRevision');
    const next = freezeSession({
      id: sessionId,
      mode: viewMode(input.mode),
      operation: normalizedOperation,
      status: 'draft',
      target,
      baseRevision,
      attempt: 0,
      createdAtMs: now,
      updatedAtMs: now,
      revision: 1,
      failureCode: null,
    });
    this.sessions.set(sessionId, next);
    this.enforceCapacity(sessionId);
    this.activeId = sessionId;
    this.generation += 1;
    return next;
  }

  transition(id: string, nextStatus: ArcGisEditStatus, timestampMs: number, failureCode: string | null = null): ArcGisEditSession {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const sessionId = boundedText(id, this.policy.maxIdLength, 'edit session id');
    const current = this.sessions.get(sessionId);
    if (!current) throw new Error('edit session does not exist');
    if (now + this.policy.maxClockSkewMs < current.updatedAtMs) throw new Error('stale edit transition rejected');
    const normalizedStatus = status(nextStatus);
    this.assertTransition(current.status, normalizedStatus);
    let attempt = current.attempt;
    if (normalizedStatus === 'committing') {
      attempt += 1;
      if (attempt > this.policy.maxAttempts) throw new Error('edit retry budget exhausted');
    }
    const normalizedFailure = normalizedStatus === 'failed'
      ? boundedText(failureCode ?? '', this.policy.maxFailureCodeLength, 'failureCode')
      : null;
    const next = freezeSession({ ...current, status: normalizedStatus, attempt, updatedAtMs: now, revision: current.revision + 1, failureCode: normalizedFailure });
    this.sessions.set(sessionId, next);
    this.generation += 1;
    return next;
  }

  activate(id: string, timestampMs: number): ArcGisEditSession {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const sessionId = boundedText(id, this.policy.maxIdLength, 'edit session id');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('edit session does not exist');
    if (this.activeId !== sessionId) { this.activeId = sessionId; this.generation += 1; }
    return session;
  }

  remove(id: string): boolean {
    this.assertUsable();
    const sessionId = boundedText(id, this.policy.maxIdLength, 'edit session id');
    if (!this.sessions.delete(sessionId)) return false;
    if (this.activeId === sessionId) this.activeId = null;
    this.generation += 1;
    return true;
  }

  clearActive(): void {
    this.assertUsable();
    if (this.activeId === null) return;
    this.activeId = null;
    this.generation += 1;
  }

  snapshot(timestampMs: number): ArcGisEditSessionSnapshot {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const sessions = [...this.sessions.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
      .map(freezeSession);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, sessions: Object.freeze(sessions) });
  }

  restore(snapshot: Pick<ArcGisEditSessionSnapshot, 'activeId' | 'sessions'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length > this.policy.maxSessions) throw new Error('edit snapshot exceeds capacity');
    const staged = new Map<string, ArcGisEditSession>();
    for (const source of snapshot.sessions) {
      const sessionId = boundedText(source.id, this.policy.maxIdLength, 'edit session id');
      if (staged.has(sessionId)) throw new Error('duplicate edit session id');
      const createdAtMs = nonNegativeTime(source.createdAtMs, 'createdAtMs');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('edit update precedes creation');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future edit snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue;
      const normalizedOperation = operation(source.operation);
      const normalizedStatus = status(source.status);
      const target = this.normalizeTarget(source.target, normalizedOperation);
      const baseRevision = source.baseRevision;
      if (baseRevision !== null && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) throw new Error('invalid baseRevision');
      if (normalizedOperation !== 'create' && baseRevision === null) throw new Error('restored update/delete requires baseRevision');
      if (!Number.isSafeInteger(source.attempt) || source.attempt < 0 || source.attempt > this.policy.maxAttempts) throw new Error('invalid edit attempt count');
      const revision = positiveInteger(source.revision, 'revision');
      const failureCode = normalizedStatus === 'failed'
        ? boundedText(source.failureCode ?? '', this.policy.maxFailureCodeLength, 'failureCode')
        : null;
      staged.set(sessionId, freezeSession({ id: sessionId, mode: viewMode(source.mode), operation: normalizedOperation, status: normalizedStatus, target, baseRevision, attempt: source.attempt, createdAtMs, updatedAtMs, revision, failureCode }));
    }
    let activeId: string | null = null;
    if (snapshot.activeId !== null) {
      activeId = boundedText(snapshot.activeId, this.policy.maxIdLength, 'active edit session id');
      if (!staged.has(activeId)) throw new Error('active edit session is missing');
    }
    this.sessions.clear();
    for (const [key, value] of staged) this.sessions.set(key, value);
    this.activeId = activeId;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessions.clear();
    this.activeId = null;
  }

  private normalizeTarget(target: ArcGisEditTarget, op: ArcGisEditOperation): ArcGisEditTarget {
    if (!target || typeof target !== 'object') throw new Error('edit target is required');
    const layerKey = boundedText(target.layerKey, this.policy.maxLayerKeyLength, 'layerKey');
    const normalizedObjectId = objectId(target.objectId);
    if (op === 'create' && normalizedObjectId !== null) throw new Error('create edit must not predeclare an objectId');
    if (op !== 'create' && normalizedObjectId === null) throw new Error('update/delete edit requires objectId');
    return freezeTarget({ layerKey, objectId: normalizedObjectId });
  }

  private assertTransition(from: ArcGisEditStatus, to: ArcGisEditStatus): void {
    if (from === to) throw new Error('no-op edit transition rejected');
    const allowed: Readonly<Record<ArcGisEditStatus, readonly ArcGisEditStatus[]>> = {
      draft: ['validated', 'failed'],
      validated: ['committing', 'failed'],
      committing: ['committed', 'failed'],
      failed: ['validated'],
      committed: [],
    };
    if (!allowed[from].includes(to)) throw new Error(`invalid edit transition ${from} -> ${to}`);
  }

  private prune(now: number): void {
    let changed = false;
    for (const [key, value] of this.sessions) {
      if (now - value.updatedAtMs <= this.policy.retentionMs) continue;
      this.sessions.delete(key);
      if (this.activeId === key) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedId: string): void {
    while (this.sessions.size > this.policy.maxSessions) {
      const victim = [...this.sessions.values()]
        .filter(value => value.id !== protectedId)
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))[0];
      if (!victim) throw new Error('edit session capacity cannot be satisfied');
      this.sessions.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisEditSessionCoordinator is disposed');
  }
}
