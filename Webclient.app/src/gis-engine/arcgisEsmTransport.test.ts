import { describe, expect, it, vi } from 'vitest';
import {
  adaptArcgisEsmModule,
  createArcgisEsmTransport,
  getDefaultArcgisEsmSpecifiers,
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
    expect(resolveArcgisEsmSpecifier('esri/core/watchUtils'))
      .toBe('@arcgis/core/core/reactiveUtils.js');
    expect(resolveArcgisEsmSpecifier('esri/tasks/QueryTask'))
      .toBe('@arcgis/core/rest/query.js');
    expect(resolveArcgisEsmSpecifier('esri/tasks/support/Query'))
      .toBe('@arcgis/core/rest/support/Query.js');
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
  it('adapts removed watchUtils and QueryTask APIs onto modern 5.x modules', async () => {
    const handle = { remove: vi.fn() };
    const watch = vi.fn(() => handle);
    const when = vi.fn(() => handle);
    const watchUtils = adaptArcgisEsmModule('esri/core/watchUtils', { watch, when }) as {
      init: (target: object, propertyName: string, callback: (value: unknown) => void) => typeof handle;
      whenTrue: (target: object, propertyName: string, callback: (value: unknown) => void) => typeof handle;
    };
    const target = { ready: true };
    expect(watchUtils.init(target, 'ready', vi.fn())).toBe(handle);
    expect(watchUtils.whenTrue(target, 'ready', vi.fn())).toBe(handle);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(when).toHaveBeenCalledTimes(1);

    const executeQueryJSON = vi.fn().mockResolvedValue({ features: [] });
    const executeForCount = vi.fn().mockResolvedValue(4);
    const QueryTask = adaptArcgisEsmModule('esri/tasks/QueryTask', {
      executeQueryJSON,
      executeForCount,
      executeForIds: vi.fn().mockResolvedValue([1, 2]),
    }) as new (options: { url: string }) => {
      execute: (query: unknown) => Promise<unknown>;
      executeForCount: (query: unknown) => Promise<unknown>;
    };
    const task = new QueryTask({ url: 'https://example.test/FeatureServer/0' });
    await task.execute({ where: '1=1' });
    await task.executeForCount({ where: '1=1' });
    expect(executeQueryJSON).toHaveBeenCalledWith(
      'https://example.test/FeatureServer/0',
      { where: '1=1' },
      undefined,
    );
    expect(executeForCount).toHaveBeenCalledTimes(1);
  });

  it('registers the production 2D/3D modules as statically analyzable Vite imports', () => {
    const specifiers = getDefaultArcgisEsmSpecifiers();
    expect(specifiers).toContain('@arcgis/core/Map.js');
    expect(specifiers).toContain('@arcgis/core/views/MapView.js');
    expect(specifiers).toContain('@arcgis/core/views/SceneView.js');
    expect(specifiers).toContain('@arcgis/core/rest/query.js');
    expect(specifiers).toContain('@arcgis/core/core/reactiveUtils.js');
  });
});
