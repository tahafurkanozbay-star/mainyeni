import { buildGoogleRouteUrl, filterFastAccessRecords, normalizeFastAccessRecord } from './ManagedFastAccessQueryWindow';

describe('ManagedFastAccessQueryWindow helpers', () => {
  test('normalizes heterogeneous fast-access attributes', () => {
    expect(normalizeFastAccessRecord({
      attr: { OBJECTID: 42, ADI: 'Ankara Parkı', ADRES: 'Çankaya', TELEFON: '0312 000 00 00' }
    })).toMatchObject({
      objectId: 42,
      title: 'Ankara Parkı',
      address: 'Çankaya',
      phone: '0312 000 00 00'
    });
  });

  test('falls back without exposing undefined labels', () => {
    expect(normalizeFastAccessRecord({ attr: {} }, 2)).toMatchObject({
      title: 'Kayıt 3',
      address: 'Adres bilgisi bulunmuyor',
      phone: ''
    });
  });

  test('filters Turkish text diacritic-insensitively', () => {
    const records = [
      { title: 'Kütüphane', address: 'Çankaya', phone: '' },
      { title: 'Park', address: 'Keçiören', phone: '' }
    ];
    expect(filterFastAccessRecords(records, 'kutuphane')).toHaveLength(1);
    expect(filterFastAccessRecords(records, 'kecioren')).toHaveLength(1);
  });

  test('creates a route only for finite coordinates', () => {
    expect(buildGoogleRouteUrl({ latitude: 39.92, longitude: 32.85 })).toContain('39.92%2C32.85');
    expect(buildGoogleRouteUrl({})).toBeNull();
  });
});
