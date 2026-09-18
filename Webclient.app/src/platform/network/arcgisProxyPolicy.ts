import { runtimeConfig } from '../config/runtimeConfig';
import type { ConfigurationService } from '../bootstrap/bootstrapCore';

export type ArcgisProxyRegistrationStatus =
  | 'registered'
  | 'duplicate'
  | 'same-origin';

export interface ArcgisProxyRule {
  readonly urlPrefix: string;
  readonly proxyUrl: string;
}

export interface ArcgisProxyAdapter {
  readonly addProxyRule: (rule: ArcgisProxyRule) => void;
}

export interface ArcgisProxyPolicyOptions {
  readonly apiBaseUrl?: string;
  readonly origin?: string | null;
  readonly loadAdapter?: () => Promise<ArcgisProxyAdapter>;
}

export interface ArcgisProxyRegistration {
  readonly status: ArcgisProxyRegistrationStatus;
  readonly proxied: boolean;
}

export interface ArcgisProxyPolicySnapshot {
  readonly registeredRuleCount: number;
  readonly adapterLoaded: boolean;
}

export interface ArcgisProxyPolicy {
  readonly register: (serviceUrl: string) => Promise<ArcgisProxyRegistration>;
  readonly snapshot: () => ArcgisProxyPolicySnapshot;
  readonly clear: () => void;
}

export class ArcgisProxyPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArcgisProxyPolicyError';
    this.code = code;
  }
}

const SERVICE_URL_KEYS = Object.freeze(['eg', 'Eg', 'url', 'Url'] as const);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;

const normalizeOrigin = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

const browserOrigin = (): string | null => {
  if (typeof window === 'undefined') return null;
  return normalizeOrigin(window.location.origin);
};

const canonicalPath = (pathname: string): string => {
  const compact = pathname.replace(/\/{2,}/gu, '/');
  if (compact === '/') return compact;
  return compact.replace(/\/+$/u, '') || '/';
};

const canonicalProxyPrefix = (
  value: string,
  origin: string | null,
): Readonly<{ urlPrefix: string; sameOrigin: boolean }> => {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_CONTROL_CHARACTERS',
      'ArcGIS service URL contains control characters.',
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_MISSING',
      'ArcGIS service URL is required.',
    );
  }

  if (trimmed.startsWith('//') || trimmed.includes('\\')) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_AMBIGUOUS',
      'ArcGIS service URL must use a canonical HTTP(S) form.',
    );
  }

  const absolute = ABSOLUTE_SCHEME_PATTERN.test(trimmed);
  if (!absolute && !trimmed.startsWith('/')) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_RELATIVE',
      'ArcGIS service URL must be absolute or same-origin rooted.',
    );
  }

  const base = origin ?? 'https://kent-rehberi.invalid';
  let parsed: URL;
  try {
    parsed = new URL(trimmed, base);
  } catch {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_INVALID',
      'ArcGIS service URL is invalid.',
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_PROTOCOL',
      'ArcGIS service URL must use HTTP or HTTPS.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_URL_UNSAFE_COMPONENT',
      'ArcGIS service URL must not contain credentials, query strings, or fragments.',
    );
  }

  const path = canonicalPath(parsed.pathname);
  if (!absolute) {
    return Object.freeze({ urlPrefix: path, sameOrigin: true });
  }

  const normalized = `${parsed.origin}${path}`;
  return Object.freeze({
    urlPrefix: normalized,
    sameOrigin: origin !== null && parsed.origin === origin,
  });
};

const normalizeApiBasePath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === '/') return '';
  return trimmed.replace(/\/+$/u, '');
};

export const buildArcgisProxyEndpoint = (
  apiBaseUrl: string = runtimeConfig.apiBaseUrl,
): string => `${normalizeApiBasePath(apiBaseUrl)}/Gis/Proxy` || '/Gis/Proxy';

export const resolveConfigurationServiceUrl = (
  service: ConfigurationService,
): string | null => {
  for (const key of SERVICE_URL_KEYS) {
    const value = service[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
};

const defaultAdapterLoader = async (): Promise<ArcgisProxyAdapter> => {
  const module = await import('@arcgis/core/core/urlUtils.js') as unknown as {
    readonly addProxyRule?: (rule: ArcgisProxyRule) => void;
  };

  if (typeof module.addProxyRule !== 'function') {
    throw new ArcgisProxyPolicyError(
      'PLATFORM_PROXY_ADAPTER_INVALID',
      'ArcGIS proxy adapter does not expose addProxyRule().',
    );
  }

  return Object.freeze({
    addProxyRule: (rule: ArcgisProxyRule): void => module.addProxyRule?.(rule),
  });
};

export const createArcgisProxyPolicy = (
  options: ArcgisProxyPolicyOptions = {},
): ArcgisProxyPolicy => {
  const origin = normalizeOrigin(options.origin) ?? browserOrigin();
  const proxyUrl = buildArcgisProxyEndpoint(options.apiBaseUrl ?? runtimeConfig.apiBaseUrl);
  const loadAdapter = options.loadAdapter ?? defaultAdapterLoader;
  const registered = new Set<string>();
  let adapterPromise: Promise<ArcgisProxyAdapter> | null = null;

  const adapter = (): Promise<ArcgisProxyAdapter> => {
    adapterPromise ??= loadAdapter();
    return adapterPromise;
  };

  const register = async (
    serviceUrl: string,
  ): Promise<ArcgisProxyRegistration> => {
    const normalized = canonicalProxyPrefix(serviceUrl, origin);
    if (normalized.sameOrigin) {
      return Object.freeze({ status: 'same-origin', proxied: false });
    }
    if (registered.has(normalized.urlPrefix)) {
      return Object.freeze({ status: 'duplicate', proxied: true });
    }

    const loaded = await adapter();
    loaded.addProxyRule(Object.freeze({
      urlPrefix: normalized.urlPrefix,
      proxyUrl,
    }));
    registered.add(normalized.urlPrefix);

    return Object.freeze({ status: 'registered', proxied: true });
  };

  const snapshot = (): ArcgisProxyPolicySnapshot => Object.freeze({
    registeredRuleCount: registered.size,
    adapterLoaded: adapterPromise !== null,
  });

  const clear = (): void => {
    registered.clear();
  };

  return Object.freeze({ register, snapshot, clear });
};

export const arcgisProxyPolicy = createArcgisProxyPolicy();
