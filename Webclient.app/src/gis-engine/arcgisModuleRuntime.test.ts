import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getArcgisModuleRuntimeSnapshot,
  loadArcgisModule,
  resetArcgisModuleRuntimeCache,
  resetArcgisModuleTransport,
  setArcgisModuleTransport,
  type ArcgisModuleTransport,
} from './arcgisModuleRuntime';

const loadModulesMock = vi.fn();
const testTransport: ArcgisModuleTransport = {
  name: 'test-esm',
  loadModules: loadModulesMock,
};

describe('arcgisModuleRuntime', () => {
  beforeEach(() => {
    resetArcgisModuleTransport();
    setArcgisModuleTransport(testTransport);
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
      backend: 'test-esm',
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

  it('clears cached modules when the transport changes', async () => {
    const firstValue = { source: 'first' };
    loadModulesMock.mockResolvedValue([firstValue]);
    await expect(loadArcgisModule('esri/Map')).resolves.toBe(firstValue);
    expect(getArcgisModuleRuntimeSnapshot().cachedModules).toBe(1);

    const nextValue = { source: 'next' };
    setArcgisModuleTransport({
      name: 'next-transport',
      loadModules: async () => [nextValue],
    });

    expect(getArcgisModuleRuntimeSnapshot().cachedModules).toBe(0);
    await expect(loadArcgisModule('esri/Map')).resolves.toBe(nextValue);
  });

  it('resets custom transports to the production @arcgis/core ESM backend', () => {
    const snapshot = resetArcgisModuleTransport();
    expect(snapshot).toMatchObject({ backend: 'arcgis-core-esm', cachedModules: 0 });
  });

  it('rejects transports that cannot load modules', () => {
    expect(() => setArcgisModuleTransport({ name: 'invalid' } as ArcgisModuleTransport))
      .toThrow('ArcGIS module transport must provide loadModules().');
  });
});
