/**
 * Enforce the RFC 6750 bearer-token alphabet before a value can enter browser
 * session storage or become an Authorization header.
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
  // Session setters receive unknown values; a Proxy or accessor may throw.
  // Fail closed without allowing a hostile object to interrupt logout/login.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    if (!Object.prototype.hasOwnProperty.call(value, 'accessToken')) return false;
    const token = (value as { readonly accessToken?: unknown }).accessToken;
    if (!isSafeBearerToken(token)) return false;
    const name = (value as { readonly userName?: unknown }).userName;
    return name === undefined || (typeof name === 'string' && name.length <= 512);
  } catch {
    return false;
  }
}
