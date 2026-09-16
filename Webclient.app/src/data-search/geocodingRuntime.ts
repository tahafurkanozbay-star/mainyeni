import type { Coordinate, GeocodePage } from './contracts';
import { createAbortError, throwIfAborted } from './contracts';
import { adaptGeocodingPayload } from './geocodingAdapter';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type GeocodingOperation = 'forward' | 'reverse';

export interface ForwardGeocodeRequest {
  readonly query: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly minimumScore?: number;
  readonly countryCode?: string | null;
  readonly language?: string | null;
  readonly bias?: Coordinate | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReverseGeocodeRequest {
  readonly coordinates: Coordinate | readonly [number, number];
  readonly limit?: number;
  readonly minimumScore?: number;
  readonly language?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GeocodingProviderContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly providerId: string;
  readonly operation: GeocodingOperation;
}

export interface GeocodingProvider {
  readonly id: string;
  readonly priority?: number;
  readonly forward?: (
    request: ForwardGeocodeRequest,
    context: GeocodingProviderContext,
  ) => Promise<unknown> | unknown;
  readonly reverse?: (
    request: ReverseGeocodeRequest,
    context: GeocodingProviderContext,
  ) => Promise<unknown> | unknown;
}

export interface GeocodingRuntimeOptions {
  readonly maxProviders?: number;
  readonly cacheSize?: number;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly clock?: () => number;
}

export interface GeocodingExecutionOptions {
  readonly providerId?: string | null;
  readonly signal?: AbortSignal | null;
  readonly bypassCache?: boolean;
  readonly now?: number;
}

export interface GeocodingRuntimeResult {
  readonly operation: GeocodingOperation;
  readonly providerId: string;
  readonly requestId: string;
  readonly page: GeocodePage;
  readonly cacheHit: boolean;
  readonly deduplicated: boolean;
  readonly elapsedMs: number;
  readonly requestFingerprint: string;
}

export interface GeocodingRuntimeSnapshot {
  readonly providerCount: number;
  readonly cacheEntries: number;
  readonly inFlight: number;
  readonly requests: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly deduplicated: number;
  readonly aborts: number;
  readonly timeouts: number;
  readonly failures: number;
  readonly providerCalls: Readonly<Record<string, number>>;
}

interface NormalizedOptions {
  readonly maxProviders: number;
  readonly cacheSize: number;
  readonly cacheTtlMs: number;
  readonly timeoutMs: number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly clock: () => number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly result: GeocodingRuntimeResult;
}

interface InFlightEntry {
  readonly controller: AbortController;
  readonly promise: Promise<GeocodingRuntimeResult>;
  subscribers: number;
  settled: boolean;
}

interface MutableStats {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  deduplicated: number;
  aborts: number;
  timeouts: number;
  failures: number;
  providerCalls: Record<string, number>;
}

const DEFAULT_CACHE_SIZE = 128;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 100;

const normalizeProviderId = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const normalizeOptions = (options: GeocodingRuntimeOptions): NormalizedOptions => {
  const maxLimit = normalizeInteger(options.maxLimit, {
    min: 1,
    max: 500,
    fallback: DEFAULT_MAX_LIMIT,
  });
  return Object.freeze({
    maxProviders: normalizeInteger(options.maxProviders, { min: 1, max: 64, fallback: 8 }),
    cacheSize: normalizeInteger(options.cacheSize, { min: 1, max: 5_000, fallback: DEFAULT_CACHE_SIZE }),
    cacheTtlMs: normalizeInteger(options.cacheTtlMs, {
      min: 1,
      max: 24 * 60 * 60 * 1000,
      fallback: DEFAULT_CACHE_TTL_MS,
    }),
    timeoutMs: normalizeInteger(options.timeoutMs, {
      min: 100,
      max: 120_000,
      fallback: DEFAULT_TIMEOUT_MS,
    }),
    defaultLimit: normalizeInteger(options.defaultLimit, {
      min: 1,
      max: maxLimit,
      fallback: DEFAULT_LIMIT,
    }),
    maxLimit,
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  });
};

const normalizeLimit = (value: unknown, options: NormalizedOptions): number => normalizeInteger(value, {
  min: 1,
  max: options.maxLimit,
  fallback: options.defaultLimit,
});

const normalizeForward = (
  request: ForwardGeocodeRequest,
  options: NormalizedOptions,
): ForwardGeocodeRequest => {
  const query = normalizeText(request.query);
  if (!query) throw new TypeError('Forward geocoding query is required');
  return Object.freeze({
    query,
    limit: normalizeLimit(request.limit, options),
    offset: normalizeInteger(request.offset, { min: 0, max: 100_000, fallback: 0 }),
    minimumScore: Math.min(100, Math.max(0, Number(request.minimumScore) || 0)),
    countryCode: normalizeText(request.countryCode) || null,
    language: normalizeText(request.language) || null,
    bias: request.bias ? normalizeCoordinates(request.bias) : null,
    metadata: Object.freeze({ ...request.metadata }),
  });
};

const normalizeReverse = (
  request: ReverseGeocodeRequest,
  options: NormalizedOptions,
): ReverseGeocodeRequest => {
  const coordinates = normalizeCoordinates(request.coordinates);
  if (!coordinates) throw new TypeError('Reverse geocoding requires valid coordinates');
  return Object.freeze({
    coordinates,
    limit: normalizeLimit(request.limit, options),
    minimumScore: Math.min(100, Math.max(0, Number(request.minimumScore) || 0)),
    language: normalizeText(request.language) || null,
    metadata: Object.freeze({ ...request.metadata }),
  });
};

const supports = (provider: GeocodingProvider, operation: GeocodingOperation): boolean =>
  operation === 'forward' ? typeof provider.forward === 'function' : typeof provider.reverse === 'function';

const timeoutError = (): Error => {
  const error = new Error('Geocoding provider timed out');
  error.name = 'TimeoutError';
  return error;
};

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
const isTimeoutError = (error: unknown): boolean => error instanceof Error && error.name === 'TimeoutError';

export class GeocodingRuntime {
  private readonly options: NormalizedOptions;
  private readonly providers = new Map<string, GeocodingProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly stats: MutableStats = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    deduplicated: 0,
    aborts: 0,
    timeouts: 0,
    failures: 0,
    providerCalls: {},
  };
  private sequence = 0;

  constructor(options: GeocodingRuntimeOptions = {}) {
    this.options = normalizeOptions(options);
  }

  private now(): number {
    return safeNow(this.options.clock);
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `geocode-${this.sequence}`;
  }

  register(provider: GeocodingProvider): () => void {
    const id = normalizeProviderId(provider.id);
    if (!id) throw new TypeError('Geocoding provider id is required');
    if (!supports(provider, 'forward') && !supports(provider, 'reverse')) {
      throw new TypeError(`Geocoding provider ${id} must implement forward and/or reverse`);
    }
    if (!this.providers.has(id) && this.providers.size >= this.options.maxProviders) {
      throw new Error(`Geocoding provider limit reached: ${this.options.maxProviders}`);
    }
    this.providers.set(id, Object.freeze({ ...provider, id }));
    return () => { this.unregister(id); };
  }

  unregister(providerId: unknown): boolean {
    const id = normalizeProviderId(providerId);
    const removed = this.providers.delete(id);
    if (removed) this.invalidateProvider(id);
    return removed;
  }

  private selectProvider(operation: GeocodingOperation, requestedId?: string | null): GeocodingProvider {
    const requested = normalizeProviderId(requestedId);
    if (requested) {
      const provider = this.providers.get(requested);
      if (!provider) throw new Error(`Unknown geocoding provider: ${requested}`);
      if (!supports(provider, operation)) throw new Error(`Geocoding provider ${requested} does not support ${operation}`);
      return provider;
    }
    const provider = [...this.providers.values()]
      .filter(candidate => supports(candidate, operation))
      .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0)
        || left.id.localeCompare(right.id))[0];
    if (!provider) throw new Error(`No geocoding provider supports ${operation}`);
    return provider;
  }

  private requestFingerprint(
    operation: GeocodingOperation,
    providerId: string,
    request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  ): string {
    return hashFingerprint(stableSerialize({ operation, providerId, request }));
  }

  private cacheKey(providerId: string, operation: GeocodingOperation, fingerprint: string): string {
    return `${providerId}|${operation}|${fingerprint}`;
  }

  private cacheGet(key: string, now: number): GeocodingRuntimeResult | null {
    for (const [entryKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(entryKey);
    }
    const entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return Object.freeze({ ...entry.result, cacheHit: true });
  }

  private cacheSet(key: string, result: GeocodingRuntimeResult, now: number): void {
    this.cache.delete(key);
    this.cache.set(key, Object.freeze({
      expiresAt: now + this.options.cacheTtlMs,
      result,
    }));
    while (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private adapt(
    payload: unknown,
    request: ForwardGeocodeRequest | ReverseGeocodeRequest,
  ): GeocodePage {
    return adaptGeocodingPayload(payload, {
      offset: 'offset' in request ? request.offset : 0,
      limit: request.limit,
      minimumScore: request.minimumScore,
      dedupe: true,
    });
  }

  private invoke(
    provider: GeocodingProvider,
    operation: GeocodingOperation,
    request: ForwardGeocodeRequest | ReverseGeocodeRequest,
    requestId: string,
    controller: AbortController,
  ): Promise<unknown> {
    this.stats.providerCalls[provider.id] = (this.stats.providerCalls[provider.id] ?? 0) + 1;
    const context: GeocodingProviderContext = Object.freeze({
      signal: controller.signal,
      requestId,
      providerId: provider.id,
      operation,
    });
    const providerPromise = Promise.resolve(operation === 'forward'
      ? provider.forward?.(request as ForwardGeocodeRequest, context)
      : provider.reverse?.(request as ReverseGeocodeRequest, context));
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(timeoutError());
      }, this.options.timeoutMs);
    });
    return Promise.race([providerPromise, timeoutPromise]).finally(() => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    });
  }

  private subscribe(
    entry: InFlightEntry,
    signal?: AbortSignal | null,
  ): Promise<GeocodingRuntimeResult> {
    entry.subscribers += 1;
    if (!signal) {
      return entry.promise.finally(() => {
        entry.subscribers = Math.max(0, entry.subscribers - 1);
      });
    }
    throwIfAborted(signal);
    return new Promise<GeocodingRuntimeResult>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        entry.subscribers = Math.max(0, entry.subscribers - 1);
      };
      const onAbort = (): void => {
        finish();
        this.stats.aborts += 1;
        if (!entry.settled && entry.subscribers === 0) entry.controller.abort();
        reject(createAbortError('Geocoding subscriber aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        result => { finish(); resolve(result); },
        error => { finish(); reject(error); },
      );
    });
  }

  private execute(
    operation: GeocodingOperation,
    request: ForwardGeocodeRequest | ReverseGeocodeRequest,
    execution: GeocodingExecutionOptions,
  ): Promise<GeocodingRuntimeResult> {
    try {
      throwIfAborted(execution.signal);
      const provider = this.selectProvider(operation, execution.providerId);
      const fingerprint = this.requestFingerprint(operation, provider.id, request);
      const key = this.cacheKey(provider.id, operation, fingerprint);
      const now = Number.isFinite(Number(execution.now)) ? Math.trunc(Number(execution.now)) : this.now();
      this.stats.requests += 1;
      if (!execution.bypassCache) {
        const cached = this.cacheGet(key, now);
        if (cached) {
          this.stats.cacheHits += 1;
          return Promise.resolve(cached);
        }
      }
      this.stats.cacheMisses += 1;
      const existing = this.inFlight.get(key);
      if (existing) {
        this.stats.deduplicated += 1;
        return this.subscribe(existing, execution.signal);
      }

      const controller = new AbortController();
      const requestId = this.nextRequestId();
      const startedAt = this.now();
      let entry: InFlightEntry;
      const promise = this.invoke(provider, operation, request, requestId, controller)
        .then(payload => {
          throwIfAborted(controller.signal);
          const result: GeocodingRuntimeResult = Object.freeze({
            operation,
            providerId: provider.id,
            requestId,
            page: this.adapt(payload, request),
            cacheHit: false,
            deduplicated: false,
            elapsedMs: Math.max(0, this.now() - startedAt),
            requestFingerprint: fingerprint,
          });
          if (!execution.bypassCache) this.cacheSet(key, result, this.now());
          return result;
        })
        .catch(error => {
          if (isTimeoutError(error)) this.stats.timeouts += 1;
          else if (isAbortError(error) || controller.signal.aborted) this.stats.aborts += 1;
          else this.stats.failures += 1;
          throw error;
        })
        .finally(() => {
          entry.settled = true;
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        });
      entry = { controller, promise, subscribers: 0, settled: false };
      this.inFlight.set(key, entry);
      return this.subscribe(entry, execution.signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  forward(
    request: ForwardGeocodeRequest,
    execution: GeocodingExecutionOptions = {},
  ): Promise<GeocodingRuntimeResult> {
    try {
      return this.execute('forward', normalizeForward(request, this.options), execution);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  reverse(
    request: ReverseGeocodeRequest,
    execution: GeocodingExecutionOptions = {},
  ): Promise<GeocodingRuntimeResult> {
    try {
      return this.execute('reverse', normalizeReverse(request, this.options), execution);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  invalidateProvider(providerIdInput: unknown): number {
    const providerId = normalizeProviderId(providerIdInput);
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${providerId}|`)) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clearCache(): number {
    const count = this.cache.size;
    this.cache.clear();
    return count;
  }

  abortAll(): number {
    let count = 0;
    for (const entry of this.inFlight.values()) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort();
        count += 1;
      }
    }
    return count;
  }

  snapshot(): GeocodingRuntimeSnapshot {
    return Object.freeze({
      providerCount: this.providers.size,
      cacheEntries: this.cache.size,
      inFlight: this.inFlight.size,
      requests: this.stats.requests,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      deduplicated: this.stats.deduplicated,
      aborts: this.stats.aborts,
      timeouts: this.stats.timeouts,
      failures: this.stats.failures,
      providerCalls: Object.freeze({ ...this.stats.providerCalls }),
    });
  }
}

export const createGeocodingRuntime = (options: GeocodingRuntimeOptions = {}): GeocodingRuntime =>
  new GeocodingRuntime(options);

export const createStaticGeocodingProvider = (
  idInput: unknown,
  handler: {
    readonly forward?: (request: ForwardGeocodeRequest) => unknown;
    readonly reverse?: (request: ReverseGeocodeRequest) => unknown;
  },
): GeocodingProvider => {
  const id = normalizeProviderId(idInput);
  if (!id) throw new TypeError('Static geocoding provider id is required');
  return Object.freeze({
    id,
    ...(handler.forward
      ? { forward: (request: ForwardGeocodeRequest) => handler.forward?.(request) }
      : {}),
    ...(handler.reverse
      ? { reverse: (request: ReverseGeocodeRequest) => handler.reverse?.(request) }
      : {}),
  });
};
