import type { GuardrailReason, UrlBoundaryPolicy, UrlBoundaryResult } from './contracts';
import { evaluateTextBoundary } from './textBoundary';

export const DEFAULT_URL_BOUNDARY_POLICY: UrlBoundaryPolicy = Object.freeze({
  allowedProtocols: Object.freeze(['https:', 'http:']),
  allowedOrigins: Object.freeze([]),
  allowedHosts: Object.freeze([]),
  blockedHosts: Object.freeze([]),
  allowedPorts: Object.freeze(['', '80', '443']),
  allowRelative: true,
  allowFragments: false,
  allowLocalNetworkTargets: false,
  requireHttpsForExternal: true,
  maxUrlLength: 8_192,
  maxPathLength: 4_096,
  maxPathSegments: 128,
  maxQueryLength: 4_096,
  maxQueryParameters: 128,
  maxFragmentLength: 512,
});

const reason = (
  code: string,
  message: string,
  severity: GuardrailReason['severity'] = 'error',
): GuardrailReason => Object.freeze({ code, message, severity });

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

const normalizeProtocol = (value: string): string => {
  const lower = value.trim().toLowerCase();
  return lower.length > 0 && !lower.endsWith(':') ? lower + ':' : lower;
};

const normalizeStringSet = (values: readonly string[]): readonly string[] =>
  Object.freeze([
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ]);

export const normalizeUrlBoundaryPolicy = (
  input: Partial<UrlBoundaryPolicy> = {},
): UrlBoundaryPolicy => {
  const baseUrl = input.baseUrl?.trim();
  return Object.freeze({
    allowedProtocols: Object.freeze(
      (input.allowedProtocols ?? DEFAULT_URL_BOUNDARY_POLICY.allowedProtocols)
        .map(normalizeProtocol),
    ),
    allowedOrigins: normalizeStringSet(
      input.allowedOrigins ?? DEFAULT_URL_BOUNDARY_POLICY.allowedOrigins,
    ),
    allowedHosts: normalizeStringSet(
      input.allowedHosts ?? DEFAULT_URL_BOUNDARY_POLICY.allowedHosts,
    ),
    blockedHosts: normalizeStringSet(
      input.blockedHosts ?? DEFAULT_URL_BOUNDARY_POLICY.blockedHosts,
    ),
    allowedPorts: normalizeStringSet(
      input.allowedPorts ?? DEFAULT_URL_BOUNDARY_POLICY.allowedPorts,
    ),
    allowRelative: input.allowRelative ?? DEFAULT_URL_BOUNDARY_POLICY.allowRelative,
    allowFragments: input.allowFragments ?? DEFAULT_URL_BOUNDARY_POLICY.allowFragments,
    allowLocalNetworkTargets:
      input.allowLocalNetworkTargets ?? DEFAULT_URL_BOUNDARY_POLICY.allowLocalNetworkTargets,
    requireHttpsForExternal:
      input.requireHttpsForExternal ?? DEFAULT_URL_BOUNDARY_POLICY.requireHttpsForExternal,
    maxUrlLength: positiveInt(
      input.maxUrlLength ?? DEFAULT_URL_BOUNDARY_POLICY.maxUrlLength,
      DEFAULT_URL_BOUNDARY_POLICY.maxUrlLength,
    ),
    maxPathLength: positiveInt(
      input.maxPathLength ?? DEFAULT_URL_BOUNDARY_POLICY.maxPathLength,
      DEFAULT_URL_BOUNDARY_POLICY.maxPathLength,
    ),
    maxPathSegments: positiveInt(
      input.maxPathSegments ?? DEFAULT_URL_BOUNDARY_POLICY.maxPathSegments,
      DEFAULT_URL_BOUNDARY_POLICY.maxPathSegments,
    ),
    maxQueryLength: positiveInt(
      input.maxQueryLength ?? DEFAULT_URL_BOUNDARY_POLICY.maxQueryLength,
      DEFAULT_URL_BOUNDARY_POLICY.maxQueryLength,
    ),
    maxQueryParameters: positiveInt(
      input.maxQueryParameters ?? DEFAULT_URL_BOUNDARY_POLICY.maxQueryParameters,
      DEFAULT_URL_BOUNDARY_POLICY.maxQueryParameters,
    ),
    maxFragmentLength: positiveInt(
      input.maxFragmentLength ?? DEFAULT_URL_BOUNDARY_POLICY.maxFragmentLength,
      DEFAULT_URL_BOUNDARY_POLICY.maxFragmentLength,
    ),
    ...(baseUrl ? { baseUrl } : {}),
  });
};

const isRelativeInput = (value: string): boolean => {
  if (value.startsWith('//')) return false;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
};

const parseIpv4 = (hostname: string): readonly number[] | null => {
  const pieces = hostname.split('.');
  if (pieces.length !== 4) return null;
  const result: number[] = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/u.test(piece)) return null;
    const value = Number(piece);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    result.push(value);
  }
  return result;
};

const isLocalIpv4 = (parts: readonly number[]): boolean => {
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
};

const stripIpv6Brackets = (value: string): string =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

const isLocalIpv6 = (hostname: string): boolean => {
  const value = stripIpv6Brackets(hostname).toLowerCase();
  if (!value.includes(':')) return false;
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb')
  ) return true;
  if (value.startsWith('ff')) return true;
  return false;
};

export const isLocalNetworkHostname = (input: string): boolean => {
  const hostname = input.trim().toLowerCase().replace(/\.$/u, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isLocalIpv4(ipv4)) return true;
  return isLocalIpv6(hostname);
};

const hostMatches = (hostname: string, patterns: readonly string[]): boolean => {
  const normalized = hostname.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === pattern;
  });
};

const resolveBase = (policy: UrlBoundaryPolicy): URL | null => {
  if (!policy.baseUrl) return null;
  try {
    return new URL(policy.baseUrl);
  } catch {
    return null;
  }
};

export const evaluateUrlBoundary = (
  input: unknown,
  policyInput: Partial<UrlBoundaryPolicy> = {},
): UrlBoundaryResult => {
  const policy = normalizeUrlBoundaryPolicy(policyInput);
  const text = evaluateTextBoundary(input, {
    maxCodeUnits: policy.maxUrlLength,
    maxUtf8Bytes: policy.maxUrlLength * 4,
    rejectControlCharacters: true,
    rejectBidiControls: true,
    stripInvisibleFormatting: false,
    trim: true,
    normalizeUnicode: false,
  });
  const reasons = [...text.reasons];
  const value = text.value;
  const relative = isRelativeInput(value);
  const base = resolveBase(policy);

  if (relative && !policy.allowRelative) {
    reasons.push(reason('relative-url-not-allowed', 'Relative URLs are not allowed by policy.'));
  }

  let parsed: URL | null = null;
  try {
    if (relative) {
      if (base) parsed = new URL(value, base);
      else reasons.push(reason('missing-base-url', 'A base URL is required for relative input.'));
    } else {
      parsed = new URL(value);
    }
  } catch {
    reasons.push(reason('invalid-url', 'URL parsing failed.'));
  }

  if (!parsed) {
    return Object.freeze({
      input: value,
      normalizedUrl: null,
      origin: null,
      protocol: null,
      hostname: null,
      port: null,
      relative,
      sameOrigin: false,
      localNetworkTarget: false,
      decision: 'deny',
      reasons: Object.freeze(reasons),
    });
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const origin = parsed.origin.toLowerCase();
  const sameOrigin = Boolean(base && parsed.origin === base.origin);
  const localNetworkTarget = isLocalNetworkHostname(hostname);

  if (!policy.allowedProtocols.map(normalizeProtocol).includes(protocol)) {
    reasons.push(reason('unsupported-protocol', 'URL protocol is not allowed.'));
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reasons.push(reason('url-userinfo-not-allowed', 'URL user information is not allowed.'));
  }

  if (!policy.allowedPorts.includes(parsed.port)) {
    reasons.push(reason('port-not-allowed', 'URL port is not allowed.'));
  }

  if (hostMatches(hostname, policy.blockedHosts)) {
    reasons.push(reason('host-not-allowed', 'URL host is explicitly blocked.'));
  }

  if (localNetworkTarget && !policy.allowLocalNetworkTargets) {
    reasons.push(reason('local-network-target', 'Literal local-network targets are not allowed.'));
  }

  const external = base ? parsed.origin !== base.origin : true;

  if (external && policy.requireHttpsForExternal && protocol !== 'https:') {
    reasons.push(reason('external-https-required', 'External URLs must use HTTPS.'));
  }

  if (
    external &&
    policy.allowedOrigins.length > 0 &&
    !policy.allowedOrigins.includes(origin)
  ) {
    reasons.push(reason('origin-not-allowed', 'URL origin is not explicitly allowed.'));
  }

  if (
    external &&
    policy.allowedHosts.length > 0 &&
    !hostMatches(hostname, policy.allowedHosts)
  ) {
    reasons.push(reason('host-not-allowed', 'URL host is not explicitly allowed.'));
  }

  if (!policy.allowFragments && parsed.hash.length > 0) {
    reasons.push(reason('fragment-not-allowed', 'URL fragments are not allowed.'));
  }

  if (parsed.hash.length > policy.maxFragmentLength + 1) {
    reasons.push(reason('fragment-too-long', 'URL fragment exceeds the configured budget.'));
  }

  if (parsed.pathname.length > policy.maxPathLength) {
    reasons.push(reason('path-too-long', 'URL path exceeds the configured budget.'));
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length > policy.maxPathSegments) {
    reasons.push(reason('path-too-deep', 'URL path contains too many segments.'));
  }

  if (parsed.search.length > policy.maxQueryLength + 1) {
    reasons.push(reason('query-too-large', 'URL query exceeds the configured budget.'));
  }

  let queryCount = 0;
  parsed.searchParams.forEach(() => {
    queryCount += 1;
  });
  if (queryCount > policy.maxQueryParameters) {
    reasons.push(reason('too-many-query-parameters', 'URL contains too many query parameters.'));
  }

  if (parsed.href.length > policy.maxUrlLength) {
    reasons.push(reason('input-too-long', 'Normalized URL exceeds the configured budget.'));
  }

  const denied = reasons.some(
    (entry) => entry.severity === 'error' || entry.severity === 'critical',
  );

  return Object.freeze({
    input: value,
    normalizedUrl: parsed.href,
    origin,
    protocol,
    hostname,
    port: parsed.port,
    relative,
    sameOrigin,
    localNetworkTarget,
    decision: denied ? 'deny' : text.changed ? 'normalize' : 'allow',
    reasons: Object.freeze(reasons),
  });
};

export const sameOrigin = (input: string, baseUrl: string): boolean => {
  try {
    const base = new URL(baseUrl);
    return new URL(input, base).origin === base.origin;
  } catch {
    return false;
  }
};
