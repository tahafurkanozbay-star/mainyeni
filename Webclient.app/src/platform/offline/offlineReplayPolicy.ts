export type OfflineReplayMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OfflineReplayCandidate {
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyBytes?: number;
  readonly createdAt?: number;
  readonly expiresAt?: number;
}

export interface OfflineReplayPolicyOptions {
  readonly origin: string;
  readonly allowedPathPrefixes?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly maxAgeMs?: number;
  readonly clock?: () => number;
}

export type OfflineReplayRejection =
  | 'invalid-url'
  | 'cross-origin'
  | 'unsafe-path'
  | 'unsafe-method'
  | 'sensitive-header'
  | 'body-budget'
  | 'invalid-time'
  | 'expired'
  | 'stale';

export interface OfflineReplayDecision {
  readonly allowed: boolean;
  readonly reason?: OfflineReplayRejection;
  readonly normalizedUrl?: string;
  readonly method?: OfflineReplayMethod;
}

export interface OfflineReplayPolicySnapshot {
  readonly evaluated: number;
  readonly allowed: number;
  readonly rejected: number;
  readonly lastRejection?: OfflineReplayRejection;
}

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);
const METHODS = new Set<OfflineReplayMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
};

const normalizePrefix = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    throw new TypeError('allowed path prefix must be an absolute same-origin path');
  }
  const url = new URL(trimmed, 'https://policy.invalid');
  if (url.origin !== 'https://policy.invalid' || url.username || url.password || url.hash) {
    throw new TypeError('allowed path prefix must not contain credentials or fragments');
  }
  return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
};

const normalizeOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('origin must use http or https');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('origin must not contain credentials, path, query or fragment');
  }
  return url.origin;
};

/**
 * Fail-closed admission boundary for durable mutation replay. This policy does
 * not perform network I/O and deliberately does not persist credentials. It is
 * intended to run immediately before a queued descriptor is converted into a
 * transport request.
 */
export class OfflineReplayPolicy {
  readonly origin: string;
  readonly maxBodyBytes: number;
  readonly maxAgeMs: number;
  readonly #allowedPathPrefixes: readonly string[];
  readonly #clock: () => number;
  #evaluated = 0;
  #allowed = 0;
  #rejected = 0;
  #lastRejection: OfflineReplayRejection | undefined;

  constructor(options: OfflineReplayPolicyOptions) {
    if (!options || typeof options.origin !== 'string') throw new TypeError('origin is required');
    this.origin = normalizeOrigin(options.origin);
    this.maxBodyBytes = boundedInteger('maxBodyBytes', options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 0, 8 * 1024 * 1024);
    this.maxAgeMs = boundedInteger('maxAgeMs', options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 1_000, 7 * 24 * 60 * 60 * 1000);
    this.#clock = options.clock ?? Date.now;
    const prefixes = options.allowedPathPrefixes ?? ['/api/'];
    if (prefixes.length === 0 || prefixes.length > 32) throw new RangeError('allowedPathPrefixes must contain between 1 and 32 entries');
    this.#allowedPathPrefixes = Object.freeze([...new Set(prefixes.map(normalizePrefix))]);
  }

  evaluate(candidate: OfflineReplayCandidate): Readonly<OfflineReplayDecision> {
    this.#evaluated += 1;
    let url: URL;
    try {
      url = new URL(candidate.url, this.origin);
    } catch {
      return this.#deny('invalid-url');
    }
    if (url.origin !== this.origin || url.username || url.password) return this.#deny('cross-origin');
    if (!this.#isAllowedPath(url.pathname)) return this.#deny('unsafe-path');

    const method = candidate.method.trim().toUpperCase() as OfflineReplayMethod;
    if (!METHODS.has(method)) return this.#deny('unsafe-method');
    if (this.#containsSensitiveHeader(candidate.headers)) return this.#deny('sensitive-header');

    const bodyBytes = candidate.bodyBytes ?? 0;
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > this.maxBodyBytes) return this.#deny('body-budget');

    const now = this.#clock();
    if (!Number.isFinite(now)) return this.#deny('invalid-time');
    if (candidate.createdAt !== undefined) {
      if (!Number.isFinite(candidate.createdAt) || candidate.createdAt > now) return this.#deny('invalid-time');
      if (now - candidate.createdAt > this.maxAgeMs) return this.#deny('stale');
    }
    if (candidate.expiresAt !== undefined) {
      if (!Number.isFinite(candidate.expiresAt)) return this.#deny('invalid-time');
      if (candidate.expiresAt <= now) return this.#deny('expired');
      if (candidate.createdAt !== undefined && candidate.expiresAt <= candidate.createdAt) return this.#deny('invalid-time');
    }

    this.#allowed += 1;
    return Object.freeze({ allowed: true, normalizedUrl: `${url.pathname}${url.search}`, method });
  }

  snapshot(): Readonly<OfflineReplayPolicySnapshot> {
    return Object.freeze({
      evaluated: this.#evaluated,
      allowed: this.#allowed,
      rejected: this.#rejected,
      ...(this.#lastRejection === undefined ? {} : { lastRejection: this.#lastRejection }),
    });
  }

  #isAllowedPath(pathname: string): boolean {
    const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
    return this.#allowedPathPrefixes.some(prefix => normalized.startsWith(prefix));
  }

  #containsSensitiveHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
    if (!headers) return false;
    for (const [name, value] of Object.entries(headers)) {
      const normalized = name.trim().toLowerCase();
      if (SENSITIVE_HEADERS.has(normalized)) return true;
      if (normalized === 'set-cookie' || normalized === 'proxy-authenticate' || normalized === 'www-authenticate') return true;
      if (typeof value !== 'string' || value.length > 8_192) return true;
    }
    return false;
  }

  #deny(reason: OfflineReplayRejection): Readonly<OfflineReplayDecision> {
    this.#rejected += 1;
    this.#lastRejection = reason;
    return Object.freeze({ allowed: false, reason });
  }
}
