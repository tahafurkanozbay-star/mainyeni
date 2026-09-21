export interface AdminMapConfigInput {
  readonly Centerx?: string | number | null;
  readonly Centery?: string | number | null;
  readonly Zoom?: string | number | null;
  readonly DefaultBasemapTitle?: string | null;
}

export interface NormalizedAdminMapConfig {
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly basemap: string;
}

export const DEFAULT_ADMIN_MAP_CONFIG: NormalizedAdminMapConfig = Object.freeze({
  center: Object.freeze([32.8541, 39.9208]) as readonly [number, number],
  zoom: 10,
  basemap: 'topo-vector',
});

const parseFinite = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.replace(',', '.'))
      : Number.NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeBasemap = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_ADMIN_MAP_CONFIG.basemap;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120
    ? trimmed
    : DEFAULT_ADMIN_MAP_CONFIG.basemap;
};

export const normalizeAdminMapConfig = (
  config: AdminMapConfigInput | null | undefined,
): NormalizedAdminMapConfig => {
  const longitude = clamp(
    parseFinite(config?.Centerx, DEFAULT_ADMIN_MAP_CONFIG.center[0]),
    -180,
    180,
  );
  const latitude = clamp(
    parseFinite(config?.Centery, DEFAULT_ADMIN_MAP_CONFIG.center[1]),
    -90,
    90,
  );
  const zoom = clamp(
    parseFinite(config?.Zoom, DEFAULT_ADMIN_MAP_CONFIG.zoom),
    0,
    23,
  );

  return Object.freeze({
    center: Object.freeze([longitude, latitude]) as readonly [number, number],
    zoom,
    basemap: normalizeBasemap(config?.DefaultBasemapTitle),
  });
};
