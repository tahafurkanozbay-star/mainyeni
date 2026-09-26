export type SpatialTileRequestPriority = 'critical' | 'interactive' | 'prefetch';

export interface SpatialTileRequestDescriptor {
  readonly key: string;
  readonly layerId: string;
  readonly estimatedBytes: number;
  readonly priority: SpatialTileRequestPriority;
}

export interface SpatialTileRequestLimits {
  readonly maxInflight: number;
  readonly maxInflightBytes: number;
  readonly maxPerLayer: number;
  readonly maxSubscribersPerRequest: number;
  readonly maxTracked: number;
}

export interface SpatialTileRequestLease {
  readonly key: string;
  readonly subscriberId: string;
  readonly generation: number;
  readonly owner: boolean;
}

export interface SpatialTileRequestSnapshot {
  readonly inflight: number;
  readonly inflightBytes: number;
  readonly subscribers: number;
  readonly byLayer: Readonly<Record<string, number>>;
  readonly deduplicated: number;
  readonly rejected: number;
  readonly cancelled: number;
}

interface TrackedRequest extends SpatialTileRequestDescriptor {
  readonly generation: number;
  readonly subscribers: Set<string>;
}

const DEFAULT_LIMITS: SpatialTileRequestLimits = Object.freeze({
  maxInflight: 24,
  maxInflightBytes: 48 * 1024 * 1024,
  maxPerLayer: 8,
  maxSubscribersPerRequest: 32,
  maxTracked: 64,
});

const PRIORITY_RANK: Readonly<Record<SpatialTileRequestPriority, number>> = Object.freeze({
  critical: 0,
  interactive: 1,
  prefetch: 2,
});

const normalizeText = (value: string, maxLength: number): string | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) return undefined;
  if (!/^[\p{L}\p{N}_.:@/ -]+$/u.test(normalized)) return undefined;
  return normalized;
};

const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const validateLimits = (input: Partial<SpatialTileRequestLimits>): SpatialTileRequestLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!positiveInteger(limits.maxInflight) || limits.maxInflight > 10_000) throw new RangeError('maxInflight');
  if (!positiveInteger(limits.maxInflightBytes) || limits.maxInflightBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxInflightBytes');
  if (!positiveInteger(limits.maxPerLayer) || limits.maxPerLayer > limits.maxInflight) throw new RangeError('maxPerLayer');
  if (!positiveInteger(limits.maxSubscribersPerRequest) || limits.maxSubscribersPerRequest > 10_000) throw new RangeError('maxSubscribersPerRequest');
  if (!positiveInteger(limits.maxTracked) || limits.maxTracked < limits.maxInflight || limits.maxTracked > 100_000) throw new RangeError('maxTracked');
  return Object.freeze(limits);
};

const normalizeDescriptor = (input: SpatialTileRequestDescriptor): SpatialTileRequestDescriptor | undefined => {
  const key = normalizeText(input.key, 180);
  const layerId = normalizeText(input.layerId, 160);
  if (!key || !layerId) return undefined;
  if (!positiveInteger(input.estimatedBytes)) return undefined;
  if (!(input.priority in PRIORITY_RANK)) return undefined;
  return Object.freeze({ key, layerId, estimatedBytes: input.estimatedBytes, priority: input.priority });
};

/**
 * Transport-neutral single-flight authority for ArcGIS tile work.
 *
 * The coordinator deliberately owns no fetch implementation. A caller that receives
 * an owner lease starts the already-governed ArcGIS request. Later callers for the
 * same canonical key receive subscriber leases and share that work. When the final
 * subscriber leaves, the key is returned from release() so the transport owner can
 * abort its request. Generation tokens prevent stale completions from deleting a
 * newer request that reused the same key.
 */
export class SpatialTileRequestCoordinator {
  readonly #limits: SpatialTileRequestLimits;
  readonly #tracked = new Map<string, TrackedRequest>();
  #generation = 0;
  #deduplicated = 0;
  #rejected = 0;
  #cancelled = 0;

  constructor(limits: Partial<SpatialTileRequestLimits> = {}) {
    this.#limits = validateLimits(limits);
  }

  get limits(): SpatialTileRequestLimits {
    return this.#limits;
  }

  acquire(
    descriptor: SpatialTileRequestDescriptor,
    subscriberId: string,
  ): SpatialTileRequestLease | undefined {
    const normalized = normalizeDescriptor(descriptor);
    const subscriber = normalizeText(subscriberId, 180);
    if (!normalized || !subscriber) {
      this.#rejected += 1;
      return undefined;
    }

    const existing = this.#tracked.get(normalized.key);
    if (existing) {
      if (!this.#sameRequest(existing, normalized)) {
        this.#rejected += 1;
        return undefined;
      }
      if (existing.subscribers.has(subscriber)) {
        this.#deduplicated += 1;
        return this.#lease(existing, subscriber, false);
      }
      if (existing.subscribers.size >= this.#limits.maxSubscribersPerRequest) {
        this.#rejected += 1;
        return undefined;
      }
      existing.subscribers.add(subscriber);
      this.#deduplicated += 1;
      return this.#lease(existing, subscriber, false);
    }

    if (!this.#canStart(normalized)) {
      this.#rejected += 1;
      return undefined;
    }

    const request: TrackedRequest = {
      ...normalized,
      generation: this.#generation,
      subscribers: new Set([subscriber]),
    };
    this.#generation += 1;
    this.#tracked.set(request.key, request);
    return this.#lease(request, subscriber, true);
  }

  release(lease: SpatialTileRequestLease): boolean {
    const key = normalizeText(lease.key, 180);
    const subscriber = normalizeText(lease.subscriberId, 180);
    if (!key || !subscriber || !Number.isInteger(lease.generation) || lease.generation < 0) return false;
    const request = this.#tracked.get(key);
    if (!request || request.generation !== lease.generation) return false;
    if (!request.subscribers.delete(subscriber)) return false;
    if (request.subscribers.size > 0) return false;
    this.#tracked.delete(key);
    this.#cancelled += 1;
    return true;
  }

  complete(key: string, generation: number): readonly string[] {
    const normalizedKey = normalizeText(key, 180);
    if (!normalizedKey || !Number.isInteger(generation) || generation < 0) return Object.freeze([]);
    const request = this.#tracked.get(normalizedKey);
    if (!request || request.generation !== generation) return Object.freeze([]);
    this.#tracked.delete(normalizedKey);
    return Object.freeze([...request.subscribers].sort((left, right) => left.localeCompare(right)));
  }

  cancelLayer(layerId: string): readonly string[] {
    const normalizedLayer = normalizeText(layerId, 160);
    if (!normalizedLayer) return Object.freeze([]);
    const cancelled: string[] = [];
    for (const [key, request] of this.#tracked) {
      if (request.layerId !== normalizedLayer) continue;
      this.#tracked.delete(key);
      cancelled.push(key);
      this.#cancelled += 1;
    }
    cancelled.sort((left, right) => left.localeCompare(right));
    return Object.freeze(cancelled);
  }

  clear(): readonly string[] {
    const cancelled = [...this.#tracked.keys()].sort((left, right) => left.localeCompare(right));
    this.#cancelled += cancelled.length;
    this.#tracked.clear();
    return Object.freeze(cancelled);
  }

  has(key: string): boolean {
    const normalized = normalizeText(key, 180);
    return normalized ? this.#tracked.has(normalized) : false;
  }

  snapshot(): SpatialTileRequestSnapshot {
    let inflightBytes = 0;
    let subscribers = 0;
    const byLayer: Record<string, number> = {};
    for (const request of this.#tracked.values()) {
      inflightBytes += request.estimatedBytes;
      subscribers += request.subscribers.size;
      byLayer[request.layerId] = (byLayer[request.layerId] ?? 0) + 1;
    }
    return Object.freeze({
      inflight: this.#tracked.size,
      inflightBytes,
      subscribers,
      byLayer: Object.freeze(byLayer),
      deduplicated: this.#deduplicated,
      rejected: this.#rejected,
      cancelled: this.#cancelled,
    });
  }

  #sameRequest(left: TrackedRequest, right: SpatialTileRequestDescriptor): boolean {
    return left.layerId === right.layerId
      && left.estimatedBytes === right.estimatedBytes
      && left.priority === right.priority;
  }

  #canStart(candidate: SpatialTileRequestDescriptor): boolean {
    if (this.#tracked.size >= this.#limits.maxInflight || this.#tracked.size >= this.#limits.maxTracked) return false;
    if (candidate.estimatedBytes > this.#limits.maxInflightBytes) return false;
    let bytes = candidate.estimatedBytes;
    let layerCount = 0;
    for (const request of this.#tracked.values()) {
      bytes += request.estimatedBytes;
      if (request.layerId === candidate.layerId) layerCount += 1;
    }
    if (bytes > this.#limits.maxInflightBytes) return false;
    return layerCount < this.#limits.maxPerLayer;
  }

  #lease(request: TrackedRequest, subscriberId: string, owner: boolean): SpatialTileRequestLease {
    return Object.freeze({
      key: request.key,
      subscriberId,
      generation: request.generation,
      owner,
    });
  }
}
