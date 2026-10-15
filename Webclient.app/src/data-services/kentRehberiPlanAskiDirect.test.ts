import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchKentRehberiGeoJson,
  fetchKentRehberiTypeCatalog,
  fetchKentRehberiFeature,
} from './kentRehberiGeoJsonLayer';
import {
  fetchPlanAskiFeatureDirect,
  fetchPlanAskiGeoJsonDirect,
  fetchPlanAskiTypeCatalogDirect,
} from './kentRehberiPlanAskiDirect';

const makeResponse = (records: unknown, status = 200): Response =>
  new Response(JSON.stringify(records), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const row = (tur: number, objectId: number, overrides: Record<string, unknown> = {}) => ({
  objectId,
  adi: 'Kadin Danisma Merkezi',
  adres: 'Merkez\nSokak 8',
  ilce: 'ÇANKAYA',
  mahalle: 'KIZILAY',
  x: 32.855,
  y: 39.92,
  tur,
  yapan: 0,
  webSayfasi: null,
  durakNo: null,
  ...overrides,
});

const mockTypes = (
  byType: Readonly<Record<number, readonly unknown[]>>,
): { readonly requests: string[]; readonly fetchImpl: typeof fetch } => {
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    expect(url).toMatch(/^https:\/\/planaski\.ankara\.bel\.tr\/kentrehberiapi\/api\/kentrehberi\?tur=\d+$/u);
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    return makeResponse(byType[Number(new URL(url).searchParams.get('tur'))] ?? []);
  }) as typeof fetch;
  return { requests, fetchImpl };
};

afterEach(() => vi.unstubAllEnvs());

describe('direct PlanASKI browser transport', () => {
  it('converts official flat JSON with multiline names and addresses to bounded GeoJSON', async () => {
    const { requests, fetchImpl } = mockTypes({
      13: [row(13, 201, { adi: 'Kadin\nDanisma', adres: 'Cadde\r\nNo: 4' })],
    });
    const value = await fetchPlanAskiGeoJsonDirect({ tur: 13, limit: 10, fetchImpl });
    expect(requests).toEqual([
      'https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=13',
    ]);
    expect(value).toMatchObject({
      type: 'FeatureCollection',
      meta: { count: 1, hasMore: false, limit: 10 },
      features: [{
        type: 'Feature',
        id: 201,
        geometry: { type: 'Point', coordinates: [32.855, 39.92] },
        properties: { objectid: 201, tur: 13, adi: 'Kadin Danisma', adres: 'Cadde No: 4' },
      }],
    });
  });

  it('connects existing React request functions to the direct upstream only when enabled', async () => {
    vi.stubEnv('VITE_KENT_REHBERI_SOURCE', 'planaski');
    const { requests, fetchImpl } = mockTypes({ 13: [row(13, 201)] });
    const result = await fetchKentRehberiGeoJson({ tur: 13, limit: 10, fetchImpl });
    expect(result.features).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('localhost');
  });

  it('retains same-origin API mode if not explicitly selected', async () => {
    vi.stubEnv('VITE_KENT_REHBERI_SOURCE', 'api');
    const fetchImpl = vi.fn(async () => makeResponse({
      type: 'FeatureCollection',
      features: [],
      meta: { count: 0, limit: 10, hasMore: false },
    })) as typeof fetch;
    await fetchKentRehberiGeoJson({ limit: 10, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/kent-rehberi?limit=10',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('fetches all 43 types for catalog and supports exact category matching', async () => {
    const { requests, fetchImpl } = mockTypes({
      10: [row(10, 201)],
      13: [row(13, 202)],
    });
    const catalog = await fetchPlanAskiTypeCatalogDirect({ fetchImpl });
    expect(requests).toHaveLength(43);
    expect(catalog.types).toHaveLength(43);
    expect(catalog.types[10]?.count).toBe(1);
    expect(catalog.types[13]?.samples).toMatchObject([{ objectid: 202 }]);
    expect(catalog.types[42]?.count).toBe(0);
    vi.stubEnv('VITE_KENT_REHBERI_SOURCE', 'planaski');
    const directCatalog = await fetchKentRehberiTypeCatalog({ fetchImpl });
    expect(directCatalog.types[13]?.samples[0]?.adi).toBe('Kadin Danisma Merkezi');
  });

  it('searches directly across categories and finds individual records', async () => {
    const { fetchImpl } = mockTypes({
      10: [row(10, 201)],
      13: [row(13, 202, { adi: 'Kadin Danisma', ilce: 'SİNCAN' })],
    });
    const result = await fetchPlanAskiGeoJsonDirect({ limit: 10, q: 'kadın danışma', ilce: 'sincan', fetchImpl });
    expect(result.features.map((feature) => feature.id)).toEqual([202]);
    const feature = await fetchPlanAskiFeatureDirect(202, { fetchImpl });
    expect(feature?.properties.tur).toBe(13);
    expect(await fetchPlanAskiFeatureDirect(999999, { fetchImpl })).toBeNull();
    vi.stubEnv('VITE_KENT_REHBERI_SOURCE', 'planaski');
    expect((await fetchKentRehberiFeature(202, { fetchImpl }))?.id).toBe(202);
  });

  it.each([
    { adi: 'Title\tTab' },
    { adi: 'Title\u0000Nul' },
    { adres: 'Line\tTab' },
    { ilce: 'District\nBreak' },
    { objectId: 0 },
    { tur: 42 },
    { x: 181 },
    { x: '' },
    { x: 32.8, y: null },
    { adi: 'A'.repeat(4097) },
  ])('rejects malformed official records without silently skipping them', async (overrides) => {
    const { fetchImpl } = mockTypes({ 13: [row(13, 201, overrides)] });
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl })).rejects.toThrow();
  });

  it('fails closed for malformed HTTP payloads and disabled CORS responses', async () => {
    const html = vi.fn(async () => new Response('<html></html>', {
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: html })).rejects.toThrow();
    const failed = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: failed })).rejects.toThrow();
  });

  it('enforces global object IDs and returns bounded filtered results', async () => {
    const { fetchImpl } = mockTypes({
      10: [row(10, 201)],
      13: [row(13, 201)],
    });
    await expect(fetchPlanAskiGeoJsonDirect({ fetchImpl })).rejects.toThrow('shared across categories');

    const bounded = mockTypes({
      10: [row(10, 201), row(10, 202)],
    });
    const result = await fetchPlanAskiGeoJsonDirect({ fetchImpl: bounded.fetchImpl, limit: 1 });
    expect(result.meta).toMatchObject({ count: 1, hasMore: true });
    expect(result.features).toHaveLength(1);
  });

  it('rejects out-of-range categories without requesting arbitrary URLs', async () => {
    const { requests, fetchImpl } = mockTypes({});
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 43, fetchImpl })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
