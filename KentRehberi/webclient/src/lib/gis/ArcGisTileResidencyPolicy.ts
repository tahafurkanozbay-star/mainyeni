export type TileResidencyPriority = 'interactive' | 'visible' | 'background';

export interface TileResidencyIntent {
  readonly viewId: string;
  readonly layerId: string;
  readonly tileId: string;
  readonly revision: number;
  readonly priority: TileResidencyPriority;
  readonly estimatedBytes: number;
}

export interface TileResidencyLease extends TileResidencyIntent {
  readonly generation: number;
  readonly admittedAt: number;
}

export interface TileResidencyPolicyOptions {
  readonly maxEntries?: number;
  readonly maxEntriesPerLayer?: number;
  readonly maxResidentBytes?: number;
  readonly maxTileBytes?: number;
  readonly maxIdentifierLength?: number;
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
}

export interface TileResidencySnapshot {
  readonly queued: number;
  readonly resident: number;
  readonly residentBytes: number;
  readonly rejected: number;
  readonly expired: number;
  readonly stale: number;
  readonly generation: number;
}

type EntryState = 'queued' | 'resident';
interface Entry {
  intent: TileResidencyIntent;
  state: EntryState;
  generation: number;
  admittedAt: number;
  touchedAt: number;
  actualBytes: number;
}

const SAFE_ID = /^[a-zA-Z0-9._:/-]+$/;
const PRIORITY: Record<TileResidencyPriority, number> = { interactive: 0, visible: 1, background: 2 };

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback;
}

export class ArcGisTileResidencyPolicy {
  private readonly entries = new Map<string, Entry>();
  private readonly revisions = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerLayer: number;
  private readonly maxResidentBytes: number;
  private readonly maxTileBytes: number;
  private readonly maxIdentifierLength: number;
  private readonly leaseTtlMs: number;
  private generation = 0;
  private rejected = 0;
  private expired = 0;
  private stale = 0;
  private disposed = false;

  constructor(options: TileResidencyPolicyOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, 512);
    this.maxEntriesPerLayer = Math.min(this.maxEntries, positiveInteger(options.maxEntriesPerLayer, 128));
    this.maxResidentBytes = finitePositive(options.maxResidentBytes, 128 * 1024 * 1024);
    this.maxTileBytes = Math.min(this.maxResidentBytes, finitePositive(options.maxTileBytes, 8 * 1024 * 1024));
    this.maxIdentifierLength = positiveInteger(options.maxIdentifierLength, 160);
    this.leaseTtlMs = finitePositive(options.leaseTtlMs, 30_000);
    this.now = options.now ?? Date.now;
  }

  setRevision(viewId: string, revision: number): boolean {
    if (this.disposed || !this.validId(viewId) || !Number.isSafeInteger(revision) || revision < 0) return false;
    const previous = this.revisions.get(viewId) ?? -1;
    if (revision < previous) return false;
    this.revisions.set(viewId, revision);
    if (revision > previous) {
      for (const [key, entry] of this.entries) {
        if (entry.intent.viewId === viewId && entry.intent.revision < revision) {
          this.entries.delete(key);
          this.stale += 1;
        }
      }
    }
    return true;
  }

  admit(intent: TileResidencyIntent): TileResidencyLease | null {
    if (this.disposed || !this.validIntent(intent)) return this.reject();
    this.sweep();
    const currentRevision = this.revisions.get(intent.viewId);
    if (currentRevision !== undefined && intent.revision !== currentRevision) {
      this.stale += 1;
      return null;
    }
    if (currentRevision === undefined) this.revisions.set(intent.viewId, intent.revision);
    const key = this.key(intent);
    const existing = this.entries.get(key);
    if (existing) {
      existing.touchedAt = this.now();
      return this.lease(existing);
    }
    if (this.entries.size >= this.maxEntries || this.layerCount(intent.layerId) >= this.maxEntriesPerLayer) return this.reject();
    const admittedAt = this.now();
    const entry: Entry = {
      intent: Object.freeze({ ...intent }),
      state: 'queued',
      generation: ++this.generation,
      admittedAt,
      touchedAt: admittedAt,
      actualBytes: 0,
    };
    this.entries.set(key, entry);
    return this.lease(entry);
  }

  next(): TileResidencyLease | null {
    if (this.disposed) return null;
    this.sweep();
    const queued = [...this.entries.values()].filter((entry) => entry.state === 'queued');
    queued.sort((a, b) =>
      PRIORITY[a.intent.priority] - PRIORITY[b.intent.priority]
      || a.admittedAt - b.admittedAt
      || a.intent.layerId.localeCompare(b.intent.layerId)
      || a.intent.tileId.localeCompare(b.intent.tileId));
    return queued[0] ? this.lease(queued[0]) : null;
  }

  commit(lease: TileResidencyLease, actualBytes: number): boolean {
    if (this.disposed || !Number.isFinite(actualBytes) || actualBytes < 0 || actualBytes > this.maxTileBytes) return false;
    this.sweep();
    const entry = this.resolve(lease);
    if (!entry || entry.state !== 'queued') return false;
    const projected = this.residentBytes() + actualBytes;
    if (projected > this.maxResidentBytes) return false;
    entry.state = 'resident';
    entry.actualBytes = actualBytes;
    entry.touchedAt = this.now();
    return true;
  }

  touch(lease: TileResidencyLease): boolean {
    if (this.disposed) return false;
    this.sweep();
    const entry = this.resolve(lease);
    if (!entry || entry.state !== 'resident') return false;
    entry.touchedAt = this.now();
    return true;
  }

  release(lease: TileResidencyLease): boolean {
    if (this.disposed) return false;
    const entry = this.resolve(lease);
    if (!entry) return false;
    return this.entries.delete(this.key(entry.intent));
  }

  cancelView(viewId: string): number {
    if (this.disposed || !this.validId(viewId)) return 0;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.intent.viewId === viewId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    this.revisions.delete(viewId);
    return removed;
  }

  snapshot(): TileResidencySnapshot {
    if (!this.disposed) this.sweep();
    let queued = 0;
    let resident = 0;
    for (const entry of this.entries.values()) entry.state === 'queued' ? queued++ : resident++;
    return Object.freeze({ queued, resident, residentBytes: this.residentBytes(), rejected: this.rejected, expired: this.expired, stale: this.stale, generation: this.generation });
  }

  dispose(): void {
    this.entries.clear();
    this.revisions.clear();
    this.disposed = true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt > this.leaseTtlMs) {
        this.entries.delete(key);
        this.expired += 1;
      }
    }
  }

  private resolve(lease: TileResidencyLease): Entry | undefined {
    const entry = this.entries.get(this.key(lease));
    if (!entry || entry.generation !== lease.generation || entry.intent.revision !== lease.revision) return undefined;
    return entry;
  }

  private residentBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.state === 'resident') total += entry.actualBytes;
    return total;
  }

  private layerCount(layerId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.intent.layerId === layerId) count += 1;
    return count;
  }

  private validIntent(intent: TileResidencyIntent): boolean {
    return this.validId(intent.viewId) && this.validId(intent.layerId) && this.validId(intent.tileId)
      && Number.isSafeInteger(intent.revision) && intent.revision >= 0
      && (intent.priority === 'interactive' || intent.priority === 'visible' || intent.priority === 'background')
      && Number.isFinite(intent.estimatedBytes) && intent.estimatedBytes >= 0 && intent.estimatedBytes <= this.maxTileBytes;
  }

  private validId(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= this.maxIdentifierLength && SAFE_ID.test(value);
  }

  private key(intent: Pick<TileResidencyIntent, 'viewId' | 'layerId' | 'tileId'>): string {
    return `${intent.viewId}\u0000${intent.layerId}\u0000${intent.tileId}`;
  }

  private lease(entry: Entry): TileResidencyLease {
    return Object.freeze({ ...entry.intent, generation: entry.generation, admittedAt: entry.admittedAt });
  }

  private reject(): null {
    this.rejected += 1;
    return null;
  }
}
