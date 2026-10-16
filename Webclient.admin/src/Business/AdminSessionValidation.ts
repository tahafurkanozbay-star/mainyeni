/**
 * Enforce the RFC 6750 bearer-token alphabet before a value can enter volatile
 * Admin session memory or become an Authorization header.
 *
 * This is a syntactic boundary only: the API must still verify signatures,
 * issuer, audience, lifetime and access permissions on every request.
 */
export interface ValidAdminSession {
  readonly accessToken: string;
  readonly userName?: string;
  readonly [key: string]: unknown;
}

const MAX_BEARER_LENGTH = 8_192;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;

export function isSafeBearerToken(token: unknown): token is string {
  return typeof token === 'string'
    && token.length > 0
    && token.length <= MAX_BEARER_LENGTH
    && BEARER_TOKEN.test(token);
}

/**
 * Read untrusted response properties only through own data descriptors.
 * A Proxy can return a validated descriptor yet return a different value from
 * ordinary property access. Return an immutable, validated snapshot rather than
 * reading the source object again after validation.
 */
export function snapshotValidAdminSession(value: unknown): ValidAdminSession | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const bearer = Object.getOwnPropertyDescriptor(value, 'accessToken');
    if (!bearer || !('value' in bearer) || !isSafeBearerToken(bearer.value)) return null;
    const name = Object.getOwnPropertyDescriptor(value, 'userName');
    if (name && !('value' in name)) return null;
    const userName = name?.value;
    if (userName !== undefined && (typeof userName !== 'string' || userName.length > 512)) {
      return null;
    }
    return Object.freeze({
      accessToken: bearer.value,
      ...(userName === undefined ? {} : { userName }),
    });
  } catch {
    // Proxy traps and revoked proxies must fail closed without throwing out of
    // the authentication boundary.
    return null;
  }
}

/** Boolean compatibility check; consumers must use the validated snapshot. */
export function isValidAdminSession(value: unknown): boolean {
  return snapshotValidAdminSession(value) !== null;
}
