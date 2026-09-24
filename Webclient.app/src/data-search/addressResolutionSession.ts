import type { AddressLevel, Coordinate } from './contracts';
import { createAbortError, throwIfAborted } from './contracts';
import {
  hashFingerprint,
  normalizeCoordinates,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';
import { canonicalizeAddressText } from './addressSemantics';

export const ADDRESS_RESOLUTION_SESSION_VERSION = '2026-09-24.v2';

export type AddressResolutionStatus = 'idle' | 'scheduled' | 'running' | 'success' | 'error' | 'aborted';

export interface AddressResolutionRequest {
  readonly query?: string | null;
  readonly coordinates?: Coordinate | readonly [number, number] | null;
  readonly level?: AddressLevel | null;
  readonly district?: string | null;
  readonly neighborhood?: string | null;
  readonly street?: string | null;
  readonly providerIds?: readonly string[];
  readonly limit?: number;
}

export interface NormalizedAddressResolutionRequest {
  readonly query: string;
  readonly canonicalQuery: string;
  readonly coordinates: Coordinate | null;
  readonly level: AddressLevel | null;
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly providerIds: readonly string[];
  readonly limit: number;
  readonly fingerprint: string;
}

export interface AddressResolutionExecutionContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly fingerprint: string;
}

export type AddressResolutionExecutor<TResult> = (
  request: NormalizedAddressResolutionRequest,
  context: AddressResolutionExecutionContext,
) => Promise<TResult> | TResult;

export interface AddressResolutionSessionOptions {
  readonly debounceMs?: number;
  readonly cacheSize?: number;
  readonly cacheTtlMs?: number;
  readonly historySize?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly clock?: () => number;
}

export interface AddressResolutionEnvelope<TResult> {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly result: TResult;
  readonly cacheHit: boolean;
  readonly elapsedMs: number;
  readonly stale: boolean;
}

export interface AddressResolutionState<TResult> {
  readonly version: string;
  readonly status: AddressResolutionStatus;
  readonly requestId: string | null;
  readonly fingerprint: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly result: TResult | null;
  readonly errorName: string | null;
  readonly cacheHit: boolean;
  readonly sequence: number;
}

export interface AddressResolutionHistoryEntry {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly status: Exclude<AddressResolutionStatus, 'idle' | 'scheduled' | 'running'>;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly cacheHit: boolean;
  readonly errorName: string | null;
}

export interface AddressResolutionSessionSnapshot {
  readonly status: AddressResolutionStatus;
  readonly sequence: number;
  readonly cacheEntries: number;
  readonly historyEntries: number;
  readonly hasScheduledRequest: boolean;
  readonly hasActiveRequest: boolean;
  readonly executions: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly aborts: number;
  readonly failures: number;
}

interface NormalizedSessionOptions {
  readonly debounceMs: number;
  readonly cacheSize: number;
  readonly cacheTtlMs: number;
  readonly historySize: number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly clock: () => number;
}

interface CacheEntry<TResult> {
  readonly expiresAt: number;
  readonly result: TResult;
}

interface ScheduledEntry<TResult> {
  readonly requestId: string;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveEntry<TResult> {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly promise: Promise<AddressResolutionEnvelope<TResult>>;
}

interface MutableStats {
  executions: number;
  cacheHits: number;
  cacheMisses: number;
  aborts: number;
  failures: number;
}

const normalizeLevel = (value: unknown): AddressLevel | null => {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'district'
    || normalized === 'neighborhood'
    || normalized === 'street'
    || normalized === 'building'
    || normalized === 'door'
    || normalized === 'address'
    ? normalized
    : null;
};

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const normalizeProviderIds = (values: readonly string[] | undefined): readonly string[] => Object.freeze(
  Array.from(new Set((values ?? [])
    .map(value => normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'en')),
);

const normalizeOptions = (options: AddressResolutionSessionOptions = {}): NormalizedSessionOptions => {
  const maxLimit = normalizeInteger(options.maxLimit, { min: 1, max: 1_000, fallback: 100 });
  return Object.freeze({
    debounceMs: normalizeInteger(options.debounceMs, { min: 0, max: 60_000, fallback: 180 }),
    cacheSize: normalizeInteger(options.cacheSize, { min: 1, max: 10_000, fallback: 128 }),
    cacheTtlMs: normalizeInteger(options.cacheTtlMs, { min: 1, max: 86_400_000, fallback: 300_000 }),
    historySize: normalizeInteger(options.historySize, { min: 0, max: 10_000, fallback: 64 }),
    defaultLimit: normalizeInteger(options.defaultLimit, { min: 1, max: maxLimit, fallback: 10 }),
    maxLimit,
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  });
};

export const normalizeAddressResolutionRequest = (
  request: AddressResolutionRequest,
  optionsInput: Pick<AddressResolutionSessionOptions, 'defaultLimit' | 'maxLimit'> = {},
): NormalizedAddressResolutionRequest => {
  const options = normalizeOptions(optionsInput);
  const query = normalizeText(request.query);
  const canonicalQuery = canonicalizeAddressText(query);
  const coordinates = request.coordinates ? normalizeCoordinates(request.coordinates) : null;
  if (!query && !coordinates) throw new TypeError('Address resolution requires a query or valid coordinates');
  if (request.coordinates && !coordinates) throw new TypeError('Address resolution coordinates are invalid');
  const normalized = {
    query,
    canonicalQuery,
    coordinates,
    level: normalizeLevel(request.level),
    district: canonicalizeAddressText(request.district),
    neighborhood: canonicalizeAddressText(request.neighborhood),
    street: canonicalizeAddressText(request.street),
    providerIds: normalizeProviderIds(request.providerIds),
    limit: normalizeInteger(request.limit, { min: 1, max: options.maxLimit, fallback: options.defaultLimit }),
  };
  const fingerprint = hashFingerprint(stableSerialize({
    version: ADDRESS_RESOLUTION_SESSION_VERSION,
    canonicalQuery: normalized.canonicalQuery,
    coordinates: normalized.coordinates,
    level: normalized.level,
    district: normalized.district,
    neighborhood: normalized.neighborhood,
    street: normalized.street,
    providerIds: normalized.providerIds,
    limit: normalized.limit,
  }));
  return Object.freeze({ ...normalized, fingerprint });
};

const initialState = <TResult>(): AddressResolutionState<TResult> => Object.freeze({
  version: ADDRESS_RESOLUTION_SESSION_VERSION,
  status: 'idle',
  requestId: null,
  fingerprint: null,
  startedAt: null,
  completedAt: null,
  result: null,
  errorName: null,
  cacheHit: false,
  sequence: 0,
});

const errorName = (error: unknown): string => error instanceof Error
  ? normalizeText(error.name || 'Error').slice(0, 80) || 'Error'
  : 'Error';
const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

export class AddressResolutionSession<TResult> {
  private readonly executor: AddressResolutionExecutor<TResult>;
  private readonly options: NormalizedSessionOptions;
  private readonly cache = new Map<string, CacheEntry<TResult>>();
  private readonly history: AddressResolutionHistoryEntry[] = [];
  private readonly stats: MutableStats = { executions: 0, cacheHits: 0, cacheMisses: 0, aborts: 0, failures: 0 };
  private state: AddressResolutionState<TResult> = initialState<TResult>();
  private scheduled: ScheduledEntry<TResult> | null = null;
  private active: ActiveEntry<TResult> | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(executor: AddressResolutionExecutor<TResult>, options: AddressResolutionSessionOptions = {}) {
    if (typeof executor !== 'function') throw new TypeError('Address resolution executor is required');
    this.executor = executor;
    this.options = normalizeOptions(options);
  }

  private now(): number { return safeNow(this.options.clock); }
  private nextRequestId(): string { this.sequence += 1; return `address-resolution-${this.sequence}`; }
  private assertActiveSession(): void { if (this.disposed) throw new Error('Address resolution session has been disposed'); }
  private setState(next: AddressResolutionState<TResult>): void { this.state = Object.freeze(next); }

  private pruneExpired(now: number): void {
    [...this.cache.entries()]
      .filter(([, entry]) => entry.expiresAt <= now)
      .map(([key]) => this.cache.delete(key));
  }

  private cacheGet(fingerprint: string, now: number): TResult | null {
    this.pruneExpired(now);
    const entry = this.cache.get(fingerprint);
    if (!entry) return null;
    this.cache.delete(fingerprint);
    this.cache.set(fingerprint, entry);
    return entry.result;
  }

  private cacheSet(fingerprint: string, result: TResult, now: number): void {
    this.pruneExpired(now);
    this.cache.delete(fingerprint);
    this.cache.set(fingerprint, Object.freeze({ expiresAt: now + this.options.cacheTtlMs, result }));
    if (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
  }

  private pushHistory(entry: AddressResolutionHistoryEntry): void {
    if (this.options.historySize <= 0) return;
    this.history.push(Object.freeze(entry));
    if (this.history.length > this.options.historySize) this.history.splice(0, this.history.length - this.options.historySize);
  }

  private cancelScheduled(reason = 'Address resolution schedule superseded'): void {
    const scheduled = this.scheduled;
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.scheduled = null;
    scheduled.reject(createAbortError(reason));
    this.stats.aborts += 1;
  }

  private cancelActive(reason = 'Address resolution request superseded'): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.controller.abort(reason);
  }

  private completeCached(requestId: string, request: NormalizedAddressResolutionRequest, result: TResult, startedAt: number): AddressResolutionEnvelope<TResult> {
    const completedAt = this.now();
    const envelope = Object.freeze({ requestId, fingerprint: request.fingerprint, result, cacheHit: true, elapsedMs: Math.max(0, completedAt - startedAt), stale: false });
    this.setState({ version: ADDRESS_RESOLUTION_SESSION_VERSION, status: 'success', requestId, fingerprint: request.fingerprint, startedAt, completedAt, result, errorName: null, cacheHit: true, sequence: this.sequence });
    this.pushHistory({ requestId, fingerprint: request.fingerprint, status: 'success', startedAt, completedAt, elapsedMs: envelope.elapsedMs, cacheHit: true, errorName: null });
    return envelope;
  }

  private execute(request: NormalizedAddressResolutionRequest, requestId: string, externalSignal?: AbortSignal | null): Promise<AddressResolutionEnvelope<TResult>> {
    throwIfAborted(externalSignal);
    const startedAt = this.now();
    const cached = this.cacheGet(request.fingerprint, startedAt);
    if (cached !== null) {
      this.stats.cacheHits += 1;
      return Promise.resolve(this.completeCached(requestId, request, cached, startedAt));
    }
    this.stats.cacheMisses += 1;
    this.stats.executions += 1;
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort('Address resolution caller aborted');
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    this.setState({ version: ADDRESS_RESOLUTION_SESSION_VERSION, status: 'running', requestId, fingerprint: request.fingerprint, startedAt, completedAt: null, result: null, errorName: null, cacheHit: false, sequence: this.sequence });
    const context: AddressResolutionExecutionContext = Object.freeze({ signal: controller.signal, requestId, fingerprint: request.fingerprint });
    const promise = Promise.resolve()
      .then(() => this.executor(request, context))
      .then(result => {
        throwIfAborted(controller.signal);
        const completedAt = this.now();
        const stale = this.state.requestId !== requestId;
        if (!stale) {
          this.cacheSet(request.fingerprint, result, completedAt);
          this.setState({ version: ADDRESS_RESOLUTION_SESSION_VERSION, status: 'success', requestId, fingerprint: request.fingerprint, startedAt, completedAt, result, errorName: null, cacheHit: false, sequence: this.sequence });
        }
        this.pushHistory({ requestId, fingerprint: request.fingerprint, status: 'success', startedAt, completedAt, elapsedMs: Math.max(0, completedAt - startedAt), cacheHit: false, errorName: null });
        return Object.freeze({ requestId, fingerprint: request.fingerprint, result, cacheHit: false, elapsedMs: Math.max(0, completedAt - startedAt), stale });
      })
      .catch(error => {
        const completedAt = this.now();
        const aborted = isAbortError(error) || controller.signal.aborted || externalSignal?.aborted === true;
        if (aborted) this.stats.aborts += 1;
        else this.stats.failures += 1;
        if (this.state.requestId === requestId) this.setState({ version: ADDRESS_RESOLUTION_SESSION_VERSION, status: aborted ? 'aborted' : 'error', requestId, fingerprint: request.fingerprint, startedAt, completedAt, result: null, errorName: aborted ? 'AbortError' : errorName(error), cacheHit: false, sequence: this.sequence });
        this.pushHistory({ requestId, fingerprint: request.fingerprint, status: aborted ? 'aborted' : 'error', startedAt, completedAt, elapsedMs: Math.max(0, completedAt - startedAt), cacheHit: false, errorName: aborted ? 'AbortError' : errorName(error) });
        if (aborted && !isAbortError(error)) throw createAbortError('Address resolution request aborted');
        throw error;
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', onExternalAbort);
        if (this.active?.requestId === requestId) this.active = null;
      });
    this.active = Object.freeze({ requestId, controller, promise });
    return promise;
  }

  resolveNow(requestInput: AddressResolutionRequest, options: { readonly signal?: AbortSignal | null; readonly bypassCache?: boolean } = {}): Promise<AddressResolutionEnvelope<TResult>> {
    this.assertActiveSession();
    this.cancelScheduled();
    const request = normalizeAddressResolutionRequest(requestInput, this.options);
    const requestId = this.nextRequestId();
    this.cancelActive();
    if (options.bypassCache) this.cache.delete(request.fingerprint);
    return this.execute(request, requestId, options.signal);
  }

  schedule(requestInput: AddressResolutionRequest, options: { readonly signal?: AbortSignal | null; readonly bypassCache?: boolean } = {}): Promise<AddressResolutionEnvelope<TResult>> {
    this.assertActiveSession();
    throwIfAborted(options.signal);
    this.cancelScheduled();
    const request = normalizeAddressResolutionRequest(requestInput, this.options);
    const requestId = this.nextRequestId();
    this.cancelActive();
    if (options.bypassCache) this.cache.delete(request.fingerprint);
    if (this.options.debounceMs === 0) return this.execute(request, requestId, options.signal);
    this.setState({ version: ADDRESS_RESOLUTION_SESSION_VERSION, status: 'scheduled', requestId, fingerprint: request.fingerprint, startedAt: null, completedAt: null, result: null, errorName: null, cacheHit: false, sequence: this.sequence });
    return new Promise<AddressResolutionEnvelope<TResult>>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.scheduled?.requestId !== requestId) return;
        clearTimeout(this.scheduled.timer);
        this.scheduled = null;
        this.stats.aborts += 1;
        reject(createAbortError('Scheduled address resolution aborted'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        if (this.scheduled?.requestId !== requestId) return;
        this.scheduled = null;
        options.signal?.removeEventListener('abort', onAbort);
        this.execute(request, requestId, options.signal).then(resolve, reject);
      }, this.options.debounceMs);
      this.scheduled = { requestId, reject, timer };
    });
  }

  invalidate(fingerprint?: string | null): number {
    if (fingerprint) return this.cache.delete(fingerprint) ? 1 : 0;
    const count = this.cache.size;
    this.cache.clear();
    return count;
  }

  getState(): AddressResolutionState<TResult> { return this.state; }
  getHistory(): readonly AddressResolutionHistoryEntry[] { return Object.freeze([...this.history]); }
  snapshot(): AddressResolutionSessionSnapshot {
    return Object.freeze({ status: this.state.status, sequence: this.sequence, cacheEntries: this.cache.size, historyEntries: this.history.length, hasScheduledRequest: this.scheduled !== null, hasActiveRequest: this.active !== null, executions: this.stats.executions, cacheHits: this.stats.cacheHits, cacheMisses: this.stats.cacheMisses, aborts: this.stats.aborts, failures: this.stats.failures });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduled('Address resolution session disposed');
    this.cancelActive('Address resolution session disposed');
    this.cache.clear();
  }
}

export const createAddressResolutionSession = <TResult>(executor: AddressResolutionExecutor<TResult>, options: AddressResolutionSessionOptions = {}): AddressResolutionSession<TResult> => new AddressResolutionSession(executor, options);
