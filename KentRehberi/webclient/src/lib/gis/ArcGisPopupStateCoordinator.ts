export type ArcGisPopupViewMode = '2d' | '3d';
export type ArcGisPopupObjectId = string | number;

export interface ArcGisPopupIdentity {
  readonly layerKey: string;
  readonly objectId: ArcGisPopupObjectId;
}

export interface ArcGisPopupRequest extends ArcGisPopupIdentity {
  readonly requestedAtMs: number;
  readonly title?: string;
  readonly anchor?: { readonly x: number; readonly y: number; readonly wkid: number };
}

export interface ArcGisPopupPolicy {
  readonly maxEntries: number;
  readonly maxLayerKeyLength: number;
  readonly maxObjectIdLength: number;
  readonly maxTitleLength: number;
  readonly retentionMs: number;
}

export interface ArcGisPopupEntry extends ArcGisPopupIdentity {
  readonly requestedAtMs: number;
  readonly title: string | null;
  readonly anchor: { readonly x: number; readonly y: number; readonly wkid: number } | null;
  readonly generation: number;
}

export interface ArcGisPopupSnapshot {
  readonly mode: ArcGisPopupViewMode;
  readonly generation: number;
  readonly active: ArcGisPopupIdentity | null;
  readonly entries: readonly ArcGisPopupEntry[];
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
function normalizeMode(value: ArcGisPopupViewMode): ArcGisPopupViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid popup view mode');
  return value;
}

/**
 * Bounded identity-only popup authority shared by 2D/3D views.
 * ArcGIS Graphic, Geometry, Popup and LayerView instances remain caller-owned.
 */
export class ArcGisPopupStateCoordinator {
  private readonly policy: ArcGisPopupPolicy;
  private readonly entries = new Map<string, ArcGisPopupEntry>();
  private mode: ArcGisPopupViewMode = '2d';
  private activeKey: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisPopupPolicy) {
    this.policy = Object.freeze({
      maxEntries: positiveSafeInteger(policy.maxEntries, 'maxEntries'),
      maxLayerKeyLength: positiveSafeInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxObjectIdLength: positiveSafeInteger(policy.maxObjectIdLength, 'maxObjectIdLength'),
      maxTitleLength: positiveSafeInteger(policy.maxTitleLength, 'maxTitleLength'),
      retentionMs: positiveSafeInteger(policy.retentionMs, 'retentionMs'),
    });
  }

  setMode(mode: ArcGisPopupViewMode): boolean {
    this.assertUsable();
    const next = normalizeMode(mode);
    if (next === this.mode) return false;
    this.mode = next;
    this.generation += 1;
    return true;
  }

  open(request: ArcGisPopupRequest, nowMs: number): ArcGisPopupEntry {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    const requestedAtMs = finiteNonNegative(request.requestedAtMs, 'requestedAtMs');
    if (requestedAtMs > now) throw new Error('requestedAtMs cannot be in the future');
    const identity = this.normalizeIdentity(request);
    const key = this.identityKey(identity);
    this.pruneInternal(now);
    const existing = this.entries.get(key);
    if (existing && requestedAtMs < existing.requestedAtMs) throw new Error('stale popup update');
    const title = this.normalizeTitle(request.title);
    const anchor = this.normalizeAnchor(request.anchor);
    if (!existing && this.entries.size >= this.policy.maxEntries) this.evictOldest();
    this.generation += 1;
    const entry = Object.freeze({ ...identity, requestedAtMs, title, anchor, generation: this.generation });
    this.entries.set(key, entry);
    this.activeKey = key;
    return entry;
  }

  activate(identity: ArcGisPopupIdentity, nowMs: number): boolean {
    this.assertUsable();
    this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
    const key = this.identityKey(this.normalizeIdentity(identity));
    if (!this.entries.has(key)) return false;
    if (this.activeKey === key) return false;
    this.activeKey = key;
    this.generation += 1;
    return true;
  }

  close(): boolean {
    this.assertUsable();
    if (this.activeKey === null) return false;
    this.activeKey = null;
    this.generation += 1;
    return true;
  }

  remove(identity: ArcGisPopupIdentity): boolean {
    this.assertUsable();
    const key = this.identityKey(this.normalizeIdentity(identity));
    const removed = this.entries.delete(key);
    if (!removed) return false;
    if (this.activeKey === key) this.activeKey = null;
    this.generation += 1;
    return true;
  }

  removeLayer(layerKey: string): number {
    this.assertUsable();
    const normalized = this.normalizeLayerKey(layerKey);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.layerKey !== normalized) continue;
      this.entries.delete(key);
      if (this.activeKey === key) this.activeKey = null;
      removed += 1;
    }
    if (removed) this.generation += 1;
    return removed;
  }

  prune(nowMs: number): number {
    this.assertUsable();
    return this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
  }

  snapshot(nowMs?: number): ArcGisPopupSnapshot {
    this.assertUsable();
    if (nowMs !== undefined) this.pruneInternal(finiteNonNegative(nowMs, 'nowMs'));
    const entries = [...this.entries.values()].sort((a, b) =>
      b.requestedAtMs - a.requestedAtMs || a.layerKey.localeCompare(b.layerKey) || this.compareObjectIds(a.objectId, b.objectId));
    const activeEntry = this.activeKey === null ? undefined : this.entries.get(this.activeKey);
    const active = activeEntry ? Object.freeze({ layerKey: activeEntry.layerKey, objectId: activeEntry.objectId }) : null;
    return Object.freeze({ mode: this.mode, generation: this.generation, active, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisPopupSnapshot, 'mode' | 'active' | 'entries'>, nowMs: number): void {
    this.assertUsable();
    const now = finiteNonNegative(nowMs, 'nowMs');
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid popup snapshot');
    const next = new Map<string, ArcGisPopupEntry>();
    for (const raw of snapshot.entries) {
      const identity = this.normalizeIdentity(raw);
      const requestedAtMs = finiteNonNegative(raw.requestedAtMs, 'requestedAtMs');
      if (requestedAtMs > now) throw new Error('snapshot contains future popup');
      if (now - requestedAtMs > this.policy.retentionMs) continue;
      const key = this.identityKey(identity);
      if (next.has(key)) throw new Error('duplicate popup identity');
      this.generation += 1;
      next.set(key, Object.freeze({ ...identity, requestedAtMs, title: this.normalizeTitle(raw.title ?? undefined), anchor: this.normalizeAnchor(raw.anchor ?? undefined), generation: this.generation }));
    }
    let activeKey: string | null = null;
    if (snapshot.active !== null) {
      activeKey = this.identityKey(this.normalizeIdentity(snapshot.active));
      if (!next.has(activeKey)) throw new Error('active popup is absent from snapshot entries');
    }
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
    this.activeKey = activeKey;
    this.mode = normalizeMode(snapshot.mode);
    this.generation += 1;
  }

  clear(): void {
    this.assertUsable();
    if (!this.entries.size && this.activeKey === null) return;
    this.entries.clear();
    this.activeKey = null;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.activeKey = null;
  }

  private pruneInternal(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now < entry.requestedAtMs) throw new Error('clock moved before popup observation');
      if (now - entry.requestedAtMs <= this.policy.retentionMs) continue;
      this.entries.delete(key);
      if (this.activeKey === key) this.activeKey = null;
      removed += 1;
    }
    if (removed) this.generation += 1;
    return removed;
  }

  private evictOldest(): void {
    const candidates = [...this.entries.entries()].sort((a, b) =>
      a[1].requestedAtMs - b[1].requestedAtMs || a[0].localeCompare(b[0]));
    const victim = candidates[0];
    if (!victim) throw new Error('popup capacity exceeded');
    this.entries.delete(victim[0]);
    if (this.activeKey === victim[0]) this.activeKey = null;
  }

  private normalizeIdentity(identity: ArcGisPopupIdentity): ArcGisPopupIdentity {
    const layerKey = this.normalizeLayerKey(identity.layerKey);
    const objectId = identity.objectId;
    if (typeof objectId === 'number') {
      if (!Number.isSafeInteger(objectId) || objectId < 0) throw new Error('invalid numeric objectId');
    } else if (typeof objectId === 'string') {
      if (!objectId || objectId.length > this.policy.maxObjectIdLength || objectId.trim() !== objectId) throw new Error('invalid string objectId');
    } else throw new Error('invalid objectId');
    return Object.freeze({ layerKey, objectId });
  }

  private normalizeLayerKey(value: string): string {
    if (typeof value !== 'string') throw new Error('invalid layerKey');
    const normalized = value.trim();
    if (!normalized || normalized !== value || normalized.length > this.policy.maxLayerKeyLength) throw new Error('invalid layerKey');
    return normalized;
  }

  private normalizeTitle(value: string | undefined): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > this.policy.maxTitleLength || value.trim() !== value) throw new Error('invalid popup title');
    return value;
  }

  private normalizeAnchor(value: ArcGisPopupRequest['anchor']): ArcGisPopupEntry['anchor'] {
    if (value === undefined) return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('invalid popup anchor');
    if (!Number.isSafeInteger(value.wkid) || value.wkid <= 0) throw new Error('invalid popup WKID');
    return Object.freeze({ x: value.x, y: value.y, wkid: value.wkid });
  }

  private identityKey(identity: ArcGisPopupIdentity): string {
    return `${identity.layerKey}\u0000${typeof identity.objectId}:${String(identity.objectId)}`;
  }

  private compareObjectIds(a: ArcGisPopupObjectId, b: ArcGisPopupObjectId): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a.localeCompare(b);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisPopupStateCoordinator is disposed');
  }
}
