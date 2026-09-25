import {
  SpatialTileAdmissionRuntime,
  type SpatialTileAdmissionJob,
  type SpatialTileAdmissionLimits,
} from './spatialTileAdmissionRuntime';
import {
  SpatialTileCacheRuntime,
  type SpatialTileCacheEntry,
  type SpatialTileCacheLimits,
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
export type SpatialTilePipelineState = 'idle' | 'queued' | 'inflight' | 'cached' | 'rejected';

export interface SpatialTilePipelineDescriptor {
  readonly key: string;
  readonly layerId: string;
  readonly lod: number;
  readonly row: number;
  readonly column: number;
  readonly estimatedBytes: number;
  readonly priority: SpatialTilePipelinePriority;
}

export interface SpatialTilePipelineLease {
  readonly key: string;
  readonly subscriberId: string;
  readonly generation: number;
  readonly owner: boolean;
  readonly state: Exclude<SpatialTilePipelineState, 'idle' | 'rejected'>;
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
  readonly byState: Readonly<Record<SpatialTilePipelineState, number>>;
  readonly byLayer: Readonly<Record<string, number>>;
  readonly cacheEntries: number;
  readonly inflightRequests: number;
  readonly requestSubscribers: number;
  readonly diagnostics: number;
  readonly rejected: number;
  readonly cacheHits: number;
  readonly completed: number;
  readonly cancelled: number;
}

interface TileRecord extends SpatialTilePipelineDescriptor {
  state: SpatialTilePipelineState;
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
  if (!nonNegativeInteger(input.lod) || input.lod > 30) return undefined;
  if (!nonNegativeInteger(input.row) || !nonNegativeInteger(input.column)) return undefined;
  if (!positiveInteger(input.estimatedBytes) || input.estimatedBytes > 2 * 1024 * 1024 * 1024) return undefined;
  if (!PRIORITIES.has(input.priority)) return undefined;
  return Object.freeze({
    key,
    layerId,
    lod: input.lod,
    row: input.row,
    column: input.column,
    estimatedBytes: input.estimatedBytes,
    priority: input.priority,
  });
};

/**
 * Bounded orchestration authority for the spatial tile lifecycle.
 *
 * This class intentionally does not perform network I/O. It composes cache,
 * admission, request-deduplication and prefetch authorities while preserving a
 * small deterministic state machine that UI and ArcGIS transport adapters can
 * observe. Transport owners receive an owner lease and remain responsible for
 * starting/aborting the actual verified ArcGIS request.
 */
export class SpatialTilePipelineRuntime {
  readonly #limits: SpatialTilePipelineLimits;
  readonly #cache: SpatialTileCacheRuntime;
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
    this.#cache = new SpatialTileCacheRuntime(options.cache);
    this.#admission = new SpatialTileAdmissionRuntime(options.admission);
    this.#requests = new SpatialTileRequestCoordinator(options.request);
    this.#prefetch = new SpatialTilePrefetchPlanner(options.prefetch);
  }

  get limits(): SpatialTilePipelineLimits {
    return this.#limits;
  }

  acquire(
    descriptor: SpatialTilePipelineDescriptor,
    subscriberId: string,
    now = Date.now(),
  ): SpatialTilePipelineLease | undefined {
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

    const cached = this.#cache.get(normalized.key, now);
    if (cached) {
      this.#remember(normalized, 'cached', now);
      this.#cacheHits += 1;
      this.#record('cache-hit', normalized.key, normalized.layerId);
      return Object.freeze({
        key: normalized.key,
        subscriberId: subscriber,
        generation: 0,
        owner: false,
        state: 'cached',
      });
    }

    if (!this.#canRemember(normalized)) {
      this.#reject('capacity-rejected', normalized.key, normalized.layerId);
      return undefined;
    }

    const requestDescriptor: SpatialTileRequestDescriptor = {
      key: normalized.key,
      layerId: normalized.layerId,
      estimatedBytes: normalized.estimatedBytes,
      priority: normalized.priority,
    };
    const lease = this.#requests.acquire(requestDescriptor, subscriber);
    if (!lease) {
      this.#reject('request-rejected', normalized.key, normalized.layerId);
      return undefined;
    }

    this.#remember(normalized, 'inflight', now, lease.generation);
    this.#record('request-acquired', normalized.key, normalized.layerId);
    return this.#toPipelineLease(lease, 'inflight');
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
      this.#cancelled += 1;
      this.#record('request-released', record.key, record.layerId);
    }
    return true;
  }

  complete(
    key: string,
    generation: number,
    cacheEntry: SpatialTileCacheEntry,
    now = Date.now(),
  ): readonly string[] {
    const record = this.#tiles.get(key);
    if (!record || record.generation !== generation) return Object.freeze([]);
    const subscribers = this.#requests.complete(key, generation);
    if (subscribers.length === 0) return subscribers;
    const stored = this.#cache.set(cacheEntry, now);
    if (stored) {
      record.state = 'cached';
      record.generation = undefined;
      record.touchedAt = now;
    } else {
      this.#tiles.delete(key);
    }
    this.#completed += 1;
    this.#record('request-completed', record.key, record.layerId);
    return subscribers;
  }

  cancelLayer(layerId: string): readonly string[] {
    const normalized = normalizeText(layerId, 160);
    if (!normalized) return Object.freeze([]);
    const cancelled = this.#requests.cancelLayer(normalized);
    const removed = new Set(cancelled);
    for (const [key, record] of this.#tiles) {
      if (record.layerId !== normalized) continue;
      if (record.state === 'cached') continue;
      this.#tiles.delete(key);
      removed.add(key);
    }
    const result = [...removed].sort((left, right) => left.localeCompare(right));
    this.#cancelled += result.length;
    this.#record('layer-cancelled', undefined, normalized);
    return Object.freeze(result);
  }

  clear(): readonly string[] {
    const requestKeys = this.#requests.clear();
    const knownKeys = [...this.#tiles.keys()];
    const cancelled = [...new Set([...requestKeys, ...knownKeys])].sort((left, right) => left.localeCompare(right));
    this.#tiles.clear();
    this.#cache.clear();
    this.#admission.clear();
    this.#cancelled += cancelled.length;
    this.#record('pipeline-cleared');
    return Object.freeze(cancelled);
  }

  planPrefetch(candidates: readonly SpatialTilePrefetchCandidate[]): ReturnType<SpatialTilePrefetchPlanner['plan']> {
    return this.#prefetch.plan(candidates);
  }

  admit(job: SpatialTileAdmissionJob): ReturnType<SpatialTileAdmissionRuntime['admit']> {
    return this.#admission.admit(job);
  }

  stateOf(key: string): SpatialTilePipelineState {
    const normalized = normalizeText(key, 180);
    if (!normalized) return 'idle';
    return this.#tiles.get(normalized)?.state ?? 'idle';
  }

  diagnostics(): readonly SpatialTilePipelineDiagnostic[] {
    return Object.freeze(this.#diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  }

  snapshot(): SpatialTilePipelineSnapshot {
    const byState: Record<SpatialTilePipelineState, number> = {
      idle: 0,
      queued: 0,
      inflight: 0,
      cached: 0,
      rejected: 0,
    };
    const byLayer: Record<string, number> = {};
    for (const record of this.#tiles.values()) {
      byState[record.state] += 1;
      byLayer[record.layerId] = (byLayer[record.layerId] ?? 0) + 1;
    }
    const cache = this.#cache.snapshot();
    const requests = this.#requests.snapshot();
    return Object.freeze({
      knownTiles: this.#tiles.size,
      byState: Object.freeze(byState),
      byLayer: Object.freeze(byLayer),
      cacheEntries: cache.entries,
      inflightRequests: requests.inflight,
      requestSubscribers: requests.subscribers,
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
    for (const record of this.#tiles.values()) {
      if (record.layerId === candidate.layerId) layerCount += 1;
    }
    return layerCount < this.#limits.maxLayerTiles;
  }

  #remember(
    descriptor: SpatialTilePipelineDescriptor,
    state: SpatialTilePipelineState,
    now: number,
    generation?: number,
  ): void {
    const record: TileRecord = { ...descriptor, state, touchedAt: now };
    if (generation !== undefined) record.generation = generation;
    this.#tiles.set(descriptor.key, record);
  }

  #reject(code: SpatialTilePipelineDiagnostic['code'], key?: string, layerId?: string): void {
    this.#rejected += 1;
    this.#record(code, key, layerId);
  }

  #record(code: SpatialTilePipelineDiagnostic['code'], key?: string, layerId?: string): void {
    const diagnostic: SpatialTilePipelineDiagnostic = { sequence: this.#sequence, code };
    this.#sequence += 1;
    const complete = { ...diagnostic, ...(key ? { key } : {}), ...(layerId ? { layerId } : {}) };
    this.#diagnostics.push(Object.freeze(complete));
    if (this.#diagnostics.length > this.#limits.maxDiagnostics) this.#diagnostics.shift();
  }

  #toPipelineLease(
    lease: SpatialTileRequestLease,
    state: 'queued' | 'inflight',
  ): SpatialTilePipelineLease {
    return Object.freeze({
      key: lease.key,
      subscriberId: lease.subscriberId,
      generation: lease.generation,
      owner: lease.owner,
      state,
    });
  }
}
