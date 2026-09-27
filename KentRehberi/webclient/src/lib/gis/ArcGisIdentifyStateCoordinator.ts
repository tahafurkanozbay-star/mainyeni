export type ArcGisIdentifyMode = '2d' | '3d';
export type ArcGisIdentifyStatus = 'pending' | 'ready' | 'failed';

export interface ArcGisIdentifyTarget {
  readonly layerKey: string;
  readonly objectId: string | number;
}

export interface ArcGisIdentifyRequest {
  readonly id: string;
  readonly mode: ArcGisIdentifyMode;
  readonly x: number;
  readonly y: number;
  readonly wkid: number;
  readonly observedAtMs: number;
  readonly targets?: readonly ArcGisIdentifyTarget[];
}

export interface ArcGisIdentifyEntry extends ArcGisIdentifyRequest {
  readonly status: ArcGisIdentifyStatus;
  readonly targets: readonly ArcGisIdentifyTarget[];
  readonly generation: number;
  readonly diagnostic?: string;
}

export interface ArcGisIdentifyPolicy {
  readonly maxEntries: number;
  readonly maxTargetsPerEntry: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly maxDiagnosticLength: number;
  readonly retentionMs: number;
  readonly maxCoordinateMagnitude: number;
}

export interface ArcGisIdentifySnapshot {
  readonly activeId: string | null;
  readonly generation: number;
  readonly entries: readonly ArcGisIdentifyEntry[];
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
 * Primitive-only authority for bounded identify/pick state shared by 2D and 3D views.
 * ArcGIS Graphics, LayerViews, geometries, request handles and service payloads remain caller-owned.
 */
export class ArcGisIdentifyStateCoordinator {
  private readonly policy: ArcGisIdentifyPolicy;
  private readonly entries = new Map<string, ArcGisIdentifyEntry>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisIdentifyPolicy) {
    this.policy = Object.freeze({
      maxEntries: positiveInteger(policy.maxEntries, 'maxEntries'),
      maxTargetsPerEntry: positiveInteger(policy.maxTargetsPerEntry, 'maxTargetsPerEntry'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxDiagnosticLength: positiveInteger(policy.maxDiagnosticLength, 'maxDiagnosticLength'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxCoordinateMagnitude: finitePositive(policy.maxCoordinateMagnitude, 'maxCoordinateMagnitude'),
    });
  }

  begin(request: ArcGisIdentifyRequest, nowMs: number): ArcGisIdentifyEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const normalized = this.normalizeRequest(request, now);
    this.pruneInternal(now);
    const existing = this.entries.get(normalized.id);
    if (existing && normalized.observedAtMs < existing.observedAtMs) throw new Error('stale identify request');
    if (!existing && this.entries.size >= this.policy.maxEntries) this.evictOldest();
    this.generation += 1;
    const entry = Object.freeze({ ...normalized, status: 'pending' as const, generation: this.generation });
    this.entries.set(entry.id, entry);
    this.activeId = entry.id;
    return entry;
  }

  resolve(id: string, targets: readonly ArcGisIdentifyTarget[], observedAtMs: number, nowMs: number): ArcGisIdentifyEntry {
    return this.finish(id, 'ready', targets, undefined, observedAtMs, nowMs);
  }

  fail(id: string, diagnostic: string, observedAtMs: number, nowMs: number): ArcGisIdentifyEntry {
    const normalizedDiagnostic = this.normalizeDiagnostic(diagnostic);
    return this.finish(id, 'failed', [], normalizedDiagnostic, observedAtMs, nowMs);
  }

  activate(id: string, nowMs: number): boolean {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    this.pruneInternal(now);
    const normalized = this.normalizeId(id);
    if (!this.entries.has(normalized) || this.activeId === normalized) return false;
    this.activeId = normalized;
    this.generation += 1;
    return true;
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

  snapshot(nowMs?: number): ArcGisIdentifySnapshot {
    this.assertUsable();
    if (nowMs !== undefined) this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
    const entries = [...this.entries.values()].sort((a, b) => b.observedAtMs - a.observedAtMs || a.id.localeCompare(b.id));
    return Object.freeze({ activeId: this.activeId, generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisIdentifySnapshot, 'activeId' | 'entries'>, nowMs: number): void {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid identify snapshot');
    const next = new Map<string, ArcGisIdentifyEntry>();
    for (const raw of snapshot.entries) {
      const normalized = this.normalizeRequest(raw, now);
      if (now - normalized.observedAtMs > this.policy.retentionMs) continue;
      if (next.has(normalized.id)) throw new Error('duplicate identify id');
      const status = raw.status;
      if (status !== 'pending' && status !== 'ready' && status !== 'failed') throw new Error('invalid identify status');
      const diagnostic = status === 'failed' ? this.normalizeDiagnostic(raw.diagnostic ?? '') : undefined;
      this.generation += 1;
      const entry = diagnostic === undefined
        ? Object.freeze({ ...normalized, status, generation: this.generation })
        : Object.freeze({ ...normalized, status, diagnostic, generation: this.generation });
      next.set(entry.id, entry);
    }
    const activeId = snapshot.activeId === null ? null : this.normalizeId(snapshot.activeId);
    if (activeId !== null && !next.has(activeId)) throw new Error('active identify entry is absent from snapshot');
    this.entries.clear();
    for (const [id, entry] of next) this.entries.set(id, entry);
    this.activeId = activeId;
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

  private finish(
    id: string,
    status: 'ready' | 'failed',
    targets: readonly ArcGisIdentifyTarget[],
    diagnostic: string | undefined,
    observedAtMs: number,
    nowMs: number,
  ): ArcGisIdentifyEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const observed = finiteNonNegative(observedAtMs, 'observedAtMs');
    if (observed > now) throw new Error('observedAtMs cannot be in the future');
    const normalizedId = this.normalizeId(id);
    const current = this.entries.get(normalizedId);
    if (!current) throw new Error('identify entry does not exist');
    if (observed < current.observedAtMs) throw new Error('stale identify completion');
    const normalizedTargets = this.normalizeTargets(targets);
    this.generation += 1;
    const common = { ...current, observedAtMs: observed, status, targets: normalizedTargets, generation: this.generation };
    const next: ArcGisIdentifyEntry = diagnostic === undefined
      ? Object.freeze(common)
      : Object.freeze({ ...common, diagnostic });
    this.entries.set(normalizedId, next);
    return next;
  }

  private normalizeRequest(request: ArcGisIdentifyRequest, now: number): Omit<ArcGisIdentifyEntry, 'status' | 'generation' | 'diagnostic'> {
    const id = this.normalizeId(request.id);
    if (request.mode !== '2d' && request.mode !== '3d') throw new Error('invalid identify mode');
    if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) throw new Error('identify coordinates must be finite');
    if (Math.abs(request.x) > this.policy.maxCoordinateMagnitude || Math.abs(request.y) > this.policy.maxCoordinateMagnitude) {
      throw new Error('identify coordinate exceeds configured magnitude');
    }
    if (!Number.isSafeInteger(request.wkid) || request.wkid <= 0) throw new Error('invalid identify WKID');
    const observedAtMs = finiteNonNegative(request.observedAtMs, 'observedAtMs');
    if (observedAtMs > now) throw new Error('observedAtMs cannot be in the future');
    return Object.freeze({ id, mode: request.mode, x: request.x, y: request.y, wkid: request.wkid, observedAtMs, targets: this.normalizeTargets(request.targets ?? []) });
  }

  private normalizeTargets(targets: readonly ArcGisIdentifyTarget[]): readonly ArcGisIdentifyTarget[] {
    if (!Array.isArray(targets) || targets.length > this.policy.maxTargetsPerEntry) throw new Error('invalid identify target count');
    const seen = new Set<string>();
    const normalized = targets.map((target) => {
      if (!target || typeof target !== 'object') throw new Error('invalid identify target');
      const layerKey = this.normalizeLayerKey(target.layerKey);
      const objectId = target.objectId;
      if (typeof objectId === 'number') {
        if (!Number.isSafeInteger(objectId)) throw new Error('invalid numeric object id');
      } else if (typeof objectId === 'string') {
        if (!objectId || objectId.length > this.policy.maxIdLength || objectId.trim() !== objectId || objectId.includes('\u0000')) throw new Error('invalid string object id');
      } else throw new Error('invalid object id');
      const key = `${layerKey}\u0000${typeof objectId}\u0000${String(objectId)}`;
      if (seen.has(key)) throw new Error('duplicate identify target');
      seen.add(key);
      return Object.freeze({ layerKey, objectId });
    });
    return Object.freeze(normalized);
  }

  private normalizeId(value: string): string {
    if (typeof value !== 'string' || !value || value.length > this.policy.maxIdLength || value.trim() !== value || value.includes('\u0000')) throw new Error('invalid identify id');
    return value;
  }

  private normalizeLayerKey(value: string): string {
    if (typeof value !== 'string' || !value || value.length > this.policy.maxLayerKeyLength || value.trim() !== value || value.includes('\u0000')) throw new Error('invalid layer key');
    return value;
  }

  private normalizeDiagnostic(value: string): string {
    if (typeof value !== 'string' || value.length > this.policy.maxDiagnosticLength || value.includes('\u0000')) throw new Error('invalid identify diagnostic');
    return value;
  }

  private pruneInternal(now: number): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now < entry.observedAtMs) throw new Error('clock moved before identify observation');
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
    if (!victim) throw new Error('identify capacity exceeded');
    this.entries.delete(victim.id);
    if (this.activeId === victim.id) this.activeId = null;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisIdentifyStateCoordinator is disposed');
  }
}
