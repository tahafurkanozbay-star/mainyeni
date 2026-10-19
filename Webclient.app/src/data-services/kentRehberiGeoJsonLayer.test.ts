import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attachKentRehberiGeoJsonLayer,
  createKentRehberiGeoJsonLayer,
  createKentRehberiPopupContent,
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
    expect(resolveKentRehberiOverviewIconKey({ adi: 'Otopark' })).toBe('default');
  });

  test('popup shows only the address and opens Google Maps actions for the selected point', () => {
    const popup = createKentRehberiPopupContent({
      graphic: {
        attributes: {
          adres: '  Kızılay\nAnkara  ',
          ilce: 'Çankaya',
          mahalle: 'Kızılay',
          objectid: 101,
        },
        geometry: { type: 'point', longitude: 32.854, latitude: 39.92 },
      },
    });

    expect(popup.querySelector('.kent-rehberi-popup__address')?.textContent).toBe('Kızılay Ankara');
    expect(popup.textContent).not.toContain('Adres:');
    expect(popup.textContent).not.toContain('Çankaya');
    expect(popup.textContent).not.toContain('101');

    const links = [...popup.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(['Yol tarifi al', 'Sokak görünümü al']);
    expect(links.every((link) => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true);

    const directions = new URL(links[0].href);
    expect(directions.origin).toBe('https://www.google.com');
    expect(directions.pathname).toBe('/maps/dir/');
    expect(directions.searchParams.get('api')).toBe('1');
    expect(directions.searchParams.get('destination')).toBe('39.92,32.854');

    const streetView = new URL(links[1].href);
    expect(streetView.origin).toBe('https://www.google.com');
    expect(streetView.searchParams.get('map_action')).toBe('pano');
    expect(streetView.searchParams.get('viewpoint')).toBe('39.92,32.854');
  });

  test('popup falls back to an address for directions but does not invent a Street View coordinate', () => {
    const popup = createKentRehberiPopupContent({
      graphic: { attributes: { adres: 'Atatürk Bulvarı, Ankara' } },
    });

    const links = [...popup.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(['Yol tarifi al']);
    const directions = new URL(links[0].href);
    expect(directions.searchParams.get('destination')).toBe('Atatürk Bulvarı, Ankara');
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
    });

    const renderer = captured.options?.renderer as {
      type?: string;
      field?: string;
      uniqueValueInfos?: Array<{ value: string; symbol: { url: string } }>;
      defaultSymbol?: { url: string };
    };
    expect(renderer).toMatchObject({ type: 'unique-value', field: 'iconKey' });
    expect(renderer.uniqueValueInfos?.every((entry) => /\.svg$/i.test(entry.symbol.url))).toBe(true);
    expect(renderer.uniqueValueInfos?.find((entry) => entry.value === 'segmen')?.symbol.url).toContain('segmensu.svg');
    expect(renderer.defaultSymbol).toMatchObject({ type: 'simple-marker', size: 1, color: [0, 0, 0, 0] });
    expect(map.add).toHaveBeenCalledWith(layer);

    const startupRequestCount = fetchImpl.mock.calls.length;
    const catalog = await fetchKentRehberiTypeCatalog({ fetchImpl });
    expect(catalog.types).toHaveLength(43);
    expect(fetchImpl).toHaveBeenCalledTimes(startupRequestCount);

    handle.dispose();
  });

  test('popup shows only the address plus Google Maps directions and Street View', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:popup-test' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const layer = { load: vi.fn(async () => undefined), destroy: vi.fn() };
    const captured: { options: Record<string, unknown> | null } = { options: null };
    const Layer = vi.fn(function (options: Record<string, unknown>) {
      captured.options = options;
      return layer;
    });

    await createKentRehberiGeoJsonLayer(demoGeoJson, (async () => Layer) as never);
    const template = captured.options?.popupTemplate as {
      title?: string;
      returnGeometry?: boolean;
      content?: (feature: { graphic: {
        attributes: Record<string, unknown>;
        geometry: { longitude: number; latitude: number };
      } }) => HTMLElement;
    };
    expect(template.title).toBe('{adi}');
    expect(template.returnGeometry).toBe(true);
    expect(typeof template.content).toBe('function');

    const content = template.content?.({
      graphic: {
        attributes: {
          adi: 'Yerel Demo Noktası',
          adres: 'Kocatepe Mahallesi, Ankara',
          objectid: 101,
          ilce: 'Çankaya',
          mahalle: 'Kızılay',
          tur: 13,
          durakNo: 'D-101',
        },
        geometry: { longitude: 32.854, latitude: 39.92 },
      },
    });
    expect(content?.querySelector('.kent-rehberi-popup__address')?.textContent)
      .toBe('Kocatepe Mahallesi, Ankara');
    expect(content?.textContent).not.toContain('Adres:');
    expect(content?.textContent).not.toContain('Çankaya');
    expect(content?.textContent).not.toContain('D-101');

    const links = Array.from(content?.querySelectorAll('a') ?? []);
    expect(links.map((link) => link.textContent)).toEqual(['Yol tarifi al', 'Sokak görünümü al']);
    expect(links.every((link) => link.target === '_blank' && link.rel.includes('noopener'))).toBe(true);

    const directions = new URL(links[0].href);
    expect(directions.origin).toBe('https://www.google.com');
    expect(directions.pathname).toBe('/maps/dir/');
    expect(directions.searchParams.get('api')).toBe('1');
    expect(directions.searchParams.get('destination')).toBe('39.92,32.854');

    const streetView = new URL(links[1].href);
    expect(streetView.origin).toBe('https://www.google.com');
    expect(streetView.pathname).toBe('/maps/@');
    expect(streetView.searchParams.get('api')).toBe('1');
    expect(streetView.searchParams.get('map_action')).toBe('pano');
    expect(streetView.searchParams.get('viewpoint')).toBe('39.92,32.854');
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
