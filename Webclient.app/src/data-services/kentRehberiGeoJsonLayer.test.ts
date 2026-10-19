import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attachKentRehberiGeoJsonLayer,
  createKentRehberiGeoJsonLayer,
  resolveKentRehberiOverviewIconKey,
  fetchKentRehberiFeature,
  fetchKentRehberiGeoJson,
  fetchKentRehberiTypeCatalog,
  type KentRehberiGeoJsonFeatureCollection,
} from './kentRehberiGeoJsonLayer';

const demoGeoJson: KentRehberiGeoJsonFeatureCollection = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 101,
    geometry: { type: 'Point', coordinates: [32.854, 39.92] },
    properties: {
      objectid: 101, adi: 'Yerel Demo Noktası', adres: 'Ankara',
      ilce: 'Çankaya', mahalle: 'Kızılay', tur: 13, yapan: null,
      webSayfasi: null, durakNo: null,
    },
  }],
  meta: { count: 1, limit: 500, hasMore: false },
};

const response = (rows: readonly unknown[]): Response => new Response(JSON.stringify(rows), {
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const row = (tur: number, objectId: number) => ({
  objectId, adi: 'Kent Rehberi kaydı', adres: 'Ankara',
  ilce: 'Çankaya', mahalle: 'Kızılay', x: 32.854, y: 39.92,
  tur, yapan: null, webSayfasi: null, durakNo: null,
});

describe('PlanASKI-only Kent Rehberi GeoJSON layer', () => {
  afterEach(() => vi.restoreAllMocks());

  test('resolves registered SVG symbols from Turkish POI names', () => {
    expect(resolveKentRehberiOverviewIconKey({ adi: 'Seğmen Su Fabrikası' })).toBe('segmen');
    expect(resolveKentRehberiOverviewIconKey({ adi: 'Kütüphane' })).toBe('kutuphane');
    expect(resolveKentRehberiOverviewIconKey({ adi: 'Bilinmeyen bir nokta' })).toBe('default');
  });

  test('attaches the overview with an SVG unique-value renderer', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:overview-svg' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const layer = { load: vi.fn(async () => undefined), destroy: vi.fn() };
    const captured: { options: Record<string, unknown> | null } = { options: null };
    const Layer = vi.fn(function (options: Record<string, unknown>) { captured.options = options; return layer; });
    const map = { add: vi.fn(), remove: vi.fn() };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const tur = Number(new URL(String(input)).searchParams.get('tur'));
      return response(tur === 13 ? [{ ...row(13, 101), adi: 'Seğmen Su Fabrikası' }] : []);
    }) as typeof fetch;

    const handle = await attachKentRehberiGeoJsonLayer({
      map,
      moduleLoader: (async () => Layer) as never,
      fetchImpl,
      tur: 13,
      limit: 10,
    });

    const renderer = captured.options?.renderer as {
      type?: string;
      field?: string;
      uniqueValueInfos?: Array<{ value: string; symbol: { url: string } }>;
      defaultSymbol?: { url: string };
    };
    expect(renderer).toMatchObject({ type: 'unique-value', field: 'iconKey' });
    expect(renderer.uniqueValueInfos?.every((entry) => /\\.svg$/i.test(entry.symbol.url))).toBe(true);
    expect(renderer.uniqueValueInfos?.find((entry) => entry.value === 'segmen')?.symbol.url).toContain('segmensu.svg');
    expect(renderer.defaultSymbol?.url).toContain('pictureMarker.png');
    expect(map.add).toHaveBeenCalledWith(layer);
    handle.dispose();
  });

  test('always fetches the official PlanASKI endpoint, even if a legacy API flag is present', async () => {
    vi.stubEnv('VITE_KENT_REHBERI_SOURCE', 'api');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur=13');
      expect(init?.credentials).toBe('omit');
      expect(init?.mode).toBe('cors');
      return response([row(13, 101)]);
    }) as typeof fetch;

    const result = await fetchKentRehberiGeoJson({ tur: 13, limit: 10, fetchImpl });
    expect(result.features.map(feature => feature.id)).toEqual([101]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cancels a stalled SDK load and releases the layer and Blob URL immediately', async () => {
    const abort = new AbortController();
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:cancelled' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const layer = { load: vi.fn(() => new Promise(() => undefined)), cancelLoad: vi.fn(), destroy: vi.fn() };
    const Layer = vi.fn(function () { return layer; });
    const loading = createKentRehberiGeoJsonLayer(demoGeoJson, (async () => Layer) as never, {}, abort.signal);
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(layer.load).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(layer.cancelLoad).toHaveBeenCalledOnce();
    expect(layer.destroy).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:cancelled');
  });

  test('does not leave a loaded layer resident if attaching it to the map fails', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:attach-failed' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const layer = { load: vi.fn(async () => undefined), destroy: vi.fn() };
    const Layer = vi.fn(function () { return layer; });
    const error = new Error('map disposed');
    await expect(attachKentRehberiGeoJsonLayer({
      map: { add: () => { throw error; }, remove: vi.fn() },
      moduleLoader: (async () => Layer) as never,
      fetchImpl: (async () => response([row(13, 101)])) as typeof fetch,
      tur: 13,
    })).rejects.toBe(error);
    expect(layer.destroy).toHaveBeenCalledOnce();
  });

  test('individual feature and type-catalog helpers keep the same direct upstream boundary', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://planaski.ankara.bel.tr');
      expect(url.pathname).toBe('/kentrehberiapi/api/kentrehberi');
      const tur = Number(url.searchParams.get('tur'));
      return response(tur === 13 ? [row(13, 101)] : []);
    }) as typeof fetch;

    const catalog = await fetchKentRehberiTypeCatalog({ fetchImpl });
    expect(catalog.types).toHaveLength(43);
    expect((await fetchKentRehberiFeature(101, { fetchImpl }))?.id).toBe(101);
    expect(fetchImpl.mock.calls.every(([input]) => String(input).startsWith('https://planaski.ankara.bel.tr/'))).toBe(true);
  });
});
