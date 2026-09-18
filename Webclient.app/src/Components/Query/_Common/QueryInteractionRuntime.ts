export const DEFAULT_BUFFER_UNITS = 20;
export const MIN_BUFFER_UNITS = 1;
export const MAX_BUFFER_UNITS = 100;
export const METERS_PER_BUFFER_UNIT = 100;

export interface GeometryCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeometryLike {
  readonly latitude?: unknown;
  readonly longitude?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly centroid?: GeometryLike | null;
  readonly extent?: {
    readonly center?: GeometryLike | null;
  } | null;
}

export interface ClientLoggerLike {
  readonly CreateClientLog?: (
    eventName: string,
    payload: unknown,
  ) => unknown | Promise<unknown>;
}

export interface LatestRequestGate {
  readonly next: () => number;
  readonly current: () => number;
  readonly isCurrent: (requestId: number) => boolean;
  readonly invalidate: () => number;
}

export interface OwnedResourceRegistryOptions<Layer, Graphic> {
  readonly removeLayer?: (layer: Layer) => void;
  readonly removeGraphic?: (graphic: Graphic) => void;
  readonly onCleanupError?: (error: unknown) => void;
}

export interface OwnedResourceRegistry<Layer, Graphic> {
  readonly trackLayer: (layer: Layer | null | undefined) => Layer | null | undefined;
  readonly untrackLayer: (layer: Layer | null | undefined) => Layer | null | undefined;
  readonly trackGraphic: (graphic: Graphic | null | undefined) => Graphic | null | undefined;
  readonly untrackGraphic: (graphic: Graphic | null | undefined) => Graphic | null | undefined;
  readonly removeLayer: (layer: Layer | null | undefined) => void;
  readonly removeGraphic: (graphic: Graphic | null | undefined) => void;
  readonly clearLayers: () => void;
  readonly clearGraphics: () => void;
  readonly clear: () => void;
  readonly sizes: () => Readonly<{ layers: number; graphics: number }>;
}

export interface GeolocationCoordinatesResult {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
}

export interface GeolocationRequestOptions {
  readonly geolocation?: Geolocation | null;
  readonly timeout?: number;
  readonly maximumAge?: number;
  readonly enableHighAccuracy?: boolean;
}

export const normalizeFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const normalizeBufferUnits = (
  value: unknown,
  fallback = DEFAULT_BUFFER_UNITS,
  min = MIN_BUFFER_UNITS,
  max = MAX_BUFFER_UNITS,
): number => {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const safeFallback = clamp(
    Math.round(normalizeFiniteNumber(fallback) ?? DEFAULT_BUFFER_UNITS),
    safeMin,
    safeMax,
  );
  const numeric = normalizeFiniteNumber(value);
  if (numeric === null) return safeFallback;
  return clamp(Math.round(numeric), safeMin, safeMax);
};

export const bufferUnitsToMeters = (value: unknown): number =>
  normalizeBufferUnits(value) * METERS_PER_BUFFER_UNIT;

export const metersToBufferUnits = (value: unknown): number => {
  const meters = normalizeFiniteNumber(value);
  if (meters === null) return DEFAULT_BUFFER_UNITS;
  return normalizeBufferUnits(meters / METERS_PER_BUFFER_UNIT);
};

export const normalizeCoordinate = (value: unknown): number | null =>
  normalizeFiniteNumber(value);

const asGeometryLike = (value: unknown): GeometryLike | null =>
  value !== null && typeof value === 'object' ? value as GeometryLike : null;

export const getGeometryCoordinates = (
  geometry: GeometryLike | null | undefined,
): GeometryCoordinates | null => {
  if (!geometry) return null;
  const extentCenter = asGeometryLike(geometry.extent?.center);
  const centroid = asGeometryLike(geometry.centroid);
  const target = extentCenter ?? centroid ?? geometry;
  const latitude = normalizeCoordinate(target.latitude ?? target.y);
  const longitude = normalizeCoordinate(target.longitude ?? target.x);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
};

export const buildGoogleDirectionsUrl = (
  geometry: GeometryLike | null | undefined,
): string | null => {
  const coordinates = getGeometryCoordinates(geometry);
  if (!coordinates) return null;
  const destination = `${coordinates.latitude},${coordinates.longitude}`;
  const params = new URLSearchParams({
    saddr: 'My Location',
    daddr: destination,
  });
  return `https://www.google.com.tr/maps?${params.toString()}`;
};

export type ExternalOpener = (
  url?: string | URL,
  target?: string,
  features?: string,
) => Window | null;

export const openExternalSafely = (
  url: string | null | undefined,
  opener: ExternalOpener | undefined = typeof window === 'undefined'
    ? undefined
    : window.open.bind(window),
): boolean => {
  if (!url || typeof opener !== 'function') return false;

  let parsed: URL;
  try {
    parsed = new URL(url, typeof window === 'undefined' ? 'https://localhost/' : window.location.href);
  } catch {
    return false;
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) return false;

  const openedWindow = opener(parsed.href, '_blank', 'noopener,noreferrer');
  if (!openedWindow) return false;

  try {
    openedWindow.opener = null;
  } catch {
    // Browser-enforced noopener can make the property inaccessible/read-only.
  }
  return true;
};

export const normalizeErrorMessage = (
  error: unknown,
  fallback = 'İşlem tamamlanamadı. Lütfen tekrar deneyin.',
): string => {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();

  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.errorMessage;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  return fallback;
};

export const safeClientLog = async (
  logger: ClientLoggerLike | null | undefined,
  eventName: string,
  payload: unknown,
  onError?: (error: unknown) => void,
): Promise<boolean> => {
  if (typeof logger?.CreateClientLog !== 'function') return false;
  try {
    await logger.CreateClientLog(eventName, payload);
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
};

export const createLatestRequestGate = (): LatestRequestGate => {
  let sequence = 0;
  return Object.freeze({
    next: () => {
      sequence += 1;
      return sequence;
    },
    current: () => sequence,
    isCurrent: (requestId: number) => requestId === sequence,
    invalidate: () => {
      sequence += 1;
      return sequence;
    },
  });
};

export const createOwnedResourceRegistry = <Layer, Graphic>(
  options: OwnedResourceRegistryOptions<Layer, Graphic> = {},
): OwnedResourceRegistry<Layer, Graphic> => {
  const layers = new Set<Layer>();
  const graphics = new Set<Graphic>();

  const safely = (callback: () => void): void => {
    try {
      callback();
    } catch (error) {
      options.onCleanupError?.(error);
    }
  };

  return {
    trackLayer: (layer) => {
      if (layer !== null && layer !== undefined) layers.add(layer);
      return layer;
    },
    untrackLayer: (layer) => {
      if (layer !== null && layer !== undefined) layers.delete(layer);
      return layer;
    },
    trackGraphic: (graphic) => {
      if (graphic !== null && graphic !== undefined) graphics.add(graphic);
      return graphic;
    },
    untrackGraphic: (graphic) => {
      if (graphic !== null && graphic !== undefined) graphics.delete(graphic);
      return graphic;
    },
    removeLayer: (layer) => {
      if (layer === null || layer === undefined) return;
      layers.delete(layer);
      safely(() => options.removeLayer?.(layer));
    },
    removeGraphic: (graphic) => {
      if (graphic === null || graphic === undefined) return;
      graphics.delete(graphic);
      safely(() => options.removeGraphic?.(graphic));
    },
    clearLayers: () => {
      for (const layer of layers) safely(() => options.removeLayer?.(layer));
      layers.clear();
    },
    clearGraphics: () => {
      for (const graphic of graphics) safely(() => options.removeGraphic?.(graphic));
      graphics.clear();
    },
    clear: () => {
      for (const layer of layers) safely(() => options.removeLayer?.(layer));
      for (const graphic of graphics) safely(() => options.removeGraphic?.(graphic));
      layers.clear();
      graphics.clear();
    },
    sizes: () => Object.freeze({
      layers: layers.size,
      graphics: graphics.size,
    }),
  };
};

export const createGeolocationRequest = ({
  geolocation,
  timeout = 10_000,
  maximumAge = 60_000,
  enableHighAccuracy = false,
}: GeolocationRequestOptions = {}): Promise<GeolocationCoordinatesResult> => {
  const source = geolocation
    ?? (typeof navigator !== 'undefined' ? navigator.geolocation : null);

  if (!source?.getCurrentPosition) {
    return Promise.reject(new Error('Konum servisi bu tarayıcıda desteklenmiyor.'));
  }

  const boundedTimeout = clamp(
    Math.round(normalizeFiniteNumber(timeout) ?? 10_000),
    1_000,
    60_000,
  );
  const boundedMaximumAge = clamp(
    Math.round(normalizeFiniteNumber(maximumAge) ?? 60_000),
    0,
    300_000,
  );

  return new Promise((resolve, reject) => {
    source.getCurrentPosition(
      (position) => {
        const latitude = normalizeCoordinate(position.coords.latitude);
        const longitude = normalizeCoordinate(position.coords.longitude);
        if (
          latitude === null
          || longitude === null
          || latitude < -90
          || latitude > 90
          || longitude < -180
          || longitude > 180
        ) {
          reject(new Error('Konum bilgisi geçersiz döndü.'));
          return;
        }
        resolve({
          latitude,
          longitude,
          accuracy: normalizeCoordinate(position.coords.accuracy),
        });
      },
      (error) => {
        reject(new Error(error.message || 'Konum izni alınamadı.'));
      },
      {
        enableHighAccuracy,
        timeout: boundedTimeout,
        maximumAge: boundedMaximumAge,
      },
    );
  });
};

export { isSmallViewport } from './QuerySearchRuntime';
