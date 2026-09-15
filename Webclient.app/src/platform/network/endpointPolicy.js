const ARC_GIS_PATHS = /(?:\/rest\/services\/|\/MapServer(?:\/|$)|\/FeatureServer(?:\/|$))/i;
const BLOCKED_SERVICE_TYPES = new Set(['wms', 'wfs', 'wmts']);

const parseUrl = (value) => {
  try {
    return new URL(value, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  } catch (error) {
    return null;
  }
};

export const classifyEndpoint = (endpoint) => {
  const url = parseUrl(endpoint);
  if (!url) return { allowed: false, reason: 'invalid-url', kind: 'invalid' };

  const sameOrigin = typeof window === 'undefined' || url.origin === window.location.origin;
  if (sameOrigin) return { allowed: true, reason: 'same-origin', kind: 'same-origin' };
  if (ARC_GIS_PATHS.test(url.pathname)) return { allowed: true, reason: 'approved-arcgis-rest', kind: 'arcgis-rest' };
  return { allowed: false, reason: 'unapproved-cross-origin', kind: 'cross-origin' };
};

export const assertEndpointAllowed = (endpoint, { serviceType } = {}) => {
  if (serviceType && BLOCKED_SERVICE_TYPES.has(String(serviceType).toLowerCase())) {
    const error = new Error(`GIS service type ${serviceType} is not allowed by project policy`);
    error.code = 'BLOCKED_SERVICE_TYPE';
    throw error;
  }
  const result = classifyEndpoint(endpoint);
  if (!result.allowed) {
    const error = new Error(`Network endpoint is not allowed: ${result.reason}`);
    error.code = 'UNAPPROVED_ENDPOINT';
    error.reason = result.reason;
    throw error;
  }
  return result;
};

export const redactEndpoint = (endpoint) => {
  const url = parseUrl(endpoint);
  if (!url) return '<invalid-endpoint>';
  for (const key of ['token', 'key', 'api_key', 'apikey', 'password', 'secret', 'access_token']) {
    url.searchParams.delete(key);
  }
  return url.toString();
};

export const networkPolicy = Object.freeze({
  browserDefault: 'same-origin',
  approvedCrossOrigin: ['ArcGIS REST services only when directly required by the existing GIS runtime'],
  blockedServiceTypes: Array.from(BLOCKED_SERVICE_TYPES),
  secretsInQuery: false,
  analyticsByDefault: false,
  remoteFontsByDefault: false,
  genericProxyRule: 'Prefer server-side BFF/proxy when credentials, privileged data, filtering, aggregation or authorization is required.',
});
