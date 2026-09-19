import { describe, expect, it } from 'vitest';
import {
  buildGoogleRouteUrl,
  filterFastAccessRecords,
  getFastAccessRecordKey,
  normalizeFastAccessRecord,
  type FastAccessFeature,
} from './ManagedFastAccessQueryWindow';

describe('ManagedFastAccessQueryWindow runtime helpers', () => {
  it('normalizes common Turkish attribute names without coercing ids', () => {
    const feature: FastAccessFeature = {
      attr: {
        OBJECTID: 42,
        ADI: 'Kuğulu Park',
        ADRES: 'Çankaya',
        TELEFON: '0312 000 00 00',
      },
    };

    expect(normalizeFastAccessRecord(feature)).toMatchObject({
      objectId: 42,
      title: 'Kuğulu Park',
      address: 'Çankaya',
      phone: '0312 000 00 00',
    });
  });

  it('provides deterministic readable fallbacks for sparse records', () => {
    expect(normalizeFastAccessRecord({}, 2)).toMatchObject({
      objectId: null,
      title: 'Kayıt 3',
      address: 'Adres bilgisi bulunmuyor',
      phone: '',
    });
  });

  it('filters title, address and phone with Turkish normalization', () => {
    const records = [
      normalizeFastAccessRecord({ attr: { id: 1, adi: 'Çiğdem Parkı', adres: 'Çankaya' } }),
      normalizeFastAccessRecord({ attr: { id: 2, adi: 'Gençlik Merkezi', adres: 'Keçiören' } }),
    ];

    expect(filterFastAccessRecords(records, 'cigdem')).toHaveLength(1);
    expect(filterFastAccessRecords(records, 'keci')).toHaveLength(1);
    expect(filterFastAccessRecords(records, '')).toBe(records);
  });

  it('prefers server identity and keeps zero as a valid id', () => {
    expect(getFastAccessRecordKey(normalizeFastAccessRecord({ attr: { id: 0 } }))).toBe('0');
    expect(getFastAccessRecordKey(normalizeFastAccessRecord({
      attributes: { globalid: 'abc-123' },
    }))).toBe('abc-123');
  });

  it('builds a safe HTTPS directions URL only for valid coordinates', () => {
    expect(buildGoogleRouteUrl({ latitude: 39.92, longitude: 32.85 }))
      .toContain('https://www.google.com.tr/maps?');
    expect(buildGoogleRouteUrl({ latitude: 200, longitude: 32.85 })).toBeNull();
  });
});
