import { AppError } from '../errors/appError';

export interface EndpointPolicyOptions {
  readonly allowQuery?: boolean;
  readonly allowHash?: boolean;
  readonly maxLength?: number;
  readonly allowedPrefixes?: readonly string[];
}

const DEFAULT_MAX_LENGTH = 2048;

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const containsEncodedBackslash = (value: string): boolean => /%5c/i.test(value);
const containsEncodedControl = (value: string): boolean => /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value);
const hasScheme = (value: string): boolean => /^[a-z][a-z\d+.-]*:/i.test(value);

const endpointError = (message: string, details?: Readonly<Record<string, unknown>>): AppError =>
  new AppError(message, {
    code: 'CROSS_ORIGIN_BLOCKED',
    retryable: false,
    details,
  });

export const isSameOriginPath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DEFAULT_MAX_LENGTH) return false;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return false;
  if (trimmed.includes('\\') || containsEncodedBackslash(trimmed)) return false;
  if (containsControlCharacter(trimmed) || containsEncodedControl(trimmed)) return false;
  if (hasScheme(trimmed)) return false;
  return true;
};

export const assertApplicationEndpoint = (
  value: unknown,
  options: EndpointPolicyOptions = {},
): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const maxLength = Math.max(64, Math.min(8192, Math.trunc(Number(options.maxLength) || DEFAULT_MAX_LENGTH)));
  if (!isSameOriginPath(raw) || raw.length > maxLength) {
    throw endpointError('Cross-origin application endpoint is blocked.', { reason: 'invalid-path' });
  }
  if (options.allowQuery === false && raw.includes('?')) {
    throw endpointError('Application endpoint query string is blocked.', { reason: 'query-disallowed' });
  }
  if (options.allowHash === false && raw.includes('#')) {
    throw endpointError('Application endpoint fragment is blocked.', { reason: 'hash-disallowed' });
  }
  if (options.allowedPrefixes?.length) {
    const path = raw.split(/[?#]/, 1)[0] ?? raw;
    const allowed = options.allowedPrefixes.some((prefix) => {
      const normalized = normalizeApplicationPath(prefix, { allowQuery: false, allowHash: false });
      return path === normalized || path.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`);
    });
    if (!allowed) throw endpointError('Application endpoint is outside the allowed path scope.', { reason: 'prefix-disallowed' });
  }
  return raw;
};

const normalizeSegments = (pathname: string): string => {
  const output: string[] = [];
  for (const rawSegment of pathname.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    if (rawSegment === '..') {
      output.pop();
      continue;
    }
    output.push(rawSegment);
  }
  return `/${output.join('/')}`;
};

export const normalizeApplicationPath = (
  value: unknown,
  options: EndpointPolicyOptions = {},
): string => {
  const raw = String(value || '').trim();
  if (!raw) return '/';

  if (containsControlCharacter(raw) || containsEncodedControl(raw) || raw.includes('\\') || containsEncodedBackslash(raw)) {
    return assertApplicationEndpoint(raw, options);
  }
  if (hasScheme(raw) || raw.startsWith('//')) return assertApplicationEndpoint(raw, options);

  const hashIndex = raw.indexOf('#');
  const queryIndex = raw.indexOf('?');
  const cutIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const pathEnd = cutIndexes.length ? Math.min(...cutIndexes) : raw.length;
  const pathPart = raw.slice(0, pathEnd);
  const suffix = raw.slice(pathEnd);
  const path = normalizeSegments(`/${pathPart.replace(/^\/+/, '')}`);
  return assertApplicationEndpoint(`${path || '/'}${suffix}`, options);
};

export const joinApplicationPath = (
  base: unknown,
  ...segments: readonly unknown[]
): string => {
  const normalizedBase = normalizeApplicationPath(base, { allowQuery: false, allowHash: false });
  const cleanBase = normalizedBase === '/' ? '' : normalizedBase.replace(/\/$/, '');
  const cleanSegments = segments
    .map((segment) => String(segment ?? '').trim())
    .filter(Boolean)
    .map((segment) => {
      if (containsControlCharacter(segment) || segment.includes('\\') || hasScheme(segment) || segment.startsWith('//')) {
        throw endpointError('Application path segment is unsafe.', { reason: 'unsafe-segment' });
      }
      return segment.replace(/^\/+|\/+$/g, '');
    })
    .filter(Boolean);
  return normalizeApplicationPath(`${cleanBase}/${cleanSegments.join('/')}` || '/');
};

export const withApplicationQuery = (
  pathValue: unknown,
  params: Readonly<Record<string, unknown>>,
): string => {
  const path = normalizeApplicationPath(pathValue, { allowQuery: false, allowHash: false });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null) search.append(key, String(item));
      });
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? assertApplicationEndpoint(`${path}?${encoded}`) : path;
};

export const stripApplicationQuery = (value: unknown): string => {
  const path = normalizeApplicationPath(value);
  const index = path.search(/[?#]/);
  return index >= 0 ? path.slice(0, index) || '/' : path;
};

export const endpointFingerprint = (value: unknown): string => {
  const path = stripApplicationQuery(value).toLowerCase();
  let hash = 5381;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) + hash) ^ path.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
