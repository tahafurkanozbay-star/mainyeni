/**
 * TomTom Orbis real-time traffic-flow raster tile URL template.
 * The browser credential is public client configuration; restrict it to the deployed origin
 * and the Traffic Flow API in the provider portal.
 */
export const normalizeTomTomTrafficCredential = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** Resolve the documented public browser key first, while accepting the
 * original CREDENTIAL name as a backwards-compatible deployment alias. */
export const resolveTomTomTrafficCredential = (environment: Readonly<Record<string, unknown>>): string =>
  normalizeTomTomTrafficCredential(environment.VITE_TOMTOM_TRAFFIC_API_KEY)
    || normalizeTomTomTrafficCredential(environment.VITE_TOMTOM_TRAFFIC_CREDENTIAL);

export const getTomTomTrafficCredential = (): string =>
  resolveTomTomTrafficCredential(import.meta.env as Readonly<Record<string, unknown>>);

export const buildTomTomTrafficFlowUrlTemplate = (credentialValue: string): string => {
  const credential = normalizeTomTomTrafficCredential(credentialValue);
  if (!credential) throw new Error('TomTom trafik kimlik bilgisi yapılandırılmamış.');
  const query = new URLSearchParams({
    apiVersion: '2',
    key: credential,
    style: 'light',
    tileSize: '256',
  });
  return `https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/{level}/{col}/{row}?${query.toString()}`;
};
