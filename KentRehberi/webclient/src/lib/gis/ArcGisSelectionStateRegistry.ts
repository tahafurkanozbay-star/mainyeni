export type ArcGisSelectionViewMode = '2d' | '3d';
export type ArcGisSelectionOrigin = 'user' | 'query' | 'restore';

export interface ArcGisSelectionIdentity {
  readonly layerKey: string;
  readonly objectId: string | number;
}

export interface ArcGisSelectionEntry extends ArcGisSelectionIdentity {
  readonly origin: ArcGisSelectionOrigin;
  readonly selectedAtMs: number;
  readonly revision: number;
}

export interface ArcGisSelectionPolicy {
  readonly maxSelections: number;
  readonly maxLayerKeyLength: number;
  readonly maxObjectIdLength: number;
  readonly maxAgeMs: number;
}

export interface ArcGisSelectionSnapshot {
  readonly mode: ArcGisSelectionViewMode;
  readonly revision: number;
  readonly selections: readonly ArcGisSelectionEntry[];
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function normalizeMode(value: ArcGisSelectionViewMode): ArcGisSelectionViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid selection view mode');
  return value;
}

function normalizeOrigin(value: ArcGisSelectionOrigin): ArcGisSelectionOrigin {
  if (value !== 'user' && value !== 'query' && value !== 'restore') throw new Error('invalid selection origin');
  return value;
}

/**
 * Bounded, transport-agnostic selection authority shared by 2D and 3D views.
 * It stores only stable ArcGIS feature identities; graphics, geometries and
 * service payloads remain owned by callers so retained memory stays bounded.
 */
export class ArcGisSelectionStateRegistry {
  private readonly policy: ArcGisSelectionPolicy;
  private readonly entries = new Map<string, ArcGisSelectionEntry>();
  private mode: ArcGisSelectionViewMode = '2d';
  private revision = 0;
  private disposed = false;

  constructor(policy: ArcGisSelectionPolicy) {
    this.policy = Object.freeze({
      maxSelections: positiveSafeInteger(policy.maxSelections, 'maxSelections'),
      maxLayerKeyLength: positiveSafeInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxObjectIdLength: positiveSafeInteger(policy.maxObjectIdLength, 'maxObjectIdLength'),
      maxAgeMs: positiveSafeInteger(policy.maxAgeMs, 'maxAgeMs'),
    });
  }

  setMode(mode: ArcGisSelectionViewMode): void {
    this.assertUsable();
    this.mode = normalizeMode(mode);
  }

  select(identity: ArcGisSelectionIdentity, origin: ArcGisSelectionOrigin, nowMs: number): ArcGisSelectionEntry {
    this.assertUsable();
    const normalized = this.normalizeIdentity(identity);
    const timestamp = finiteNonNegative(nowMs, 'nowMs');
    const key = this.identityKey(normalized);
    const existing = this.entries.get(key);
    if (!existing && this.entries.size >= this.policy.maxSelections) throw new Error('selection capacity exceeded');
    this.revision += 1;
    const entry = Object.freeze({ ...normalized, origin: normalizeOrigin(origin), selectedAtMs: timestamp, revision: this.revision });
    this.entries.set(key, entry);
    return entry;
  }

  deselect(identity: ArcGisSelectionIdentity): boolean {
    this.assertUsable();
    const removed = this.entries.delete(this.identityKey(this.normalizeIdentity(identity)));
    if (removed) this.revision += 1;
    return removed;
  }

  has(identity: ArcGisSelectionIdentity): boolean {
    this.assertUsable();
    return this.entries.has(this.identityKey(this.normalizeIdentity(identity)));
  }

  prune(nowMs: number): number {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now >= entry.selectedAtMs && now - entry.selectedAtMs > this.policy.maxAgeMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.revision += 1;
    return removed;
  }

  clear(): void {
    this.assertUsable();
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.revision += 1;
  }

  snapshot(): ArcGisSelectionSnapshot {
    this.assertUsable();
    const selections = [...this.entries.values()].sort((left, right) => {
      const layer = left.layerKey.localeCompare(right.layerKey);
      return layer !== 0 ? layer : String(left.objectId).localeCompare(String(right.objectId));
    });
    return Object.freeze({ mode: this.mode, revision: this.revision, selections: Object.freeze(selections) });
  }

  restore(snapshot: Pick<ArcGisSelectionSnapshot, 'mode' | 'selections'>, nowMs: number): void {
    this.assertUsable();
    const timestamp = finiteNonNegative(nowMs, 'nowMs');
    if (!Array.isArray(snapshot.selections) || snapshot.selections.length > this.policy.maxSelections) throw new Error('invalid selection snapshot');
    const next = new Map<string, ArcGisSelectionEntry>();
    for (const value of snapshot.selections) {
      const identity = this.normalizeIdentity(value);
      const key = this.identityKey(identity);
      if (next.has(key)) throw new Error('duplicate selection identity');
      this.revision += 1;
      next.set(key, Object.freeze({ ...identity, origin: 'restore', selectedAtMs: timestamp, revision: this.revision }));
    }
    this.entries.clear();
    for (const [key, value] of next) this.entries.set(key, value);
    this.mode = normalizeMode(snapshot.mode);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
  }

  private normalizeIdentity(identity: ArcGisSelectionIdentity): ArcGisSelectionIdentity {
    const layerKey = identity.layerKey.trim();
    if (!layerKey || layerKey.length > this.policy.maxLayerKeyLength) throw new Error('invalid layerKey');
    const objectId = identity.objectId;
    if (typeof objectId === 'number') {
      if (!Number.isSafeInteger(objectId) || objectId < 0) throw new Error('invalid numeric objectId');
    } else if (typeof objectId === 'string') {
      if (!objectId || objectId.length > this.policy.maxObjectIdLength || objectId.trim() !== objectId) throw new Error('invalid string objectId');
    } else {
      throw new Error('invalid objectId');
    }
    return Object.freeze({ layerKey, objectId });
  }

  private identityKey(identity: ArcGisSelectionIdentity): string {
    return `${identity.layerKey}\u0000${typeof identity.objectId}:${String(identity.objectId)}`;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisSelectionStateRegistry is disposed');
  }
}
