export type OfflineCacheDecisionReason =
  | 'admit'
  | 'unsupported-method'
  | 'cross-origin'
  | 'sensitive-request'
  | 'sensitive-response'
  | 'uncacheable-status'
  | 'uncacheable-directive'
  | 'oversized-response'
  | 'unsupported-content-type'
  | 'expired';

export interface OfflineCachePolicyOptions {
  readonly origin: string;
  readonly maxEntryBytes?: number;
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly allowedPathPrefixes?: readonly string[];
  readonly allowedContentTypes?: readonly string[];
  readonly historyLimit?: number;
  readonly clock?: () => number;
}

export interface OfflineCacheRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OfflineCacheResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly sizeBytes?: number;
}

export interface OfflineCacheDecision {
  readonly admitted: boolean;
  readonly reason: OfflineCacheDecisionReason;
  readonly key?: string;
  readonly expiresAt?: number;
}

export interface OfflineCacheEntry {
  readonly key: string;
  readonly url: string;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly sizeBytes: number;
  readonly lastAccessedAt: number;
  readonly hits: number;
}

export interface OfflineCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly evicted: number;
  readonly expired: number;
}

export interface OfflineCacheEvent {
  readonly sequence: number;
  readonly at: number;
  readonly type: 'admitted' | 'rejected' | 'evicted' | 'expired' | 'hit' | 'miss';
  readonly reason?: OfflineCacheDecisionReason;
  readonly key?: string;
}

const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const normalizeOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('origin must contain only scheme and authority');
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError('offline cache origin must use HTTPS');
  return url.origin;
};

const normalizePrefix = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) throw new TypeError('cache path prefix must be an absolute same-origin path');
  const url = new URL(value, 'https://offline.invalid');
  if (url.origin !== 'https://offline.invalid') throw new TypeError('cache path prefix must remain same-origin');
  return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
};

const normalizeHeaders = (headers: Readonly<Record<string, string>> | undefined): ReadonlyMap<string, string> => {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) normalized.set(name.trim().toLowerCase(), value.trim());
  return normalized;
};

const parseCacheControl = (value: string | undefined): ReadonlyMap<string, string | true> => {
  const directives = new Map<string, string | true>();
  for (const raw of value?.split(',') ?? []) {
    const [rawName, ...rest] = raw.trim().split('=');
    const name = rawName?.toLowerCase();
    if (!name) continue;
    const joined = rest.join('=').trim();
    directives.set(name, joined ? joined.replace(/^"|"$/g, '') : true);
  }
  return directives;
};

const parseMaxAgeMs = (directives: ReadonlyMap<string, string | true>): number | undefined => {
  const raw = directives.get('s-maxage') ?? directives.get('max-age');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return seconds * 1000;
};

const hasSensitiveRequestHeaders = (headers: ReadonlyMap<string, string>): boolean =>
  headers.has('authorization') || headers.has('proxy-authorization') || headers.has('cookie') || headers.has('x-api-key');

const hasSensitiveResponseHeaders = (headers: ReadonlyMap<string, string>): boolean =>
  headers.has('set-cookie') || headers.has('set-cookie2') || headers.get('vary')?.split(',').some(value => value.trim() === '*') === true;

export class OfflineCachePolicy {
  readonly origin: string;
  readonly maxEntryBytes: number;
  readonly maxEntries: number;
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly allowedPathPrefixes: readonly string[];
  readonly allowedContentTypes: readonly string[];
  readonly historyLimit: number;
  readonly #clock: () => number;
  readonly #entries = new Map<string, OfflineCacheEntry>();
  readonly #history: OfflineCacheEvent[] = [];
  #sequence = 0;
  #admitted = 0;
  #rejected = 0;
  #evicted = 0;
  #expired = 0;

  constructor(options: OfflineCachePolicyOptions) {
    if (!options?.origin) throw new TypeError('origin is required');
    this.origin = normalizeOrigin(options.origin);
    this.maxEntryBytes = boundedInteger('maxEntryBytes', options.maxEntryBytes ?? 2 * 1024 * 1024, 1024, 32 * 1024 * 1024);
    this.maxEntries = boundedInteger('maxEntries', options.maxEntries ?? 128, 1, 4096);
    this.defaultTtlMs = boundedInteger('defaultTtlMs', options.defaultTtlMs ?? 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
    this.maxTtlMs = boundedInteger('maxTtlMs', options.maxTtlMs ?? 24 * 60 * 60 * 1000, this.defaultTtlMs, 7 * 24 * 60 * 60 * 1000);
    this.allowedPathPrefixes = Object.freeze((options.allowedPathPrefixes ?? ['/assets/', '/static/']).map(normalizePrefix));
    this.allowedContentTypes = Object.freeze((options.allowedContentTypes ?? ['application/json', 'image/', 'font/', 'text/css', 'text/javascript', 'application/javascript']).map(value => value.toLowerCase()));
    this.historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 96, 0, 2048);
    this.#clock = options.clock ?? Date.now;
  }

  evaluate(request: OfflineCacheRequest, response: OfflineCacheResponse): Readonly<OfflineCacheDecision> {
    const now = this.#clock();
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return this.#reject('unsupported-method');
    let url: URL;
    try { url = new URL(request.url, this.origin); } catch { return this.#reject('cross-origin'); }
    if (url.origin !== this.origin || url.username || url.password) return this.#reject('cross-origin');
    if (!this.#pathAllowed(url.pathname)) return this.#reject('cross-origin');
    const requestHeaders = normalizeHeaders(request.headers);
    if (hasSensitiveRequestHeaders(requestHeaders)) return this.#reject('sensitive-request');
    const responseHeaders = normalizeHeaders(response.headers);
    if (hasSensitiveResponseHeaders(responseHeaders)) return this.#reject('sensitive-response');
    if (response.status !== 200) return this.#reject('uncacheable-status');
    const directives = parseCacheControl(responseHeaders.get('cache-control'));
    if (directives.has('no-store') || directives.has('private')) return this.#reject('uncacheable-directive');
    const sizeBytes = response.sizeBytes ?? this.#contentLength(responseHeaders);
    if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > this.maxEntryBytes) return this.#reject('oversized-response');
    const contentType = responseHeaders.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!contentType || !this.allowedContentTypes.some(allowed => allowed.endsWith('/') ? contentType.startsWith(allowed) : contentType === allowed)) return this.#reject('unsupported-content-type');
    const maxAgeMs = parseMaxAgeMs(directives);
    if (maxAgeMs === 0) return this.#reject('expired');
    const ttl = Math.min(maxAgeMs ?? this.defaultTtlMs, this.maxTtlMs);
    const key = `${method}:${url.pathname}${url.search}`;
    return Object.freeze({ admitted: true, reason: 'admit', key, expiresAt: now + ttl });
  }

  admit(request: OfflineCacheRequest, response: OfflineCacheResponse): Readonly<OfflineCacheDecision> {
    const decision = this.evaluate(request, response);
    if (!decision.admitted || !decision.key || decision.expiresAt === undefined) return decision;
    const now = this.#clock();
    const url = new URL(request.url, this.origin);
    const headers = normalizeHeaders(response.headers);
    const sizeBytes = response.sizeBytes ?? this.#contentLength(headers) ?? 0;
    const existing = this.#entries.get(decision.key);
    const entry: OfflineCacheEntry = Object.freeze({ key: decision.key, url: `${url.pathname}${url.search}`, storedAt: now, expiresAt: decision.expiresAt, sizeBytes, lastAccessedAt: now, hits: existing?.hits ?? 0 });
    this.#entries.set(entry.key, entry);
    this.#admitted += 1;
    this.#record('admitted', 'admit', entry.key);
    this.#prune(now);
    this.#enforceEntryBudget();
    return decision;
  }

  access(key: string): Readonly<OfflineCacheEntry> | undefined {
    const now = this.#clock();
    const entry = this.#entries.get(key);
    if (!entry) { this.#record('miss', undefined, key); return undefined; }
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      this.#expired += 1;
      this.#record('expired', 'expired', key);
      return undefined;
    }
    const updated = Object.freeze({ ...entry, lastAccessedAt: now, hits: entry.hits + 1 });
    this.#entries.set(key, updated);
    this.#record('hit', undefined, key);
    return updated;
  }

  remove(key: string): boolean { return this.#entries.delete(key); }

  prune(): number { return this.#prune(this.#clock()); }

  snapshot(): Readonly<OfflineCacheSnapshot> {
    let bytes = 0;
    for (const entry of this.#entries.values()) bytes += entry.sizeBytes;
    return Object.freeze({ entries: this.#entries.size, bytes, admitted: this.#admitted, rejected: this.#rejected, evicted: this.#evicted, expired: this.#expired });
  }

  entries(): readonly Readonly<OfflineCacheEntry>[] {
    return Object.freeze(Array.from(this.#entries.values()).sort((a, b) => a.expiresAt - b.expiresAt || a.key.localeCompare(b.key)));
  }

  history(): readonly Readonly<OfflineCacheEvent>[] { return Object.freeze(this.#history.map(event => Object.freeze({ ...event }))); }

  #pathAllowed(pathname: string): boolean {
    for (const prefix of this.allowedPathPrefixes) {
      const root = prefix.slice(0, -1);
      if (pathname === root || pathname.startsWith(prefix)) return true;
    }
    return false;
  }

  #contentLength(headers: ReadonlyMap<string, string>): number | undefined {
    const raw = headers.get('content-length');
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  }

  #reject(reason: Exclude<OfflineCacheDecisionReason, 'admit'>): Readonly<OfflineCacheDecision> {
    this.#rejected += 1;
    this.#record('rejected', reason);
    return Object.freeze({ admitted: false, reason });
  }

  #prune(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) { this.#entries.delete(key); this.#expired += 1; removed += 1; this.#record('expired', 'expired', key); }
    }
    return removed;
  }

  #enforceEntryBudget(): void {
    while (this.#entries.size > this.maxEntries) {
      let candidate: OfflineCacheEntry | undefined;
      for (const entry of this.#entries.values()) {
        if (!candidate || entry.lastAccessedAt < candidate.lastAccessedAt || (entry.lastAccessedAt === candidate.lastAccessedAt && entry.storedAt < candidate.storedAt) || (entry.lastAccessedAt === candidate.lastAccessedAt && entry.storedAt === candidate.storedAt && entry.key.localeCompare(candidate.key) < 0)) candidate = entry;
      }
      if (!candidate) return;
      this.#entries.delete(candidate.key);
      this.#evicted += 1;
      this.#record('evicted', undefined, candidate.key);
    }
  }

  #record(type: OfflineCacheEvent['type'], reason?: OfflineCacheDecisionReason, key?: string): void {
    if (this.historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at: this.#clock(), type, ...(reason ? { reason } : {}), ...(key ? { key: key.slice(0, 256) } : {}) }));
    if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit);
  }
}
