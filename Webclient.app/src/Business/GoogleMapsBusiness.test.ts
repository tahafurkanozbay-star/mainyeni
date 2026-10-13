import { describe, expect, it } from 'vitest';
import { GoogleMapsBusiness } from './GoogleMapsBusiness';
describe('Google Maps public panorama contract', () => {
  it('uses the official cross-device panorama action with an encoded location', () => {
    const url = new URL(GoogleMapsBusiness.CreateStreetViewUrlFromPoint({ latitude: -33.25, longitude: 151.2 }));
    expect(url.origin).toBe('https://www.google.com'); expect(url.pathname).toBe('/maps/@');
    expect(Object.fromEntries(url.searchParams)).toEqual({ api: '1', map_action: 'pano', viewpoint: '-33.25,151.2' });
  });
  it.each([{}, { latitude: null, longitude: 1 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: Infinity, longitude: 0 }])('rejects an invalid location %j', point => { expect(() => GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point)).toThrow(); });
  it('preserves zero coordinates and the existing route-link contract', () => {
    expect(new URL(GoogleMapsBusiness.CreateStreetViewUrlFromPoint({ latitude: 0, longitude: 0 })).searchParams.get('viewpoint')).toBe('0,0');
    expect(new URL(GoogleMapsBusiness.CreateRoutesUrlFromPoint({ latitude: 39, longitude: 32 })).searchParams.get('daddr')).toBe('39,32');
  });
});
