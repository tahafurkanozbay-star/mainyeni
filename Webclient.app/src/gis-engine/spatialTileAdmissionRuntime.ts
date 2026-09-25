export type SpatialTileAdmissionPriority = 'critical' | 'interactive' | 'prefetch';

export interface SpatialTileAdmissionRequest {
  readonly key: string;
  readonly layerId: string;
  readonly estimatedBytes: number;
  readonly priority: SpatialTileAdmissionPriority;
}

export interface SpatialTileAdmissionLimits {
  readonly maxActive: number;
  readonly maxActiveBytes: number;
  readonly maxPerLayer: number;
  readonly maxPerLayerBytes: number;
  readonly maxQueued: number;
  readonly maxQueuedBytes: number;
}

export interface SpatialTileAdmissionSnapshot {
  readonly activeCount: number;
  readonly activeBytes: number;
  readonly queuedCount: number;
  readonly queuedBytes: number;
  readonly activeByLayer: Readonly<Record<string, number>>;
  readonly queuedByLayer: Readonly<Record<string, number>>;
}

export interface SpatialTileAdmissionHandle {
  readonly key: string;
  readonly state: 'active' | 'queued';
}

interface Entry extends SpatialTileAdmissionRequest {
  readonly sequence: number;
}

const DEFAULT_LIMITS: SpatialTileAdmissionLimits = Object.freeze({
  maxActive: 16,
  maxActiveBytes: 32 * 1024 * 1024,
  maxPerLayer: 6,
  maxPerLayerBytes: 16 * 1024 * 1024,
  maxQueued: 128,
  maxQueuedBytes: 96 * 1024 * 1024,
});

const PRIORITY_RANK: Readonly<Record<SpatialTileAdmissionPriority, number>> = Object.freeze({
  critical: 0,
  interactive: 1,
  prefetch: 2,
});

const normalizeText = (value: string): string | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 180) return undefined;
  if (!/^[\p{L}\p{N}_.:@/ -]+$/u.test(normalized)) return undefined;
  return normalized;
};

const validateLimits = (input: Partial<SpatialTileAdmissionLimits>): SpatialTileAdmissionLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;
  if (!positiveInteger(limits.maxActive) || limits.maxActive > 10_000) throw new RangeError('maxActive');
  if (!positiveInteger(limits.maxActiveBytes) || limits.maxActiveBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxActiveBytes');
  if (!positiveInteger(limits.maxPerLayer) || limits.maxPerLayer > limits.maxActive) throw new RangeError('maxPerLayer');
  if (!positiveInteger(limits.maxPerLayerBytes) || limits.maxPerLayerBytes > limits.maxActiveBytes) throw new RangeError('maxPerLayerBytes');
  if (!positiveInteger(limits.maxQueued) || limits.maxQueued > 100_000) throw new RangeError('maxQueued');
  if (!positiveInteger(limits.maxQueuedBytes) || limits.maxQueuedBytes > 4 * 1024 * 1024 * 1024) throw new RangeError('maxQueuedBytes');
  return Object.freeze(limits);
};

const normalizeRequest = (request: SpatialTileAdmissionRequest): SpatialTileAdmissionRequest | undefined => {
  const key = normalizeText(request.key);
  const layerId = normalizeText(request.layerId);
  if (!key || !layerId) return undefined;
  if (!Number.isInteger(request.estimatedBytes) || request.estimatedBytes < 1) return undefined;
  if (!(request.priority in PRIORITY_RANK)) return undefined;
  return Object.freeze({ key, layerId, estimatedBytes: request.estimatedBytes, priority: request.priority });
};

const compareEntries = (left: Entry, right: Entry): number => {
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority !== 0) return priority;
  return left.sequence - right.sequence;
};

/**
 * Transport-neutral concurrency and memory admission authority for spatial tile work.
 * It owns no network carrier: callers start/cancel their verified ArcGIS requests from
 * the deterministic active/queued transitions returned here.
 */
export class SpatialTileAdmissionRuntime {
  readonly #limits: SpatialTileAdmissionLimits;
  readonly #active = new Map<string, Entry>();
  readonly #queued = new Map<string, Entry>();
  #sequence = 0;

  constructor(limits: Partial<SpatialTileAdmissionLimits> = {}) {
    this.#limits = validateLimits(limits);
  }

  get limits(): SpatialTileAdmissionLimits {
    return this.#limits;
  }

  admit(request: SpatialTileAdmissionRequest): SpatialTileAdmissionHandle | undefined {
    const normalized = normalizeRequest(request);
    if (!normalized) return undefined;
    if (normalized.estimatedBytes > this.#limits.maxActiveBytes || normalized.estimatedBytes > this.#limits.maxPerLayerBytes) return undefined;
    if (this.#active.has(normalized.key)) return Object.freeze({ key: normalized.key, state: 'active' });
    if (this.#queued.has(normalized.key)) return Object.freeze({ key: normalized.key, state: 'queued' });

    const entry: Entry = Object.freeze({ ...normalized, sequence: this.#sequence++ });
    if (this.#canActivate(entry)) {
      this.#active.set(entry.key, entry);
      return Object.freeze({ key: entry.key, state: 'active' });
    }
    if (!this.#canQueue(entry)) return undefined;
    this.#queued.set(entry.key, entry);
    return Object.freeze({ key: entry.key, state: 'queued' });
  }

  release(key: string): readonly SpatialTileAdmissionHandle[] {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) return Object.freeze([]);
    const removedActive = this.#active.delete(normalizedKey);
    const removedQueued = this.#queued.delete(normalizedKey);
    if (!removedActive && !removedQueued) return Object.freeze([]);
    return this.#promote();
  }

  cancelLayer(layerId: string): readonly string[] {
    const normalizedLayer = normalizeText(layerId);
    if (!normalizedLayer) return Object.freeze([]);
    const removed: string[] = [];
    for (const [key, entry] of this.#active) {
      if (entry.layerId === normalizedLayer) {
        this.#active.delete(key);
        removed.push(key);
      }
    }
    for (const [key, entry] of this.#queued) {
      if (entry.layerId === normalizedLayer) {
        this.#queued.delete(key);
        removed.push(key);
      }
    }
    removed.sort((left, right) => left.localeCompare(right));
    this.#promote();
    return Object.freeze(removed);
  }

  clear(): readonly string[] {
    const removed = [...this.#active.keys(), ...this.#queued.keys()].sort((left, right) => left.localeCompare(right));
    this.#active.clear();
    this.#queued.clear();
    return Object.freeze(removed);
  }

  snapshot(): SpatialTileAdmissionSnapshot {
    const active = [...this.#active.values()];
    const queued = [...this.#queued.values()];
    const countByLayer = (entries: readonly Entry[]): Readonly<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const entry of entries) counts[entry.layerId] = (counts[entry.layerId] ?? 0) + 1;
      return Object.freeze(counts);
    };
    return Object.freeze({
      activeCount: active.length,
      activeBytes: active.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
      queuedCount: queued.length,
      queuedBytes: queued.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
      activeByLayer: countByLayer(active),
      queuedByLayer: countByLayer(queued),
    });
  }

  #canActivate(entry: Entry): boolean {
    if (this.#active.size >= this.#limits.maxActive) return false;
    let activeBytes = 0;
    let layerCount = 0;
    let layerBytes = 0;
    for (const active of this.#active.values()) {
      activeBytes += active.estimatedBytes;
      if (active.layerId === entry.layerId) {
        layerCount += 1;
        layerBytes += active.estimatedBytes;
      }
    }
    if (activeBytes + entry.estimatedBytes > this.#limits.maxActiveBytes) return false;
    if (layerCount >= this.#limits.maxPerLayer) return false;
    return layerBytes + entry.estimatedBytes <= this.#limits.maxPerLayerBytes;
  }

  #canQueue(entry: Entry): boolean {
    if (this.#queued.size >= this.#limits.maxQueued) return false;
    let queuedBytes = entry.estimatedBytes;
    for (const queued of this.#queued.values()) queuedBytes += queued.estimatedBytes;
    return queuedBytes <= this.#limits.maxQueuedBytes;
  }

  #promote(): readonly SpatialTileAdmissionHandle[] {
    const promoted: SpatialTileAdmissionHandle[] = [];
    const candidates = [...this.#queued.values()].sort(compareEntries);
    for (const candidate of candidates) {
      if (!this.#canActivate(candidate)) continue;
      this.#queued.delete(candidate.key);
      this.#active.set(candidate.key, candidate);
      promoted.push(Object.freeze({ key: candidate.key, state: 'active' }));
    }
    return Object.freeze(promoted);
  }
}
