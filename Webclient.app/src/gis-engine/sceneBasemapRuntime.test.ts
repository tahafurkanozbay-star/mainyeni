import { describe, expect, it, vi } from 'vitest';
import { SceneBasemapRuntime, type SceneBasemapLike, type SceneBasemapModule, type SceneBasemapMap } from './sceneBasemapRuntime';

const makeBasemap = (id: string): SceneBasemapLike => ({
  id,
  load: vi.fn(async () => undefined),
  destroy: vi.fn(),
});

const createRuntime = (sceneBasemap = makeBasemap('streets-3d')) => {
  const fromId = vi.fn(() => sceneBasemap);
  const loadModule = vi.fn(async (): Promise<SceneBasemapModule> => ({ fromId }));
  return { runtime: new SceneBasemapRuntime(loadModule), sceneBasemap, fromId, loadModule };
};

describe('SceneBasemapRuntime', () => {
  it('uses the 3D basemap only for the scene and restores the previous 2D basemap', async () => {
    const current = { id: 'osm' };
    const map: SceneBasemapMap = { basemap: current };
    const { runtime, sceneBasemap, loadModule } = createRuntime();

    await runtime.activate(map);

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(sceneBasemap.load).toHaveBeenCalledTimes(1);
    expect(map.basemap).toBe(sceneBasemap);
    expect(runtime.restore(map)).toBe(true);
    expect(map.basemap).toBe(current);

    await runtime.activate(map);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(map.basemap).toBe(sceneBasemap);
    runtime.dispose();
    expect(map.basemap).toBe(current);
    expect(sceneBasemap.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves a different basemap selected after returning to 2D', async () => {
    const original = { id: 'osm' };
    const selected = { id: 'gray-vector' };
    const map: SceneBasemapMap = { basemap: original };
    const { runtime, sceneBasemap } = createRuntime();

    await runtime.activate(map);
    runtime.restore(map);
    map.basemap = selected;
    await runtime.activate(map);
    expect(map.basemap).toBe(sceneBasemap);
    runtime.restore(map);

    expect(map.basemap).toBe(selected);
    runtime.dispose();
    expect(map.basemap).toBe(selected);
  });

  it('does not replace the map basemap when loading is aborted', async () => {
    const current = { id: 'osm' };
    const map: SceneBasemapMap = { basemap: current };
    const sceneBasemap = makeBasemap('streets-3d');
    let finishLoad: () => void = () => undefined;
    sceneBasemap.load = vi.fn(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    const { runtime } = createRuntime(sceneBasemap);
    const controller = new AbortController();
    const operation = runtime.activate(map, controller.signal);

    await vi.waitFor(() => expect(sceneBasemap.load).toHaveBeenCalledTimes(1));
    controller.abort();
    finishLoad();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(map.basemap).toBe(current);
    expect(sceneBasemap.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an unrelated basemap change made while loading', async () => {
    const current = { id: 'osm' };
    const selected = { id: 'gray-vector' };
    const map: SceneBasemapMap = { basemap: current };
    const sceneBasemap = makeBasemap('streets-3d');
    let finishLoad: () => void = () => undefined;
    sceneBasemap.load = vi.fn(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    const { runtime } = createRuntime(sceneBasemap);
    const operation = runtime.activate(map);

    await vi.waitFor(() => expect(sceneBasemap.load).toHaveBeenCalledTimes(1));
    map.basemap = selected;
    finishLoad();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(map.basemap).toBe(selected);
    expect(sceneBasemap.destroy).toHaveBeenCalledTimes(1);
  });
});
