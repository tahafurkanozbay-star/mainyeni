import { describe, expect, it, vi } from 'vitest';
import type {
  KentRehberiGeoJsonFeature,
  KentRehberiGeoJsonFeatureCollection,
} from '../data-services/kentRehberiGeoJsonLayer';
import {
  createKentRehberiFastAccessRuntime,
  resolveKentRehberiTypesFromCatalog,
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

const emptyTypeCatalog = Object.freeze({
  types: Object.freeze([]),
});

const emptyTypeCatalogFetch = vi.fn(async () => emptyTypeCatalog);

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

  it('resolves a single fast-access type from bounded backend catalog samples', () => {
    const profile = getKentRehberiFastAccessProfile('YeniKadinDanismaQueryUrl');
    expect(profile).not.toBeNull();

    const resolved = resolveKentRehberiTypesFromCatalog({
      types: [
        {
          tur: 7,
          count: 300,
          samples: [
            { objectid: 1, adi: 'Genel Hizmet Binası', adres: 'Ankara', durakNo: null },
            { objectid: 2, adi: 'Belediye Birimi', adres: 'Ankara', durakNo: null },
          ],
        },
        {
          tur: 31,
          count: 18,
          samples: [
            { objectid: 3, adi: 'Kadın Danışma Merkezi Çankaya', adres: 'Çankaya', durakNo: null },
            { objectid: 4, adi: 'Kadın Dayanışma Merkezi', adres: 'Keçiören', durakNo: null },
          ],
        },
      ],
    }, profile!);

    expect(resolved).toEqual([31]);
  });

  it('resolves multiple type ids for intentional union profiles', () => {
    const profile = getKentRehberiFastAccessProfile('YeniBelmekBeltekQeryUrl');
    expect(profile?.mode).toBe('union');

    const resolved = resolveKentRehberiTypesFromCatalog({
      types: [
        {
          tur: 2,
          count: 25,
          samples: [
            { objectid: 1, adi: 'BELMEK Çankaya', adres: 'Ankara', durakNo: null },
          ],
        },
        {
          tur: 9,
          count: 19,
          samples: [
            { objectid: 2, adi: 'BELTEK Sincan', adres: 'Ankara', durakNo: null },
          ],
        },
      ],
    }, profile!);

    expect(resolved).toEqual([2, 9]);
  });

  it('prefers catalog discovery and avoids text probes when confidence is sufficient', async () => {
    const fetchTypeCatalog = vi.fn(async () => ({
      types: [
        {
          tur: 12,
          count: 3,
          samples: [
            { objectid: 101, adi: 'Kadın Danışma Merkezi', adres: 'Çankaya', durakNo: null },
            { objectid: 102, adi: 'Kadın Dayanışma Merkezi', adres: 'Sincan', durakNo: null },
          ],
        },
      ],
    }));
    const fetchCollection = vi.fn(async (options?: { q?: string; tur?: number; limit?: number }) => {
      expect(options?.q).toBeUndefined();
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
      fetchTypeCatalog: fetchTypeCatalog as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const business = runtime.createBusiness('YeniKadinDanismaQueryUrl');

    const result = await business?.Query({}, false);

    expect(result?.data).toHaveLength(3);
    expect(fetchTypeCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCollection).toHaveBeenCalledTimes(1);

    await business?.Query({}, false);
    expect(fetchTypeCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCollection).toHaveBeenCalledTimes(1);
  });

  it('does not start a broad category probe when catalog evidence is insufficient', async () => {
    const fetchCollection = vi.fn(async () => collection([
      feature(101, 12, 'Kadın Danışma Merkezi Çankaya'),
    ]));
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: emptyTypeCatalogFetch as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const business = runtime.createBusiness('YeniKadinDanismaQueryUrl');
    const result = await business?.Query({}, true);

    expect(result?.source).toBe('kent-rehberi');
    expect(result?.data).toHaveLength(0);
    expect(fetchCollection).not.toHaveBeenCalled();
    expect(runtime.cacheSize()).toBe(2);
  });

  it('does not sweep every type for a POI whose category cannot be resolved', async () => {
    const fetchCollection = vi.fn(async () => collection([
      feature(1, 2, 'BELMEK Çankaya'),
      feature(2, 9, 'BELTEK Sincan'),
    ]));
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: emptyTypeCatalogFetch as never,
      cacheTtlMs: 5000,
    });
    const business = runtime.createBusiness('YeniBelmekBeltekQeryUrl');
    const result = await business?.Query({}, false);

    expect(result?.data).toHaveLength(0);
    expect(result?.featureCollection.meta).toMatchObject({
      source: 'kent-rehberi',
      serviceKey: 'YeniBelmekBeltekQeryUrl',
    });
    expect(fetchCollection).not.toHaveBeenCalled();
  });

  it('reuses one in-flight catalog across different POIs when result caching is disabled', async () => {
    let resolveCatalog!: (value: {
      types: readonly {
        tur: number;
        count: number;
        samples: readonly { objectid: number; adi: string; adres: string; durakNo: null }[];
      }[];
    }) => void;
    const catalogResult = new Promise<{
      types: readonly {
        tur: number;
        count: number;
        samples: readonly { objectid: number; adi: string; adres: string; durakNo: null }[];
      }[];
    }>((resolve) => { resolveCatalog = resolve; });
    const fetchTypeCatalog = vi.fn(() => catalogResult);
    const fetchCollection = vi.fn(async (options?: { q?: string; tur?: number; limit?: number }) => {
      expect(options?.q).toBeUndefined();
      expect(options?.limit).toBe(2000);
      if (options?.tur === 13) return collection([feature(130, 13, 'Seğmen Su Fabrikası')]);
      if (options?.tur === 5) return collection([feature(50, 5, 'Kuğulu Park')]);
      throw new Error('A POI query requested an unrelated category.');
    });
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: fetchTypeCatalog as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const segmen = runtime.createBusiness('YeniSegmenSuFabrikalarıQeryUrl');
    const parklar = runtime.createBusiness('YeniParklarQeryUrl');
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();

    const first = segmen!.Query({}, false, { cache: false, signal: firstSignal.signal });
    const second = parklar!.Query({}, false, { cache: false, signal: secondSignal.signal });
    await Promise.resolve();
    expect(fetchTypeCatalog).toHaveBeenCalledTimes(1);

    resolveCatalog({
      types: [
        {
          tur: 13,
          count: 1,
          samples: [
            { objectid: 130, adi: 'Seğmen Su Fabrikası', adres: 'Ankara', durakNo: null },
          ],
        },
        {
          tur: 5,
          count: 1,
          samples: [
            { objectid: 50, adi: 'Kuğulu Park', adres: 'Çankaya', durakNo: null },
          ],
        },
      ],
    });
    const [segmenResult, parkResult] = await Promise.all([first, second]);

    expect(segmenResult.data.map((item) => item.attr.tur)).toEqual([13]);
    expect(parkResult.data.map((item) => item.attr.tur)).toEqual([5]);
    expect(fetchTypeCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCollection.mock.calls.map(([options]) => options?.tur).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual([5, 13]);
    expect(fetchCollection).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared category catalog even when one waiting query is cancelled', async () => {
    let resolveCatalog!: (value: {
      types: readonly {
        tur: number;
        count: number;
        samples: readonly { objectid: number; adi: string; adres: string; durakNo: null }[];
      }[];
    }) => void;
    const catalogResult = new Promise<{
      types: readonly {
        tur: number;
        count: number;
        samples: readonly { objectid: number; adi: string; adres: string; durakNo: null }[];
      }[];
    }>((resolve) => { resolveCatalog = resolve; });
    const fetchTypeCatalog = vi.fn(() => catalogResult);
    const fetchCollection = vi.fn(async (options?: { tur?: number; limit?: number }) => {
      expect(options?.tur).toBe(5);
      return collection([feature(50, 5, 'Kuğulu Park')]);
    });
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: fetchTypeCatalog as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const business = runtime.createBusiness('YeniParklarQeryUrl');
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = business!.Query({}, false, { cache: false, signal: firstController.signal });
    const second = business!.Query({}, false, { cache: false, signal: secondController.signal });
    firstController.abort(new Error('cancel first request'));

    await expect(first).rejects.toThrow('cancel first request');
    resolveCatalog({
      types: [{
        tur: 5,
        count: 1,
        samples: [
          { objectid: 50, adi: 'Kuğulu Park', adres: 'Çankaya', durakNo: null },
        ],
      }],
    });
    const result = await second;

    expect(result.data).toHaveLength(1);
    expect(fetchTypeCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCollection).toHaveBeenCalledTimes(1);
  });

  it('loads an object detail only from the resolved POI category', async () => {
    const fetchFeature = vi.fn(async (objectId: number, options?: { tur?: number }) =>
      objectId === 77 && options?.tur === 5 ? feature(77, 5, 'Park Detayı') : null);
    const fetchTypeCatalog = vi.fn(async () => ({
      types: [{
        tur: 5,
        count: 1,
        samples: [
          { objectid: 50, adi: 'Kuğulu Park', adres: 'Çankaya', durakNo: null },
        ],
      }],
    }));
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: vi.fn(async () => collection([])) as never,
      fetchFeature: fetchFeature as never,
      fetchTypeCatalog: fetchTypeCatalog as never,
    });
    const business = runtime.createBusiness('YeniParklarQeryUrl');

    const result = await business?.Query({ ObjectId: 77 }, true, { cache: false });

    expect(fetchFeature).toHaveBeenCalledWith(77, expect.objectContaining({ limit: 1, tur: 5 }));
    expect(fetchFeature).toHaveBeenCalledTimes(1);
    expect(result?.data[0]?.attr.objectid).toBe(77);
    expect(result?.data[0]?.geometry).toMatchObject({ x: 32.85, y: 39.92 });
  });

  it('filters category records by a normalized name query without broad queries', async () => {
    const fetchTypeCatalog = vi.fn(async () => ({
      types: [{
        tur: 5,
        count: 2,
        samples: [
          { objectid: 10, adi: 'Kuğulu Park', adres: 'Çankaya', durakNo: null },
          { objectid: 11, adi: 'Gençlik Parkı', adres: 'Altındağ', durakNo: null },
        ],
      }],
    }));
    const fetchCollection = vi.fn(async (options?: { q?: string; tur?: number }) => {
      expect(options?.q).toBeUndefined();
      expect(options?.tur).toBe(5);
      return collection([
        feature(10, 5, 'Kuğulu Park'),
        feature(11, 5, 'Gençlik Parkı'),
      ]);
    });
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: fetchTypeCatalog as never,
    });
    const business = runtime.createBusiness('YeniParklarQeryUrl');

    const result = await business?.Query({ name: 'kugulu' }, false);

    expect(result?.data).toHaveLength(1);
    expect(result?.data[0]?.attr.adi).toBe('Kuğulu Park');
    expect(fetchCollection).toHaveBeenCalledTimes(1);
  });

  it('routes global search through the Kent Rehberi collection instead of a legacy GIS layer', async () => {
    const fetchCollection = vi.fn(async (options?: { q?: string; limit?: number }) => {
      expect(options?.limit).toBe(2000);
      return collection([
        feature(21, 5, 'Kızılay Parkı', { ilce: 'Altındağ' }),
        feature(22, 5, 'Çankaya Meydanı', { mahalle: 'Söğütözü' }),
      ]);
    });
    const runtime = createKentRehberiFastAccessRuntime({
      fetchCollection: fetchCollection as never,
      fetchTypeCatalog: emptyTypeCatalogFetch as never,
      now: () => 100,
      cacheTtlMs: 10_000,
    });
    const business = runtime.createBusiness('YeniGenelArama');

    expect(business).not.toBeNull();
    const kizilay = await business!.Query({ name: 'Kızılay' }, true);
    expect(fetchCollection).toHaveBeenCalledWith(expect.objectContaining({ q: 'Kızılay', limit: 2000 }));
    expect(kizilay.data.map((item) => item.attr.objectid)).toEqual([21]);
    expect(kizilay.data[0]?.geometry).toMatchObject({ x: 32.85, y: 39.92 });
    expect(kizilay.featureCollection.meta.serviceKey).toBe('YeniGenelArama');

    // Repeating a search reuses its bounded cache; a different term gets its own result set.
    await business!.Query({ name: 'Kızılay' }, false);
    expect(fetchCollection).toHaveBeenCalledTimes(1);
    const cankaya = await business!.Query({ name: 'Çankaya' }, false);
    expect(cankaya.data.map((item) => item.attr.objectid)).toEqual([22]);
    expect(fetchCollection).toHaveBeenCalledTimes(2);

    // Search terms may occur in different fields of the same place record.
    const combinedAddress = await business!.Query({ name: 'Söğütözü Çankaya' }, false);
    expect(combinedAddress.data.map((item) => item.attr.objectid)).toEqual([22]);
    expect(fetchCollection).toHaveBeenCalledWith(expect.objectContaining({
      q: 'Söğütözü Çankaya',
      limit: 2000,
    }));
  });

  it('does not claim unrelated legacy service keys', () => {
    const runtime = createKentRehberiFastAccessRuntime();
    expect(runtime.createBusiness('PharmacyQueryUrl')).toBeNull();
    expect(runtime.createBusiness('TaxiQueryUrl')).toBeNull();
  });
});
