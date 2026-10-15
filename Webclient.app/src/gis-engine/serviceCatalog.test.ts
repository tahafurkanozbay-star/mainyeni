import {
  GIS_SERVICE_TYPES,
  enforceNetworkPolicy,
  hasSameOrigin,
  inferServiceType,
  normalizeServiceUrl,
  isDisallowedServiceType,
  sanitizeCatalog,
  sanitizeService,
} from './serviceCatalog';

describe('serviceCatalog', () => {
  test('infers ArcGIS REST service types from observed endpoint suffixes', () => {
    expect(inferServiceType({ url: '/arcgis/rest/services/roads/MapServer' }))
      .toBe(GIS_SERVICE_TYPES.MAP_SERVER);
    expect(inferServiceType({ url: '/arcgis/rest/services/parks/FeatureServer/0' }))
      .toBe(GIS_SERVICE_TYPES.FEATURE_SERVER);
    expect(inferServiceType({ url: '/arcgis/rest/services/buildings/SceneServer' }))
      .toBe(GIS_SERVICE_TYPES.SCENE_SERVER);
  });

  test('canonicalizes explicitly configured service type casing', () => {
    expect(inferServiceType({ type: 'featureServer', url: '/proxy/features' }))
      .toBe(GIS_SERVICE_TYPES.FEATURE_SERVER);
    expect(inferServiceType({ type: 'MAPSERVER', url: '/proxy/map' }))
      .toBe(GIS_SERVICE_TYPES.MAP_SERVER);
    expect(inferServiceType({ type: 'glb', url: '/models/a.glb' }))
      .toBe(GIS_SERVICE_TYPES.GLTF);
  });

  test('rejects WMS, WFS and WMTS regardless of casing', () => {
    ['WMS', 'wfs', 'WmTs', 'ogc-wms'].forEach((type) => {
      expect(isDisallowedServiceType(type)).toBe(true);
      expect(() => sanitizeService({ id: type, type, url: '/legacy' })).toThrow(/not supported/i);
    });
  });

  test('normalizes numeric strings without widening opacity or scale bounds', () => {
    const safe = sanitizeService({
      id: 'roads',
      type: 'MapServer',
      url: '/arcgis/rest/services/roads/MapServer?token=client-leak#fragment',
      opacity: '0.35',
      minScale: '250000',
      maxScale: '-5',
    });

    expect(safe.opacity).toBe(0.35);
    expect(safe.minScale).toBe(250000);
    expect(safe.maxScale).toBe(0);
    expect(safe.url).not.toContain('token=');
    expect(safe.url).not.toContain('#');
  });

  test('rejects non-network service URL schemes, malformed URLs and embedded credentials', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain,not-a-service',
      'blob:https://localhost/123',
      'file:///etc/passwd',
      'https://user:secret@gis.example.test/arcgis/MapServer',
      'http://user:secret@gis.example.test/arcgis/MapServer',
      'http://[invalid',
    ]) {
      expect(normalizeServiceUrl(url)).toBe('');
      expect(() => sanitizeService({ id: 'unsafe', type: 'MapServer', url }))
        .toThrow(/has no URL/i);
      expect(sanitizeCatalog([{ id: 'unsafe', type: 'MapServer', url }])).toEqual([]);
    }
  });

  test('preserves valid relative and HTTPS ArcGIS endpoints without URL secrets', () => {
    const relative = normalizeServiceUrl('/arcgis/MapServer?token=secret#fragment');
    expect(relative).not.toContain('token=');
    expect(relative).not.toContain('#');
    expect(relative).toContain('/arcgis/MapServer');
    expect(normalizeServiceUrl('https://maps.example.test/arcgis/FeatureServer/0'))
      .toBe('https://maps.example.test/arcgis/FeatureServer/0');
    expect(sanitizeService({
      id: 'arcgis',
      type: 'FeatureServer',
      url: 'https://maps.example.test/arcgis/FeatureServer/0',
    }).id).toBe('arcgis');
  });

  test('drops invalid and disallowed services from runtime catalogs', () => {
    expect(sanitizeCatalog([
      { id: 'roads', type: 'MapServer', url: '/roads/MapServer' },
      { id: 'legacy', type: 'WMS', url: '/legacy/wms' },
      { id: '', type: 'FeatureServer', url: '/invalid/FeatureServer' },
      { id: 'roads', type: 'FeatureServer', url: '/duplicate/FeatureServer' },
    ]).map((service) => service.id)).toEqual(['roads']);
  });

  test('recognizes same-origin endpoints and blocks unapproved remote endpoints', () => {
    expect(hasSameOrigin('/Gis/Proxy')).toBe(true);
    expect(enforceNetworkPolicy({
      id: 'same-origin',
      type: 'FeatureServer',
      url: '/Gis/Proxy',
    })).toBe(true);

    expect(() => enforceNetworkPolicy({
      id: 'remote',
      type: 'FeatureServer',
      url: 'https://remote.example.test/arcgis/FeatureServer/0',
    })).toThrow(/Remote GIS endpoint is blocked/i);
  });
});
