export const DEFAULT_LOCAL_API_PROXY_TARGET =
  'https://localhost:3003';

const allowedHosts = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

export const resolveLocalApiProxyTarget = (
  value: unknown,
): string => {
  const raw = String(value ?? '').trim();
  const candidate = raw || DEFAULT_LOCAL_API_PROXY_TARGET;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      'VITE_API_PROXY_TARGET must be an absolute localhost HTTP(S) URL.',
    );
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !allowedHosts.has(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error(
      'VITE_API_PROXY_TARGET must point to a bare localhost HTTP(S) origin.',
    );
  }

  return parsed.origin;
};
