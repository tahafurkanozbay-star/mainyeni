import {
  SpatialTileAdmissionRuntime,
  type SpatialTileAdmissionLimits,
  type SpatialTileAdmissionRequest,
} from './spatialTileAdmissionRuntime';
import {
  SpatialTileCacheRuntime,
  type SpatialTileCacheKey,
  type SpatialTileCacheLimits,
  type SpatialTileCachePutOptions,
} from './spatialTileCacheRuntime';
import {
  SpatialTilePrefetchPlanner,
  type SpatialTilePrefetchCandidate,
  type SpatialTilePrefetchLimits,
} from './spatialTilePrefetchPlanner';
import {
  SpatialTileRequestCoordinator,
  type SpatialTileRequestDescriptor,
  type SpatialTileRequestLease,
  type SpatialTileRequestLimits,
} from './spatialTileRequestCoordinator';

export type SpatialTilePipelinePriority = 'critical' | 'interactive' | 'prefetch';
export type SpatialTilePipelineState = 'idle' | 'queued' | 'inflight' | 'cached';

export interface SpatialTilePipelineDescriptor {
  readonly key: string;
  readonly layerId: string;
  readonly level: number;
  readonly row: number;
  readonly column: number;
  readonly variant?: string;
  readonly estimatedBytes: number;
  readonly priority: SpatialTilePipelinePriority;
}

export interface SpatialTilePipelineLease {
  readonly key: string;
  readonly subscriberId: string;
  readonly generation: number;
  readonly owner: boolean;
  readonly state: 'inflight' | 'cached';
}

export interface SpatialTilePipelineLimits {
  readonly maxKnownTiles: number;
  readonly maxLayerTiles: number;
  readonly maxDiagnostics: number;
  readonly maxSubscriberIdLength: number;
}

export interface SpatialTilePipelineOptions {
  readonly pipeline?: Partial<SpatialTilePipelineLimits>;
  readonly cache?: Partial<SpatialTileCacheLimits>;
  readonly admission?: Partial<SpatialTileAdmissionLimits>;
  readonly request?: Partial<SpatialTileRequestLimits>;
  readonly prefetch?: Partial<SpatialTilePrefetchLimits>;
}

export interface SpatialTilePipelineDiagnostic {
  readonly sequence: number;
  readonly code:
    | 'invalid-descriptor'
    | 'invalid-subscriber'
    | 'capacity-rejected'
    | 'request-rejected'
    | 'cache-hit'
    | 'request-acquired'
    | 'request-completed'
    | 'request-released'
    | 'layer-cancelled'
    | 'pipeline-cleared';
  readonly key?: string;
  readonly layerId?: string;
}

export interface SpatialTilePipelineSnapshot {
  readonly knownTiles: number;
  readonly cachedTiles: number;
  readonly inflightTiles: number;
  readonly byLayer: Readonly<Record<string, number>>;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly inflightRequests: number;
  readonly requestSubscribers: number;
  readonly activeAdmissions: number;
  readonly queuedAdmissions: number;
  readonly diagnostics: number;
  readonly rejected: number;
  readonly cacheHits: number;
  readonly completed: number;
  readonly cancelled: number;
}

interface TileRecord extends SpatialTilePipelineDescriptor {
  state: Exclude<SpatialTilePipelineState, 'idle'>;
  generation?: number;
  touchedAt: number;
}

const DEFAULT_LIMITS: SpatialTilePipelineLimits = Object.freeze({
  maxKnownTiles: 2_048,
  maxLayerTiles: 512,
  maxDiagnostics: 256,
  maxSubscriberIdLength: 180,
});
const KEY_PATTERN = /^[\p{L}\p{N}_.:@/ -]+$/u;
const PRIORITIES = new Set<SpatialTilePipelinePriority>(['critical', 'interactive', 'prefetch']);
const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;
const nonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

const normalizeText = (value: string, maxLength: number): string | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || !KEY_PATTERN.test(normalized)) return undefined;
  return normalized;
};

const validateLimits = (input: Partial<SpatialTilePipelineLimits>): SpatialTilePipelineLimits => {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!positiveInteger(limits.maxKnownTiles) || limits.maxKnownTiles > 100_000) throw new RangeError('maxKnownTiles');
  if (!positiveInteger(limits.maxLayerTiles) || limits.maxLayerTiles > limits.maxKnownTiles) throw new RangeError('maxLayerTiles');
  if (!positiveInteger(limits.maxDiagnostics) || limits.maxDiagnostics > 10_000) throw new RangeError('maxDiagnostics');
  if (!positiveInteger(limits.maxSubscriberIdLength) || limits.maxSubscriberIdLength > 512) throw new RangeError('maxSubscriberIdLength');
  return Object.freeze(limits);
};

const normalizeDescriptor = (input: SpatialTilePipelineDescriptor): SpatialTilePipelineDescriptor | undefined => {
  const key = normalizeText(input.key, 180);
  const layerId = normalizeText(input.layerId, 160);
  if (!key || !layerId) return undefined;
  if (!nonNegativeInteger(input.level) || input.level > 64) return undefined;
  if (!nonNegativeInteger(input.row) || input.row > 0x7fffffff) return undefined;
  if (!nonNegativeInteger(input.column) || input.column > 0x7fffffff) return undefined;
  if (!positiveInteger(input.estimatedBytes) || input.estimatedBytes > 2 * 1024 * 1024 * 1024) return undefined;
  if (!PRIORITIES.has(input.priority)) return undefined;
  const variant = input.variant === undefined ? undefined : normalizeText(input.variant, 160);
  if (input.variant !== undefined && variant === undefined) return undefined;
  return Object.freeze({
    key,
    layerId,
    level: input.level,
    row: input.row,
    column: input.column,
    estimatedBytes: input.estimatedBytes,
    priority: input.priority,
    ...(variant === undefined ? {} : { variant }),
  });
};

const cacheKey = (descriptor: SpatialTilePipelineDescriptor): SpatialTileCacheKey => ({
  layerId: descriptor.layerId,
  level: descriptor.level,
  row: descriptor.row,
  column: descriptor.column,
  ...(descriptor.variant === undefined ? {} : { variant: descriptor.variant }),
});

/** Transport-neutral bounded authority composing tile cache, admission, prefetch and single-flight request state. */
export class SpatialTilePipelineRuntime {
  readonly #limits: SpatialTilePipelineLimits;
  readonly #cache: SpatialTileCacheRuntime<true>;
  readonly #admission: SpatialTileAdmissionRuntime;
  readonly #requests: SpatialTileRequestCoordinator;
  readonly #prefetch: SpatialTilePrefetchPlanner;
  readonly #tiles = new Map<string, TileRecord>();
  readonly #diagnostics: SpatialTilePipelineDiagnostic[] = [];
  #sequence = 0;
  #rejected = 0;
  #cacheHits = 0;
  #completed = 0;
  #cancelled = 0;

  constructor(options: SpatialTilePipelineOptions = {}) {
    this.#limits = validateLimits(options.pipeline ?? {});
    this.#cache = new SpatialTileCacheRuntime<true>(options.cache ?? {});
    this.#admission = new SpatialTileAdmissionRuntime(options.admission ?? {});
    this.#requests = new SpatialTileRequestCoordinator(options.request ?? {});
    this.#prefetch = new SpatialTilePrefetchPlanner(options.prefetch ?? {});
  }

  get limits(): SpatialTilePipelineLimits {
    return this.#limits;
  }

  acquire(descriptor: SpatialTilePipelineDescriptor, subscriberId: string, now = Date.now()): SpatialTilePipelineLease | undefined {
    const normalized = normalizeDescriptor(descriptor);
    if (!normalized || !Number.isFinite(now) || now < 0) {
      this.#reject('invalid-descriptor', normalized?.key, normalized?.layerId);
      return undefined;
    }
    const subscriber = normalizeText(subscriberId, this.#limits.maxSubscriberIdLength);
    if (!subscriber) {
      this.#reject('invalid-subscriber', normalized.key, normalized.layerId);
      return undefined;
    }
    if (this.#cache.get(cacheKey(normalized), now) === true) {
      this.#remember(normalized, 'cached', now);
      this.#cacheHits += 1;
      this.#record('cache-hit', normalized.key, normalized.layerId);
      return Object.freeze({ key: normalized.key, subscriberId: subscriber, generation: 0, owner: false, state: 'cached' });
    }
    if (!this.#canRemember(normalized)) {
      this.#reject('capacity-rejected', normalized.key, normalized.layerId);
      return undefined;
    }
    const request: SpatialTileRequestDescriptor = {
      key: normalized.key,
      layerId: normalized.layerId,
      estimatedBytes: normalized.estimatedBytes,
      priority: normalized.priority,
    };
    const lease = this.#requests.acquire(request, subscriber);
    if (!lease) {
      this.#reject('request-rejected', normalized.key, normalized.layerId);
      return undefined;
    }
    this.#remember(normalized, 'inflight', now, lease.generation);
    this.#record('request-acquired', normalized.key, normalized.layerId);
    return Object.freeze({ ...lease, state: 'inflight' });
  }

  release(lease: SpatialTilePipelineLease): boolean {
    if (lease.state === 'cached') return false;
    const requestLease: SpatialTileRequestLease = {
      key: lease.key,
      subscriberId: lease.subscriberId,
      generation: lease.generation,
      owner: lease.owner,
    };
    const shouldAbort = this.#requests.release(requestLease);
    if (!shouldAbort) return false;
    const record = this.#tiles.get(lease.key);
    if (record?.generation === lease.generation) {
      this.#tiles.delete(lease.key);
      this.#admission.release(lease.key);
      this.#cancelled += 1;
      this.#record('request-released', record.key, record.layerId);
    }
    return true;
  }

  complete(key: string, generation: number, cacheOptions: SpatialTileCachePutOptions): readonly string[] {
    const record = this.#tiles.get(key);
    if (!record || record.generation !== generation) return Object.freeze([]);
    const subscribers = this.#requests.complete(key, generation);
    if (subscribers.length === 0) return subscribers;
    const stored = this.#cache.put(cacheKey(record), true, cacheOptions);
    this.#admission.release(key);
    if (stored) {
      record.state = 'cached';
      delete record.generation;
      record.touchedAt = cacheOptions.now ?? Date.now();
    } else {
      this.#tiles.delete(key);
    }
    this.#completed += 1;
    this.#record('request-completed', record.key, record.layerId);
    return subscribers;
  }

  admit(request: SpatialTileAdmissionRequest): ReturnType<SpatialTileAdmissionRuntime['admit']> {
    return this.#admission.admit(request);
  }

  planPrefetch(candidates: readonly SpatialTilePrefetchCandidate[]): ReturnType<SpatialTilePrefetchPlanner['plan']> {
    return this.#prefetch.plan(candidates);
  }

  cancelLayer(layerId: string): readonly string[] {
    const normalized = normalizeText(layerId, 160);
    if (!normalized) return Object.freeze([]);
    const removed = new Set([...this.#requests.cancelLayer(normalized), ...this.#admission.cancelLayer(normalized)]);
    for (const [key, record] of this.#tiles) {
      if (record.layerId !== normalized || record.state === 'cached') continue;
      this.#tiles.delete(key);
      removed.add(key);
    }
    const result = [...removed].sort((left, right) => left.localeCompare(right));
    this.#cancelled += result.length;
    this.#record('layer-cancelled', undefined, normalized);
    return Object.freeze(result);
  }

  clear(): readonly string[] {
    const removed = new Set([...this.#requests.clear(), ...this.#admission.clear(), ...this.#tiles.keys()]);
    this.#tiles.clear();
    this.#cache.clear({ includePinned: true });
    const result = [...removed].sort((left, right) => left.localeCompare(right));
    this.#cancelled += result.length;
    this.#record('pipeline-cleared');
    return Object.freeze(result);
  }

  stateOf(key: string): SpatialTilePipelineState {
    const normalized = normalizeText(key, 180);
    return normalized ? this.#tiles.get(normalized)?.state ?? 'idle' : 'idle';
  }

  diagnostics(): readonly SpatialTilePipelineDiagnostic[] {
    return Object.freeze(this.#diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  }

  snapshot(now = Date.now()): SpatialTilePipelineSnapshot {
    let cachedTiles = 0;
    let inflightTiles = 0;
    const byLayer: Record<string, number> = {};
    for (const record of this.#tiles.values()) {
      if (record.state === 'cached') cachedTiles += 1;
      if (record.state === 'inflight') inflightTiles += 1;
      byLayer[record.layerId] = (byLayer[record.layerId] ?? 0) + 1;
    }
    const cache = this.#cache.snapshot(now);
    const requests = this.#requests.snapshot();
    const admission = this.#admission.snapshot();
    return Object.freeze({
      knownTiles: this.#tiles.size,
      cachedTiles,
      inflightTiles,
      byLayer: Object.freeze(byLayer),
      cacheEntries: cache.entries,
      cacheBytes: cache.bytes,
      inflightRequests: requests.inflight,
      requestSubscribers: requests.subscribers,
      activeAdmissions: admission.activeCount,
      queuedAdmissions: admission.queuedCount,
      diagnostics: this.#diagnostics.length,
      rejected: this.#rejected,
      cacheHits: this.#cacheHits,
      completed: this.#completed,
      cancelled: this.#cancelled,
    });
  }

  #canRemember(candidate: SpatialTilePipelineDescriptor): boolean {
    const existing = this.#tiles.get(candidate.key);
    if (existing) return existing.layerId === candidate.layerId;
    if (this.#tiles.size >= this.#limits.maxKnownTiles) return false;
    let layerCount = 0;
    for (const record of this.#tiles.values()) if (record.layerId === candidate.layerId) layerCount += 1;
    return layerCount < this.#limits.maxLayerTiles;
  }

  #remember(descriptor: SpatialTilePipelineDescriptor, state: TileRecord['state'], now: number, generation?: number): void {
    const record: TileRecord = { ...descriptor, state, touchedAt: now, ...(generation === undefined ? {} : { generation }) };
    this.#tiles.set(descriptor.key, record);
  }

  #reject(code: SpatialTilePipelineDiagnostic['code'], key?: string, layerId?: string): void {
    this.#rejected += 1;
    this.#record(code, key, layerId);
  }

  #record(code: SpatialTilePipelineDiagnostic['code'], key?: string, layerId?: string): void {
    const diagnostic: SpatialTilePipelineDiagnostic = Object.freeze({
      sequence: this.#sequence,
      code,
      ...(key === undefined ? {} : { key }),
      ...(layerId === undefined ? {} : { layerId }),
    });
    this.#sequence += 1;
    this.#diagnostics.push(diagnostic);
    if (this.#diagnostics.length > this.#limits.maxDiagnostics) this.#diagnostics.shift();
  }
}
