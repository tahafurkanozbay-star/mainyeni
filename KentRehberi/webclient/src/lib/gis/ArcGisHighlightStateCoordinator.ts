export type ArcGisHighlightViewMode = '2d' | '3d';
export type ArcGisHighlightPriority = 'hover' | 'selection' | 'critical';

export interface ArcGisHighlightIdentity {
  readonly layerKey: string;
  readonly objectId: string | number;
}

export interface ArcGisHighlightRequest extends ArcGisHighlightIdentity {
  readonly priority: ArcGisHighlightPriority;
  readonly requestedAtMs: number;
  readonly expiresAtMs?: number;
}

export interface ArcGisHighlightPolicy {
  readonly maxHighlights: number;
  readonly maxPerLayer: number;
  readonly maxLayerKeyLength: number;
  readonly maxObjectIdLength: number;
  readonly maxTtlMs: number;
}

export interface ArcGisHighlightEntry extends ArcGisHighlightIdentity {
  readonly priority: ArcGisHighlightPriority;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly generation: number;
}

export interface ArcGisHighlightSnapshot {
  readonly mode: ArcGisHighlightViewMode;
  readonly generation: number;
  readonly highlights: readonly ArcGisHighlightEntry[];
}

const PRIORITY: Readonly<Record<ArcGisHighlightPriority, number>> = Object.freeze({ hover: 0, selection: 1, critical: 2 });

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function normalizeMode(value: ArcGisHighlightViewMode): ArcGisHighlightViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid highlight view mode');
  return value;
}

function normalizePriority(value: ArcGisHighlightPriority): ArcGisHighlightPriority {
  if (value !== 'hover' && value !== 'selection' && value !== 'critical') throw new Error('invalid highlight priority');
  return value;
}

/**
 * Bounded identity-only highlight authority for ArcGIS 2D/3D views.
 *
 * The coordinator intentionally does not retain ArcGIS Graphic, Geometry,
 * LayerView or highlight handles. Callers project this stable identity state
 * into the active view and own SDK resources. This keeps view switching and
 * disposal deterministic while bounding retained CPU memory.
 */
export class ArcGisHighlightStateCoordinator {
  private readonly policy: ArcGisHighlightPolicy;
  private readonly entries = new Map<string, ArcGisHighlightEntry>();
  private mode: ArcGisHighlightViewMode = '2d';
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisHighlightPolicy) {
    const maxHighlights = positiveSafeInteger(policy.maxHighlights, 'maxHighlights');
    const maxPerLayer = positiveSafeInteger(policy.maxPerLayer, 'maxPerLayer');
    if (maxPerLayer > maxHighlights) throw new Error('maxPerLayer cannot exceed maxHighlights');
    this.policy = Object.freeze({
      maxHighlights,
      maxPerLayer,
      maxLayerKeyLength: positiveSafeInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxObjectIdLength: positiveSafeInteger(policy.maxObjectIdLength, 'maxObjectIdLength'),
      maxTtlMs: positiveSafeInteger(policy.maxTtlMs, 'maxTtlMs'),
    });
  }

  setMode(mode: ArcGisHighlightViewMode): boolean {
    this.assertUsable();
    const normalized = normalizeMode(mode);
    if (normalized === this.mode) return false;
    this.mode = normalized;
    this.generation += 1;
    return true;
  }

  upsert(request: ArcGisHighlightRequest, nowMs: number): ArcGisHighlightEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const identity = this.normalizeIdentity(request);
    const priority = normalizePriority(request.priority);
    const requestedAtMs = finiteNonNegative(request.requestedAtMs, 'requestedAtMs');
    if (requestedAtMs > now) throw new Error('requestedAtMs cannot be in the future');
    const expiresAtMs = this.normalizeExpiry(request.expiresAtMs, requestedAtMs, now);
    this.pruneExpiredInternal(now);

    const key = this.identityKey(identity);
    const existing = this.entries.get(key);
    if (existing) {
      if (requestedAtMs < existing.requestedAtMs) throw new Error('stale highlight update');
      this.generation += 1;
      const updated = this.freezeEntry(identity, priority, requestedAtMs, expiresAtMs);
      this.entries.set(key, updated);
      return updated;
    }

    this.ensureLayerCapacity(identity.layerKey, priority);
    this.ensureGlobalCapacity(priority);
    this.generation += 1;
    const entry = this.freezeEntry(identity, priority, requestedAtMs, expiresAtMs);
    this.entries.set(key, entry);
    return entry;
  }

  remove(identity: ArcGisHighlightIdentity): boolean {
    this.assertUsable();
    const removed = this.entries.delete(this.identityKey(this.normalizeIdentity(identity)));
    if (removed) this.generation += 1;
    return removed;
  }

  removeLayer(layerKey: string): number {
    this.assertUsable();
    const normalizedLayerKey = this.normalizeLayerKey(layerKey);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.layerKey !== normalizedLayerKey) continue;
      this.entries.delete(key);
      removed += 1;
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  has(identity: ArcGisHighlightIdentity, nowMs?: number): boolean {
    this.assertUsable();
    if (nowMs !== undefined) this.pruneExpiredInternal(finiteNonNegative(nowMs, 'nowMs'));
    return this.entries.has(this.identityKey(this.normalizeIdentity(identity)));
  }

  pruneExpired(nowMs: number): number {
    this.assertUsable();
    return this.pruneExpiredInternal(finiteNonNegative(nowMs, 'nowMs'));
  }

  clear(): void {
    this.assertUsable();
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.generation += 1;
  }

  snapshot(nowMs?: number): ArcGisHighlightSnapshot {
    this.assertUsable();
    if (nowMs !== undefined) this.pruneExpiredInternal(finiteNonNegative(nowMs, 'nowMs'));
    const highlights = [...this.entries.values()].sort((left, right) => {
      const priority = PRIORITY[right.priority] - PRIORITY[left.priority];
      if (priority !== 0) return priority;
      const layer = left.layerKey.localeCompare(right.layerKey);
      if (layer !== 0) return layer;
      const type = typeof left.objectId.localeCompare ? 0 : 0;
      void type;
      return this.compareObjectIds(left.objectId, right.objectId);
    });
    return Object.freeze({ mode: this.mode, generation: this.generation, highlights: Object.freeze(highlights) });
  }

  restore(snapshot: Pick<ArcGisHighlightSnapshot, 'mode' | 'highlights'>, nowMs: number): void {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    if (!Array.isArray(snapshot.highlights) || snapshot.highlights.length > this.policy.maxHighlights) {
      throw new Error('invalid highlight snapshot');
    }
    const mode = normalizeMode(snapshot.mode);
    const next = new Map<string, ArcGisHighlightEntry>();
    const perLayer = new Map<string, number>();
    for (const raw of snapshot.highlights) {
      const identity = this.normalizeIdentity(raw);
      const priority = normalizePriority(raw.priority);
      const requestedAtMs = finiteNonNegative(raw.requestedAtMs, 'requestedAtMs');
      if (requestedAtMs > now) throw new Error('snapshot contains future highlight');
      const expiresAtMs = raw.expiresAtMs === null ? null : this.normalizeExpiry(raw.expiresAtMs, requestedAtMs, now);
      if (expiresAtMs !== null && expiresAtMs <= now) continue;
      const key = this.identityKey(identity);
      if (next.has(key)) throw new Error('duplicate highlight identity');
      const count = (perLayer.get(identity.layerKey) ?? 0) + 1;
      if (count > this.policy.maxPerLayer) throw new Error('snapshot layer capacity exceeded');
      perLayer.set(identity.layerKey, count);
      this.generation += 1;
      next.set(key, this.freezeEntry(identity, priority, requestedAtMs, expiresAtMs));
    }
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
    this.mode = mode;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
  }

  private ensureLayerCapacity(layerKey: string, incomingPriority: ArcGisHighlightPriority): void {
    const layerEntries = [...this.entries.entries()].filter(([, entry]) => entry.layerKey === layerKey);
    if (layerEntries.length < this.policy.maxPerLayer) return;
    const victim = this.chooseVictim(layerEntries, incomingPriority);
    if (!victim) throw new Error('highlight layer capacity exceeded');
    this.entries.delete(victim);
  }

  private ensureGlobalCapacity(incomingPriority: ArcGisHighlightPriority): void {
    if (this.entries.size < this.policy.maxHighlights) return;
    const victim = this.chooseVictim([...this.entries.entries()], incomingPriority);
    if (!victim) throw new Error('highlight capacity exceeded');
    this.entries.delete(victim);
  }

  private chooseVictim(
    candidates: readonly (readonly [string, ArcGisHighlightEntry])[],
    incomingPriority: ArcGisHighlightPriority,
  ): string | null {
    const eligible = candidates.filter(([, entry]) => PRIORITY[entry.priority] < PRIORITY[incomingPriority]);
    eligible.sort((left, right) => {
      const priority = PRIORITY[left[1].priority] - PRIORITY[right[1].priority];
      if (priority !== 0) return priority;
      const time = left[1].requestedAtMs - right[1].requestedAtMs;
      if (time !== 0) return time;
      return left[0].localeCompare(right[0]);
    });
    return eligible[0]?.[0] ?? null;
  }

  private pruneExpiredInternal(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs === null || entry.expiresAtMs > now) continue;
      this.entries.delete(key);
      removed += 1;
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  private normalizeExpiry(value: number | undefined, requestedAtMs: number, now: number): number | null {
    if (value === undefined) return null;
    const expiresAtMs = finiteNonNegative(value, 'expiresAtMs');
    if (expiresAtMs <= requestedAtMs) throw new Error('expiresAtMs must be after requestedAtMs');
    if (expiresAtMs - requestedAtMs > this.policy.maxTtlMs) throw new Error('highlight TTL exceeds policy');
    if (expiresAtMs <= now) throw new Error('highlight is already expired');
    return expiresAtMs;
  }

  private freezeEntry(
    identity: ArcGisHighlightIdentity,
    priority: ArcGisHighlightPriority,
    requestedAtMs: number,
    expiresAtMs: number | null,
  ): ArcGisHighlightEntry {
    return Object.freeze({ ...identity, priority, requestedAtMs, expiresAtMs, generation: this.generation });
  }

  private normalizeIdentity(identity: ArcGisHighlightIdentity): ArcGisHighlightIdentity {
    const layerKey = this.normalizeLayerKey(identity.layerKey);
    const objectId = identity.objectId;
    if (typeof objectId === 'number') {
      if (!Number.isSafeInteger(objectId) || objectId < 0) throw new Error('invalid numeric objectId');
    } else if (typeof objectId === 'string') {
      if (!objectId || objectId.length > this.policy.maxObjectIdLength || objectId.trim() !== objectId) {
        throw new Error('invalid string objectId');
      }
    } else {
      throw new Error('invalid objectId');
    }
    return Object.freeze({ layerKey, objectId });
  }

  private normalizeLayerKey(value: string): string {
    if (typeof value !== 'string') throw new Error('invalid layerKey');
    const normalized = value.trim();
    if (!normalized || normalized !== value || normalized.length > this.policy.maxLayerKeyLength) throw new Error('invalid layerKey');
    return normalized;
  }

  private identityKey(identity: ArcGisHighlightIdentity): string {
    return `${identity.layerKey}\u0000${typeof identity.objectId}:${String(identity.objectId)}`;
  }

  private compareObjectIds(left: string | number, right: string | number): number {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left.localeCompare(right);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisHighlightStateCoordinator is disposed');
  }
}
