import {
  attachKentRehberiGeoJsonLayer,
  buildKentRehberiFeaturePath,
  buildKentRehberiRequestPath,
  createKentRehberiGeoJsonLayer,
  fetchKentRehberiFeature,
  fetchKentRehberiGeoJson,
  validateKentRehberiFeatureCollection,
  type KentRehberiGeoJsonFeatureCollection,
} from './kentRehberiGeoJsonLayer';

const demoGeoJson: KentRehberiGeoJsonFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 101,
      geometry: { type: 'Point', coordinates: [32.854, 39.92] },
      properties: {
        objectid: 101,
        adi: 'Yerel Demo Noktası',
        adres: 'Ankara',
        ilce: 'Çankaya',
        mahalle: 'Kızılay',
        tur: 1,
        yapan: null,
        webSayfasi: null,
        durakNo: null,
      },
    },
  ],
  meta: { count: 1, limit: 500, hasMore: false },
};

describe('kentRehberiGeoJsonLayer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('builds only canonical same-origin API paths and enforces the public limit', () => {
    expect(buildKentRehberiRequestPath('/api', 500)).toBe('/api/kent-rehberi?limit=500');
    expect(() => buildKentRehberiRequestPath('https://evil.example/api', 500)).toThrow(/same-origin/i);
    expect(() => buildKentRehberiRequestPath('/api', 0)).toThrow(/between 1 and 2000/i);
    expect(() => buildKentRehberiRequestPath('/api', 2001)).toThrow(/between 1 and 2000/i);
  });

  test('validates the FeatureCollection contract before ArcGIS sees the payload', () => {
    const validated = validateKentRehberiFeatureCollection(demoGeoJson);
    expect(validated.features).toHaveLength(1);
    expect(validated.features[0]?.properties.objectid).toBe(101);

    expect(() => validateKentRehberiFeatureCollection({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: null, properties: { objectid: 0 } },
    ] })).toThrow(/valid objectid/i);

    expect(() => validateKentRehberiFeatureCollection({ type: 'FeatureCollection', features: Array.from({ length: 2001 }, () => ({
      type: 'Feature',
      geometry: null,
      properties: { objectid: 1 },
    })) })).toThrow(/bounded feature limit/i);
  });

  test('fetches the same-origin endpoint with the GeoJSON accept contract', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('/api/kent-rehberi?limit=250');
      expect(init?.credentials).toBe('same-origin');
      expect(new Headers(init?.headers).get('Accept')).toContain('application/geo+json');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(demoGeoJson), {
        status: 200,
        headers: { 'content-type': 'application/geo+json; charset=utf-8' },
      });
    });

    const result = await fetchKentRehberiGeoJson({
      apiBaseUrl: '/api',
      limit: 250,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.features[0]?.id).toBe(101);
  });

  test('does not reflect server error bodies into the client error', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'internal host=private-db; password=should-never-surface',
      { status: 503, headers: { 'content-type': 'text/plain' } },
    ));

    await expect(fetchKentRehberiGeoJson({
      apiBaseUrl: '/api',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow('Kent Rehberi endpoint returned HTTP 503.');

    await expect(fetchKentRehberiGeoJson({
      apiBaseUrl: '/api',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.not.toThrow(/private-db|password/i);
  });

  test('creates, attaches and deterministically disposes the loaded GeoJSONLayer', async () => {
    const createObjectURL = vi.fn(() => 'blob:https://local.test/kent-rehberi');
    const revokeObjectURL = vi.fn(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    const load = vi.fn(async () => undefined);
    const destroy = vi.fn();
    const layer = { load, destroy };
    const GeoJSONLayer = vi.fn(function GeoJSONLayerMock(options: Record<string, unknown>) {
      Object.assign(layer, options);
      return layer;
    });
    const moduleLoader = vi.fn(async () => GeoJSONLayer);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(demoGeoJson), {
      status: 200,
      headers: { 'content-type': 'application/geo+json' },
    }));
    const map = { add: vi.fn(), remove: vi.fn() };

    const handle = await attachKentRehberiGeoJsonLayer({
      map,
      apiBaseUrl: '/api',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
      moduleLoader: moduleLoader as never,
    });

    expect(moduleLoader).toHaveBeenCalledWith('esri/layers/GeoJSONLayer');
    expect(GeoJSONLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'kent-rehberi-postgis',
      title: 'Kent Rehberi',
      url: 'blob:https://local.test/kent-rehberi',
      objectIdField: 'objectid',
      fields: expect.arrayContaining([
        expect.objectContaining({ name: 'objectid', type: 'oid' }),
        expect.objectContaining({ name: 'adi', type: 'string' }),
      ]),
    }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(map.add).toHaveBeenCalledWith(layer);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://local.test/kent-rehberi');
    expect(handle.featureCount).toBe(1);

    handle.dispose();
    handle.dispose();

    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(map.remove).toHaveBeenCalledWith(layer);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('encodes bounded backend filters and object-detail paths', () => {
    expect(buildKentRehberiRequestPath('/api', 100, {
      q: 'kadın danışma',
      tur: 12,
      ilce: 'Çankaya',
      mahalle: 'Kızılay',
    })).toBe(
      '/api/kent-rehberi?limit=100&q=kad%C4%B1n+dan%C4%B1%C5%9Fma&ilce=%C3%87ankaya&mahalle=K%C4%B1z%C4%B1lay&tur=12',
    );
    expect(buildKentRehberiFeaturePath('/api', 42)).toBe('/api/kent-rehberi/42');
    expect(() => buildKentRehberiFeaturePath('/api', 0)).toThrow(/positive integer/i);
    expect(() => buildKentRehberiRequestPath('/api', 100, { q: 'x' })).toThrow(/between 2 and 120/i);
  });

  test('fetches one backend feature and treats 404 as a normal miss', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/404')) {
        return new Response('', { status: 404 });
      }
      expect(input).toBe('/api/kent-rehberi/101');
      return new Response(JSON.stringify(demoGeoJson.features[0]), {
        status: 200,
        headers: { 'content-type': 'application/geo+json' },
      });
    });

    const found = await fetchKentRehberiFeature(101, {
      apiBaseUrl: '/api',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const missing = await fetchKentRehberiFeature(404, {
      apiBaseUrl: '/api',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(found?.properties.objectid).toBe(101);
    expect(missing).toBeNull();
  });

  test('supports a category-specific renderer without changing the shared GeoJSON contract', async () => {
    const createObjectURL = vi.fn(() => 'blob:https://local.test/category');
    const revokeObjectURL = vi.fn(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    const load = vi.fn(async () => undefined);
    const destroy = vi.fn();
    const layer = { load, destroy };
    const GeoJSONLayer = vi.fn(function GeoJSONLayerMock(options: Record<string, unknown>) {
      Object.assign(layer, options);
      return layer;
    });
    const moduleLoader = vi.fn(async () => GeoJSONLayer);
    const renderer = Object.freeze({
      type: 'simple',
      symbol: Object.freeze({ type: 'picture-marker', url: 'images/icons/map/ABB/parklar.svg' }),
    });

    await createKentRehberiGeoJsonLayer(
      demoGeoJson,
      moduleLoader as never,
      {
        id: 'kent-rehberi-parks',
        title: 'Parklar',
        renderer,
      },
    );

    expect(GeoJSONLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'kent-rehberi-parks',
      title: 'Parklar',
      renderer,
    }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://local.test/category');
  });

});
