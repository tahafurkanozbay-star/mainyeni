import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSceneView, destroySceneView } from './sceneRuntime';

const ports = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./arcgisModuleRuntime', () => ({ loadArcgisModule: ports.load, resetArcgisModuleRuntimeCache: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe('scene map ownership and cancelled construction', () => {
  it('detaches a shared map before SDK destroy can destroy its layers', () => {
    const map = { destroy: vi.fn() };
    const view = {
      map: map as typeof map | null, container: {} as unknown,
      destroy: vi.fn(() => view.map?.destroy()),
    };
    destroySceneView({ view, ownsMap: false });
    expect(view.map).toBeNull();
    expect(view.container).toBeNull();
    expect(view.destroy).toHaveBeenCalledOnce();
    expect(map.destroy).not.toHaveBeenCalled();
  });

  it('retains SDK destruction of a map created by the scene runtime', () => {
    const map = { destroy: vi.fn() };
    const view = { map, destroy: vi.fn(() => map.destroy()) };
    destroySceneView({ view, ownsMap: true });
    expect(map.destroy).toHaveBeenCalledOnce();
  });

  it('refuses to destroy a shared map when detaching it fails', () => {
    const destroy = vi.fn(); const report = vi.fn();
    const view = { destroy, set map(_value: unknown) { throw new Error('detach failed'); } };
    destroySceneView({ view, ownsMap: false }, report);
    expect(destroy).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
  });

  it('continues SDK cleanup when the container setter fails', () => {
    const destroy = vi.fn(); const report = vi.fn();
    const view = { destroy, set container(_value: unknown) { throw new Error('container failed'); } };
    destroySceneView(view, report);
    expect(destroy).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it('does not import the SDK for an already cancelled request', async () => {
    const lifetime = new AbortController(); lifetime.abort();
    await expect(createSceneView({}, { signal: lifetime.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ports.load).not.toHaveBeenCalled();
  });

  it('does not construct a view after its stalled module resolves following cancellation', async () => {
    let resolve!: (value: unknown) => void;
    ports.load.mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const lifetime = new AbortController(); const Constructor = vi.fn();
    const pending = createSceneView({}, { map: {}, signal: lifetime.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    lifetime.abort(); resolve(Constructor); await rejected;
    expect(Constructor).not.toHaveBeenCalled();
  });

  it('destroys only an owned map when the view constructor throws', async () => {
    const map = { destroy: vi.fn() };
    const Constructor = vi.fn(function () { throw new Error('GPU unavailable'); });
    const MapConstructor = vi.fn(function () { return map; });
    ports.load.mockImplementation(async (name) => name === 'esri/Map' ? MapConstructor : Constructor);
    await expect(createSceneView({})).rejects.toThrow('GPU unavailable');
    expect(map.destroy).toHaveBeenCalledOnce();
    map.destroy.mockClear();
    await expect(createSceneView({}, { map })).rejects.toThrow('GPU unavailable');
    expect(map.destroy).not.toHaveBeenCalled();
  });
});
