import { hasSameOrigin } from './serviceCatalog';

const GISSRV_HOST_RE = /^[a-z0-9-]+\.gissrv\.org$/i;

export const parseGisUrl = (value) => {
  if (!value) return null;
  try {
    return new URL(String(value), typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  } catch (_) {
    return null;
  }
};

export const isServerOwnedProxyUrl = (value) => {
  const url = parseGisUrl(value);
  return Boolean(url && (hasSameOrigin(url.toString()) || GISSRV_HOST_RE.test(url.hostname)));
};

export const assertBrowserGisEndpoint = (value, options = {}) => {
  const url = parseGisUrl(value);
  if (!url) throw new Error('Invalid GIS endpoint.');
  if (isServerOwnedProxyUrl(url.toString())) return url.toString();
  if (options.allowConfiguredRemote === true) return url.toString();
  throw Object.assign(new Error('Direct remote GIS endpoint is blocked; use the server-owned GIS proxy.'), {
    code: 'DIRECT_REMOTE_GIS_BLOCKED',
    hostname: url.hostname,
  });
};

export const createRequestPolicy = (options = {}) => Object.freeze({
  timeoutMs: Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : 15000,
  cacheTtlMs: Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs) : 15000,
  allowConfiguredRemote: options.allowConfiguredRemote === true,
  sameOriginRequired: options.sameOriginRequired !== false,
});
