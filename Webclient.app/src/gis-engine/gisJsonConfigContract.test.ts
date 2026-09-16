import {
  diffGisConfigs,
  parseGisJsonConfig,
  resolveLayerResourceUrl,
} from './gisJsonConfigContract';

const base = () => ({
  version: 2,
  services: [
    { id: 'kent', url: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer', kind: 'feature' },
    { id: 'scene', url: 'https://example.invalid/arcgis/rest/services/Kent3D/SceneServer', kind: 'scene' },
  ],
  layers: [
    { id: 'group', title: 'Grup', serviceId: 'kent', layerId: 99, children: ['poi'], visible: true },
    { id: 'poi', title: 'Noktalar', serviceId: 'kent', layerId: 0, parentId: 'group', iconKey: 'park', visible: true },
    { id: 'buildings', title: 'Binalar', serviceId: 'scene', mode: '3d', visible: false },
  ],
});

describe('gisJsonConfigContract', () => {
  it('parses ArcGIS-only service/layer configuration and resolves concrete sublayers', () => {
    const config = parseGisJsonConfig(base(), { knownIconKeys: new Set(['park']) });
    expect(config.version).toBe(2);
    expect(config.roots).toEqual(expect.arrayContaining(['group', 'buildings']));
    expect(resolveLayerResourceUrl(config, 'poi'))
      .toBe('https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0');
    expect(resolveLayerResourceUrl(config, 'buildings'))
      .toBe('https://example.invalid/arcgis/rest/services/Kent3D/SceneServer');
  });

  it('rejects WMS and WFS resources rather than adding protocol fallbacks', () => {
    const wms = base();
    wms.services[0] = { id: 'kent', url: 'https://example.invalid/wms?service=WMS', kind: 'feature' };
    expect(() => parseGisJsonConfig(wms)).toThrow();
    try {
      parseGisJsonConfig(wms);
    } catch (error: any) {
      expect(error.issues.some((entry: any) => entry.code === 'forbidden-ogc-service')).toBe(true);
    }
  });

  it('does not invent a FeatureServer sublayer when layerId is missing', () => {
    const invalid = base();
    invalid.layers[1] = { id: 'poi', title: 'Noktalar', serviceId: 'kent', parentId: 'group', visible: true } as any;
    expect(() => parseGisJsonConfig(invalid)).toThrow();
    try {
      parseGisJsonConfig(invalid);
    } catch (error: any) {
      expect(error.issues.some((entry: any) => entry.code === 'missing-concrete-layer-id')).toBe(true);
    }
  });

  it('detects directed parent cycles without treating a normal parent-child pair as a cycle', () => {
    expect(() => parseGisJsonConfig(base(), { knownIconKeys: new Set(['park']) })).not.toThrow();
    const cyclic = base();
    cyclic.layers[0] = { ...cyclic.layers[0], parentId: 'poi' };
    cyclic.layers[1] = { ...cyclic.layers[1], parentId: 'group' };
    expect(() => parseGisJsonConfig(cyclic)).toThrow();
    try {
      parseGisJsonConfig(cyclic);
    } catch (error: any) {
      expect(error.issues.some((entry: any) => entry.code === 'layer-cycle')).toBe(true);
    }
  });

  it('reports unknown shared icon keys without creating a second icon authority', () => {
    const config = parseGisJsonConfig(base(), { knownIconKeys: new Set(['hospital']) });
    expect(config.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-icon-key', severity: 'warning' }),
    ]));
  });

  it('rejects duplicate service and layer identifiers', () => {
    const invalid = base();
    invalid.services.push({ ...invalid.services[0] });
    invalid.layers.push({ ...invalid.layers[1] });
    expect(() => parseGisJsonConfig(invalid)).toThrow();
    try {
      parseGisJsonConfig(invalid);
    } catch (error: any) {
      expect(error.issues.map((entry: any) => entry.code)).toEqual(expect.arrayContaining([
        'duplicate-service-id',
        'duplicate-layer-id',
      ]));
    }
  });

  it('computes config deltas for targeted lifecycle invalidation', () => {
    const before = parseGisJsonConfig(base(), { knownIconKeys: new Set(['park']) });
    const nextValue = base();
    nextValue.services[0] = { ...nextValue.services[0], cacheTtlMs: 30000 };
    nextValue.layers[1] = { ...nextValue.layers[1], opacity: 0.5 };
    nextValue.layers.push({ id: 'new', title: 'Yeni', serviceId: 'kent', layerId: 2, visible: false } as any);
    const after = parseGisJsonConfig(nextValue, { knownIconKeys: new Set(['park']) });
    const diff = diffGisConfigs(before, after);
    expect(diff.changedServices).toContain('kent');
    expect(diff.changedLayers).toContain('poi');
    expect(diff.addedLayers).toContain('new');
  });
});
