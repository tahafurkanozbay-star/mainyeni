import { describe, expect, it } from 'vitest';
import {
  createParkDirectionsUrl,
  createParkMarkerSymbol,
  normalizeParkRecord,
} from './ParklarQueryWindow';

describe('ParklarQueryWindow helpers', () => {
  it('normalizes legacy park attributes without changing numeric identity', () => {
    expect(normalizeParkRecord({
      attr: {
        objectid: 17,
        adi: 'Kuğulu Park',
        adres: 'Çankaya',
        telefon: '0312 000 00 00',
      },
    })).toEqual({
      objectId: 17,
      title: 'Kuğulu Park',
      address: 'Çankaya',
      phone: '0312 000 00 00',
      addressDescription: 'Adres tarifi bulunmuyor',
    });
  });

  it('provides readable defaults for incomplete records', () => {
    expect(normalizeParkRecord({}, 4)).toEqual({
      objectId: null,
      title: 'Park 5',
      address: 'Adres bilgisi bulunmuyor',
      phone: '',
      addressDescription: 'Adres tarifi bulunmuyor',
    });
  });

  it('uses the deterministic shared icon resolver for map markers', () => {
    const small = createParkMarkerSymbol(15);
    const large = createParkMarkerSymbol(5);
    expect(small.type).toBe('picture-marker');
    expect(small.url).toContain('park');
    expect(small.width).toBe('30px');
    expect(large.width).toBe('56px');
  });

  it('builds directions only for valid coordinates', () => {
    expect(createParkDirectionsUrl({
      latitude: 39.9208,
      longitude: 32.8541,
    })).toContain('daddr=39.9208%2C32.8541');

    expect(createParkDirectionsUrl({
      latitude: 190,
      longitude: 32.8541,
    })).toBeNull();
  });
});
