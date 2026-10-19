/**
 * TomTom Orbis real-time traffic-flow raster tile URLs.
 * The API key is supplied by deployment configuration; never commit a real key.
 */
export const normalizeTomTomTrafficApiKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const getTomTomTrafficApiKey = (): string =>
  normalizeTomTomTrafficApiKey(import.meta.env.VITE_TOMTOM_TRAFFIC_API_KEY);

const assertTileCoordinate = (zoom: number, x: number, y: number): void => {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new RangeError('TomTom traffic tile zoom must be an integer from 0 to 22.');
  }
  const tileCount = 2 ** zoom;
  if (!Number.isInteger(x) || x < 0 || x >= tileCount || !Number.isInteger(y) || y < 0 || y >= tileCount) {
    throw new RangeError('TomTom traffic tile x/y coordinates are outside the selected zoom level.');
  }
};

export const buildTomTomTrafficFlowTileUrl = (
  apiKeyValue: string,
  zoom: number,
  x: number,
  y: number,
): string => {
  const apiKey = normalizeTomTomTrafficApiKey(apiKeyValue);
  if (!apiKey) throw new Error('TomTom trafik API anahtarı yapılandırılmamış.');
  assertTileCoordinate(zoom, x, y);
  const query = new URLSearchParams({
    apiVersion: '2',
    key: apiKey,
    style: 'light',
    tileSize: '256',
  });
  return `https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/${zoom}/${x}/${y}?${query.toString()}`;
};

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
