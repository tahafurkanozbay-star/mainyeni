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
    expect(getArcgisModuleRuntimeSnapshot()).toMatchObject({ backend: 'test-esm', cachedModules: 1, loadRequests: 1, cacheHits: 1, failures: 0 });
  });

  it('evicts failed requests so a later retry can recover', async () => {
    const failure = new Error('temporary ArcGIS loader failure');
    const recovered = { kind: 'FeatureLayer' };
    loadModulesMock.mockRejectedValueOnce(failure).mockResolvedValueOnce([recovered]);
    await expect(loadArcgisModule('esri/layers/FeatureLayer')).rejects.toBe(failure);
    await expect(loadArcgisModule('esri/layers/FeatureLayer')).resolves.toBe(recovered);
    expect(loadModulesMock).toHaveBeenCalledTimes(2);
    expect(getArcgisModuleRuntimeSnapshot()).toMatchObject({ cachedModules: 1, loadRequests: 2, failures: 1 });
  });

  it('rejects empty module identifiers before invoking the transport', async () => {
    await expect(loadArcgisModule('   ')).rejects.toThrow('ArcGIS module id is required.');
    expect(loadModulesMock).not.toHaveBeenCalled();
  });

  it('can swap the module transport without changing consumers', async () => {
    const esmValue = { kind: 'MapView', source: 'esm' };
    const transport: ArcgisModuleTransport = { name: 'arcgis-core-esm-test', loadModules: vi.fn(async (moduleIds) => moduleIds.map(() => esmValue)) };
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
    setArcgisModuleTransport({ name: 'next-transport', loadModules: async () => [nextValue] });
    expect(getArcgisModuleRuntimeSnapshot().cachedModules).toBe(0);
    await expect(loadArcgisModule('esri/Map')).resolves.toBe(nextValue);
  });

  it('resets custom transports to the production @arcgis/core ESM backend', () => {
    const snapshot = resetArcgisModuleTransport();
    expect(snapshot).toMatchObject({ backend: 'arcgis-core-esm', cachedModules: 0 });
  });

  it('rejects transports that cannot load modules', () => {
    expect(() => setArcgisModuleTransport({ name: 'invalid' } as ArcgisModuleTransport))
      .toThrow('ArcGIS module transport must provide a module batch loader.');
  });
});

describe('cancelled module batches retain cache ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks(); resetArcgisModuleRuntimeCache(); setArcgisModuleTransport(testTransport);
  });

  it('releases a stalled cache slot on cancellation and allows retry', async () => {
    loadModulesMock.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce(['ready']);
    const lifetime = new AbortController();
    const pending = loadArcgisModule('esri/views/SceneView', { signal: lifetime.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    lifetime.abort(); await rejected;
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    expect(loadModulesMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a failed abandoned batch evict a successful retry', async () => {
    let reject!: (reason: unknown) => void;
    loadModulesMock.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce(['ready']);
    const lifetime = new AbortController();
    const pending = loadArcgisModule('esri/views/SceneView', { signal: lifetime.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    lifetime.abort(); await rejected;
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    reject(new Error('abandoned transport failed'));
    await Promise.resolve(); await Promise.resolve();
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    expect(loadModulesMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a second cancelled subscriber evict the newer cache slot', async () => {
    loadModulesMock.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce(['ready']);
    const first = new AbortController(); const second = new AbortController();
    const a = loadArcgisModule('esri/views/SceneView', { signal: first.signal });
    const b = loadArcgisModule('esri/views/SceneView', { signal: second.signal });
    const rejectedA = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const rejectedB = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    first.abort(); await rejectedA;
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    second.abort(); await rejectedB;
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    expect(loadModulesMock).toHaveBeenCalledTimes(2);
  });

  it('cleans its abort listener after success and leaves the ready cache reusable', async () => {
    loadModulesMock.mockResolvedValue(['ready']);
    const lifetime = new AbortController(); const remove = vi.spyOn(lifetime.signal, 'removeEventListener');
    await expect(loadArcgisModule('esri/views/SceneView', { signal: lifetime.signal })).resolves.toBe('ready');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    lifetime.abort();
    await expect(loadArcgisModule('esri/views/SceneView')).resolves.toBe('ready');
    expect(loadModulesMock).toHaveBeenCalledOnce();
  });
});
