import { describe, expect, it, vi } from 'vitest';
import type {
  KentRehberiGeoJsonFeature,
  KentRehberiGeoJsonFeatureCollection,
} from '../data-services/kentRehberiGeoJsonLayer';
import {
  createKentRehberiFastAccessRuntime,
  selectDominantKentRehberiTur,
} from './kentRehberiFastAccessRuntime';
import {
  KENT_REHBERI_FAST_ACCESS_PROFILES,
  getKentRehberiFastAccessProfile,
} from './kentRehberiFastAccessProfiles';

const feature = (
  objectid: number,
  tur: number,
  adi: string,
  overrides: Readonly<Record<string, unknown>> = {},
): KentRehberiGeoJsonFeature => Object.freeze({
  type: 'Feature',
  id: objectid,
  geometry: Object.freeze({ type: 'Point', coordinates: Object.freeze([32.85, 39.92]) }),
  properties: Object.freeze({
    objectid,
    adi,
    adres: 'Ankara',
    ilce: 'Çankaya',
    mahalle: 'Kızılay',
    x: 32.85,
    y: 39.92,
    tur,
    yapan: null,
    webSayfasi: null,
    durakNo: null,
    ...overrides,
  }),
});

const collection = (
  features: readonly KentRehberiGeoJsonFeature[],
): KentRehberiGeoJsonFeatureCollection => Object.freeze({
  type: 'FeatureCollection',
  features: Object.freeze([...features]),
  meta: Object.freeze({ count: features.length, limit: 2000, hasMore: false }),
});

describe('kentRehberiFastAccessRuntime', () => {
  it('owns every current sidebar fast-access service profile exactly once', () => {
    expect(KENT_REHBERI_FAST_ACCESS_PROFILES).toHaveLength(40);
    expect(new Set(KENT_REHBERI_FAST_ACCESS_PROFILES.map((item) => item.serviceKey)).size)
      .toBe(KENT_REHBERI_FAST_ACCESS_PROFILES.length);

    for (const profile of KENT_REHBERI_FAST_ACCESS_PROFILES) {
      expect(profile.serviceKey).toMatch(/^(?:Yeni)/u);
      expect(profile.title.length).toBeGreaterThan(2);
      expect(profile.probes.length).toBeGreaterThan(0);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.probes)).toBe(true);
    }
  });

  it('scores the dominant type using category evidence rather than numeric order', () => {
    const profile = getKentRehberiFastAccessProfile('YeniKadinDanismaQueryUrl');
    expect(profile).not.toBeNull();
    expect(selectDominantKentRehberiTur([
      feature(1, 7, 'Genel Belediye Tesisi'),
      feature(2, 7, 'Başka Tesis'),
      feature(3, 31, 'Kadın Danışma Merkezi Çankaya'),
      feature(4, 31, 'Kadın Dayanışma Merkezi Keçiören'),
    ], profile!)).toBe(31);
  });

  it('discovers a type with a bounded probe and then loads the whole category', async () => {
    const fetchCollection = vi.fn(async (options?: { q?: string; tur?: number; limit?: number }) => {
      if (options?.q) {
        expect(options.limit).toBe(250);
        return collection([
          feature(101, 12, 'Kadın Danışma Merkezi Çankaya'),
          feature(102, 12, 'Kadın Dayanışma Merkezi Sincan'),
        ]);
      }
      expect(options?.tur).toBe(12);
      expect(options?.limit).toBe(2000);
      return collection([
        feature(101, 12, 'Kadın Danışma Merkezi Çankaya'),
        feature(102, 12, 'Kadın Dayanışma Merkezi Sincan'),
        feature(103, 12, 'Kadın Danışma Merkezi Yenimahalle'),
      ]);
    });

    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const business = runtime.createBusiness('YeniKadinDanismaQueryUrl');
    const result = await business?.Query({}, true);

    expect(result?.source).toBe('kent-rehberi');
    expect(result?.data).toHaveLength(3);
    expect(result?.data[0]?.geometry).toMatchObject({
      longitude: 32.85,
      latitude: 39.92,
      spatialReference: { wkid: 4326 },
    });
    expect(fetchCollection).toHaveBeenCalledTimes(2);

    await business?.Query({}, false);
    expect(fetchCollection).toHaveBeenCalledTimes(2);
    expect(runtime.cacheSize()).toBe(1);
  });

  it('uses direct probe matches when a safe type cannot be inferred', async () => {
    const fetchCollection = vi.fn(async () => collection([
      feature(1, 2, 'BELMEK Çankaya'),
      feature(2, 9, 'BELTEK Sincan'),
    ]));
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      cacheTtlMs: 5000,
    });
    const business = runtime.createBusiness('YeniBelmekBeltekQeryUrl');
    const result = await business?.Query({}, false);

    expect(result?.data.map((item) => item.attr.objectid)).toEqual([1, 2]);
    expect(result?.featureCollection.meta).toMatchObject({
      source: 'kent-rehberi',
      serviceKey: 'YeniBelmekBeltekQeryUrl',
    });
  });

  it('loads an object detail from the backend when it is not in the category cache', async () => {
    const fetchFeature = vi.fn(async (objectId: number) =>
      objectId === 77 ? feature(77, 4, 'Park Detayı') : null);
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: vi.fn(async () => collection([])) as never,
      fetchFeature: fetchFeature as never,
    });
    const business = runtime.createBusiness('YeniParklarQeryUrl');

    const result = await business?.Query({ ObjectId: 77 }, true);

    expect(fetchFeature).toHaveBeenCalledWith(77, expect.objectContaining({ limit: 1 }));
    expect(result?.data[0]?.attr.objectid).toBe(77);
    expect(result?.data[0]?.geometry).toMatchObject({ x: 32.85, y: 39.92 });
  });

  it('filters cached category records by a normalized name query', async () => {
    const fetchCollection = vi.fn(async (options?: { q?: string; tur?: number }) =>
      options?.q
        ? collection([feature(1, 5, 'Park'), feature(2, 5, 'Park')])
        : collection([
          feature(10, 5, 'Kuğulu Park'),
          feature(11, 5, 'Gençlik Parkı'),
        ]));
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
    });
    const business = runtime.createBusiness('YeniParklarQeryUrl');

    const result = await business?.Query({ name: 'kugulu' }, false);

    expect(result?.data).toHaveLength(1);
    expect(result?.data[0]?.attr.adi).toBe('Kuğulu Park');
  });

  it('does not claim unrelated legacy service keys', () => {
    const runtime = createKentRehberiFastAccessRuntime();
    expect(runtime.createBusiness('PharmacyQueryUrl')).toBeNull();
    expect(runtime.createBusiness('TaxiQueryUrl')).toBeNull();
  });
});
