export interface AdminRuntimeEnvironment {
  readonly apiBaseUrl: string;
  readonly appVersion: string;
}

const stripTrailingSlash = (value: string): string =>
  value.length > 1 ? value.replace(/\/+$/u, '') : value;

const isLocalHostname = (hostname: string): boolean =>
  hostname === 'localhost'
  || hostname === '127.0.0.1'
  || hostname === '[::1]';

export const normalizeAdminApiBaseUrl = (value: unknown): string => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return '/api';

  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//')) {
      throw new Error('Protocol-relative admin API URLs are not allowed.');
    }
    return stripTrailingSlash(candidate);
  }

  const parsed = new URL(candidate);
  const secure = parsed.protocol === 'https:';
  const localDevelopment = parsed.protocol === 'http:' && isLocalHostname(parsed.hostname);
  if (!secure && !localDevelopment) {
    throw new Error('Admin API URL must use HTTPS unless it targets localhost.');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  return stripTrailingSlash(parsed.toString());
};

export const createAdminRuntimeEnvironment = (
  source: Readonly<Record<string, unknown>>,
): AdminRuntimeEnvironment => Object.freeze({
  apiBaseUrl: normalizeAdminApiBaseUrl(source.VITE_API_URL),
  appVersion: typeof source.VITE_APP_VERSION === 'string' && source.VITE_APP_VERSION.trim()
    ? source.VITE_APP_VERSION.trim()
    : 'dev',
});

export const adminRuntimeEnvironment = createAdminRuntimeEnvironment(import.meta.env);
