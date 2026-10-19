/**
 * TomTom Orbis real-time traffic-flow raster tile URL template.
 * Its browser key must be restricted to the production site origin and the Traffic Flow API.
 */
export const normalizeTomTomTrafficApiKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const getTomTomTrafficApiKey = (): string =>
  normalizeTomTomTrafficApiKey(import.meta.env.VITE_TOMTOM_TRAFFIC_API_KEY);

export const buildTomTomTrafficFlowUrlTemplate = (apiKeyValue: string): string => {
  const apiKey = normalizeTomTomTrafficApiKey(apiKeyValue);
  if (!apiKey) throw new Error('TomTom trafik API anahtarı yapılandırılmamış.');
  const query = new URLSearchParams({
    apiVersion: '2',
    key: apiKey,
    style: 'light',
    tileSize: '256',
  });
  return `https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/{level}/{col}/{row}?${query.toString()}`;
};
