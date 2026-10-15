import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlanAskiFeatureDirect,
  fetchPlanAskiGeoJsonDirect,
  fetchPlanAskiTypeCatalogDirect,
} from './kentRehberiPlanAskiDirect';

function row(tur: number, id: number, extra: Record<string, unknown> = {}) {
  return {
    objectId: id,
    tur,
    adi: 'Kadın Danışma Merkezi',
    adres: 'Çankaya Caddesi No 3',
    ilce: 'ÇANKAYA',
    mahalle: 'KIZILAY',
    x: 32.8,
    y: 39.9,
    yapan: 1,
    ...extra,
  };
}

function service(data: Readonly<Record<number, unknown>>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: number[];
} {
  const calls: number[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://planaski.ankara.bel.tr');
    expect(url.pathname).toBe('/kentrehberiapi/api/kentrehberi');
    expect([...url.searchParams.keys()]).toEqual(['tur']);
    const tur = Number(url.searchParams.get('tur'));
    calls.push(tur);
    return new Response(JSON.stringify(data[tur] ?? []), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('QA: direct PlanASKI filter and record admission', () => {
  it.each([
    { field: 'q', value: 'x' },
    { field: 'q', value: 'x'.repeat(121) },
    { field: 'q', value: 'search\nquery' },
    { field: 'q', value: 'search\tquery' },
    { field: 'q', value: 17 },
    { field: 'ilce', value: 'a'.repeat(51) },
    { field: 'ilce', value: 'a\u0000b' },
    { field: 'mahalle', value: 'm'.repeat(51) },
    { field: 'mahalle', value: {} },
  ])('blocks untrusted $field before requesting any upstream category', async ({ field, value }) => {
    const upstream = service({});
    await expect(fetchPlanAskiGeoJsonDirect({
      tur: 13,
      [field]: value,
      fetchImpl: upstream.fetchImpl,
    })).rejects.toThrow();
    expect(upstream.calls).toEqual([]);
  });

  it('accepts exact text-budget boundaries and ignores empty trimmed filters', async () => {
    const upstream = service({ 13: [row(13, 101)] });
    const items = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      q: ' '.repeat(5),
      ilce: 'ÇANKAYA',
      mahalle: 'KIZILAY',
      fetchImpl: upstream.fetchImpl,
    });
    expect(items.features.map(f => f.id)).toEqual([101]);
    expect(upstream.calls).toEqual([13]);
    const longName = service({ 13: [row(13, 101, { adi: 'a'.repeat(120) })] });
    const valid = await fetchPlanAskiGeoJsonDirect({
      tur: 13, q: 'a'.repeat(120), fetchImpl: longName.fetchImpl,
    });
    expect(valid.meta?.count).toBe(1);
  });

  it('matches Turkish locale letters in name and district, including dotted/dotless I', async () => {
    const upstream = service({ 13: [
      row(13, 12, { adi: 'KADIN DANIŞMA', ilce: 'SİNCAN', mahalle: 'PINAR' }),
      row(13, 13, { adi: 'KADIN DANIŞMA', ilce: 'ÇANKAYA', mahalle: 'KIZILAY' }),
    ] });
    const result = await fetchPlanAskiGeoJsonDirect({
      tur: 13,
      q: 'kadın danışma',
      ilce: 'sincan',
      mahalle: 'pınar',
      fetchImpl: upstream.fetchImpl,
    });
    expect(result.features.map(f => f.id)).toEqual([12]);
  });

  it('returns stable ascending IDs before limiting results, independent of upstream order', async () => {
    const upstream = service({ 13: [row(13, 8), row(13, 3), row(13, 5)] });
    const result = await fetchPlanAskiGeoJsonDirect({ tur: 13, limit: 2, fetchImpl: upstream.fetchImpl });
    expect(result.features.map(f => f.id)).toEqual([3, 5]);
    expect(result.meta).toMatchObject({ count: 2, limit: 2, hasMore: true });
  });

  it.each([
    { objectId: 0 },
    { objectId: 2147483648 },
    { objectId: 1.5 },
    { objectId: '1.5' },
    { objectId: 'not-a-number' },
    { tur: 12 },
    { tur: -1 },
    { x: 180.01 },
    { y: -90.01 },
    { x: Number.POSITIVE_INFINITY },
    { x: ' ' },
    { y: null },
    { yapan: 32768 },
    { yapan: -32769 },
    { adi: {} },
    { adres: ['private'] },
    { ilce: 'a\r\nb' },
    { mahalle: 'a\nb' },
    { webSayfasi: 'x\u0001y' },
    { durakNo: 'D'.repeat(4097) },
  ])('rejects malformed row values without partially returning a layer: %j', async (overrides) => {
    const upstream = service({ 13: [row(13, 123, overrides)] });
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: upstream.fetchImpl }))
      .rejects.toThrow();
    expect(upstream.calls).toEqual([13]);
  });

  it('allows legal coordinate extremes and fully null coordinate pairs', async () => {
    const upstream = service({ 13: [
      row(13, 3, { x: 180, y: -90 }),
      row(13, 5, { x: -180, y: 90 }),
      row(13, 7, { x: null, y: null }),
    ] });
    const result = await fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: upstream.fetchImpl });
    expect(result.features.map(f => f.geometry)).toEqual([
      { type: 'Point', coordinates: [180, -90] },
      { type: 'Point', coordinates: [-180, 90] },
      null,
    ]);
  });

  it('recognizes the official alternate field names without modifying identifiers', async () => {
    const upstream = service({ 13: [{
      objectid: '101', tur: '13', adi: 'Merkez\r\nHizmet',
      adres: 'Sokak\nNo 8', x: '32,8', y: '39,9', yapan: null,
      web_sayfasi: 'https://example.test', durak_no: 123,
    }] });
    const result = await fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: upstream.fetchImpl });
    expect(result.features[0]).toMatchObject({
      id: 101,
      properties: {
        objectid: 101, tur: 13, adi: 'Merkez Hizmet', adres: 'Sokak No 8',
        webSayfasi: 'https://example.test', durakNo: '123',
      },
    });
  });

  it('rejects malformed snapshots and repeated identifiers before rendering any feature', async () => {
    const invalid = service({ 13: { records: [row(13, 1)] } });
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: invalid.fetchImpl }))
      .rejects.toThrow('bounded array');
    const duplicate = service({ 13: [row(13, 1), row(13, 1)] });
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: duplicate.fetchImpl }))
      .rejects.toThrow('repeated objectid');
  });

  it('enforces the row cap before parsing even one record', async () => {
    const oversized = service({ 13: Array(20_001).fill(null) });
    await expect(fetchPlanAskiGeoJsonDirect({ tur: 13, fetchImpl: oversized.fetchImpl }))
      .rejects.toThrow('bounded array');
  });

  it('rejects duplicate IDs across types consistently for search, catalog, and lookups', async () => {
    const upstream = service({ 10: [row(10, 200)], 13: [row(13, 200)] });
    await expect(fetchPlanAskiGeoJsonDirect({ fetchImpl: upstream.fetchImpl }))
      .rejects.toThrow('shared across categories');
    // The catalog independently reports per-type source summaries and does
    // not claim that a duplicated ID is globally unambiguous.
    const catalog = await fetchPlanAskiTypeCatalogDirect({ fetchImpl: upstream.fetchImpl });
    expect(catalog.types[10]?.count).toBe(1);
    expect(catalog.types[13]?.count).toBe(1);
    await expect(fetchPlanAskiFeatureDirect(200, { fetchImpl: upstream.fetchImpl }))
      .rejects.toThrow('shared across categories');
  });

  it('blocks invalid feature lookups before fetching the type catalog', async () => {
    const upstream = service({});
    for (const id of [0, -1, 1.5, 2147483648, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(fetchPlanAskiFeatureDirect(id, { fetchImpl: upstream.fetchImpl }))
        .rejects.toThrow();
    }
    expect(upstream.calls).toEqual([]);
  });
});
