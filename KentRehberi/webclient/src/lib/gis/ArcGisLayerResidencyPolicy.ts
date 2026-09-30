export type ArcGisResidencyTier = 'pinned' | 'interactive' | 'background';
export type ArcGisResidencyState = 'cold' | 'warming' | 'resident' | 'evicting';

export interface ArcGisResidencyBudget {
  readonly maxLayers: number;
  readonly maxResidentLayers: number;
  readonly maxResidentBytes: number;
  readonly maxWarmingLayers: number;
  readonly warmLeaseMs: number;
}

export interface ArcGisResidencyDescriptor {
  readonly layerId: string;
  readonly revision: number;
  readonly tier: ArcGisResidencyTier;
  readonly estimatedBytes: number;
  readonly visible: boolean;
  readonly interactive: boolean;
}

export interface ArcGisResidencyEntry extends ArcGisResidencyDescriptor {
  readonly state: ArcGisResidencyState;
  readonly leaseExpiresAt: number | null;
  readonly sequence: number;
}

export interface ArcGisResidencyPlan {
  readonly revision: number;
  readonly resident: readonly ArcGisResidencyEntry[];
  readonly deferred: readonly ArcGisResidencyEntry[];
  readonly residentBytes: number;
  readonly fingerprint: string;
}

const TIER_ORDER: Readonly<Record<ArcGisResidencyTier, number>> = Object.freeze({ pinned: 0, interactive: 1, background: 2 });

function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function layerId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error('layerId must be 1..256 characters');
  return normalized;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function frozen(entry: ArcGisResidencyEntry): ArcGisResidencyEntry { return Object.freeze({ ...entry }); }

export class ArcGisLayerResidencyPolicy {
  readonly #budget: Readonly<ArcGisResidencyBudget>;
  readonly #entries = new Map<string, ArcGisResidencyEntry>();
  #sequence = 0;
  #disposed = false;

  constructor(budget: ArcGisResidencyBudget) {
    const normalized = {
      maxLayers: integer(budget.maxLayers, 'maxLayers', 1),
      maxResidentLayers: integer(budget.maxResidentLayers, 'maxResidentLayers', 1),
      maxResidentBytes: integer(budget.maxResidentBytes, 'maxResidentBytes', 1),
      maxWarmingLayers: integer(budget.maxWarmingLayers, 'maxWarmingLayers', 1),
      warmLeaseMs: integer(budget.warmLeaseMs, 'warmLeaseMs', 1),
    };
    if (normalized.maxResidentLayers > normalized.maxLayers || normalized.maxWarmingLayers > normalized.maxLayers) {
      throw new Error('residency concurrency budgets cannot exceed maxLayers');
    }
    this.#budget = Object.freeze(normalized);
  }

  register(descriptor: ArcGisResidencyDescriptor): ArcGisResidencyEntry {
    this.#active();
    const id = layerId(descriptor.layerId);
    const revision = integer(descriptor.revision, 'revision');
    const estimatedBytes = integer(descriptor.estimatedBytes, 'estimatedBytes');
    if (estimatedBytes > this.#budget.maxResidentBytes) throw new Error('layer exceeds resident byte budget');
    const current = this.#entries.get(id);
    if (!current && this.#entries.size >= this.#budget.maxLayers) throw new Error('layer cardinality budget exceeded');
    if (current) {
      if (revision < current.revision) throw new Error('stale layer revision');
      if (revision === current.revision) {
        const same = current.tier === descriptor.tier && current.estimatedBytes === estimatedBytes && current.visible === descriptor.visible && current.interactive === descriptor.interactive;
        if (!same) throw new Error('revision collision');
        return current;
      }
      if (current.state === 'warming' || current.state === 'evicting') throw new Error('cannot replace transitional layer');
    }
    const next = frozen({ layerId: id, revision, tier: descriptor.tier, estimatedBytes, visible: Boolean(descriptor.visible), interactive: Boolean(descriptor.interactive), state: 'cold', leaseExpiresAt: null, sequence: ++this.#sequence });
    this.#entries.set(id, next);
    return next;
  }

  beginWarm(id: string, revision: number, now: number): ArcGisResidencyEntry {
    this.#active();
    integer(now, 'now');
    const current = this.#current(id, revision);
    if (current.state !== 'cold') throw new Error('layer is not cold');
    const warming = [...this.#entries.values()].filter((entry) => entry.state === 'warming').length;
    if (warming >= this.#budget.maxWarmingLayers) throw new Error('warming concurrency budget exceeded');
    return this.#replace(current, 'warming', now + this.#budget.warmLeaseMs);
  }

  completeWarm(id: string, revision: number, now: number): ArcGisResidencyEntry {
    this.#active();
    integer(now, 'now');
    const current = this.#current(id, revision);
    if (current.state !== 'warming') throw new Error('layer is not warming');
    if (current.leaseExpiresAt !== null && now > current.leaseExpiresAt) throw new Error('warm lease expired');
    const resident = [...this.#entries.values()].filter((entry) => entry.state === 'resident');
    if (resident.length >= this.#budget.maxResidentLayers) throw new Error('resident layer budget exceeded');
    const bytes = resident.reduce((sum, entry) => sum + entry.estimatedBytes, 0) + current.estimatedBytes;
    if (bytes > this.#budget.maxResidentBytes) throw new Error('resident byte budget exceeded');
    return this.#replace(current, 'resident', null);
  }

  abortWarm(id: string, revision: number): ArcGisResidencyEntry {
    this.#active();
    const current = this.#current(id, revision);
    if (current.state !== 'warming') throw new Error('layer is not warming');
    return this.#replace(current, 'cold', null);
  }

  beginEvict(id: string, revision: number): ArcGisResidencyEntry {
    this.#active();
    const current = this.#current(id, revision);
    if (current.state !== 'resident') throw new Error('only resident layers may be evicted');
    if (current.tier === 'pinned') throw new Error('pinned layers cannot be evicted implicitly');
    return this.#replace(current, 'evicting', null);
  }

  completeEvict(id: string, revision: number): ArcGisResidencyEntry {
    this.#active();
    const current = this.#current(id, revision);
    if (current.state !== 'evicting') throw new Error('layer is not evicting');
    return this.#replace(current, 'cold', null);
  }

  reapExpired(now: number): readonly ArcGisResidencyEntry[] {
    this.#active();
    integer(now, 'now');
    const reaped: ArcGisResidencyEntry[] = [];
    for (const entry of this.#ordered()) {
      if (entry.state === 'warming' && entry.leaseExpiresAt !== null && now > entry.leaseExpiresAt) reaped.push(this.#replace(entry, 'cold', null));
    }
    return Object.freeze(reaped);
  }

  plan(revision: number): ArcGisResidencyPlan {
    this.#active();
    integer(revision, 'revision');
    const candidates = this.#ordered().filter((entry) => entry.revision === revision && entry.state !== 'evicting');
    const resident: ArcGisResidencyEntry[] = [];
    const deferred: ArcGisResidencyEntry[] = [];
    let bytes = 0;
    for (const entry of candidates) {
      const nextBytes = bytes + entry.estimatedBytes;
      if (resident.length < this.#budget.maxResidentLayers && nextBytes <= this.#budget.maxResidentBytes) {
        resident.push(entry); bytes = nextBytes;
      } else deferred.push(entry);
    }
    const material = resident.map((entry) => `${entry.layerId}:${entry.revision}:${entry.state}:${entry.sequence}`).join('|');
    return Object.freeze({ revision, resident: Object.freeze(resident), deferred: Object.freeze(deferred), residentBytes: bytes, fingerprint: fingerprint(`${revision}|${bytes}|${material}`) });
  }

  snapshot(): readonly ArcGisResidencyEntry[] { this.#active(); return Object.freeze(this.#ordered()); }
  dispose(): void { if (!this.#disposed) { this.#entries.clear(); this.#disposed = true; } }

  #ordered(): ArcGisResidencyEntry[] {
    return [...this.#entries.values()].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || Number(b.visible) - Number(a.visible) || Number(b.interactive) - Number(a.interactive) || a.sequence - b.sequence || a.layerId.localeCompare(b.layerId));
  }
  #current(id: string, revision: number): ArcGisResidencyEntry {
    const current = this.#entries.get(layerId(id));
    if (!current) throw new Error('unknown layer');
    if (current.revision !== integer(revision, 'revision')) throw new Error('stale layer revision');
    return current;
  }
  #replace(current: ArcGisResidencyEntry, state: ArcGisResidencyState, leaseExpiresAt: number | null): ArcGisResidencyEntry {
    const next = frozen({ ...current, state, leaseExpiresAt, sequence: ++this.#sequence }); this.#entries.set(current.layerId, next); return next;
  }
  #active(): void { if (this.#disposed) throw new Error('layer residency policy is disposed'); }
}
