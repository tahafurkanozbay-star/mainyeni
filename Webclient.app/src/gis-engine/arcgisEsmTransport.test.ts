import { describe, expect, it, vi } from 'vitest';
import {
  createArcgisEsmTransport,
  resolveArcgisEsmSpecifier,
  unwrapArcgisEsmModule,
} from './arcgisEsmTransport';

describe('arcgisEsmTransport', () => {
  it('translates legacy ArcGIS AMD ids into @arcgis/core ESM specifiers', () => {
    expect(resolveArcgisEsmSpecifier('esri/layers/FeatureLayer'))
      .toBe('@arcgis/core/layers/FeatureLayer.js');
    expect(resolveArcgisEsmSpecifier('@arcgis/core/rest/identify'))
      .toBe('@arcgis/core/rest/identify.js');
    expect(resolveArcgisEsmSpecifier('@arcgis/core/Graphic.js'))
      .toBe('@arcgis/core/Graphic.js');
  });

  it('rejects unsupported non-ArcGIS module ids', () => {
    expect(() => resolveArcgisEsmSpecifier('dojo/Deferred'))
      .toThrow('Unsupported ArcGIS module id');
  });

  it('unwraps default-export classes and preserves namespace modules', () => {
    const FeatureLayer = class FeatureLayer {};
    expect(unwrapArcgisEsmModule({ default: FeatureLayer })).toBe(FeatureLayer);

    const identifyNamespace = { identify: vi.fn() };
    expect(unwrapArcgisEsmModule(identifyNamespace)).toBe(identifyNamespace);
  });

  it('loads legacy ids through the injected ESM importer in request order', async () => {
    const FeatureLayer = class FeatureLayer {};
    const identifyNamespace = { identify: vi.fn() };
    const importer = vi.fn(async (specifier: string) => {
      if (specifier.endsWith('/FeatureLayer.js')) return { default: FeatureLayer };
      return identifyNamespace;
    });
    const transport = createArcgisEsmTransport(importer);

    await expect(transport.loadModules([
      'esri/layers/FeatureLayer',
      'esri/rest/identify',
    ])).resolves.toEqual([FeatureLayer, identifyNamespace]);

    expect(importer).toHaveBeenNthCalledWith(1, '@arcgis/core/layers/FeatureLayer.js');
    expect(importer).toHaveBeenNthCalledWith(2, '@arcgis/core/rest/identify.js');
    expect(transport.name).toBe('arcgis-core-esm');
  });
});
