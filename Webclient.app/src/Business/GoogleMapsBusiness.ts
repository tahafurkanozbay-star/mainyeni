import { BusinessContractError, asFiniteNumber } from './contracts';

export interface GeographicPointInput {
  readonly latitude?: unknown;
  readonly longitude?: unknown;
}

interface GeographicPoint {
  readonly latitude: number;
  readonly longitude: number;
}

const normalizePoint = (geometry: GeographicPointInput): GeographicPoint => {
  const latitude = asFiniteNumber(geometry?.latitude);
  const longitude = asFiniteNumber(geometry?.longitude);

  if (
    latitude === null
    || longitude === null
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    throw new BusinessContractError(
      'INVALID_COORDINATE',
      'Harita bağlantısı oluşturmak için geçerli bir enlem ve boylam gereklidir.',
      false,
    );
  }

  return Object.freeze({ latitude, longitude });
};

export const GoogleMapsBusiness = Object.freeze({
  CreateRoutesUrlFromPoint: (geometry: GeographicPointInput): string => {
    const point = normalizePoint(geometry);
    const url = new URL('https://www.google.com.tr/maps');
    url.searchParams.set('saddr', 'My Location');
    url.searchParams.set('daddr', `${point.latitude},${point.longitude}`);
    return url.toString();
  },

  CreateStreetViewUrlFromPoint: (geometry: GeographicPointInput): string => {
    const point = normalizePoint(geometry);
    const url = new URL('https://maps.google.com/maps');
    url.searchParams.set('q', '');
    url.searchParams.set('layer', 'c');
    url.searchParams.set('cbll', `${point.latitude},${point.longitude}`);
    return url.toString();
  },
});
