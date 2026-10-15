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

/** Reject inherited accessors and array-like payloads at the login boundary. */
export function isValidAdminSession(value: unknown): value is ValidAdminSession {
  // Inspect only data descriptors: hostile accessors must never execute.
  // A proxy may throw from descriptor traps, so fail closed.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const bearer = Object.getOwnPropertyDescriptor(value, 'accessToken');
    if (!bearer || !('value' in bearer) || !isSafeBearerToken(bearer.value)) return false;
    const name = Object.getOwnPropertyDescriptor(value, 'userName');
    if (name && !('value' in name)) return false;
    return name === undefined || name.value === undefined
      || (typeof name.value === 'string' && name.value.length <= 512);
  } catch {
    return false;
  }
}
