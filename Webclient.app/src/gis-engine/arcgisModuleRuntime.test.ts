import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as esriLoader from 'esri-loader';
import {
  getArcgisModuleRuntimeSnapshot,
  loadArcgisModule,
  resetArcgisModuleRuntimeCache,
  resetArcgisModuleTransport,
  setArcgisModuleTransport,
  type ArcgisModuleTransport,
} from './arcgisModuleRuntime';

vi.mock('esri-loader', () => ({
  loadModules: vi.fn(),
  setDefaultOptions: vi.fn(),
}));

const loadModulesMock = vi.mocked(esriLoader.loadModules);

describe('arcgisModuleRuntime', () => {
  beforeEach(() => {
    resetArcgisModuleTransport();
    resetArcgisModuleRuntimeCache();
    vi.clearAllMocks();
  });

  it('deduplicates concurrent and repeated module requests', async () => {
    const moduleValue = { kind: 'SceneView' };
    loadModulesMock.mockResolvedValue([moduleValue]);

    const first = loadArcgisModule<typeof moduleValue>('esri/views/SceneView');
    const second = loadArcgisModule<typeof moduleValue>('esri/views/SceneView');

    await expect(first).resolves.toBe(moduleValue);
    await expect(second).resolves.toBe(moduleValue);
    expect(loadModulesMock).toHaveBeenCalledTimes(1);
    expect(getArcgisModuleRuntimeSnapshot()).toMatchObject({
      backend: 'legacy-amd',
      cachedModules: 1,
      loadRequests: 1,
      cacheHits: 1,
      failures: 0,
    });
  });

  it('evicts failed requests so a later retry can recover', async () => {
    const failure = new Error('temporary ArcGIS loader failure');
    const recovered = { kind: 'FeatureLayer' };
    loadModulesMock
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([recovered]);

    await expect(loadArcgisModule('esri/layers/FeatureLayer')).rejects.toBe(failure);
    await expect(loadArcgisModule('esri/layers/FeatureLayer')).resolves.toBe(recovered);

    expect(loadModulesMock).toHaveBeenCalledTimes(2);
    expect(getArcgisModuleRuntimeSnapshot()).toMatchObject({
      cachedModules: 1,
      loadRequests: 2,
      failures: 1,
    });
  });

  it('rejects empty module identifiers before invoking the transport', async () => {
    await expect(loadArcgisModule('   ')).rejects.toThrow('ArcGIS module id is required.');
    expect(loadModulesMock).not.toHaveBeenCalled();
  });

  it('can swap the module transport without changing consumers', async () => {
    const esmValue = { kind: 'MapView', source: 'esm' };
    const transport: ArcgisModuleTransport = {
      name: 'arcgis-core-esm-test',
      loadModules: vi.fn(async (moduleIds) => moduleIds.map(() => esmValue)),
    };

    const snapshot = setArcgisModuleTransport(transport);
    expect(snapshot).toMatchObject({ backend: 'arcgis-core-esm-test', cachedModules: 0 });

    await expect(loadArcgisModule('esri/views/MapView')).resolves.toBe(esmValue);
    expect(transport.loadModules).toHaveBeenCalledWith(['esri/views/MapView']);
    expect(loadModulesMock).not.toHaveBeenCalled();
  });

  it('clears cached AMD modules when the transport changes', async () => {
    const legacyValue = { source: 'amd' };
    loadModulesMock.mockResolvedValue([legacyValue]);
    await expect(loadArcgisModule('esri/Map')).resolves.toBe(legacyValue);
    expect(getArcgisModuleRuntimeSnapshot().cachedModules).toBe(1);

    const nextValue = { source: 'next' };
    setArcgisModuleTransport({
      name: 'next-transport',
      loadModules: async () => [nextValue],
    });

    expect(getArcgisModuleRuntimeSnapshot().cachedModules).toBe(0);
    await expect(loadArcgisModule('esri/Map')).resolves.toBe(nextValue);
  });

  it('rejects transports that cannot load modules', () => {
    expect(() => setArcgisModuleTransport({ name: 'invalid' } as ArcgisModuleTransport))
      .toThrow('ArcGIS module transport must provide loadModules().');
  });
});
