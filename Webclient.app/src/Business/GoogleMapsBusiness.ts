import type { PointLike } from './contracts';

interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

const finiteCoordinate = (
  value: unknown,
  minimum: number,
  maximum: number,
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < minimum || value > maximum) return null;
  return value;
};

const coordinates = (geometry: PointLike | null | undefined): LatLng | null => {
  if (!geometry) return null;
  const latitude = finiteCoordinate(geometry.latitude ?? geometry.y, -90, 90);
  const longitude = finiteCoordinate(geometry.longitude ?? geometry.x, -180, 180);
  if (latitude === null || longitude === null) return null;
  return Object.freeze({ latitude, longitude });
};

const formatCoordinate = (value: number): string => {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, '').replace(/\.$/u, '');
};

export const GoogleMapsBusiness = Object.freeze({
  CreateRoutesUrlFromPoint: (
    geometry: PointLike | null | undefined,
  ): string | null => {
    const point = coordinates(geometry);
    if (!point) return null;
    const url = new URL('https://www.google.com.tr/maps');
    url.searchParams.set('saddr', 'My Location');
    url.searchParams.set(
      'daddr',
      `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)}`,
    );
    return url.toString();
  },

  CreateStreetViewUrlFromPoint: (
    geometry: PointLike | null | undefined,
  ): string | null => {
    const point = coordinates(geometry);
    if (!point) return null;
    const url = new URL('https://maps.google.com/maps');
    url.searchParams.set('q', '');
    url.searchParams.set('layer', 'c');
    url.searchParams.set(
      'cbll',
      `${formatCoordinate(point.latitude)},${formatCoordinate(point.longitude)}`,
    );
    return url.toString();
  },
});
